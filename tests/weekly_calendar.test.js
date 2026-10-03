import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BookingApi } from '../src/booking_api.js';
import { BOOKING_SCHEDULE } from '../src/booking_service.js';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/js/weekly_calendar.js', import.meta.url), 'utf8') + '\nthis.Calendar = WeeklyCalendar;', context);
const Calendar = context.Calendar;

test('weekly dates cross month/year boundaries and leap days without local timezone drift', () => {
  assert.equal(Calendar.addDays('2026-12-29', 6), '2027-01-04');
  assert.equal(Calendar.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(Calendar.addDays('2028-03-01', -1), '2028-02-29');
  assert.deepEqual(Array.from(Calendar.dates('2026-10-02')), ['2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07','2026-10-08']);
  assert.equal(Calendar.weekday('2026-10-04'), 0);
});

test('public config exposes the same schedule used by the booking service', async () => {
  const config = await BookingApi.getConfig({ BOOKING_DAYS_AHEAD: '60' }).json();
  assert.deepEqual(config.schedule, BOOKING_SCHEDULE);
  assert.equal(config.maxDate, Calendar.addDays(config.minDate, 60));
  const starts = Array.from(Calendar.times(config.schedule));
  assert.equal(starts[0], '10:00');
  assert.equal(starts.at(-1), '18:00');
  assert.equal(starts.length, 17);
  const occupiedTimes = Array.from(Calendar.times(config.schedule, true));
  assert.equal(occupiedTimes.at(-1), '18:30');
  assert.equal(occupiedTimes.length, 18);
});

test('weekly admin reads remain protected by authentication', async () => {
  const date = '2026-10-05';
  let read = false;
  const response = await BookingApi.handle(new Request(`https://example.test/api/admin/bookings?date=${date}`), {
    ADMIN_TOKEN: 'test-only-token', BOOKING_DB: { prepare() { read = true; throw new Error('Should not read'); } }
  });
  assert.equal(response.status, 401);
  assert.equal(read, false);
});

function reservationHarness(fetch) {
  const sandbox = vm.createContext({
    document: { getElementById: () => null }, window: {}, URLSearchParams, Date, Map, Set, fetch,
    appJa: { text: key => key }
  });
  vm.runInContext(fs.readFileSync(new URL('../public/js/weekly_calendar.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/js/reservation_page.js', import.meta.url), 'utf8') + '\nthis.Page = ReservationPage;', sandbox);
  const page = Object.create(sandbox.Page.prototype);
  Object.assign(page, {
    availabilityRequestId: 0, date: { value: '' }, time: { value: '' }, menu: { value: 'first' },
    calendarRetry: { hidden: true }, calendar: { setAttribute() {}, focus() {} }, slotMessage: { textContent: '' },
    config: { minDate: '2099-01-05', maxDate: '2099-03-06', closedWeekdays: [0] }, weekStart: '2099-01-05',
    clearSelection() { this.date.value = ''; this.time.value = ''; }, renderCalendar() {}
  });
  return page;
}

test('late availability responses cannot replace the newly selected week', async () => {
  const pending = [];
  const page = reservationHarness(url => new Promise(resolve => pending.push({ url, resolve })));
  const oldRequest = page.loadSlots();
  const oldCount = pending.length;
  page.weekStart = '2099-01-12';
  const newRequest = page.loadSlots();
  for (const request of pending.slice(oldCount)) request.resolve({ ok: true, json: async () => ({ slots: ['14:00'] }) });
  await newRequest;
  for (const request of pending.slice(0, oldCount)) request.resolve({ ok: true, json: async () => ({ slots: ['10:00'] }) });
  await oldRequest;
  assert.equal(page.available.has('2099-01-05'), false);
  assert.equal(page.available.get('2099-01-12').has('14:00'), true);
});

test('failed availability clears prior choices and exposes retry, not stale slots', async () => {
  const page = reservationHarness(async () => { throw new Error('offline'); });
  page.date.value = '2099-01-05'; page.time.value = '10:00';
  page.available = new Map([['2099-01-05', new Set(['10:00'])]]);
  await page.loadSlots();
  assert.equal(page.date.value, ''); assert.equal(page.time.value, '');
  assert.equal(page.available.size, 0); assert.equal(page.calendarRetry.hidden, false);
  assert.equal(page.slotMessage.textContent, 'offline');
});

test('a booking cannot be submitted without selecting a calendar slot', async () => {
  let requested = false;
  const page = reservationHarness(async () => { requested = true; });
  page.form = { reportValidity: () => true };
  let message;
  page.showNotice = value => { message = value; };
  await page.submit({ preventDefault() {} });
  assert.equal(requested, false);
  assert.match(message, /日時を選択/);
});
