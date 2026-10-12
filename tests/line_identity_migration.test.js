import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('adding LINE identity preserves all existing booking fields and defaults existing users to unlinked', t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const name of ['0001_create_bookings.sql', '0002_create_blocked_periods.sql']) {
    sqlite.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  for (const status of ['confirmed', 'cancelled']) {
    sqlite.prepare(`INSERT INTO bookings (
      id, booking_number, idempotency_key, start_at, end_at, menu, customer_name, phone, email,
      status, notification_status, notification_error, line_retry_key, line_retry_created_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(status, status, status, '2099-01-01T10:00:00+09:00', '2099-01-01T11:20:00+09:00',
        'first_visit', '既存予約', '09000000000', 'existing@example.test', status, 'sent', '',
        'saved-retry-key', '2098-12-31T12:00:00+09:00', '2098-12-31T12:00:00+09:00', '2098-12-31T13:00:00+09:00');
  }
  const before = sqlite.prepare('SELECT * FROM bookings ORDER BY id').all();
  sqlite.exec(fs.readFileSync(new URL('../migrations/0003_add_booking_line_user_id.sql', import.meta.url), 'utf8'));
  const after = sqlite.prepare('SELECT * FROM bookings ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, index) => {
    assert.equal(row.line_user_id, '');
    delete row.line_user_id;
    assert.deepEqual(row, before[index]);
  });
});
