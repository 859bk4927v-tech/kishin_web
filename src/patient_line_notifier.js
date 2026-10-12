import { BookingService, MENUS } from "./booking_service.js";

export class PatientLineNotifier {
  static createMessage(booking) {
    const when = BookingService.formatParts(booking.start_at);
    return [
      "【よもん はりきゅう治療院】",
      "ご予約ありがとうございます。以下の内容でご予約を承りました。",
      "",
      `日時：${when.year}年${when.month}月${when.day}日(${when.weekday}) ${when.hour}:${when.minute}`,
      `メニュー：${MENUS[booking.menu]?.name || booking.menu}`,
      `予約番号：${booking.booking_number}`
    ].join("\n");
  }

  // "sent" means LINE accepted the request; it does not prove delivery or reading.
  static async sendAndRecord(db, bookingId, env) {
    try {
      return await this.sendSavedBooking(db, bookingId, env);
    } catch {
      // Notification or persistence failures must not invalidate a saved booking.
      return { status: "failed", error: "患者さまへのLINE通知を完了できませんでした。" };
    }
  }

  static async recordStatus(db, bookingId, retryKey, status, error) {
    // A late failure must not replace another request's successful result.
    await db.prepare(
      "UPDATE bookings SET patient_line_notification_status = ?, patient_line_notification_error = ? WHERE id = ? AND patient_line_retry_key = ? AND patient_line_notification_status != 'sent'"
    ).bind(status, error, bookingId, retryKey).run();
    const saved = await BookingService.findBooking(db, bookingId);
    return { status: saved.patient_line_notification_status, error: saved.patient_line_notification_error };
  }

  static async sendSavedBooking(db, bookingId, env) {
    let booking = await BookingService.findBooking(db, bookingId);
    if (!booking || booking.status !== "confirmed") {
      return { status: "failed", error: "有効な予約が見つかりません。" };
    }
    if (!booking.line_user_id) return { status: "skipped", error: "" };
    if (!/^U[0-9a-f]{32}$/.test(booking.line_user_id)) {
      return { status: "failed", error: "予約のLINEユーザー情報を確認できません。" };
    }
    if (["sent", "rejected"].includes(booking.patient_line_notification_status)) {
      return { status: booking.patient_line_notification_status, error: booking.patient_line_notification_error };
    }

    const token = env.LINE_CHANNEL_ACCESS_TOKEN;
    if (typeof token !== "string" || !token.trim()) {
      return this.recordStatus(db, bookingId, booking.patient_line_retry_key, "not_configured", "LINE通知設定がありません。");
    }

    if (!booking.patient_line_retry_key) {
      const payload = JSON.stringify({
        to: booking.line_user_id,
        messages: [{ type: "text", text: this.createMessage(booking) }]
      });
      // Concurrent callers must share one persisted retry key and immutable body.
      await db.prepare(
        "UPDATE bookings SET patient_line_retry_key = ?, patient_line_retry_created_at = ?, patient_line_payload = ?, patient_line_notification_status = 'pending', patient_line_notification_error = '' WHERE id = ? AND patient_line_retry_key = '' AND status = 'confirmed' AND start_at = ? AND end_at = ? AND menu = ? AND line_user_id = ?"
      ).bind(
        crypto.randomUUID(), BookingService.isoLocal(new Date()), payload,
        bookingId, booking.start_at, booking.end_at, booking.menu, booking.line_user_id
      ).run();
      booking = await BookingService.findBooking(db, bookingId);
      if (!booking || booking.status !== "confirmed" || !booking.patient_line_retry_key) {
        return { status: "failed", error: "予約内容が変更されました。通知を送信しませんでした。" };
      }
      if (["sent", "rejected"].includes(booking.patient_line_notification_status)) {
        return { status: booking.patient_line_notification_status, error: booking.patient_line_notification_error };
      }
    }

    const retryKey = booking.patient_line_retry_key;
    const age = Date.now() - Date.parse(booking.patient_line_retry_created_at);
    if (!booking.patient_line_payload || !Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000) {
      return this.recordStatus(db, bookingId, retryKey, "failed", "LINEの安全な再送期限を確認できないか、24時間を過ぎています。重複通知を避けるため再送しません。");
    }

    let status = "failed";
    let error = "LINE APIに接続できませんでした。";
    try {
      const response = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Line-Retry-Key": retryKey
        },
        body: booking.patient_line_payload
      });
      if (response.ok || (response.status === 409 && response.headers.get("x-line-accepted-request-id"))) {
        status = "sent";
        error = "";
      } else {
        status = response.status >= 400 && response.status < 500 ? "rejected" : "failed";
        error = `LINE API returned HTTP ${response.status}`;
      }
    } catch {
      // Keep the saved key and body: a timed-out request may already be accepted.
    }
    return this.recordStatus(db, bookingId, retryKey, status, error);
  }
}
