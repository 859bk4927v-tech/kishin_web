import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BookingService as Service } from '../src/booking_service.js';
import { BookingApi } from '../src/booking_api.js';
import { LineNotifier } from '../src/line_notifier.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_create_bookings.sql', '0002_create_blocked_periods.sql']) {
    sqlite.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { bind: (...params) => ({
        first: async () => statement.get(...params) || null,
        all: async () => ({ results: statement.all(...params) }),
        run: async () => statement.run(...params)
      }) };
    }
  };
}

function booking(date, time, menu = 'first_visit') {
  const id = crypto.randomUUID();
  return {
    id, bookingNumber: id, idempotencyKey: id,
    ...Service.parseStart(date, time, Service.parseMenu(menu).duration),
    menu, name: 'テスト', phone: '09000000000', email: '', createdAt: Service.isoLocal(new Date())
  };
}

function mockTurnstile(t, result = { success: true, hostname: 'example.test' }) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options.method, 'POST');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('secret'), 'test-turnstile-secret');
    assert.ok(form.get('response'));
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

test('Friday is closed while Sunday accepts reservations through the API', async t => {
  const db = database(t);
  const upcoming = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1));
  const friday = upcoming.find(date => new Date(`${date}T00:00:00Z`).getUTCDay() === 5);
  const sunday = upcoming.find(date => new Date(`${date}T00:00:00Z`).getUTCDay() === 0);
  assert.throws(() => Service.parseDate(friday, 60), /金曜日は休診日/);
  assert.equal(Service.parseDate(sunday, 60), sunday);
  const env = { BOOKING_DB: db, BOOKING_DAYS_AHEAD: '60' };
  const closed = await BookingApi.getAvailability(new URL(`https://example.test/api/availability?date=${friday}&menu=first_visit`), env);
  assert.equal(closed.status, 400);
  const open = await BookingApi.getAvailability(new URL(`https://example.test/api/availability?date=${sunday}&menu=first_visit`), env);
  assert.equal(open.status, 200);
  const { slots } = await open.json();
  assert.equal(slots[0], '09:00');
  assert.equal(slots.at(-1), '22:30');
});

test('last start depends on treatment length and midnight rolls into the next year', async t => {
  const db = database(t);
  const date = '2099-12-31';
  const firstVisit = await Service.getAvailableSlots(db, date, 'first_visit');
  const followup60 = await Service.getAvailableSlots(db, date, 'followup_60');
  const followup90 = await Service.getAvailableSlots(db, date, 'followup_90');
  assert.equal(firstVisit.length, 28);
  assert.equal(followup60.length, 29);
  assert.equal(followup90.length, 28);
  assert.equal(firstVisit.at(-1), '22:30');
  assert.equal(followup60.at(-1), '23:00');
  assert.equal(followup90.at(-1), '22:30');
  assert.equal(Service.parseStart(date, '22:30', 80).endAt, '2099-12-31T23:50:00+09:00');
  assert.equal(Service.parseStart(date, '23:00', 60).endAt, '2100-01-01T00:00:00+09:00');
  assert.equal(Service.parseStart(date, '22:30', 90).endAt, '2100-01-01T00:00:00+09:00');
  assert.throws(() => Service.parseStart(date, '23:00', 80), /閉院時刻/);
  assert.throws(() => Service.parseStart(date, '23:30', 60), /閉院時刻/);
  for (const time of ['08:30', '24:00', '23:45', '29:00']) {
    assert.throws(() => Service.parseStart(date, time, 30));
  }
});

test('old menus remain readable but cannot be selected for a new reservation', async t => {
  const db = database(t);
  assert.equal(Service.parseMenu('first').duration, 30);
  assert.equal(Service.parseMenu('meridian').price, 6600);
  const date = Array.from({ length: 2 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  const response = await BookingApi.getAvailability(new URL(`https://example.test/api/availability?date=${date}&menu=first`), { BOOKING_DB: db, BOOKING_DAYS_AHEAD: '60' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /施術メニュー/);
});

test('new and repeated booking responses include the saved receipt details', async t => {
  const db = database(t);
  const date = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  const body = {
    idempotencyKey: 'receipt-test-key-1234', menu: 'first_visit', date, time: '10:00',
    name: '予約テスト', phone: '09000000000', email: '', website: '', turnstileToken: 'test-turnstile-token'
  };
  const request = () => new Request('https://example.test/api/bookings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const env = { BOOKING_DB: db, BOOKING_DAYS_AHEAD: '60', TURNSTILE_SECRET: 'test-turnstile-secret' };
  mockTurnstile(t);
  const first = await BookingApi.createBooking(request(), env);
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.deepEqual(created.booking, {
    bookingNumber: created.bookingNumber,
    customerName: '予約テスト',
    date,
    startTime: '10:00',
    endTime: '11:20',
    menuName: '初診 : カウンセリング20分+施術60分'
  });
  assert.equal(created.notificationStatus, 'not_configured');
  const repeated = await BookingApi.createBooking(request(), env);
  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).booking, created.booking);
});

test('midnight booking blocks overlapping slots and stays visible on its original day', async t => {
  const db = database(t);
  const date = '2099-12-31';
  const saved = await Service.createBooking(db, booking(date, '23:00', 'followup_60'));
  assert.equal(saved.created, true);
  assert.equal(saved.row.end_at, '2100-01-01T00:00:00+09:00');
  const collision = await Service.createBooking(db, booking(date, '22:30', 'followup_90'));
  assert.equal(collision.row, null);
  assert.equal((await Service.getAvailableSlots(db, date, 'followup_60')).includes('23:00'), false);
  const [display] = await Service.listBookings(db, date);
  assert.equal(display.endTime, '24:00');
  assert.equal(display.date, date);
  assert.equal((await Service.listBookings(db, '2100-01-01')).length, 0);
  assert.equal((await Service.getAvailableSlots(db, '2100-01-01', 'first_visit'))[0], '09:00');
});

test('admin can block through 24:00 without allowing overlapping bookings', async t => {
  const db = database(t);
  const date = '2099-10-04';
  const times = Service.parseBlockedPeriod(date, '22:00', '24:00');
  assert.equal(times.endAt, '2099-10-05T00:00:00+09:00');
  const saved = await Service.createBlock(db, { id: 'evening', ...times, note: '', createdAt: Service.isoLocal(new Date()) });
  assert.ok(saved);
  const [display] = await Service.listBlocks(db, date);
  assert.equal(display.endTime, '24:00');
  const slots = await Service.getAvailableSlots(db, date, 'first_visit');
  assert.equal(slots.at(-1), '20:30');
  assert.equal((await Service.createBooking(db, booking(date, '21:00'))).row, null);
  assert.equal((await Service.createBooking(db, booking(date, '20:30'))).created, true);
  for (const [start, end] of [['08:30', '10:00'], ['23:30', '24:30'], ['24:00', '24:00'], ['22:00', '21:00']]) {
    assert.throws(() => Service.parseBlockedPeriod(date, start, end));
  }
});

test('availability reads occupied intervals once and respects exact boundaries and exclusion', async t => {
  const db = database(t);
  const date = '2099-10-04';
  const existing = booking(date, '10:30', 'followup_60');
  await Service.createBooking(db, existing);
  await Service.createBlock(db, {
    id: 'midday', ...Service.parseBlockedPeriod(date, '12:30', '13:00'), note: '', createdAt: Service.isoLocal(new Date())
  });
  let reads = 0;
  const trackedDb = { prepare(sql) { reads += 1; return db.prepare(sql); } };
  const slots = await Service.getAvailableSlots(trackedDb, date, 'first_visit');
  assert.equal(reads, 1);
  assert.equal(slots.includes('09:00'), false); // Ends 10:20, leaving only 10 minutes before the 10:30 booking.
  assert.equal(slots.includes('09:30'), false);
  assert.equal(slots.includes('11:30'), false); // Overlaps the 12:30 block.
  assert.equal(slots.includes('13:00'), true);
  const excludingSelf = await Service.getAvailableSlots(db, date, 'first_visit', existing.id);
  assert.equal(excludingSelf.includes('10:30'), true);
  await Service.cancelBooking(db, existing.id);
  assert.equal((await Service.getAvailableSlots(db, date, 'first_visit')).includes('09:30'), true);
});

test('legacy reservations keep their saved duration when rescheduled and cannot overlap blocks', async t => {
  const db = database(t);
  const date = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  const old = booking(date, '10:00', 'first');
  await Service.createBooking(db, old);
  const env = { BOOKING_DB: db, BOOKING_DAYS_AHEAD: '60', ADMIN_TOKEN: 'test-admin' };
  const reschedule = time => BookingApi.rescheduleBooking(new Request('https://example.test/api/admin/bookings/' + old.id, {
    method: 'PUT', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ date, time })
  }), env, old.id);
  const changed = await reschedule('11:00');
  assert.equal(changed.status, 200);
  const [display] = await Service.listBookings(db, date);
  assert.equal(display.startTime, '11:00');
  assert.equal(display.endTime, '11:30');
  assert.equal(display.durationMinutes, 30);
  assert.match(display.menuName, /初回/);
  await Service.createBlock(db, {
    id: 'afternoon', ...Service.parseBlockedPeriod(date, '13:00', '14:00'), note: '', createdAt: Service.isoLocal(new Date())
  });
  assert.equal((await reschedule('13:00')).status, 409);
  assert.equal((await Service.listBookings(db, date))[0].startTime, '11:00');
});

test('notification exceptions do not turn a saved reservation into an API error', async t => {
  const db = database(t);
  t.mock.method(LineNotifier, 'sendAndRecord', async () => { throw new Error('notification DB failed'); });
  mockTurnstile(t);
  const date = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  const body = {
    idempotencyKey: 'notification-exception-test', menu: 'followup_60', date, time: '10:00', name: 'テスト', phone: '09000000000', turnstileToken: 'test-turnstile-token'
  };
  const request = () => new Request('https://example.test/api/bookings', { method: 'POST', body: JSON.stringify(body) });
  const env = { BOOKING_DB: db, BOOKING_DAYS_AHEAD: '60', TURNSTILE_SECRET: 'test-turnstile-secret' };
  const response = await BookingApi.createBooking(request(), env);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).notificationStatus, 'failed');
  const [saved] = await Service.listBookings(db, date);
  assert.equal(saved.status, 'confirmed');
  await Service.cancelBooking(db, saved.id);
  const cancelledRetry = await BookingApi.createBooking(request(), env);
  assert.equal(cancelledRetry.status, 409);
  assert.match((await cancelledRetry.json()).error, /キャンセル済み/);
});

test('booking requires a Turnstile secret before writing to the database', async t => {
  const db = database(t);
  let databaseReads = 0;
  const guardedDb = { prepare() { databaseReads += 1; throw new Error('Database must not be touched'); } };
  const date = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  const request = new Request('https://example.test/api/bookings', {
    method: 'POST', body: JSON.stringify({
      idempotencyKey: 'turnstile-secret-missing', menu: 'followup_60', date, time: '10:00',
      name: 'テスト', phone: '09000000000', turnstileToken: 'test-turnstile-token'
    })
  });

  const response = await BookingApi.createBooking(request, { BOOKING_DB: guardedDb });
  assert.equal(response.status, 503);
  assert.equal(databaseReads, 0);
  assert.match((await response.json()).error, /認証設定/);
  assert.equal(await Service.listBookings(db, date).then(rows => rows.length), 0);
});

test('booking rejects a failed Turnstile verification without saving it', async t => {
  const db = database(t);
  mockTurnstile(t, { success: false, hostname: 'example.test', 'error-codes': ['invalid-input-response'] });
  const date = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  const request = new Request('https://example.test/api/bookings', {
    method: 'POST', body: JSON.stringify({
      idempotencyKey: 'turnstile-rejected-token', menu: 'followup_60', date, time: '10:00',
      name: 'テスト', phone: '09000000000', turnstileToken: 'invalid-token'
    })
  });

  const response = await BookingApi.createBooking(request, { BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret' });
  assert.equal(response.status, 403);
  assert.equal((await Service.listBookings(db, date)).length, 0);
});

test('menu and start validation reject inherited keys and invalid treatment lengths', () => {
  for (const code of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => Service.parseMenu(code), /メニュー/);
    assert.throws(() => Service.parseBookableMenu(code), /メニュー/);
  }
  for (const duration of [undefined, NaN, -30, 0]) {
    assert.throws(() => Service.parseStart('2099-10-04', '10:00', duration), /施術時間/);
  }
  assert.throws(() => Service.parseCalendarDate('2026-02-30'), /予約日/);
});
