import { BookingService, BOOKABLE_MENUS, BOOKING_SCHEDULE, CLOSED_WEEKDAYS, SAME_DAY_BOOKING_NOTICE } from "./booking_service.js";
import { LineNotifier } from "./line_notifier.js";
import { PatientLineNotifier } from "./patient_line_notifier.js";
import { LineIdentityVerifier, LineIdentityError } from "./line_identity_verifier.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY"
};

export class BookingApi {
  static json(status, payload) {
    return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
  }

  static async readJson(request) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > 20_000) throw new Error("送信内容のサイズが正しくありません。");
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("送信内容を読み取れませんでした。");
    }
  }

  static async requireAdmin(request, env) {
    const expected = env.ADMIN_TOKEN || "";
    if (!expected) return this.json(503, { error: "管理機能は未設定です。Cloudflare WorkersのADMIN_TOKEN Secretを設定してください。" });
    const supplied = request.headers.get("Authorization") || "";
    const actual = supplied.startsWith("Bearer ") ? supplied.slice(7) : "";
    if (!this.constantTimeEqual(actual, expected)) return this.json(401, { error: "管理用トークンが正しくありません。" });
    return null;
  }

  static constantTimeEqual(left, right) {
    const encoder = new TextEncoder();
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    let difference = leftBytes.length ^ rightBytes.length;
    const length = Math.max(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
      difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
    }
    return difference === 0;
  }

  static async handle(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/api/config") return this.getConfig(env);
    if (request.method === "GET" && pathname === "/api/availability") return this.getAvailability(url, env);
    if (request.method === "GET" && pathname === "/api/admin/availability") return this.getAdminAvailability(request, url, env);
    if (request.method === "POST" && pathname === "/api/bookings") return this.createBooking(request, env);
    if (pathname === "/api/admin/bookings") {
      if (request.method === "GET") return this.getAdminBookings(request, url, env);
    }
    if (pathname === "/api/admin/blocks" && request.method === "POST") return this.createAdminBlock(request, env);
    const block = pathname.match(/^\/api\/admin\/blocks\/([a-f0-9-]+)$/);
    if (request.method === "DELETE" && block) return this.deleteAdminBlock(request, env, block[1]);
    const action = pathname.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)\/(cancel|notify)$/);
    if (request.method === "POST" && action) return this.postAdminAction(request, env, action[1], action[2]);
    const booking = pathname.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)$/);
    if (request.method === "PUT" && booking) return this.rescheduleBooking(request, env, booking[1]);
    return this.json(404, { error: "APIが見つかりません。" });
  }

  static daysAhead(env) {
    const configured = Number.parseInt(env.BOOKING_DAYS_AHEAD || "60", 10);
    return Number.isFinite(configured) ? Math.max(1, Math.min(180, configured)) : 60;
  }

  static async verifyTurnstile(request, env, token) {
    const secret = env.TURNSTILE_SECRET;
    if (typeof secret !== "string" || !secret.trim()) {
      return this.json(503, { error: "予約受付の認証設定が完了していません。時間をおいて再度お試しください。" });
    }
    if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
      return this.json(400, { error: "Turnstile認証を完了してから、もう一度お試しください。" });
    }

    try {
      const form = new URLSearchParams({ secret, response: token });
      const remoteIp = request.headers.get("CF-Connecting-IP");
      if (remoteIp) form.set("remoteip", remoteIp);
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        return this.json(503, { error: "認証サービスに接続できませんでした。時間をおいて再度お試しください。" });
      }

      const result = await response.json();
      const requestHostname = new URL(request.url).hostname.toLowerCase();
      if (result?.success !== true || typeof result.hostname !== "string"
        || result.hostname.toLowerCase() !== requestHostname) {
        return this.json(403, { error: "認証を確認できませんでした。ページを再読み込みして、もう一度お試しください。" });
      }
      return null;
    } catch {
      return this.json(503, { error: "認証サービスに接続できませんでした。時間をおいて再度お試しください。" });
    }
  }

  static bookingReceipt(row) {
    const booking = BookingService.toBooking(row);
    return {
      bookingNumber: booking.bookingNumber,
      customerName: booking.customerName,
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      menuName: booking.menuName
    };
  }

  static async notifyBooking(db, bookingId, env, eventLabel, resetRetry = false) {
    try {
      return await LineNotifier.sendAndRecord(db, bookingId, env, eventLabel, resetRetry);
    } catch {
      // The reservation is already saved; notification failures must not look like a failed booking.
      return { status: "failed" };
    }
  }

  static async notifyPatientBooking(db, bookingId, env) {
    try {
      return await PatientLineNotifier.sendAndRecord(db, bookingId, env);
    } catch {
      // Keep confirmation successful even if the patient notifier unexpectedly throws.
      return { status: "failed" };
    }
  }

  static getConfig(env) {
    const today = BookingService.todayJst();
    const daysAhead = this.daysAhead(env);
    return this.json(200, {
      daysAhead,
      minDate: today,
      maxDate: BookingService.addDays(today, daysAhead),
      menus: BOOKABLE_MENUS,
      closedWeekdays: CLOSED_WEEKDAYS,
      schedule: BOOKING_SCHEDULE
    });
  }

  static async getAvailability(url, env) {
    let selectedDate;
    let menu;
    try {
      selectedDate = BookingService.parseDate(url.searchParams.get("date"), this.daysAhead(env));
      menu = url.searchParams.get("menu");
      BookingService.parseBookableMenu(menu);
    } catch (error) {
      return this.json(400, { error: error.message || "空き時間を確認できませんでした。" });
    }

    try {
      const availability = await BookingService.getSlotAvailability(env.BOOKING_DB, selectedDate, menu);
      return this.json(200, { date: selectedDate, ...availability });
    } catch {
      return this.json(500, { error: "空き時間を確認できませんでした。時間をおいて再度お試しください。" });
    }
  }

  static async getAdminBookings(request, url, env) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    const date = url.searchParams.get("date") || "";
    try {
      BookingService.parseCalendarDate(date);
    } catch {
      return this.json(400, { error: "日付を選択してください。" });
    }
    try {
      const [bookings, blocks] = await Promise.all([
        BookingService.listBookings(env.BOOKING_DB, date),
        BookingService.listBlocks(env.BOOKING_DB, date)
      ]);
      return this.json(200, { bookings, blocks });
    } catch {
      return this.json(500, { error: "予約を読み込めませんでした。時間をおいて再度お試しください。" });
    }
  }

  static async getAdminAvailability(request, url, env) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    const response = await this.getAvailability(url, env);
    if (!response.ok) return response;
    const { date, slots, contactSlots } = await response.json();
    return this.json(200, { date, slots: [...slots, ...contactSlots].sort() });
  }

  static async createAdminBlock(request, env) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    let block;
    try {
      const body = await this.readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("予定を確認してください。");
      const date = BookingService.parseDate(body.date, this.daysAhead(env));
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (note.length > 100) throw new Error("予定のメモは100文字以内にしてください。");
      // Older admin clients omit the type and keep creating private periods.
      const blockType = body.blockType === undefined ? "private" : body.blockType;
      if (!["private", "patient"].includes(blockType)) throw new Error("私用または患者予約を選択してください。");
      const menu = blockType === "patient" ? body.menu : "";
      const { startAt, endAt } = blockType === "patient"
        ? BookingService.parseStart(date, body.startTime, BookingService.parseBookableMenu(menu).duration)
        : BookingService.parseBlockedPeriod(date, body.startTime, body.endTime);
      const customerName = blockType === "patient" && typeof body.customerName === "string" ? body.customerName.trim() : "";
      const phone = blockType === "patient" && typeof body.phone === "string" ? body.phone.trim() : "";
      if (blockType === "patient") {
        if (!customerName || customerName.length > 80) throw new Error("患者さまのお名前を入力してください(80文字以内)。");
        if (body.phone !== undefined && typeof body.phone !== "string") throw new Error("電話番号を確認してください。");
        if (phone && !BookingService.isValidPhone(phone)) throw new Error("電話番号を確認してください。");
      }
      block = { id: crypto.randomUUID(), startAt, endAt, note, blockType, customerName, phone, menu,
        createdAt: BookingService.isoLocal(new Date()) };
    } catch (error) {
      return this.json(400, { error: error.message || "予定を確認してください。" });
    }
    try {
      const inserted = await BookingService.createBlock(env.BOOKING_DB, block);
      if (!inserted) return this.json(409, { error: "その時間には予約または別の予定があります。時間を選び直してください。" });
      return this.json(201, { ok: true, block: BookingService.toBlock(inserted) });
    } catch {
      return this.json(500, { error: "予定を保存できませんでした。" });
    }
  }

  static async deleteAdminBlock(request, env, blockId) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    try {
      const deleted = await BookingService.deleteBlock(env.BOOKING_DB, blockId);
      if (!deleted) return this.json(404, { error: "予定が見つかりません。" });
      return this.json(200, { ok: true });
    } catch {
      return this.json(500, { error: "予定を削除できませんでした。" });
    }
  }

  static async createBooking(request, env) {
    let body;
    let selectedDate;
    let selectedTime;
    let menuCode;
    let menu;
    let startAt;
    let endAt;
    let name;
    let phone;
    let email;
    let idempotencyKey;
    try {
      body = await this.readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("送信内容を確認してください。");
      if (body.website) return this.json(400, { error: "予約を送信できませんでした。" });
      idempotencyKey = body.idempotencyKey;
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
        throw new Error("ページを再読み込みしてから、もう一度お試しください。");
      }
      selectedDate = BookingService.parseDate(body.date, this.daysAhead(env));
      menuCode = body.menu;
      menu = BookingService.parseBookableMenu(menuCode);
      selectedTime = body.time;
      ({ startAt, endAt } = BookingService.parseStart(selectedDate, selectedTime, menu.duration));
      name = typeof body.name === "string" ? body.name.trim() : "";
      phone = typeof body.phone === "string" ? body.phone.trim() : "";
      email = typeof body.email === "string" ? body.email.trim() : "";
      if (!name || name.length > 80) throw new Error("お名前を入力してください(80文字以内)。");
      if (!BookingService.isValidPhone(phone)) throw new Error("電話番号を確認してください。");
      if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        throw new Error("メールアドレスを確認してください。");
      }
    } catch (error) {
      return this.json(400, { error: error.message || "予約内容を確認してください。" });
    }

    const turnstileError = await this.verifyTurnstile(request, env, body.turnstileToken);
    if (turnstileError) return turnstileError;

    let lineUserId;
    try {
      lineUserId = await LineIdentityVerifier.verify(body.lineIdToken, env.LINE_MINIAPP_CHANNEL_ID);
    } catch (error) {
      return error instanceof LineIdentityError
        ? this.json(error.status, { error: error.message })
        : this.json(503, { error: "LINEの本人確認ができません。時間をおいて再度お試しください。" });
    }

    const datePart = selectedDate.replaceAll("-", "");
    const random = Array.from(crypto.getRandomValues(new Uint8Array(2)), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    const booking = {
      id: crypto.randomUUID(),
      bookingNumber: `YOM-${datePart}-${random}`,
      idempotencyKey,
      startAt,
      endAt,
      menu: menuCode,
      name,
      phone,
      email,
      lineUserId,
      createdAt: BookingService.isoLocal(new Date())
    };

    try {
      // Check after external verification, immediately before saving. A saved request
      // may still return its receipt after the cutoff, without creating or notifying again.
      const allowed = BookingService.isOnlineBookingStartAllowed(startAt);
      const result = allowed
        ? await BookingService.createBooking(env.BOOKING_DB, booking)
        : { row: await BookingService.findBookingByRequestKey(env.BOOKING_DB, idempotencyKey), created: false };
      if (!allowed && !result.row) return this.json(400, { error: SAME_DAY_BOOKING_NOTICE });
      if (!result.row) return this.json(409, { error: "申し訳ありません。その時間は予約済みです。別の時間をお選びください。" });
      if ((result.row.line_user_id || "") !== lineUserId) {
        return this.json(409, { error: "予約時のLINEアカウントと一致しません。元の予約画面から再度お試しください。" });
      }
      if (result.row.status !== "confirmed") {
        return this.json(409, { error: "この予約はキャンセル済みです。ページを再読み込みして、新しくご予約ください。" });
      }
      if (!result.created) {
        return this.json(200, {
          ok: true,
          bookingNumber: result.row.booking_number,
          booking: this.bookingReceipt(result.row),
          notificationStatus: result.row.notification_status,
          patientLineNotificationStatus: result.row.line_user_id
            ? result.row.patient_line_notification_status || "not_requested"
            : "skipped"
        });
      }
      const notification = await this.notifyBooking(env.BOOKING_DB, booking.id, env);
      const patientNotification = result.row.line_user_id
        ? await this.notifyPatientBooking(env.BOOKING_DB, result.row.id, env)
        : { status: "skipped" };
      return this.json(201, {
        ok: true,
        bookingNumber: booking.bookingNumber,
        booking: this.bookingReceipt(result.row),
        notificationStatus: notification.status,
        patientLineNotificationStatus: patientNotification.status
      });
    } catch {
      return this.json(500, { error: "予約を保存できませんでした。時間をおいて再度お試しください。" });
    }
  }

  static async postAdminAction(request, env, bookingId, action) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    try {
      await this.readJson(request);
    } catch (error) {
      return this.json(400, { error: error.message });
    }
    if (action === "cancel") {
      try {
        const result = await BookingService.cancelBooking(env.BOOKING_DB, bookingId);
        if (!result) return this.json(404, { error: "有効な予約が見つかりません。" });
        return this.json(200, { ok: true });
      } catch {
        return this.json(500, { error: "予約をキャンセルできませんでした。" });
      }
    }
    const notification = await this.notifyBooking(env.BOOKING_DB, bookingId, env);
    if (notification.status === "sent") return this.json(200, { ok: true, notificationStatus: notification.status });
    if (notification.status === "not_configured") return this.json(503, { error: "LINE通知設定がありません。環境変数を設定してください。" });
    return this.json(502, {
      error: "LINE通知を送信できませんでした。設定と接続を確認してください。",
      notificationStatus: notification.status
    });
  }

  static async rescheduleBooking(request, env, bookingId) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    let selectedDate;
    let selectedTime;
    try {
      const body = await this.readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("送信内容を確認してください。");
      selectedDate = BookingService.parseDate(body.date, this.daysAhead(env));
      selectedTime = body.time;
    } catch (error) {
      return this.json(400, { error: error.message || "予約内容を確認してください。" });
    }

    let existing;
    try {
      existing = await BookingService.findBooking(env.BOOKING_DB, bookingId);
    } catch {
      return this.json(500, { error: "予約を読み込めませんでした。時間をおいて再度お試しください。" });
    }
    if (!existing || existing.status !== "confirmed") return this.json(404, { error: "有効な予約が見つかりません。" });

    let startAt;
    let endAt;
    try {
      const { durationMinutes } = BookingService.toBooking(existing);
      ({ startAt, endAt } = BookingService.parseStart(selectedDate, selectedTime, durationMinutes));
    } catch (error) {
      return this.json(400, { error: error.message || "予約内容を確認してください。" });
    }
    if (startAt === existing.start_at) return this.json(200, { ok: true });

    try {
      const updated = await BookingService.rescheduleBooking(env.BOOKING_DB, bookingId, startAt, endAt);
      if (!updated) {
        const stillActive = await BookingService.findBooking(env.BOOKING_DB, bookingId);
        if (!stillActive || stillActive.status !== "confirmed") return this.json(404, { error: "有効な予約が見つかりません。" });
        return this.json(409, { error: "その時間はすでに予約されています。別の日時を選んでください。" });
      }
      const notification = await this.notifyBooking(env.BOOKING_DB, bookingId, env, "予約日時が変更されました", true);
      return this.json(200, { ok: true, notificationStatus: notification.status });
    } catch {
      return this.json(500, { error: "予約日時を保存できませんでした。" });
    }
  }
}
