import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { GoogleCalendarImport as Import } from '../src/google_calendar_import.js';
import { GoogleCalendarSync as Export } from '../src/google_calendar_sync.js';
import { BookingService as Service } from '../src/booking_service.js';
import { BookingApi } from '../src/booking_api.js';
import worker from '../src/worker.js';

const calendar='clinic@example.test', date='2030-01-01';
function database(t) {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())
    sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  t.mock.method(Service,'todayJst',()=>date);
  t.mock.method(Date,'now',()=>Date.parse(date+'T08:00:00+09:00'));
  return {sqlite, prepare(sql) {
    const statement=sqlite.prepare(sql);
    return {bind(...values) { return {
      first:async()=>statement.get(...values)||null,
      all:async()=>({results:statement.all(...values)}),
      run:async()=>statement.run(...values)
    };}};
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try {const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}
    catch(e){sqlite.exec('ROLLBACK');throw e;}
  }};
}
const envFor=db=>({BOOKING_DB:db,GOOGLE_CALENDAR_ID:calendar,GOOGLE_SERVICE_ACCOUNT_JSON:'mock',BOOKING_DAYS_AHEAD:'60',ADMIN_TOKEN:'test-admin'});
const event=(id='g1',start='12:00',end='13:00')=>({id,status:'confirmed',summary:'非公開の用事',start:{dateTime:`${date}T${start}:00+09:00`},end:{dateTime:`${date}T${end}:00+09:00`}});
const page=(items=[],next)=>Response.json({kind:'calendar#events',items,...(next?{nextPageToken:next}:{})});
const rows=db=>db.sqlite.prepare('SELECT * FROM google_calendar_busy ORDER BY event_id').all();
function mock(t,handler) {
  t.mock.method(Export,'accessToken',async()=> 'test-token');
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const u=new URL(url);assert.equal(u.hostname,'www.googleapis.com');
    assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer test-token');
    assert.equal(u.searchParams.get('singleEvents'),'true');assert.equal(u.searchParams.get('timeZone'),'Asia/Tokyo');
    return handler(u);
  });
}
function booking(start='14:00') {
  const id=crypto.randomUUID();return {id,bookingNumber:id,idempotencyKey:id,...Service.parseStart(date,start,60),
    menu:'followup_60',name:'患者',phone:'09000000000',email:'',createdAt:date+'T08:00:00+09:00'};
}

test('imports Google busy periods without creating bookings, notifications or export jobs; repeats are idempotent',async t=>{
  const db=database(t);mock(t,()=>page([event()]));
  assert.equal((await Import.run(envFor(db))).status,'complete');
  assert.equal((await Import.run(envFor(db))).status,'complete');assert.equal(rows(db).length,1);
  for(const table of ['bookings','blocked_periods','google_calendar_sync'])assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.equal((await Import.status(envFor(db))).count,1);
});

test('Google dates normalize to JST, all-day end is exclusive, seconds round conservatively',async()=>{
  const timed=await Import.period({...event(),start:{dateTime:'2030-01-01T03:00:00.123Z'},end:{dateTime:'2030-01-01T04:00:00.123Z'}});
  assert.equal(timed.start,date+'T12:00:00+09:00');assert.equal(timed.end,date+'T13:00:01+09:00');
  const all=await Import.period({...event(),start:{date:date},end:{date:'2030-01-03'}});
  assert.equal(all.start,date+'T00:00:00+09:00');assert.equal(all.end,'2030-01-03T00:00:00+09:00');
  await assert.rejects(()=>Import.period({...event(),start:{dateTime:'2030-01-01T12:00:00'}}));
});

test('ignores free, cancelled, declined and informational events and excludes only matching exported event IDs',async()=>{
  for(const change of [{status:'cancelled'},{transparency:'transparent'},{attendees:[{self:true,responseStatus:'declined'}]},{eventType:'workingLocation'},{eventType:'birthday'}])
    assert.equal(await Import.period({...event(),...change}),null);
  const id=await Export.eventId({source_type:'booking',source_id:'source'});
  const own={...event(id),extendedProperties:{private:{kishinSource:'booking:source'}}};
  assert.equal(await Import.period(own),null);
  assert.ok(await Import.period({...own,id:'copied-event'}));
});

test('Google changes, deletions, free-time changes and cancelled recurrence instances replace the snapshot',async t=>{
  const db=database(t);let events=[event(),event('recurrence_20300101','15:00','16:00')];mock(t,()=>page(events));
  await Import.run(envFor(db));assert.equal(rows(db).length,2);
  events=[event('g1','13:00','14:00'),{id:'recurrence_20300101',status:'cancelled'}];
  await Import.run(envFor(db));assert.equal(rows(db).length,1);assert.equal(rows(db)[0].start_at,date+'T13:00:00+09:00');
  events=[{...event(),transparency:'transparent'}];await Import.run(envFor(db));assert.equal(rows(db).length,0);
  events=[event()];await Import.run(envFor(db));events=[];await Import.run(envFor(db));assert.equal(rows(db).length,0);
});

test('multi-page import resumes across invocations and never exposes a partial snapshot',async t=>{
  const db=database(t);mock(t,()=>page([event('old')]));await Import.run(envFor(db));
  const seen=[];mock(t,u=>{const token=u.searchParams.get('pageToken');seen.push(token);
    return token==='b'?page([], 'c'):token==='c'?page([event('new2')]):page([event('new1')],'b');});
  assert.equal((await Import.run(envFor(db))).status,'pending');assert.equal(rows(db)[0].event_id,'old');
  assert.equal((await Import.run(envFor(db))).status,'complete');assert.deepEqual(rows(db).map(r=>r.event_id),['new1','new2']);
  assert.deepEqual(seen,[null,'b','c']);
});

test('network, malformed event and page failures retain previous busy periods and do not leak response contents',async t=>{
  const db=database(t);mock(t,()=>page([event('old')]));await Import.run(envFor(db));
  mock(t,()=>new Response('private server response',{status:403}));
  assert.equal((await Import.run(envFor(db))).status,'failed');assert.equal(rows(db)[0].event_id,'old');
  assert.equal((await Import.status(envFor(db))).error,'Google予定取込: HTTP 403');
  mock(t,()=>page([{...event(),end:{dateTime:'invalid'}}]));await Import.run(envFor(db));assert.equal(rows(db)[0].event_id,'old');
  mock(t,()=>Response.json({error:'secret'}));await Import.run(envFor(db));assert.equal(rows(db)[0].event_id,'old');
  mock(t,()=>page([event('new')]));await Import.run(envFor(db));assert.equal(rows(db)[0].event_id,'new');
});

test('snapshot publication rolls back on DB failure and can be retried',async t=>{
  const db=database(t);mock(t,()=>page([event('old')]));await Import.run(envFor(db));
  db.sqlite.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON google_calendar_busy WHEN NEW.event_id='new' BEGIN SELECT RAISE(ABORT,'failure'); END;");
  mock(t,()=>page([event('new')]));await Import.run(envFor(db));assert.equal(rows(db)[0].event_id,'old');
  db.sqlite.exec('DROP TRIGGER simulate_failure');await Import.run(envFor(db));assert.equal(rows(db)[0].event_id,'new');
});

test('overlapping import runs are leased and an expired old run cannot publish over a newer snapshot',async t=>{
  const db=database(t);let release,entered;
  const waiting=new Promise(r=>entered=r), gate=new Promise(r=>release=r);let calls=0;
  mock(t,async()=>{calls++;if(calls===1){entered();await gate;return page([event('old')]);}return page([event('new')]);});
  const first=Import.run(envFor(db));await waiting;
  assert.equal((await Import.run(envFor(db))).status,'busy');assert.equal(calls,1);
  db.sqlite.exec("UPDATE google_calendar_import SET lease_until=0,started_at=0");
  await Import.run(envFor(db));release();await first;assert.deepEqual(rows(db).map(r=>r.event_id),['new']);
});

test('expired pagination restarts and an empty successful Google response releases deleted slots',async t=>{
  const db=database(t);mock(t,()=>page([event('old')]));await Import.run(envFor(db));
  mock(t,()=>new Response(null,{status:410}));await Import.run(envFor(db));
  assert.equal(db.sqlite.prepare('SELECT run_id FROM google_calendar_import').get().run_id,'');
  mock(t,()=>Response.json({kind:'calendar#events'}));await Import.run(envFor(db));assert.equal(rows(db).length,0);
});

test('a superseded worker cannot clear a replacement worker staging the same import run',async t=>{
  const db=database(t);let release,entered,calls=0;
  const waiting=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  mock(t,async u=>{calls++;if(calls===1){entered();await gate;return page([event('old')]);}
    const token=u.searchParams.get('pageToken');return token==='b'?page([event('new2')],'c'):token==='c'?page([event('new3')]):page([event('new1')],'b');});
  const first=Import.run(envFor(db));await waiting;db.sqlite.exec('UPDATE google_calendar_import SET lease_until=0');
  assert.equal((await Import.run(envFor(db))).status,'pending');release();assert.equal((await first).status,'superseded');
  assert.equal((await Import.run(envFor(db))).status,'complete');assert.deepEqual(rows(db).map(r=>r.event_id),['new1','new2','new3']);
});

test('availability and atomic writes reject Google overlaps while exact boundaries stay bookable',async t=>{
  const db=database(t);mock(t,()=>page([event()]));
  const initial=await Service.getAvailableSlots(db,date,'followup_60');assert(initial.includes('12:00'));
  await Import.run(envFor(db));
  const slots=await Service.getAvailableSlots(db,date,'followup_60');assert(!slots.includes('12:00'));assert(slots.includes('11:00'));assert(slots.includes('13:00'));
  assert.equal((await Service.createBooking(db,booking('12:00'))).row,null);
  const stored=await Service.createBooking(db,booking('15:00'));assert(stored.created);
  assert.equal(await Service.rescheduleBooking(db,stored.row.id,date+'T12:00:00+09:00',date+'T13:00:00+09:00'),null);
  for(const blockType of ['private','patient'])assert.equal(await Service.createBlock(db,{id:crypto.randomUUID(),startAt:date+'T12:00:00+09:00',endAt:date+'T13:00:00+09:00',createdAt:date,note:'',blockType,menu:blockType==='patient'?'followup_60':''}),null);
  assert.equal((await Service.createBooking(db,booking('13:00'))).created,true);
});

test('an imported overlap never cancels or edits an existing clinic booking',async t=>{
  const db=database(t);const saved=await Service.createBooking(db,booking('12:00'));
  const before=db.sqlite.prepare('SELECT * FROM bookings').get();mock(t,()=>page([event()]));await Import.run(envFor(db));
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM bookings').get(),before);assert.equal(saved.row.status,'confirmed');
});

test('all-day and multi-day Google events show each day in admin with read-only titles; public API exposes only slots',async t=>{
  const db=database(t);mock(t,()=>page([{...event(),start:{date:date},end:{date:'2030-01-03'}}]));await Import.run(envFor(db));
  const blocks=await Service.listBlocks(db,'2030-01-02');assert.equal(blocks.length,1);assert.equal(blocks[0].date,'2030-01-02');
  assert.equal(blocks[0].startTime,'00:00');assert.equal(blocks[0].endTime,'24:00');assert.equal(blocks[0].blockType,'google');assert.equal(blocks[0].readOnly,true);
  assert.deepEqual(await Service.getAvailableSlots(db,'2030-01-02','followup_60'),[]);
  assert.equal((await Service.listBlocks(db,'2030-01-03')).length,0);
  const r=await BookingApi.handle(new Request(`https://example.test/api/availability?date=${date}&menu=followup_60`),envFor(db));
  assert.equal(r.status,200);assert(!(await r.text()).includes('非公開'));
  const deleted=await BookingApi.handle(new Request('https://example.test/api/admin/blocks/'+encodeURIComponent(blocks[0].id),{method:'DELETE',headers:{Authorization:'Bearer test-admin'}}),envFor(db));
  assert.notEqual(deleted.status,200);assert.equal(rows(db).length,1);
});

test('admin manual synchronization queues import and export while unauthenticated requests queue neither',async t=>{
  const db=database(t);let imports=0,exports=0;
  t.mock.method(Import,'run',async()=>{imports++;});t.mock.method(Export,'run',async()=>{exports++;});
  const jobs=[];const ctx={waitUntil:p=>jobs.push(p)};
  const endpoint='https://example.test/api/admin/calendar-sync';
  assert.equal((await worker.fetch(new Request(endpoint,{method:'POST'}),envFor(db),ctx)).status,401);
  assert.equal(imports,0);assert.equal(exports,0);
  assert.equal((await worker.fetch(new Request(endpoint,{method:'POST',headers:{Authorization:'Bearer test-admin'}}),envFor(db),ctx)).status,202);
  await Promise.all(jobs);assert.equal(imports,1);assert.equal(exports,1);
});
