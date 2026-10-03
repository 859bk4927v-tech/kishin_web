import { BookingService, MENUS } from "./booking_service.js";

export class LineNotifier {
  static async sendAndRecord(db, bookingId, env, eventLabel = "予約が入りました", resetRetry = false) {
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(bookingId).first();
    if (!booking || booking.status !== "confirmed") return { status: "failed", error: "予約が見つかりません。" };

    const token = env.LINE_CHANNEL_ACCESS_TOKEN || "";
    const ownerUserId = env.LINE_OWNER_USER_ID || "";
    if (!token || !ownerUserId) {
      await db.prepare(
        "UPDATE bookings SET notification_status = 'not_configured', notification_error = '', updated_at = ? WHERE id = ?"
      ).bind(BookingService.isoLocal(new Date()), bookingId).run();
      return { status: "not_configured", error: "" };
    }

    let retryKey = booking.line_retry_key;
    let retryCreatedAt = booking.line_retry_created_at;
    if (resetRetry || !retryKey) {
      retryKey = crypto.randomUUID();
      retryCreatedAt = BookingService.isoLocal(new Date());
    } else if (retryCreatedAt && Date.now() - Date.parse(retryCreatedAt) > 24 * 60 * 60 * 1000) {
      return { status: "failed", error: "LINEの安全な再送期限（24時間）を過ぎています。重複通知を避けるため自動再送しません。" };
    }

    await db.prepare(
      "UPDATE bookings SET line_retry_key = ?, line_retry_created_at = ? WHERE id = ?"
    ).bind(retryKey, retryCreatedAt, bookingId).run();

    const menu = MENUS[booking.menu];
    const when = BookingService.formatParts(booking.start_at);
    const message = [
      `【よもん はりきゅう治療院】${eventLabel}`,
      `予約番号：${booking.booking_number}`,
      `日時：${when.year}年${when.month}月${when.day}日（${when.weekday}） ${when.hour}:${when.minute}`,
      `メニュー：${menu.name}`,
      `お名前：${booking.customer_name}`,
      `電話番号：${booking.phone}`
    ].join("\n");

    let status = "failed";
    let error = "LINE APIに接続できませんでした。";
    try {
      const response = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Line-Retry-Key": retryKey
        },
        body: JSON.stringify({ to: ownerUserId, messages: [{ type: "text", text: message }] })
      });
      if (response.ok || response.status === 409) {
        status = "sent";
        error = "";
      } else {
        error = `LINE API returned HTTP ${response.status}`;
      }
    } catch {
      // Keep the same retry key so an uncertain network result cannot duplicate a message.
    }

    await db.prepare(
      "UPDATE bookings SET notification_status = ?, notification_error = ?, line_retry_key = ?, line_retry_created_at = ?, updated_at = ? WHERE id = ?"
    ).bind(
      status,
      error,
      retryKey,
      status === "sent" ? "" : retryCreatedAt,
      BookingService.isoLocal(new Date()),
      bookingId
    ).run();
    return { status, error };
  }
}
