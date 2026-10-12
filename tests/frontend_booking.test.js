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

test('LINE booking waits for identity, includes the token only in the POST body and prevents double submission', async () => {
  let resolveIdentity;
  let requests = 0;
  let requestBody;
  const sandbox = context(async (path, options) => {
    requests++;
    assert.equal(path, '/api/bookings');
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ booking: {
      bookingNumber: 'YOM-LINE', customerName: 'テスト', date: '2099-01-02', startTime: '10:00', endTime: '11:20', menuName: '初診'
    }, notificationStatus: 'sent' }) };
  });
  let receipt;
  let destination;
  sandbox.window = {
    getLineIdTokenForBooking: () => new Promise(resolve => { resolveIdentity = resolve; }),
    sessionStorage: { setItem(key, value) { receipt = value; } },
    location: { replace(value) { destination = value; } }
  };
  load(sandbox, 'weekly_calendar.js', 'api_client.js', 'booking_receipt.js', 'reservation_page.js');
  const page = vm.runInContext('Object.create(ReservationPage.prototype)', sandbox);
  Object.assign(page, {
    form: { reportValidity: () => true }, date: { value: '2099-01-02' }, time: { value: '10:00' },
    submitButton: {}, createBookingRequest: () => ({ menu: 'first_visit', turnstileToken: 'turnstile-test' })
  });
  const pending = page.submit({ preventDefault() {} });
  await page.submit({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.equal(page.form.inert, true);
  resolveIdentity('test.header.signature');
  await pending;
  assert.equal(requests, 1);
  assert.deepEqual(requestBody, { menu: 'first_visit', turnstileToken: 'turnstile-test', lineIdToken: 'test.header.signature' });
  assert.equal(receipt.includes('test.header.signature'), false);
  assert.equal(destination, 'reservation_complete_page');
});

test('failed LINE identity does not submit a reservation and restores the form', async () => {
  let requests = 0;
  const sandbox = context(async () => { requests++; });
  sandbox.window.getLineIdTokenForBooking = async () => { throw new Error('LINEの予約画面を開き直してください。'); };
  load(sandbox, 'weekly_calendar.js', 'api_client.js', 'booking_receipt.js', 'reservation_page.js');
  const page = vm.runInContext('Object.create(ReservationPage.prototype)', sandbox);
  let notice;
  Object.assign(page, {
    form: { reportValidity: () => true }, date: { value: '2099-01-02' }, time: { value: '10:00' },
    submitButton: {}, notice: { scrollIntoView() {} }, showNotice(message) { notice = message; }
  });
  await page.submit({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.match(notice, /LINEの予約画面/);
  assert.equal(page.form.inert, false);
  assert.equal(page.submitButton.disabled, false);
});

test('LIFF identity helper waits for initialization, retrieves a fresh token and skips ordinary browsers', async () => {
  let resolveInit;
  let token = 'first.header.signature';
  const sandbox = context(() => {});
  sandbox.window.liff = {
    isInClient: () => true, isLoggedIn: () => true,
    init: ({ liffId }) => {
      // The browser's LIFF app and the server's token audience must be deployed together.
      const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
      assert.match(liffId, /^\d+-[A-Za-z0-9]+$/);
      assert.equal(liffId.split('-')[0], config.vars.LINE_MINIAPP_CHANNEL_ID);
      return new Promise(resolve => { resolveInit = resolve; });
    }, getIDToken: () => token
  };
  load(sandbox, 'line_miniapp.js');
  const pending = vm.runInContext('getLineIdTokenForBooking()', sandbox);
  resolveInit();
  assert.equal(await pending, token);
  token = 'second.header.signature';
  assert.equal(await vm.runInContext('getLineIdTokenForBooking()', sandbox), token);
  sandbox.window.liff.isInClient = () => false;
  assert.equal(await vm.runInContext('getLineIdTokenForBooking()', sandbox), '');
  sandbox.window.liff.isInClient = () => true;
  token = null;
  await assert.rejects(vm.runInContext('getLineIdTokenForBooking()', sandbox), /本人確認/);
});
