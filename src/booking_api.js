import { BookingService, BOOKABLE_MENUS, BOOKING_SCHEDULE, CLOSED_WEEKDAYS } from "./booking_service.js";
import { LineNotifier } from "./line_notifier.js";

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
      const slots = await BookingService.getAvailableSlots(env.BOOKING_DB, selectedDate, menu);
      return this.json(200, { date: selectedDate, slots });
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

  static async createAdminBlock(request, env) {
    const authError = await this.requireAdmin(request, env);
    if (authError) return authError;
    let block;
    try {
      const body = await this.readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("予定を確認してください。");
      const date = BookingService.parseDate(body.date, this.daysAhead(env));
      const { startAt, endAt } = BookingService.parseBlockedPeriod(date, body.startTime, body.endTime);
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (note.length > 100) throw new Error("予定のメモは100文字以内にしてください。");
      block = { id: crypto.randomUUID(), startAt, endAt, note, createdAt: BookingService.isoLocal(new Date()) };
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
      createdAt: BookingService.isoLocal(new Date())
    };

    try {
      const result = await BookingService.createBooking(env.BOOKING_DB, booking);
      if (!result.row) return this.json(409, { error: "申し訳ありません。その時間は予約済みです。別の時間をお選びください。" });
      if (result.row.status !== "confirmed") {
        return this.json(409, { error: "この予約はキャンセル済みです。ページを再読み込みして、新しくご予約ください。" });
      }
      if (!result.created) {
        return this.json(200, {
          ok: true,
          bookingNumber: result.row.booking_number,
          booking: this.bookingReceipt(result.row),
          notificationStatus: result.row.notification_status
        });
      }
      const notification = await this.notifyBooking(env.BOOKING_DB, booking.id, env);
      return this.json(201, {
        ok: true,
        bookingNumber: booking.bookingNumber,
        booking: this.bookingReceipt(result.row),
        notificationStatus: notification.status
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
