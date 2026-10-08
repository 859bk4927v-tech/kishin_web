const JST = "Asia/Tokyo";
const SLOT_MINUTES = 30;
const BOOKING_BUFFER_MINUTES = 30;
const OPENING_MINUTE = 9 * 60;
const LAST_START_MINUTE = 23 * 60 + 30;
const CLOSING_MINUTE = 24 * 60;
export const CLOSED_WEEKDAYS = Object.freeze([5]);

export const BOOKING_SCHEDULE = Object.freeze({
  slotMinutes: SLOT_MINUTES,
  bookingBufferMinutes: BOOKING_BUFFER_MINUTES,
  openingMinute: OPENING_MINUTE,
  lastStartMinute: LAST_START_MINUTE,
  closingMinute: CLOSING_MINUTE
});

export const BOOKABLE_MENUS = Object.freeze({
  first_visit: { name: "初診 : カウンセリング20分+施術60分", duration: 80, price: 7000 },
  followup_60: { name: "2回目以降 : 施術60分", duration: 60, price: 6000 },
  followup_90: { name: "2回目以降 : 施術90分", duration: 90, price: 9000 }
});

// Preserve the original duration and name for bookings made before the price change.
export const MENUS = Object.freeze({
  ...BOOKABLE_MENUS,
  first: { name: "初回 : カウンセリング+施術 30分", duration: 30, price: 3850 },
  acupuncture: { name: "鍼 30分", duration: 30, price: 3300 },
  acupuncture_moxa: { name: "鍼+灸 30分", duration: 30, price: 3850 },
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

  static parseCalendarDate(rawValue) {
    if (typeof rawValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
      throw new Error("予約日を選び直してください。");
    }
    const [year, month, day] = rawValue.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.toISOString().slice(0, 10) !== rawValue) {
      throw new Error("予約日を選び直してください。");
    }
    return rawValue;
  }

  static parseDate(rawValue, daysAhead) {
    this.parseCalendarDate(rawValue);
    const today = this.todayJst();
    if (rawValue < today || rawValue > this.addDays(today, daysAhead)) {
      throw new Error("予約できる期間外の日付です。");
    }
    if (CLOSED_WEEKDAYS.includes(new Date(`${rawValue}T00:00:00Z`).getUTCDay())) {
      throw new Error("金曜日は休診日です。別の日をお選びください。");
    }
    return rawValue;
  }

  static parseMenu(menuCode) {
    if (typeof menuCode !== "string" || !Object.hasOwn(MENUS, menuCode)) {
      throw new Error("施術メニューを選び直してください。");
    }
    return MENUS[menuCode];
  }

  static parseBookableMenu(menuCode) {
    if (typeof menuCode !== "string" || !Object.hasOwn(BOOKABLE_MENUS, menuCode)) {
      throw new Error("施術メニューを選び直してください。");
    }
    return BOOKABLE_MENUS[menuCode];
  }

  static parseStart(dateText, selectedTime, durationMinutes) {
    this.parseCalendarDate(dateText);
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw new Error("施術時間を確認してください。");
    }
    if (typeof selectedTime !== "string" || !/^(?:[01][0-9]|2[0-3]):(?:00|30)$/.test(selectedTime)) {
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
    const endAt = this.timestampAtMinute(dateText, endMinute);
    return { startAt, endAt };
  }

  static parseBlockedPeriod(dateText, startTime, endTime) {
    this.parseCalendarDate(dateText);
    const validTime = /^(?:[01][0-9]|2[0-3]):(?:00|30)$/;
    if (typeof startTime !== "string" || !validTime.test(startTime) ||
        typeof endTime !== "string" || !(validTime.test(endTime) || endTime === "24:00")) {
      throw new Error("9 : 00~24 : 00の30分単位で時間を選んでください。");
    }
    const toMinute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    if (toMinute(startTime) < OPENING_MINUTE || toMinute(endTime) > CLOSING_MINUTE ||
        toMinute(startTime) >= toMinute(endTime)) {
      throw new Error("終了時刻は開始時刻より後にしてください。");
    }
    const startAt = `${dateText}T${startTime}:00+09:00`;
    if (Date.parse(startAt) <= Date.now()) throw new Error("過去の時間には予定を登録できません。");
    return { startAt, endAt: this.timestampAtMinute(dateText, toMinute(endTime)) };
  }

  // Store midnight as the next day so SQLite's timestamp comparisons stay chronological.
  static timestampAtMinute(dateText, minute) {
    const date = this.addDays(dateText, Math.floor(minute / (24 * 60)));
    const hour = String(Math.floor(minute / 60) % 24).padStart(2, "0");
    return `${date}T${hour}:${String(minute % 60).padStart(2, "0")}:00+09:00`;
  }

  static addMinutes(timestamp, minutes) {
    return this.isoLocal(new Date(Date.parse(timestamp) + minutes * 60_000));
  }

  static endTimeLabel(start, end) {
    const nextDay = `${start.year}-${start.month}-${start.day}` !== `${end.year}-${end.month}-${end.day}`;
    return `${nextDay && end.hour === "00" ? "24" : end.hour}:${end.minute}`;
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
    if (typeof value !== "string" || !/^[+0-9()\-ー\uFF0D\s]{8,30}$/.test(value)) return false;
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
      endTime: this.endTimeLabel(start, end),
      menu: row.menu,
      menuName: MENUS[row.menu]?.name || row.menu,
      durationMinutes: (Date.parse(row.end_at) - Date.parse(row.start_at)) / 60000,
      customerName: row.customer_name,
      phone: row.phone,
      email: row.email,
      status: row.status,
      notificationStatus: row.notification_status,
      notificationError: row.notification_error
    };
  }

  static toBlock(row) {
    const start = this.formatParts(row.start_at);
    const end = this.formatParts(row.end_at);
    return {
      id: row.id,
      date: `${start.year}-${start.month}-${start.day}`,
      startTime: `${start.hour}:${start.minute}`,
      endTime: this.endTimeLabel(start, end),
      note: row.note
    };
  }

  static async getAvailableSlots(db, dateText, menuCode, excludeId = null) {
    const menu = this.parseMenu(menuCode);
    this.parseCalendarDate(dateText);
    const dayStart = `${dateText}T00:00:00+09:00`;
    const dayEnd = `${this.addDays(dateText, 1)}T00:00:00+09:00`;
    const occupied = await db.prepare(`
      SELECT start_at, end_at, 'booking' AS period_type FROM bookings
      WHERE status = 'confirmed' AND id != ? AND start_at < ? AND end_at > ?
      UNION ALL
      SELECT start_at, end_at, 'block' AS period_type FROM blocked_periods WHERE start_at < ? AND end_at > ?
    `).bind(excludeId || '', dayEnd, dayStart, dayEnd, dayStart).all();
    const slots = [];
    for (let startMinute = OPENING_MINUTE; startMinute <= LAST_START_MINUTE; startMinute += SLOT_MINUTES) {
      if (startMinute + menu.duration > CLOSING_MINUTE) continue;
      const hour = Math.floor(startMinute / 60);
      const minute = startMinute % 60;
      const timeText = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const startAt = `${dateText}T${timeText}:00+09:00`;
      if (Date.parse(startAt) <= Date.now()) continue;
      const { endAt } = this.parseStart(dateText, timeText, menu.duration);
      const collision = occupied.results.some(period => period.period_type === "booking"
        ? period.start_at < this.addMinutes(endAt, BOOKING_BUFFER_MINUTES)
          && period.end_at > this.addMinutes(startAt, -BOOKING_BUFFER_MINUTES)
        : period.start_at < endAt && period.end_at > startAt);
      if (!collision) slots.push(timeText);
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
      AND NOT EXISTS (
        SELECT 1 FROM blocked_periods WHERE start_at < ? AND end_at > ?
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
      this.addMinutes(booking.endAt, BOOKING_BUFFER_MINUTES),
      this.addMinutes(booking.startAt, -BOOKING_BUFFER_MINUTES),
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

  static async findBooking(db, bookingId) {
    return db.prepare("SELECT * FROM bookings WHERE id = ?").bind(bookingId).first();
  }

  static async cancelBooking(db, bookingId) {
    return db.prepare(
      "UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'confirmed' RETURNING id"
    ).bind(this.isoLocal(new Date()), bookingId).first();
  }

  static async rescheduleBooking(db, bookingId, startAt, endAt) {
    return db.prepare(`
      UPDATE bookings
      SET start_at = ?, end_at = ?, notification_status = 'pending', notification_error = '', updated_at = ?
      WHERE id = ? AND status = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM bookings
          WHERE status = 'confirmed' AND id != ? AND start_at < ? AND end_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM blocked_periods WHERE start_at < ? AND end_at > ?
        )
      RETURNING id
    `).bind(
      startAt, endAt, this.isoLocal(new Date()), bookingId, bookingId,
      this.addMinutes(endAt, BOOKING_BUFFER_MINUTES), this.addMinutes(startAt, -BOOKING_BUFFER_MINUTES),
      endAt, startAt
    ).first();
  }

  static async listBlocks(db, dateText) {
    const startAt = `${dateText}T00:00:00+09:00`;
    const endAt = `${this.addDays(dateText, 1)}T00:00:00+09:00`;
    const result = await db.prepare(
      "SELECT * FROM blocked_periods WHERE start_at >= ? AND start_at < ? ORDER BY start_at"
    ).bind(startAt, endAt).all();
    return result.results.map((row) => this.toBlock(row));
  }

  static async createBlock(db, block) {
    return db.prepare(`
      INSERT INTO blocked_periods (id, start_at, end_at, note, created_at)
      SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM bookings
        WHERE status = 'confirmed' AND start_at < ? AND end_at > ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocked_periods WHERE start_at < ? AND end_at > ?
      )
      RETURNING *
    `).bind(
      block.id, block.startAt, block.endAt, block.note, block.createdAt,
      block.endAt, block.startAt, block.endAt, block.startAt
    ).first();
  }

  static async deleteBlock(db, blockId) {
    return db.prepare("DELETE FROM blocked_periods WHERE id = ? RETURNING id").bind(blockId).first();
  }
}
