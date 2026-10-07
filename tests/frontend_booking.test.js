import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BOOKING_SCHEDULE } from '../src/booking_service.js';

function context(fetch, document = { getElementById: () => null }) {
  return vm.createContext({ document, fetch, Headers, URLSearchParams, window: {}, appJa: { text: () => '通信に失敗しました。' } });
}

function load(sandbox, ...files) {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8'), sandbox);
  }
}

test('JSON transport reports network failures in Japanese and keeps HTTP status for malformed errors', async () => {
  const sandbox = context(async () => { throw new TypeError('Failed to fetch'); });
  load(sandbox, 'api_client.js');
  await assert.rejects(vm.runInContext("ApiClient.request('/api/config')", sandbox), /通信に失敗/);
  sandbox.fetch = async () => ({ status: 401, ok: false, json: async () => { throw new Error('HTML response'); } });
  await assert.rejects(vm.runInContext("ApiClient.request('/api/admin/bookings')", sandbox), error => error.status === 401);
});

test('a late unauthorized response cannot log out a newer admin session', async () => {
  let finish;
  const sandbox = context(() => new Promise(resolve => { finish = resolve; }));
  load(sandbox, 'api_client.js', 'admin_page.js');
  const page = vm.runInContext('Object.create(AdminPage.prototype)', sandbox);
  Object.assign(page, { token: 'old-token', sessionVersion: 1 });
  let logouts = 0;
  page.logout = () => { logouts += 1; };
  const request = page.request('/api/admin/bookings');
  page.sessionVersion = 2;
  page.token = 'new-token';
  finish({ ok: false, status: 401, json: async () => ({ error: '古いトークンです。' }) });
  await assert.rejects(request, /セッションが変わりました/);
  assert.equal(logouts, 0);
  assert.equal(page.token, 'new-token');
});

test('reschedule form supports legacy menus missing from the public menu catalogue', () => {
  const document = {
    getElementById: () => null,
    createElement: type => ({ type, children: [], append(...children) { this.children.push(...children); }, addEventListener() {} })
  };
  const sandbox = context(() => {}, document);
  load(sandbox, 'weekly_calendar.js', 'admin_page.js');
  const page = vm.runInContext('Object.create(AdminPage.prototype)', sandbox);
  page.document = document;
  page.config = { schedule: BOOKING_SCHEDULE, menus: { first_visit: { duration: 80 } }, minDate: '2099-01-01', maxDate: '2099-03-01' };
  const card = { querySelector: () => null, append(form) { this.form = form; } };
  page.showReschedule(card, { menu: 'first', durationMinutes: 30, date: '2099-01-02', startTime: '10:00' });
  assert.equal(card.form.children.find(node => node.id === 'rescheduleTime').max, '23:30');
  page.showReschedule(card, { menu: 'first_visit', durationMinutes: 80, date: '2099-01-02', startTime: '10:00' });
  assert.equal(card.form.children.find(node => node.id === 'rescheduleTime').max, '22:30');
});

test('repeated submit events while saving send only one booking request', async () => {
  let finish;
  let requests = 0;
  let navigations = 0;
  const sandbox = context(() => { requests += 1; return new Promise(resolve => { finish = resolve; }); });
  sandbox.window = { sessionStorage: { setItem() {} }, location: { replace() { navigations += 1; } } };
  load(sandbox, 'weekly_calendar.js', 'api_client.js', 'booking_receipt.js', 'reservation_page.js');
  const page = vm.runInContext('Object.create(ReservationPage.prototype)', sandbox);
  Object.assign(page, {
    form: { reportValidity: () => true }, date: { value: '2099-01-02' }, time: { value: '10:00' },
    submitButton: {}, createBookingRequest: () => ({ menu: 'first_visit' })
  });
  const pending = page.submit({ preventDefault() {} });
  await page.submit({ preventDefault() {} });
  assert.equal(requests, 1);
  assert.equal(page.form.inert, true);
  finish({ ok: true, json: async () => ({ booking: {
    bookingNumber: 'YOM-TEST', customerName: 'テスト', date: '2099-01-02', startTime: '10:00', endTime: '11:20', menuName: '初診'
  }, notificationStatus: 'sent' }) });
  await pending;
  assert.equal(navigations, 1);
  assert.equal(page.form.inert, false);
});
