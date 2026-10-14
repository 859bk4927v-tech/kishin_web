import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BookingService as Service } from '../src/booking_service.js';
import { BookingApi } from '../src/booking_api.js';
import { LineNotifier } from '../src/line_notifier.js';
import { PatientLineNotifier } from '../src/patient_line_notifier.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
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

function lineBookingInput() {
  const date = Array.from({ length: 7 }, (_, i) => Service.addDays(Service.todayJst(), i + 1))
    .find(value => new Date(`${value}T00:00:00Z`).getUTCDay() !== 5);
  return {
    idempotencyKey: 'line-booking-test-key', menu: 'followup_60', date, time: '10:00',
    name: 'LINE予約テスト', phone: '09000000000', email: '', website: '',
    turnstileToken: 'test-turnstile-token', lineIdToken: 'test.header.signature'
  };
}

const lineRequest = body => new Request('https://example.test/api/bookings', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

function mockBookingVerification(t, identityResponse) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return Response.json({ success: true, hostname: 'example.test' });
    }
    assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(new URLSearchParams(options.body).get('client_id'), '2011966873');
    return identityResponse();
  });
}

function patientNotificationFlow(t, options = {}) {
  const db = database(t);
  const userId = 'U' + 'a'.repeat(32);
  const ownerId = 'U' + 'b'.repeat(32);
  const pushes = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return Response.json({ success: true, hostname: 'example.test' });
    }
    if (url === 'https://api.line.me/oauth2/v2.1/verify') {
      return Response.json({ iss: 'https://access.line.me', aud: '2011966873', sub: userId,
        iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (url !== 'https://api.line.me/v2/bot/message/push') throw new Error('Unexpected external request');
    const payload = JSON.parse(request.body);
    const rows = await db.prepare('SELECT * FROM bookings WHERE status = ?').bind('confirmed').all();
    pushes.push({ payload, headers: request.headers, savedBookings: rows.results });
    if (payload.to === userId && options.patientThrows) throw new Error('Sensitive network details');
    return new Response(null, { status: payload.to === userId
      ? options.patientStatus || 200 : options.ownerStatus || 200 });
  });
  return {
    db, userId, ownerId, pushes,
    env: { BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret', LINE_MINIAPP_CHANNEL_ID: '2011966873',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-line-secret', LINE_OWNER_USER_ID: ownerId }
  };
}

test('new verified booking notifies owner and saved patient after persistence, while repeats and conflicts send nothing', async t => {
  const f = patientNotificationFlow(t);
  const input = { ...lineBookingInput(), lineUserId: 'U' + 'f'.repeat(32) };
  const response = await BookingApi.createBooking(lineRequest(input), f.env);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.notificationStatus, 'sent');
  assert.equal(receipt.patientLineNotificationStatus, 'sent');
  assert.deepEqual(f.pushes.map(push => push.payload.to), [f.ownerId, f.userId]);
  assert.ok(f.pushes.every(push => push.savedBookings.length === 1));
  const patientPush = f.pushes[1];
  const saved = patientPush.savedBookings[0];
  assert.equal(saved.line_user_id, f.userId);
  assert.equal(saved.patient_line_retry_key, patientPush.headers['X-Line-Retry-Key']);
  assert.match(patientPush.payload.messages[0].text, new RegExp(saved.booking_number));
  assert.match(patientPush.payload.messages[0].text, /10:00/);
  assert.equal(JSON.stringify(receipt).includes(f.userId), false);
  assert.equal(JSON.stringify(receipt).includes(input.lineIdToken), false);
  const repeated = await BookingApi.createBooking(lineRequest(input), f.env);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).patientLineNotificationStatus, 'sent');
  assert.equal((await BookingApi.createBooking(lineRequest({ ...input, idempotencyKey: 'conflicting-booking-key' }), f.env)).status, 409);
  await Service.cancelBooking(f.db, saved.id);
  assert.equal((await BookingApi.createBooking(lineRequest(input), f.env)).status, 409);
  assert.equal(f.pushes.length, 2);
});

for (const options of [{ patientThrows: true }, { patientStatus: 500 }, { patientStatus: 400 }]) {
  test(`patient notification failure ${JSON.stringify(options)} preserves confirmation and does not resend on booking retry`, async t => {
    const f = patientNotificationFlow(t, options);
    const input = lineBookingInput();
    const response = await BookingApi.createBooking(lineRequest(input), f.env);
    assert.equal(response.status, 201);
    const receipt = await response.json();
    const expected = options.patientStatus === 400 ? 'rejected' : 'failed';
    assert.equal(receipt.ok, true);
    assert.equal(receipt.notificationStatus, 'sent');
    assert.equal(receipt.patientLineNotificationStatus, expected);
    assert.equal(JSON.stringify(receipt).includes('Sensitive'), false);
    const saved = await f.db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').bind(input.idempotencyKey).first();
    assert.equal(saved.status, 'confirmed');
    assert.equal(saved.notification_status, 'sent');
    assert.equal(saved.patient_line_notification_status, expected);
    const repeat = await BookingApi.createBooking(lineRequest(input), f.env);
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).patientLineNotificationStatus, expected);
    assert.equal(f.pushes.length, 2);
  });
}

test('patient notification proceeds when owner notification unexpectedly throws', async t => {
  const f = patientNotificationFlow(t);
  t.mock.method(LineNotifier, 'sendAndRecord', async () => { throw new Error('Owner notifier unavailable'); });
  const response = await BookingApi.createBooking(lineRequest(lineBookingInput()), f.env);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.notificationStatus, 'failed');
  assert.equal(receipt.patientLineNotificationStatus, 'sent');
  assert.deepEqual(f.pushes.map(push => push.payload.to), [f.userId]);
});

test('an unexpected patient notifier exception cannot turn a saved booking into an error', async t => {
  const f = patientNotificationFlow(t);
  t.mock.method(PatientLineNotifier, 'sendAndRecord', async () => { throw new Error('Patient notifier unavailable'); });
  const input = lineBookingInput();
  const response = await BookingApi.createBooking(lineRequest(input), f.env);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.notificationStatus, 'sent');
  assert.equal(receipt.patientLineNotificationStatus, 'failed');
  assert.deepEqual(f.pushes.map(push => push.payload.to), [f.ownerId]);
  const row = await f.db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').bind(input.idempotencyKey).first();
  assert.equal(row.status, 'confirmed');
});

test('ordinary web bookings notify only the owner and never invoke the patient notifier', async t => {
  const f = patientNotificationFlow(t);
  const notifier = t.mock.method(PatientLineNotifier, 'sendAndRecord', async () => { throw new Error('Must not call'); });
  const input = { ...lineBookingInput(), lineUserId: f.userId };
  delete input.lineIdToken;
  const response = await BookingApi.createBooking(lineRequest(input), f.env);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.notificationStatus, 'sent');
  assert.equal(receipt.patientLineNotificationStatus, 'skipped');
  const repeated = await BookingApi.createBooking(lineRequest(input), f.env);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).patientLineNotificationStatus, 'skipped');
  assert.equal(notifier.mock.callCount(), 0);
  assert.deepEqual(f.pushes.map(push => push.payload.to), [f.ownerId]);
});

test('verified LINE bookings store only the trusted user ID, retry once and retain identity when rescheduled', async t => {
  const db = database(t);
  const input = { ...lineBookingInput(), lineUserId: 'U' + 'f'.repeat(32) };
  const userId = 'U' + 'a'.repeat(32);
  mockBookingVerification(t, () => Response.json({
    iss: 'https://access.line.me', aud: '2011966873', sub: userId,
    iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600
  }));
  let notifications = 0;
  t.mock.method(LineNotifier, 'sendAndRecord', async () => { notifications++; return { status: 'sent' }; });
  const env = { BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret', LINE_MINIAPP_CHANNEL_ID: '2011966873' };
  const response = await BookingApi.createBooking(lineRequest(input), env);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(JSON.stringify(receipt).includes(userId), false);
  assert.equal(JSON.stringify(receipt).includes(input.lineIdToken), false);
  let row = await db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').bind(input.idempotencyKey).first();
  assert.equal(row.line_user_id, userId);
  assert.equal(JSON.stringify(row).includes(input.lineIdToken), false);
  assert.equal((await BookingApi.createBooking(lineRequest(input), env)).status, 200);
  assert.equal(notifications, 1);
  assert.equal((await Service.listBookings(db, input.date)).length, 1);
  const { startAt, endAt } = Service.parseStart(input.date, '13:00', 60);
  await Service.rescheduleBooking(db, row.id, startAt, endAt);
  assert.equal((await Service.findBooking(db, row.id)).line_user_id, userId);
  await Service.cancelBooking(db, row.id);
  assert.equal((await Service.findBooking(db, row.id)).line_user_id, userId);
});

test('unverified client user IDs cannot associate an ordinary web booking with LINE', async t => {
  const db = database(t);
  mockTurnstile(t);
  const input = { ...lineBookingInput(), lineUserId: 'U' + 'f'.repeat(32) };
  delete input.lineIdToken;
  const response = await BookingApi.createBooking(lineRequest(input), { BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret' });
  assert.equal(response.status, 201);
  const row = await db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').bind(input.idempotencyKey).first();
  assert.equal(row.line_user_id, '');
});

test('failed LINE verification and unavailable LINE cannot access the booking database or send notifications', async t => {
  const input = lineBookingInput();
  let databaseCalls = 0;
  const guardedDb = { prepare() { databaseCalls++; throw new Error('Database must not be touched'); } };
  t.mock.method(LineNotifier, 'sendAndRecord', () => { throw new Error('Must not notify'); });
  const patientNotifier = t.mock.method(PatientLineNotifier, 'sendAndRecord', () => { throw new Error('Must not notify'); });
  for (const status of [400, 429, 500]) {
    mockBookingVerification(t, () => Response.json({ error_description: input.lineIdToken }, { status }));
    const response = await BookingApi.createBooking(lineRequest(input), {
      BOOKING_DB: guardedDb, TURNSTILE_SECRET: 'test-turnstile-secret', LINE_MINIAPP_CHANNEL_ID: '2011966873'
    });
    assert.equal(response.status, status === 400 ? 401 : 503);
    assert.equal((await response.text()).includes(input.lineIdToken), false);
  }
  assert.equal(databaseCalls, 0);
  assert.equal(patientNotifier.mock.callCount(), 0);
});

test('missing LINE configuration rejects LINE bookings before any database access', async t => {
  mockTurnstile(t);
  const response = await BookingApi.createBooking(lineRequest(lineBookingInput()), {
    BOOKING_DB: { prepare() { throw new Error('Database must not be touched'); } }, TURNSTILE_SECRET: 'test-turnstile-secret'
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /本人確認設定/);
});

test('a booking retry cannot replace its saved LINE user or return its receipt to another identity', async t => {
  const db = database(t);
  const input = lineBookingInput();
  let userId = 'U' + 'a'.repeat(32);
  const originalUser = userId;
  mockBookingVerification(t, () => Response.json({
    iss: 'https://access.line.me', aud: '2011966873', sub: userId,
    iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600
  }));
  let notifications = 0;
  t.mock.method(LineNotifier, 'sendAndRecord', async () => { notifications++; return { status: 'sent' }; });
  const env = { BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret', LINE_MINIAPP_CHANNEL_ID: '2011966873' };
  assert.equal((await BookingApi.createBooking(lineRequest(input), env)).status, 201);
  userId = 'U' + 'b'.repeat(32);
  const wrongUser = await BookingApi.createBooking(lineRequest(input), env);
  assert.equal(wrongUser.status, 409);
  assert.equal((await wrongUser.text()).includes(input.name), false);
  delete input.lineIdToken;
  assert.equal((await BookingApi.createBooking(lineRequest(input), env)).status, 409);
  const row = await db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?').bind(input.idempotencyKey).first();
  assert.equal(row.line_user_id, originalUser);
  assert.equal(notifications, 1);
  assert.equal((await Service.listBookings(db, input.date)).length, 1);
});

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

test('same-day availability starts three hours ahead, rounds to slots, and leaves tomorrow unchanged', async t => {
  const db = database(t);
  let now = Date.parse('2026-10-14T14:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Service, 'todayJst', () => '2026-10-14');
  for (const menu of ['first_visit', 'followup_60', 'followup_90']) {
    const response = await BookingApi.getAvailability(new URL(`https://example.test/api/availability?date=2026-10-14&menu=${menu}`), { BOOKING_DB: db });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).slots[0], '17:00');
  }
  now += 1;
  assert.equal((await Service.getAvailableSlots(db, '2026-10-14', 'first_visit'))[0], '17:30');
  now = Date.parse('2026-10-14T22:00:00+09:00');
  assert.deepEqual(await Service.getAvailableSlots(db, '2026-10-14', 'followup_60'), []);
  assert.equal((await Service.getAvailableSlots(db, '2026-10-15', 'first_visit'))[0], '09:00');
  // The decision uses Japan's date, even while UTC is still on the previous day.
  now = Date.parse('2026-10-15T08:00:00+09:00');
  assert.equal((await Service.getAvailableSlots(db, '2026-10-15', 'first_visit'))[0], '11:00');
});

test('public booking rejects short notice, accepts the boundary, and safely replays a saved booking after cutoff', async t => {
  const db = database(t);
  let now = Date.parse('2026-10-14T14:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Service, 'todayJst', () => '2026-10-14');
  mockTurnstile(t);
  let notifications = 0;
  t.mock.method(LineNotifier, 'sendAndRecord', async () => { notifications++; return { status: 'sent' }; });
  const input = { ...lineBookingInput(), date: '2026-10-14', time: '16:30', lineIdToken: undefined };
  const env = { BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret', ADMIN_TOKEN: 'test-admin' };
  const denied = await BookingApi.createBooking(lineRequest(input), env);
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /3時間.*電話.*LINE/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM bookings').bind().first()).total, 0);
  assert.equal(notifications, 0);
  input.time = '17:00';
  const accepted = await BookingApi.createBooking(lineRequest(input), env);
  assert.equal(accepted.status, 201);
  const receipt = await accepted.json();
  now += 60_000;
  const repeated = await BookingApi.createBooking(lineRequest(input), env);
  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).booking, receipt.booking);
  assert.equal(notifications, 1);
  assert.equal((await BookingApi.createBooking(lineRequest({ ...input, idempotencyKey: 'another-short-notice-request' }), env)).status, 400);
  const saved = await Service.findBookingByRequestKey(db, input.idempotencyKey);
  const changed = await BookingApi.rescheduleBooking(new Request('https://example.test/api/admin/bookings/' + saved.id, {
    method: 'PUT', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: input.date, time: '15:00' })
  }), env, saved.id);
  assert.equal(changed.status, 200);
  assert.equal((await Service.findBooking(db, saved.id)).start_at, '2026-10-14T15:00:00+09:00');
  const block = await BookingApi.createAdminBlock(new Request('https://example.test/api/admin/blocks', {
    method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: input.date, startTime: '14:30', endTime: '15:00' })
  }), env);
  assert.equal(block.status, 201);
});

test('booking reevaluates short notice after external verification before writing or notifying', async t => {
  const db = database(t);
  let now = Date.parse('2026-10-14T13:59:59+09:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Service, 'todayJst', () => '2026-10-14');
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    now = Date.parse('2026-10-14T14:00:01+09:00');
    return Response.json({ success: true, hostname: 'example.test' });
  });
  const response = await BookingApi.createBooking(lineRequest({ ...lineBookingInput(), date: '2026-10-14', time: '17:00', lineIdToken: undefined }), {
    BOOKING_DB: db, TURNSTILE_SECRET: 'test-turnstile-secret'
  });
  assert.equal(response.status, 400);
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM bookings').bind().first()).total, 0);
});

test('contact-only slots expose free short-notice times without exposing occupied or past times, in one read', async t => {
  const db = database(t);
  let now = Date.parse('2026-10-14T14:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Service, 'todayJst', () => '2026-10-14');
  let reads = 0;
  const tracked = { prepare(sql) { reads++; return db.prepare(sql); } };
  let response = await BookingApi.getAvailability(new URL('https://example.test/api/availability?date=2026-10-14&menu=first_visit'), { BOOKING_DB: tracked });
  let result = await response.json();
  assert.equal(reads, 1);
  assert.deepEqual(result.contactSlots, ['14:30','15:00','15:30','16:00','16:30']);
  assert.equal(result.slots[0], '17:00');
  now = Date.parse('2026-10-14T14:29:00+09:00');
  response = await BookingApi.getAvailability(new URL('https://example.test/api/availability?date=2026-10-14&menu=first_visit'), { BOOKING_DB: db });
  result = await response.json();
  assert.equal(result.contactSlots.at(-1), '17:00');
  assert.equal(result.slots[0], '17:30');
  await Service.createBlock(db, { id: 'contact-window-block', ...Service.parseBlockedPeriod('2026-10-14','14:30','15:00'), note: '', createdAt: Service.isoLocal(new Date()) });
  await Service.createBooking(db, booking('2026-10-14','15:30','followup_60'));
  result = await Service.getSlotAvailability(db, '2026-10-14', 'first_visit');
  for (const time of ['14:00','14:30','15:00','15:30','16:00','16:30']) assert.equal(result.contactSlots.includes(time), false);
  assert.equal(result.contactSlots.includes('17:00'), true);
  assert.deepEqual((await Service.getSlotAvailability(db,'2026-10-15','first_visit')).contactSlots, []);
});
