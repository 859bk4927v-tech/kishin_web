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
  assert.deepEqual(Object.keys(config.menus), ['first_visit', 'followup_60', 'followup_90']);
  assert.deepEqual(Object.values(config.menus).map(({ duration, price }) => [duration, price]), [[80, 7000], [60, 6000], [90, 9000]]);
  assert.equal(config.maxDate, Calendar.addDays(config.minDate, 60));
  const starts = Array.from(Calendar.times(config.schedule));
  assert.equal(starts[0], '09:00');
  assert.deepEqual(config.closedWeekdays, [5]);
  assert.equal(starts.at(-1), '23:30');
  assert.equal(starts.length, 30);
  const occupiedTimes = Array.from(Calendar.times(config.schedule, true));
  assert.equal(occupiedTimes.at(-1), '23:30');
  assert.equal(occupiedTimes.length, 30);
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
    document: { getElementById: () => null }, window: {}, URLSearchParams, Date, Map, Set, Headers, fetch,
    appJa: { text: key => key }
  });
  vm.runInContext(fs.readFileSync(new URL('../public/js/weekly_calendar.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/js/api_client.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/js/reservation_page.js', import.meta.url), 'utf8') + '\nthis.Page = ReservationPage;', sandbox);
  const page = Object.create(sandbox.Page.prototype);
  Object.assign(page, {
    document: sandbox.document,
    availabilityRequestId: 0, date: { value: '' }, time: { value: '' }, menu: { value: 'first_visit' },
    calendarRetry: { hidden: true }, calendar: { setAttribute() {}, focus() {} }, slotMessage: { textContent: '' },
    config: { minDate: '2099-01-05', maxDate: '2099-03-06', closedWeekdays: [5], schedule: BOOKING_SCHEDULE, menus: { first_visit: { duration: 80 } } }, weekStart: '2099-01-05',
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
  assert.equal(page.slotMessage.textContent, 'booking.communicationError');
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


test('evening filter shows late slots and clears a now-hidden selection', () => {
  const page = reservationHarness(() => {});
  page.eveningOnly = { checked: true };
  page.available = new Map([['2099-01-05', new Set(['09:00'])]]);
  page.calendar.getAttribute = () => 'false';
  page.date.value = '2099-01-05'; page.time.value = '09:00';
  page.changeTimeFilter();
  assert.equal(page.time.value, '');
  assert.deepEqual(Array.from(page.visibleTimes()), ['18:00','18:30','19:00','19:30','20:00','20:30','21:00','21:30','22:00','22:30']);
  assert.match(page.slotMessage.textContent, /18:00以降に空きはありません/);
  page.available.get('2099-01-05').add('22:30');
  page.updateAvailabilityMessage();
  assert.equal(page.slotMessage.textContent, 'ご希望の日時をタップしてください。');
  page.eveningOnly.checked = false;
  assert.equal(page.visibleTimes().length, 28);
});

test('customer slots enforce the Japanese same-day cutoff and a stale selection cannot submit', async t => {
  let now = Date.parse('2026-10-14T14:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  let requests = 0;
  const page = reservationHarness(async () => { requests++; throw new Error('Should not submit'); });
  assert.equal(page.isSlotWithinBookingWindow('2026-10-14', '16:30'), false);
  assert.equal(page.isSlotWithinBookingWindow('2026-10-14', '17:00'), true);
  now += 1;
  assert.equal(page.isSlotWithinBookingWindow('2026-10-14', '17:00'), false);
  assert.equal(page.isSlotWithinBookingWindow('2026-10-14', '17:30'), true);
  assert.equal(page.isSlotWithinBookingWindow('2026-10-15', '09:00'), true);
  let reloads = 0;
  let notice = '';
  page.showNotice = message => { notice = message; };
  page.loadSlots = async () => { reloads++; page.clearSelection(); };
  page.date.value = '2026-10-14'; page.time.value = '17:00';
  page.form = { reportValidity: () => true };
  page.submitButton = {};
  await page.submit({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.equal(reloads, 1);
  assert.equal(page.time.value, '');
  assert.equal(notice, 'booking.sameDayNotice');
  assert.equal(page.form.inert, false);
  page.selectSlot({}, '2026-10-14', '17:00');
  assert.equal(reloads, 2);
  assert.equal(page.time.value, '');
  now = Date.parse('2026-10-15T08:00:00+09:00');
  assert.equal(page.isSlotWithinBookingWindow('2026-10-15', '10:30'), false);
  assert.equal(page.isSlotWithinBookingWindow('2026-10-15', '11:00'), true);
});

test('short-notice triangles open the contact dialog without selecting or submitting a reservation', t => {
  let now = Date.parse('2026-10-14T14:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  const elements = new Map();
  const element = () => ({ children: [], dataset: {}, attrs: {}, events: {},
    append(child) { this.children.push(child); }, setAttribute(key,value) { this.attrs[key] = value; },
    addEventListener(event,callback) { this.events[event] = callback; },
    replaceChildren(child) { this.children = [child]; } });
  const document = { createElement: element, getElementById(id) {
    if (id === 'bookingForm') return null;
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }};
  const sandbox = vm.createContext({document,window:{},Date,Map,Set,appJa:{text:key=>key}});
  vm.runInContext(fs.readFileSync(new URL('../public/js/weekly_calendar.js',import.meta.url),'utf8')+'\nthis.Calendar=WeeklyCalendar;',sandbox);
  vm.runInContext(fs.readFileSync(new URL('../public/js/reservation_page.js',import.meta.url),'utf8')+'\nthis.Page=ReservationPage;',sandbox);
  const cells = new Map();
  sandbox.Calendar.createTable = (doc,dates,times,title,render) => {
    cells.clear();
    for (const date of dates) for (const time of times) {
      const cell = element();render(cell,date,time);cells.set(date+' '+time,cell);
    }
    return element();
  };
  const page = Object.create(sandbox.Page.prototype);
  Object.assign(page,{document,calendar:element(),weekStart:'2026-10-14',menu:{value:'first_visit'},
    config:{minDate:'2026-10-14',maxDate:'2026-12-13',schedule:BOOKING_SCHEDULE,menus:{first_visit:{duration:80}}},
    available:new Map([['2026-10-14',new Set(['17:00','17:30'])]]),
    contactAvailable:new Map([['2026-10-14',new Set(['14:30','16:30'])]]),
    date:{value:''},time:{value:''}});
  const dialog = document.getElementById('bookingContactDialog');
  let opened = 0;
  dialog.showModal = () => { opened++;dialog.open=true; };
  const buttonAt = time => cells.get('2026-10-14 '+time).children[0];
  page.renderCalendar();
  assert.equal(buttonAt('14:30').textContent,'△');
  assert.equal(buttonAt('17:00').textContent,'○');
  assert.equal(cells.get('2026-10-14 15:00').textContent,'×');
  assert.equal(cells.get('2026-10-14 14:00').textContent,'×');
  buttonAt('14:30').events.click();
  assert.equal(opened,1);
  assert.equal(buttonAt('14:30').attrs['aria-haspopup'],'dialog');
  assert.match(document.getElementById('bookingContactDateTime').textContent,/14 : 30/);
  assert.equal(page.date.value,'');
  assert.equal(page.time.value,'');
  now = Date.parse('2026-10-14T14:29:00+09:00');
  page.renderCalendar();
  assert.equal(buttonAt('17:00').textContent,'△');
  assert.equal(buttonAt('17:30').textContent,'○');
  const html = fs.readFileSync(new URL('../public/page/customer_page/reservation_page.html',import.meta.url),'utf8');
  const modal = html.split('<dialog id="bookingContactDialog"')[1].split('</dialog>')[0];
  assert.match(modal,/method="dialog"/);
  assert.match(modal,/href="tel:07085738131"/);
  assert.match(modal,/href="https:\/\/line.me\/R\/ti\/p\/@725wajvz"/);
});

test('contact-only availability uses the same tap instruction and respects the evening filter', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-14T14:00:00+09:00'));
  const page = reservationHarness(() => {});
  page.available = new Map();
  page.contactAvailable = new Map([['2026-10-14', new Set(['16:30'])]]);
  page.updateAvailabilityMessage();
  assert.equal(page.slotMessage.textContent, 'ご希望の日時をタップしてください。');
  page.eveningOnly = {checked: true};
  page.updateAvailabilityMessage();
  assert.match(page.slotMessage.textContent, /18:00以降に空きはありません/);
});
