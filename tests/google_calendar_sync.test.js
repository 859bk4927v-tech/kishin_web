import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { GoogleCalendarSync as Sync } from '../src/google_calendar_sync.js';
import { BookingService } from '../src/booking_service.js';
import worker from '../src/worker.js';
import { GoogleCalendarImport } from '../src/google_calendar_import.js';

function database(t, latest = true) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql') && (latest || n < '0007')).sort()) {
    sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind: (...values) => ({ first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }), run: async () => statement.run(...values) }) };
  }};
}
function add(db, kind = 'patient', id = 'local-test') {
  db.sqlite.prepare(`INSERT INTO blocked_periods(id,start_at,end_at,note,created_at,block_type,customer_name,phone,menu)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id,'2030-01-01T23:00:00+09:00','2030-01-02T00:00:00+09:00',
    '非公開のメモ','2030-01-01',kind,kind === 'patient' ? 'テスト患者' : '', '09012345678',kind === 'patient' ? 'followup_60' : '');
}
const envFor = db => ({ BOOKING_DB: db, GOOGLE_CALENDAR_ID: 'calendar@example.test', GOOGLE_SERVICE_ACCOUNT_JSON: 'configured-for-mock' });
const state = db => db.sqlite.prepare('SELECT * FROM google_calendar_sync').get();
function mockGoogle(t, db, handler) {
  t.mock.method(Sync, 'accessToken', async () => 'test-only-google-token');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer test-only-google-token');
    assert.equal(options.redirect, 'manual');
    calls.push({ url, ...options });
    return handler(url, options, calls);
  });
  return calls;
}
const eventResponse = (extra = {}) => Response.json({ id: 'id', etag: 'test-etag',
  extendedProperties: { private: { kishinSource: 'block:local-test' } }, ...extra });

test('migration preserves records, seeds only future active appointments, and adds no patient payload to queue', async t => {
  const db = database(t, false);
  add(db);
  db.sqlite.prepare("INSERT INTO blocked_periods(id,start_at,end_at,note,created_at) VALUES('past','2000-01-01','2000-01-02','original','2000')").run();
  const old = db.sqlite.prepare('SELECT * FROM blocked_periods ORDER BY id').all();
  db.sqlite.exec(fs.readFileSync(new URL('../migrations/0007_add_google_calendar_sync.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM blocked_periods ORDER BY id').all(), old);
  assert.equal(state(db).source_id, 'local-test');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM google_calendar_sync').get().count, 1);
  assert(!JSON.stringify(state(db)).includes('テスト患者'));
  db.sqlite.prepare("UPDATE blocked_periods SET phone='08012345678' WHERE id='local-test'").run();
  assert.equal(state(db).version, 1);
  db.sqlite.prepare("UPDATE blocked_periods SET start_at='2030-01-01T22:00:00+09:00' WHERE id='local-test'").run();
  assert.equal(state(db).version, 2);
  db.sqlite.prepare("DELETE FROM blocked_periods WHERE id='local-test'").run();
  assert.equal(state(db).version, 3);
  assert.equal(state(db).pending, 1);
});

test('booking creation, replay, rescheduling and cancellation update one durable queue entry', async t => {
  const db = database(t);
  const booking = { id: 'booking-test', bookingNumber: 'B1', idempotencyKey: 'unique',
    startAt: '2030-01-01T09:00:00+09:00', endAt: '2030-01-01T10:00:00+09:00', menu: 'followup_60',
    name: '患者', phone: '09012345678', email: '', createdAt: '2026-01-01' };
  assert.equal((await BookingService.createBooking(db, booking)).created, true);
  assert.equal(state(db).version, 1);
  assert.equal((await BookingService.createBooking(db, booking)).created, false);
  assert.equal(state(db).version, 1);
  await BookingService.rescheduleBooking(db, booking.id, '2030-01-01T11:00:00+09:00', '2030-01-01T12:00:00+09:00');
  assert.equal(state(db).version, 2);
  await BookingService.cancelBooking(db, booking.id);
  assert.equal(state(db).version, 3);
});

test('missing configuration performs no DB or network operations', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not call'); });
  assert.equal((await Sync.run({})).status, 'not_configured');
  assert.equal((await Sync.run({GOOGLE_SERVICE_ACCOUNT_JSON: {}, GOOGLE_CALENDAR_ID: 123})).status, 'not_configured');
});

test('a rolled back appointment also rolls back its queued synchronization', async t => {
  const db=database(t);
  db.sqlite.exec('BEGIN');add(db);db.sqlite.exec('ROLLBACK');
  assert.equal(state(db),undefined);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM blocked_periods').get().count,0);
});

test('a large backfill stays bounded and leaves remaining appointments for subsequent runs', async t => {
  const db=database(t);
  for(let i=0;i<10;i++) add(db,'patient','backfill-'+i);
  mockGoogle(t,db,(_,options) => options.method==='GET' ? new Response('',{status:404}) : Response.json({}));
  assert.equal((await Sync.run(envFor(db),100)).processed,5);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM google_calendar_sync WHERE pending=1').get().count,5);
});

test('public bookings reflect saved course times, rescheduling and cancellation in Google', async t => {
  const db = database(t);
  const booking = {id:'public',bookingNumber:'public',idempotencyKey:'public',startAt:'2030-01-01T09:00:00+09:00',
    endAt:'2030-01-01T10:20:00+09:00',menu:'first_visit',name:'予約確認',phone:'09012345678',email:'private@example.test',createdAt:'2026-01-01'};
  await BookingService.createBooking(db,booking);
  let remote;
  const calls = mockGoogle(t,db,(_,options) => {
    if (options.method === 'GET') return remote ? Response.json({...remote,etag:'version'}) : new Response('',{status:404});
    remote=options.body ? JSON.parse(options.body) : undefined;
    return Response.json({});
  });
  await Sync.run(envFor(db));
  assert.equal(remote.end.dateTime,booking.endAt);
  assert(remote.summary.includes('予約確認')); assert(remote.summary.includes('初診'));
  assert(!JSON.stringify(remote).includes('private@example.test'));
  await BookingService.rescheduleBooking(db,'public','2030-01-01T11:00:00+09:00','2030-01-01T12:20:00+09:00');
  await Sync.run(envFor(db));
  assert.equal(remote.start.dateTime,'2030-01-01T11:00:00+09:00');
  await BookingService.cancelBooking(db,'public');
  await Sync.run(envFor(db));
  assert.equal(calls.at(-1).method,'DELETE');
  assert.equal(state(db).pending,0);
});

test('two concurrent workers cannot send the same leased item simultaneously', async t => {
  const db=database(t); add(db);
  let release;
  let enter;
  const entered=new Promise(resolve => {enter=resolve;});
  const paused=new Promise(resolve => {release=resolve;});
  const calls=mockGoogle(t,db,async (_,options) => {
    if(options.method==='GET') {enter();await paused;return new Response('',{status:404});}
    return Response.json({});
  });
  const first=Sync.run(envFor(db),1);
  await entered;
  await Sync.run(envFor(db),1);
  assert.equal(calls.length,1);
  release();await first;
  assert.equal(calls.length,2);assert.equal(state(db).pending,0);
});

test('creates deterministic private events with exact dates and no contact details or notes', async t => {
  const db = database(t); add(db);
  const calls = mockGoogle(t, db, (_, options) => options.method === 'GET' ? new Response('', { status: 404 }) : Response.json({}));
  await Sync.run(envFor(db));
  assert.equal(state(db).pending, 0);
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].body);
  assert.match(payload.id, /^[0-9a-v]{65}$/);
  assert.equal(payload.id, await Sync.eventId({ source_type: 'block', source_id: 'local-test' }));
  assert(payload.summary.includes('テスト患者'));
  assert.equal(payload.end.dateTime, '2030-01-02T00:00:00+09:00');
  assert.equal(payload.visibility, 'private');
  assert(!calls[1].body.includes('09012345678'));
  assert(!calls[1].body.includes('非公開のメモ'));
  assert.equal(payload.attendees, undefined);
  await Sync.run(envFor(db));
  assert.equal(calls.length, 2);
});

test('private appointments expose only the private title and times', async t => {
  const db = database(t); add(db, 'private');
  const calls = mockGoogle(t, db, (_, options) => options.method === 'GET' ? new Response('', { status: 404 }) : Response.json({}));
  await Sync.run(envFor(db));
  assert.equal(JSON.parse(calls[1].body).summary, '私用');
});

test('updates use the existing event and etag instead of duplicating it', async t => {
  const db = database(t); add(db);
  const calls = mockGoogle(t, db, () => eventResponse());
  await Sync.run(envFor(db));
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].headers['If-Match'], 'test-etag');
  assert.equal(state(db).pending, 0);
});

test('deleted admin patient appointments are removed using durable tombstones', async t => {
  const db = database(t); add(db);
  await BookingService.deleteBlock(db, 'local-test');
  const calls = mockGoogle(t, db, () => eventResponse());
  await Sync.run(envFor(db));
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(state(db).pending, 0);
});

test('missing or already cancelled Google events make deletion idempotent', async t => {
  const db = database(t); add(db);
  await BookingService.deleteBlock(db, 'local-test');
  const calls = mockGoogle(t, db, () => eventResponse({ status: 'cancelled', extendedProperties: undefined }));
  await Sync.run(envFor(db));
  assert.equal(calls.length, 1);
  assert.equal(state(db).pending, 0);
});

for (const code of [401, 403, 409, 412, 429, 500]) {
  test(`Google HTTP ${code} leaves confirmed data intact and schedules a safe retry`, async t => {
    const db = database(t); add(db);
    const calls = mockGoogle(t, db, (_, options) => options.method === 'GET' ? new Response('', { status: 404 }) : new Response('sensitive-upstream-body', { status: code }));
    await Sync.run(envFor(db));
    assert.equal(state(db).pending, 1);
    assert.equal(state(db).lease_until, 0);
    assert(state(db).next_attempt_at > Date.now());
    assert.equal(state(db).last_error, `Google予定反映 HTTP ${code}`);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM blocked_periods').get().count, 1);
    await Sync.run(envFor(db));
    assert.equal(calls.length, 2);
    db.sqlite.exec('UPDATE google_calendar_sync SET next_attempt_at=0');
    t.mock.method(globalThis, 'fetch', async (_, options) => options.method === 'GET' ? eventResponse() : Response.json({}));
    await Sync.run(envFor(db));
    assert.equal(state(db).pending, 0);
  });
}

test('a timeout after Google accepts a creation reuses the event ID and recovers without a duplicate', async t => {
  const db = database(t); add(db);
  const calls = mockGoogle(t, db, (_, options) => {
    if (options.method === 'GET') return new Response('', { status: 404 });
    throw new Error('secret-key-and-network-details');
  });
  await Sync.run(envFor(db));
  const originalId = JSON.parse(calls[1].body).id;
  assert(!state(db).last_error.includes('secret-key'));
  assert.equal(state(db).last_error,'Googleカレンダーとの通信を完了できませんでした。（event-write/Error）');
  db.sqlite.exec('UPDATE google_calendar_sync SET next_attempt_at=0');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert(url.endsWith('/' + originalId));
    return options.method === 'GET' ? eventResponse() : Response.json({});
  });
  await Sync.run(envFor(db));
  assert.equal(state(db).pending, 0);
});

test('changes made during synchronization remain pending and converge to the newest booking state', async t => {
  const db = database(t); add(db);
  let changed = false;
  mockGoogle(t, db, (_, options) => {
    if (options.method === 'GET') return eventResponse();
    if (!changed) {
      changed = true;
      db.sqlite.exec("UPDATE blocked_periods SET customer_name='更新後の患者' WHERE id='local-test'");
    }
    return Response.json({});
  });
  await Sync.run(envFor(db), 1);
  assert.equal(state(db).pending, 1);
  assert.equal(state(db).version, 2);
  await Sync.run(envFor(db), 1);
  assert.equal(state(db).pending, 0);
});

test('unexpired leases prevent concurrent work; expired leases recover abandoned work', async t => {
  const db = database(t); add(db);
  db.sqlite.prepare("UPDATE google_calendar_sync SET lease_until=?,lease_token='abandoned'").run(Date.now()+120000);
  const calls = mockGoogle(t, db, (_, options) => options.method === 'GET' ? new Response('', { status: 404 }) : Response.json({}));
  await Sync.run(envFor(db)); assert.equal(calls.length, 0);
  db.sqlite.exec('UPDATE google_calendar_sync SET lease_until=0');
  await Sync.run(envFor(db)); assert.equal(state(db).pending, 0);
});

test('does not overwrite unrelated Google events or silently switch the destination calendar', async t => {
  const db = database(t); add(db);
  const calls = mockGoogle(t, db, () => Response.json({ extendedProperties: {} }));
  await Sync.run(envFor(db));
  assert.equal(calls.length, 1); assert.equal(state(db).pending, 1);
  db.sqlite.exec('UPDATE google_calendar_sync SET next_attempt_at=0');
  await Sync.run({ ...envFor(db), GOOGLE_CALENDAR_ID: 'different@example.test' });
  assert.equal(calls.length, 1);
  assert(state(db).last_error.includes('移行作業'));
});

test('a late result from an expired lease cannot leave a newer completed item falsely synced', async t => {
  const db = database(t); add(db);
  mockGoogle(t, db, (_, options) => {
    if (options.method === 'GET') return eventResponse();
    // Simulate a replacement worker completing while the original request is delayed.
    db.sqlite.exec("UPDATE google_calendar_sync SET lease_token='',lease_until=0,pending=0,version=version+1");
    return Response.json({});
  });
  await Sync.run(envFor(db),1);
  assert.equal(state(db).pending,1);
  assert.equal(state(db).version,3);
});

test('service account authentication signs the expected JWT and validates Google responses', async t => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
  const encoded = Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64');
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type:'service_account', client_email:'test@project.iam.gserviceaccount.com', private_key:`-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`, token_uri:'https://evil.test' }) };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.redirect, 'manual');
    const [header,claim,signature] = options.body.get('assertion').split('.');
    assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',keys.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(`${header}.${claim}`)),true);
    const data = JSON.parse(Buffer.from(claim,'base64url'));
    assert.equal(data.scope,'https://www.googleapis.com/auth/calendar.events');
    assert.equal(data.aud,url); assert.equal(data.exp-data.iat,3600); assert.equal(data.sub,undefined);
    return Response.json({ access_token:'local-token',token_type:'Bearer' });
  });
  assert.equal(await Sync.accessToken(env), 'local-token');
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {status:302,headers:{Location:'https://unexpected.example/'}}));
  await assert.rejects(() => Sync.accessToken(env), /^Error: Google認証 HTTP 302$/);
  t.mock.method(globalThis, 'fetch', async () => new Response('upstream-secret', {status:400}));
  await assert.rejects(() => Sync.accessToken(env), /^Error: Google認証 HTTP 400$/);
  await assert.rejects(() => Sync.accessToken({ GOOGLE_SERVICE_ACCOUNT_JSON:'broken' }), /JSON設定/);
});

test('Google event redirects remain pending and never follow the redirect target', async t => {
  const db=database(t); add(db);
  const calls=mockGoogle(t,db,() => new Response(null,{status:302,headers:{Location:'https://unexpected.example/'}}));
  await Sync.run(envFor(db),1);
  assert.equal(calls.length,1);
  assert.equal(state(db).pending,1);
  assert.equal(state(db).last_error,'Google予定取得 HTTP 302');
});

test('Google permission failures retain only allowlisted reason codes, never upstream details', async t => {
  const db=database(t); add(db);
  mockGoogle(t,db,(_,options) => options.method==='GET' ? new Response(null,{status:404}) :
    Response.json({error:{message:'private appointment or key',errors:[{reason:'requiredAccessLevel',message:'private details'}]}},{status:403}));
  await Sync.run(envFor(db),1);
  assert.equal(state(db).last_error,'Google予定反映 HTTP 403 [requiredAccessLevel]');
  assert.equal(state(db).pending,1);
  const error=await Sync.apiError('Google予定反映',Response.json({error:{errors:[{reason:'private details'}]}},{status:403}));
  assert.equal(error.message,'Google予定反映 HTTP 403');
});

test('status and manual retries require admin authentication and reveal no patient data', async t => {
  const db = database(t); add(db);
  const env = { ...envFor(db), ADMIN_TOKEN:'test-only-admin' };
  for (const method of ['GET','POST']) {
    assert.equal((await worker.fetch(new Request('https://example.test/api/admin/calendar-sync',{method}),env,{})).status,401);
  }
  const response = await worker.fetch(new Request('https://example.test/api/admin/calendar-sync',{headers:{Authorization:'Bearer test-only-admin'}}),env,{});
  const data = await response.json();
  assert.deepEqual(data,{configured:true,pending:1,synced:0,failed:0,import:{syncedAt:'',error:'',inProgress:false,count:0}});
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const missing = await worker.fetch(new Request('https://example.test/api/admin/calendar-sync',{method:'POST',headers:{Authorization:'Bearer test-only-admin'}}),{...env,GOOGLE_CALENDAR_ID:''},{});
  assert.equal(missing.status,503);
});

test('worker isolates sync failures from successful API responses and cron retries pending work', async t => {
  const db = database(t);
  const env = { ...envFor(db), ADMIN_TOKEN:'test-only-admin' };
  const jobs = [];
  let runs=0;
  let imports=0;
  t.mock.method(GoogleCalendarImport,'run',async () => {imports++;return {status:'failed'};});
  t.mock.method(Sync,'run',async () => {runs++;return {status:'failed'};});
  // Use a fixed open day so the actual API write succeeds independent of the clock.
  t.mock.method(BookingService,'todayJst',() => '2030-01-01');
  const request2 = new Request('https://example.test/api/admin/blocks',{method:'POST',headers:{Authorization:'Bearer test-only-admin'},body:JSON.stringify({date:'2030-01-01',startTime:'23:00',endTime:'23:30',blockType:'private'})});
  const response = await worker.fetch(request2,env,{waitUntil: job => jobs.push(job)});
  assert.equal(response.status,201);
  await Promise.all(jobs); assert.equal(runs,1); assert.equal(state(db).pending,1);
  worker.scheduled({},env,{waitUntil: job => jobs.push(job)});
  await Promise.all(jobs); assert.equal(runs,2);
  assert.equal(imports,1);
});
