const JST = "Asia/Tokyo";
const SLOT_MINUTES = 30;
const OPENING_MINUTE = 10 * 60;
const LAST_START_MINUTE = 18 * 60;
const CLOSING_MINUTE = 19 * 60;

export const BOOKING_SCHEDULE = Object.freeze({
  slotMinutes: SLOT_MINUTES,
  openingMinute: OPENING_MINUTE,
  lastStartMinute: LAST_START_MINUTE,
  closingMinute: CLOSING_MINUTE
});

export const MENUS = Object.freeze({
  first: { name: "初回：カウンセリング＋施術 30分", duration: 30, price: 3850 },
  acupuncture: { name: "鍼 30分", duration: 30, price: 3300 },
  acupuncture_moxa: { name: "鍼＋灸 30分", duration: 30, price: 3850 },
  meridian: { name: "経絡ケア 60分", duration: 60, price: 6600 }
});

export class BookingService {
  static todayJst() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  static addDays(dateText, days) {
    const [year, month, day] = dateText.split("-").map(Number);
    const value = new Date(Date.UTC(year, month - 1, day + days));
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  }

  static parseDate(rawValue, daysAhead) {
    if (typeof rawValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
      throw new Error("予約日を選び直してください。");
    }
    const [year, month, day] = rawValue.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.toISOString().slice(0, 10) !== rawValue) {
      throw new Error("予約日を選び直してください。");
    }
    const today = this.todayJst();
    if (rawValue < today || rawValue > this.addDays(today, daysAhead)) {
      throw new Error("予約できる期間外の日付です。");
    }
    if (parsed.getUTCDay() === 0) {
      throw new Error("日曜日は休院日です。別の日をお選びください。");
    }
    return rawValue;
  }

  static parseMenu(menuCode) {
    if (typeof menuCode !== "string" || !MENUS[menuCode]) {
      throw new Error("施術メニューを選び直してください。");
    }
    return MENUS[menuCode];
  }

  static parseStart(dateText, selectedTime, durationMinutes) {
    if (typeof selectedTime !== "string" || !/^(?:1[0-8]|10):(?:00|30)$/.test(selectedTime)) {
      throw new Error("営業時間内の30分単位の時刻を選んでください。");
    }
    const [hour, minute] = selectedTime.split(":").map(Number);
    const startMinute = hour * 60 + minute;
    if (startMinute < OPENING_MINUTE || startMinute > LAST_START_MINUTE || startMinute % SLOT_MINUTES !== 0) {
      throw new Error("営業時間内の30分単位の時刻を選んでください。");
    }
    const startAt = `${dateText}T${selectedTime}:00+09:00`;
    if (Date.parse(startAt) <= Date.now()) throw new Error("過去の時間は予約できません。");
    const endMinute = startMinute + durationMinutes;
    if (endMinute > CLOSING_MINUTE) throw new Error("施術終了が閉院時刻を過ぎます。");
    const endHour = Math.floor(endMinute / 60);
    const endMinutePart = endMinute % 60;
    const endAt = `${dateText}T${String(endHour).padStart(2, "0")}:${String(endMinutePart).padStart(2, "0")}:00+09:00`;
    return { startAt, endAt };
  }

  static isoLocal(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+09:00`;
  }

  static isValidPhone(value) {
    if (typeof value !== "string" || !/^[+0-9()\-ー－\s]{8,30}$/.test(value)) return false;
    const digits = value.replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15;
  }

  static formatParts(value) {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: JST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    return Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  }

  static toBooking(row) {
    const start = this.formatParts(row.start_at);
    const end = this.formatParts(row.end_at);
    return {
      id: row.id,
      bookingNumber: row.booking_number,
      date: `${start.year}-${start.month}-${start.day}`,
      startTime: `${start.hour}:${start.minute}`,
      endTime: `${end.hour}:${end.minute}`,
      menu: row.menu,
      customerName: row.customer_name,
      phone: row.phone,
      email: row.email,
      status: row.status,
      notificationStatus: row.notification_status,
      notificationError: row.notification_error
    };
  }

  static async getAvailableSlots(db, dateText, menuCode, excludeId = null) {
    const menu = this.parseMenu(menuCode);
    const slots = [];
    for (let startMinute = OPENING_MINUTE; startMinute <= LAST_START_MINUTE; startMinute += SLOT_MINUTES) {
      if (startMinute + menu.duration > CLOSING_MINUTE) continue;
      const hour = Math.floor(startMinute / 60);
      const minute = startMinute % 60;
      const timeText = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const startAt = `${dateText}T${timeText}:00+09:00`;
      if (Date.parse(startAt) <= Date.now()) continue;
      const { endAt } = this.parseStart(dateText, timeText, menu.duration);
      if (excludeId) {
        const collision = await db.prepare(
          "SELECT 1 AS occupied FROM bookings WHERE status = 'confirmed' AND id != ? AND start_at < ? AND end_at > ? LIMIT 1"
        ).bind(excludeId, endAt, startAt).first();
        if (!collision) slots.push(timeText);
      } else {
        const collision = await db.prepare(
          "SELECT 1 AS occupied FROM bookings WHERE status = 'confirmed' AND start_at < ? AND end_at > ? LIMIT 1"
        ).bind(endAt, startAt).first();
        if (!collision) slots.push(timeText);
      }
    }
    return slots;
  }

  static async createBooking(db, booking) {
    const inserted = await db.prepare(`
      INSERT INTO bookings (
        id, booking_number, idempotency_key, start_at, end_at, menu,
        customer_name, phone, email, status, notification_status, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM bookings
        WHERE status = 'confirmed' AND start_at < ? AND end_at > ?
      )
      ON CONFLICT(idempotency_key) DO NOTHING
      RETURNING *
    `).bind(
      booking.id,
      booking.bookingNumber,
      booking.idempotencyKey,
      booking.startAt,
      booking.endAt,
      booking.menu,
      booking.name,
      booking.phone,
      booking.email,
      booking.createdAt,
      booking.createdAt,
      booking.endAt,
      booking.startAt
    ).first();

    if (inserted) return { row: inserted, created: true };
    const previous = await db.prepare("SELECT * FROM bookings WHERE idempotency_key = ?")
      .bind(booking.idempotencyKey).first();
    if (previous) return { row: previous, created: false };
    return { row: null, created: false };
  }

  static async listBookings(db, dateText) {
    const startAt = `${dateText}T00:00:00+09:00`;
    const endAt = `${this.addDays(dateText, 1)}T00:00:00+09:00`;
    const result = await db.prepare(
      "SELECT * FROM bookings WHERE start_at >= ? AND start_at < ? ORDER BY start_at"
    ).bind(startAt, endAt).all();
    return result.results.map((row) => this.toBooking(row));
  }
}
