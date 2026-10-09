import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const reservationSource = fs.readFileSync(new URL('../public/js/reservation_page.js', import.meta.url), 'utf8');
const receiptSource = fs.readFileSync(new URL('../public/js/reservation_complete_page.js', import.meta.url), 'utf8');
const helperSources = ['weekly_calendar.js', 'api_client.js', 'booking_receipt.js']
  .map(file => fs.readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8'));

function loadHelpers(sandbox) {
  helperSources.forEach(source => vm.runInContext(source, sandbox));
}

test('successful submission stores the receipt and opens the completion page', async () => {
  const saved = new Map();
  let destination = '';
  const booking = {
    bookingNumber: 'YOM-20261006-ABCD', customerName: '予約テスト', date: '2026-10-06',
    startTime: '10:00', endTime: '11:20', menuName: '初診:カウンセリング20分+施術60分'
  };
  const sandbox = vm.createContext({
    document: { getElementById: () => null },
    window: {
      sessionStorage: { setItem: (key, value) => saved.set(key, value) },
      location: { replace: value => { destination = value; } }
    },
    fetch: async () => ({ ok: true, json: async () => ({ bookingNumber: booking.bookingNumber, booking, notificationStatus: 'sent' }) }),
    appJa: { text: key => key }, JSON, Headers
  });
  loadHelpers(sandbox);
  vm.runInContext(`${reservationSource}\nthis.Page = ReservationPage;`, sandbox);
  const page = Object.create(sandbox.Page.prototype);
  page.form = { reportValidity: () => true };
  page.date = { value: booking.date };
  page.time = { value: booking.startTime };
  page.submitButton = { disabled: false, textContent: '' };
  page.createBookingRequest = () => ({ menu: 'first_visit' });
  page.resetForm = () => { throw new Error('should navigate before clearing the form'); };
  page.loadConfig = () => { throw new Error('should navigate before reloading'); };
  await page.submit({ preventDefault() {} });
  assert.equal(destination, 'reservation_complete_page.html');
  assert.deepEqual(JSON.parse(saved.get('yomon.bookingReceipt')), { ...booking, notificationStatus: 'sent' });
});

test('completion page displays saved details without putting them in the URL', () => {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: id === 'bookingReceipt' });
    return nodes.get(id);
  } };
  const booking = {
    bookingNumber: 'YOM-20261006-ABCD', customerName: '<予約テスト>', date: '2026-10-06',
    startTime: '10:00', endTime: '11:20', menuName: '初診 : カウンセリング20分+施術60分',
    notificationStatus: 'sent'
  };
  const sandbox = vm.createContext({ document, window: { sessionStorage: { getItem: () => JSON.stringify(booking) } }, JSON });
  loadHelpers(sandbox);
  vm.runInContext(receiptSource, sandbox);
  assert.equal(nodes.get('receiptNumber').textContent, booking.bookingNumber);
  assert.equal(nodes.get('receiptName').textContent, booking.customerName);
  assert.equal(nodes.get('receiptDateTime').textContent, '2026年10月6日(火) 10 : 00~11 : 20');
  assert.equal(nodes.get('receiptMenu').textContent, booking.menuName);
  assert.equal(nodes.get('bookingReceipt').hidden, false);
  assert.equal(nodes.get('receiptMissing').hidden, true);
});

test('completion page does not claim success without saved booking data', () => {
  const document = { getElementById() { throw new Error('no receipt should be rendered'); } };
  const sandbox = vm.createContext({ document, window: { sessionStorage: { getItem: () => null } }, JSON });
  loadHelpers(sandbox);
  vm.runInContext(receiptSource, sandbox);
});

test('receipt ignores impossible dates and handles disabled browser storage', () => {
  const sandbox = vm.createContext({
    window: { sessionStorage: { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); } } }
  });
  loadHelpers(sandbox);
  vm.runInContext('this.Receipt = BookingReceipt;', sandbox);
  const booking = { bookingNumber: 'YOM-TEST', customerName: 'テスト', date: '2026-02-30', startTime: '10:00', endTime: '11:00', menuName: '施術60分' };
  assert.equal(sandbox.Receipt.isValid(booking), false);
  assert.equal(sandbox.Receipt.read(), null);
  booking.date = '2026-02-28';
  assert.equal(sandbox.Receipt.save({ booking, notificationStatus: 'sent' }), false);
});
