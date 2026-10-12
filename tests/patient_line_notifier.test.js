import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PatientLineNotifier } from '../src/patient_line_notifier.js';

const userId = 'U' + 'a'.repeat(32);
const env = { LINE_CHANNEL_ACCESS_TOKEN: 'test-secret', LINE_OWNER_USER_ID: 'U' + 'b'.repeat(32) };

function fixture(t, { linkedUser = userId, status = 'confirmed' } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const name of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  sqlite.prepare(`INSERT INTO bookings (
    id, booking_number, idempotency_key, start_at, end_at, menu, customer_name, phone,
    status, notification_status, line_retry_key, created_at, updated_at, line_user_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'booking-1', 'YOM-TEST-1', 'request-1', '2099-01-01T14:00:00+09:00', '2099-01-01T15:20:00+09:00',
    'first_visit', '予約テスト', '09000000000', status, 'sent', 'owner-retry-key',
    '2098-12-31T12:00:00+09:00', '2098-12-31T13:00:00+09:00', linkedUser
  );
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind: (...params) => ({
      first: async () => statement.get(...params) || null,
      run: async () => statement.run(...params)
    }) };
  } };
  return {
    db, sqlite,
    row: () => sqlite.prepare('SELECT * FROM bookings WHERE id = ?').get('booking-1'),
    send: (settings = env) => PatientLineNotifier.sendAndRecord(db, 'booking-1', settings)
  };
}

test('patient notification uses the verified saved recipient and preserves owner notification and booking fields', async t => {
  const f = fixture(t);
  const before = f.row();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.match(options.headers['X-Line-Retry-Key'], /^[0-9a-f-]{36}$/);
    assert.equal(f.row().patient_line_retry_key, options.headers['X-Line-Retry-Key']);
    assert.equal(f.row().patient_line_payload, options.body);
    const payload = JSON.parse(options.body);
    assert.equal(payload.to, userId);
    assert.equal(payload.messages.length, 1);
    const message = payload.messages[0].text;
    assert.match(message, /ご予約ありがとうございます/);
    assert.match(message, /2099年01月01日.*14:00/);
    assert.match(message, /カウンセリング20分\+施術60分/);
    assert.match(message, /YOM-TEST-1/);
    assert.equal(message.includes(before.phone), false);
    assert.equal(message.includes(before.customer_name), false);
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(await f.send(), { status: 'sent', error: '' });
  const after = f.row();
  for (const [key, value] of Object.entries(before)) {
    if (!key.startsWith('patient_line_')) assert.equal(after[key], value, key);
  }
  assert.equal(JSON.stringify(after).includes(env.LINE_CHANNEL_ACCESS_TOKEN), false);
});

for (const [label, options, expected] of [
  ['ordinary web booking', { linkedUser: '' }, 'skipped'],
  ['cancelled booking', { status: 'cancelled' }, 'failed'],
  ['invalid saved user', { linkedUser: 'invalid' }, 'failed']
]) {
  test(`${label} cannot send a patient notification`, async t => {
    const f = fixture(t, options);
    const before = f.row();
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not send'); });
    assert.equal((await f.send()).status, expected);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(f.row(), before);
  });
}

test('missing booking cannot send', async t => {
  const f = fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not send'); });
  assert.equal((await PatientLineNotifier.sendAndRecord(f.db, 'missing', env)).status, 'failed');
  assert.equal(fetch.mock.callCount(), 0);
});

test('missing token records only patient configuration status and can recover after configuration', async t => {
  const f = fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  assert.equal((await f.send({})).status, 'not_configured');
  assert.equal(f.row().patient_line_retry_key, '');
  assert.equal(f.row().notification_status, 'sent');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await f.send()).status, 'sent');
});

test('accepted notification is not sent again', async t => {
  const f = fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  assert.equal((await f.send()).status, 'sent');
  assert.equal((await f.send()).status, 'sent');
  assert.equal(fetch.mock.callCount(), 1);
});

test('uncertain delivery reuses the original key and body even if the booking was rescheduled', async t => {
  const f = fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) throw new Error('Network failure with sensitive details');
    return new Response(null, { status: 409, headers: { 'x-line-accepted-request-id': 'already-accepted' } });
  });
  assert.deepEqual(await f.send(), { status: 'failed', error: 'LINE APIに接続できませんでした。' });
  assert.equal(f.row().status, 'confirmed');
  f.sqlite.prepare('UPDATE bookings SET start_at = ?, end_at = ? WHERE id = ?')
    .run('2099-01-02T10:00:00+09:00', '2099-01-02T11:20:00+09:00', 'booking-1');
  assert.equal((await f.send()).status, 'sent');
  assert.equal(requests[0].headers['X-Line-Retry-Key'], requests[1].headers['X-Line-Retry-Key']);
  assert.equal(requests[0].body, requests[1].body);
});

for (const status of [400, 401, 409, 429, 500]) {
  test(`HTTP ${status} does not falsely record successful delivery or expose LINE error bodies`, async t => {
    const f = fixture(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('sensitive response', { status }));
    const expected = status < 500 ? 'rejected' : 'failed';
    assert.deepEqual(await f.send(), { status: expected, error: `LINE API returned HTTP ${status}` });
    assert.equal(f.row().status, 'confirmed');
    if (expected === 'rejected') {
      assert.equal((await f.send()).status, 'rejected');
      assert.equal(fetch.mock.callCount(), 1);
    }
  });
}

test('expired or invalid retry metadata never generates a fresh key or sends again', async t => {
  const f = fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('uncertain'); });
  await f.send();
  const key = f.row().patient_line_retry_key;
  for (const createdAt of [new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), '', 'invalid']) {
    f.sqlite.prepare('UPDATE bookings SET patient_line_retry_created_at = ? WHERE id = ?').run(createdAt, 'booking-1');
    assert.equal((await f.send()).status, 'failed');
    assert.equal(f.row().patient_line_retry_key, key);
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test('concurrent sends share one retry key and body and a late error cannot overwrite acceptance', async t => {
  const f = fixture(t);
  let releaseFirst;
  let firstReached;
  const firstReady = new Promise(resolve => { firstReached = resolve; });
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) {
      firstReached();
      return firstResponse;
    }
    return new Response(null, { status: 200 });
  });
  const first = f.send();
  await firstReady;
  assert.equal((await f.send()).status, 'sent');
  releaseFirst(new Response(null, { status: 500 }));
  assert.equal((await first).status, 'sent');
  assert.equal(requests[0].headers['X-Line-Retry-Key'], requests[1].headers['X-Line-Retry-Key']);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(f.row().patient_line_notification_status, 'sent');
});

test('simultaneous first sends atomically reserve one key and payload', async t => {
  const f = fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(options);
    return new Response(null, { status: 200 });
  });
  const results = await Promise.all([f.send(), f.send(), f.send()]);
  assert.ok(results.every(result => result.status === 'sent'));
  assert.ok(requests.length >= 1);
  assert.equal(new Set(requests.map(request => request.headers['X-Line-Retry-Key'])).size, 1);
  assert.equal(new Set(requests.map(request => request.body)).size, 1);
});

test('failure to record API acceptance retains a safe retry key and the confirmed booking', async t => {
  const f = fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(options);
    return requests.length === 1
      ? new Response(null, { status: 200 })
      : new Response(null, { status: 409, headers: { 'x-line-accepted-request-id': 'accepted' } });
  });
  const originalPrepare = f.db.prepare;
  let failOnce = true;
  t.mock.method(f.db, 'prepare', sql => {
    if (failOnce && sql.startsWith('UPDATE bookings SET patient_line_notification_status = ?')) {
      failOnce = false;
      throw new Error('Database temporarily unavailable');
    }
    return originalPrepare(sql);
  });
  assert.equal((await f.send()).status, 'failed');
  assert.equal(f.row().status, 'confirmed');
  assert.equal(f.row().patient_line_notification_status, 'pending');
  assert.equal((await f.send()).status, 'sent');
  assert.equal(requests[0].headers['X-Line-Retry-Key'], requests[1].headers['X-Line-Retry-Key']);
  assert.equal(requests[0].body, requests[1].body);
});

test('database failures are returned as notification failures without throwing or sending', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not send'); });
  const db = { prepare() { throw new Error('sensitive database error'); } };
  const result = await PatientLineNotifier.sendAndRecord(db, 'booking-1', env);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.includes('sensitive'), false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('patient notification migration preserves every existing booking field', t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const name of ['0001_create_bookings.sql', '0002_create_blocked_periods.sql', '0003_add_booking_line_user_id.sql']) {
    sqlite.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const status of ['confirmed', 'cancelled']) {
    sqlite.prepare(`INSERT INTO bookings (id, booking_number, idempotency_key, start_at, end_at, menu,
      customer_name, phone, status, notification_status, line_retry_key, created_at, updated_at, line_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      status, status, status, '2099-01-01T10:00:00+09:00', '2099-01-01T11:00:00+09:00',
      'followup_60', '既存予約', '09000000000', status, 'sent', 'owner-key', 'saved-created', 'saved-updated', userId
    );
  }
  const before = sqlite.prepare('SELECT * FROM bookings ORDER BY id').all();
  sqlite.exec(fs.readFileSync(new URL('../migrations/0004_add_patient_line_notification.sql', import.meta.url), 'utf8'));
  const after = sqlite.prepare('SELECT * FROM bookings ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, index) => {
    assert.equal(row.patient_line_notification_status, 'not_requested');
    for (const key of Object.keys(row).filter(key => key.startsWith('patient_line_'))) {
      if (key !== 'patient_line_notification_status') assert.equal(row[key], '');
      delete row[key];
    }
    assert.deepEqual(row, before[index]);
  });
});
