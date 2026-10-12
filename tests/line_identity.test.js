import test from 'node:test';
import assert from 'node:assert/strict';
import { LineIdentityVerifier as Verifier } from '../src/line_identity_verifier.js';

const channelId = '2011966873';
const token = 'test.header.signature';
const userId = 'U' + 'a'.repeat(32);
const claims = () => ({
  iss: 'https://access.line.me', aud: channelId, sub: userId,
  iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) + 3600
});

test('ordinary web bookings do not require LINE configuration or contact LINE', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not contact LINE'); });
  assert.equal(await Verifier.verify(undefined, undefined), '');
  assert.equal(await Verifier.verify('', undefined), '');
});

test('LINE verification posts the opaque token and configured channel ID, returning only the verified subject', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), { id_token: token, client_id: channelId });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ ...claims(), name: 'Not stored', email: 'not-stored@example.test' });
  });
  assert.equal(await Verifier.verify(token, channelId), userId);
  assert.equal(requests, 1);
});

test('malformed LINE tokens and missing or malformed channel configuration never contact LINE', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not contact LINE'); });
  for (const value of [null, 123, {}, [], ' ', 'invalid', 'a.b.c.d', 'a.b.' + 'c'.repeat(8192)]) {
    await assert.rejects(Verifier.verify(value, channelId), error => error.status === 400);
  }
  for (const value of [undefined, '', 2011966873, '2011966873-485aCSpu', 'not-a-channel']) {
    await assert.rejects(Verifier.verify(token, value), error => error.status === 503);
  }
});

for (const [label, patch] of [
  ['another channel', { aud: '2011966875' }],
  ['another issuer', { iss: 'https://attacker.example' }],
  ['expired token', { exp: 1 }],
  ['non-numeric expiry', { exp: '9999999999' }],
  ['future issue time', { iat: 9999999998, exp: 9999999999 }],
  ['missing issue time', { iat: undefined }],
  ['missing subject', { sub: undefined }],
  ['invalid subject', { sub: 'untrusted-user-id' }]
]) {
  test(`LINE verification rejects ${label}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ...claims(), ...patch }));
    await assert.rejects(Verifier.verify(token, channelId), error => error.status === 401);
  });
}

for (const status of [400, 401, 403, 429, 500]) {
  test(`LINE HTTP ${status} produces a controlled error without leaking the response`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error_description: token }, { status }));
    await assert.rejects(Verifier.verify(token, channelId), error => {
      assert.equal(error.status, status < 429 ? 401 : 503);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  });
}

test('LINE network errors, timeouts and malformed JSON fail closed without leaking details', async t => {
  for (const fetch of [
    async () => { throw new TypeError(token); },
    async () => { throw new DOMException(token, 'TimeoutError'); },
    async () => new Response('<html>not JSON</html>')
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', fetch);
    await assert.rejects(Verifier.verify(token, channelId), error => error.status === 503 && !error.message.includes(token));
    mock.mock.restore();
  }
});
