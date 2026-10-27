import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { GoogleCalendarWatch as Watch } from '../src/google_calendar_watch.js';
import { GoogleCalendarSync as Sync } from '../src/google_calendar_sync.js';
import { GoogleCalendarImport as Import } from '../src/google_calendar_import.js';
import worker from '../src/worker.js';
import { SiteSeo } from '../src/site_seo.js';

const origin='https://clinic.example.test', calendar='clinic@example.test';
function setup(t) {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())
    sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  const db={sqlite,prepare(sql) {
    const statement=sqlite.prepare(sql);
    return {bind(...values) {return {
      first:async()=>statement.get(...values)||null,
      all:async()=>({results:statement.all(...values)}),
      run:async()=>statement.run(...values)
    };}};
  },async batch(statements) {
    sqlite.exec('BEGIN');
    try {const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}
    catch(e){sqlite.exec('ROLLBACK');throw e;}
  }};
  const env={BOOKING_DB:db,GOOGLE_CALENDAR_ID:calendar,GOOGLE_SERVICE_ACCOUNT_JSON:'test',
    GOOGLE_CALENDAR_WEBHOOK_ENABLED:'true',SITE_URL:origin,ADMIN_TOKEN:'test-admin'};
  const jobs=[],ctx={waitUntil:p=>jobs.push(p)};
  t.mock.method(Sync,'accessToken',async()=> 'test-token');
  return {db,env,jobs,ctx};
}
const channels=db=>db.sqlite.prepare('SELECT * FROM google_calendar_watch_channel ORDER BY rowid').all();
const revision=db=>db.sqlite.prepare('SELECT requested_revision,completed_revision FROM google_calendar_import').get();
function request(channel,changes={}) {
  return new Request(origin+Watch.path,{method:'POST',headers:{
    'X-Goog-Channel-ID':channel.id,'X-Goog-Channel-Token':channel.token,
    'X-Goog-Resource-ID':'resource','X-Goog-Resource-State':'exists','X-Goog-Message-Number':'2',...changes
  }});
}
function mockWatch(t,callback=()=>{}) {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(String(url),`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events/watch`);
    assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');
    const channel=JSON.parse(options.body);calls.push(channel);await callback(channel);
    return Response.json({id:channel.id,resourceId:'resource',expiration:String(Date.now()+604800000)});
  });
  return calls;
}

test('watch creation stores only a token hash, renews ahead of expiry and keeps the previous channel valid',async t=>{
  const {db,env}=setup(t),calls=mockWatch(t);
  assert.equal((await Watch.ensure(env)).status,'active');assert.equal(calls.length,1);
  assert.equal(calls[0].address,origin+Watch.path);assert.equal(calls[0].params.ttl,'604800');
  assert.equal(channels(db)[0].token_hash,await Watch.hash(calls[0].token));
  assert(!JSON.stringify(channels(db)).includes(calls[0].token));
  assert.equal((await Watch.ensure(env)).status,'unchanged');assert.equal(calls.length,1);
  db.sqlite.prepare('UPDATE google_calendar_watch_channel SET expires_at=?').run(Date.now()+3600000);
  await Watch.ensure(env);assert.equal(calls.length,2);assert.equal(channels(db).length,2);
  assert.notEqual(calls[0].id,calls[1].id);assert.notEqual(calls[0].token,calls[1].token);
  const status=await Watch.status(env);assert.equal(status.active,true);
  assert(!JSON.stringify(status).includes('resource'));assert(!JSON.stringify(status).includes(calls[1].token));
});

test('initial sync notification arriving before registration response is authenticated and retained',async t=>{
  const {db,env,ctx,jobs}=setup(t);let imports=0;
  t.mock.method(Import,'run',async()=>{imports++;return {status:'complete'};});
  mockWatch(t,async channel=>{
    assert.equal(channels(db)[0].confirmed,0);
    const r=await worker.fetch(request(channel,{'X-Goog-Resource-State':'sync','X-Goog-Message-Number':'1'}),env,ctx);
    assert.equal(r.status,204);
  });
  await Watch.ensure(env);await Promise.all(jobs);assert.equal(imports,1);
  assert.equal(channels(db)[0].confirmed,1);assert.equal(revision(db).requested_revision,1);
  assert.ok((await Watch.status(env)).lastNotificationAt);
});

test('forged, unknown, expired, wrong-resource and malformed callbacks do not trigger imports',async t=>{
  const {db,env,ctx,jobs}=setup(t),calls=mockWatch(t);await Watch.ensure(env);
  for(const headers of [
    {'X-Goog-Channel-ID':'unknown'}, {'X-Goog-Channel-Token':'0'.repeat(64)},
    {'X-Goog-Resource-ID':'wrong'}, {'X-Goog-Message-Number':'-1'}, {'X-Goog-Message-Number':'1e3'},
    {'X-Goog-Message-Number':'9'.repeat(41)}, {'X-Goog-Resource-State':'wrong'}
  ])assert.equal((await Watch.receive(request(calls[0],headers),env,ctx)).status,403);
  assert.equal((await Watch.receive(new Request(origin+Watch.path),env,ctx)).status,405);
  const wrongHost=request(calls[0]);
  assert.equal((await Watch.receive(new Request('https://preview.example.test'+Watch.path,wrongHost),env,ctx)).status,403);
  db.sqlite.exec('UPDATE google_calendar_watch_channel SET expires_at=0');
  assert.equal((await Watch.receive(request(calls[0]),env,ctx)).status,403);assert.equal(jobs.length,0);
});

test('duplicates and out-of-order messages acknowledge without work; large sequence values remain exact',async t=>{
  const {db,env,ctx,jobs}=setup(t),calls=mockWatch(t);await Watch.ensure(env);
  let imports=0;t.mock.method(Import,'run',async()=>{imports++;return {status:'complete'};});
  for(const number of ['9007199254740992','9007199254740992','3','9007199254740993'])
    assert.equal((await Watch.receive(request(calls[0],{'X-Goog-Message-Number':number}),env,ctx)).status,204);
  await Promise.all(jobs);assert.equal(imports,2);assert.equal(revision(db).requested_revision,2);
  assert.equal(channels(db)[0].message_number,'9007199254740993'.padStart(40,'0'));
});

test('notification transaction rolls back on database failure and a retry can start the import',async t=>{
  const {db,env,ctx,jobs}=setup(t),calls=mockWatch(t);await Watch.ensure(env);
  t.mock.method(Import,'run',async()=>({status:'complete'}));
  db.sqlite.exec("CREATE TRIGGER fail_callback BEFORE UPDATE ON google_calendar_watch_channel BEGIN SELECT RAISE(ABORT,'failed'); END;");
  assert.equal((await Watch.receive(request(calls[0]),env,ctx)).status,503);
  assert.equal(revision(db).requested_revision,0);assert.equal(channels(db)[0].message_number,'');assert.equal(jobs.length,0);
  db.sqlite.exec('DROP TRIGGER fail_callback');
  assert.equal((await Watch.receive(request(calls[0]),env,ctx)).status,204);await Promise.all(jobs);
  assert.equal(revision(db).requested_revision,1);
});

test('concurrent registration uses one lease and failed renewal retains the active channel with bounded retries',async t=>{
  const {db,env}=setup(t);let release,entered;
  const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);
  const calls=mockWatch(t,async()=>{entered();await gate;});
  const first=Watch.ensure(env);await waiting;
  assert.equal((await Watch.ensure(env)).status,'unchanged');release();await first;assert.equal(calls.length,1);
  db.sqlite.prepare('UPDATE google_calendar_watch_channel SET expires_at=?').run(Date.now()+3600000);
  let failed=0;t.mock.method(globalThis,'fetch',async()=>{failed++;return new Response('private secret details',{status:403});});
  assert.equal((await Watch.ensure(env)).status,'failed');assert.equal((await Watch.status(env)).active,true);
  assert.equal((await Watch.status(env)).error,'Google変更通知: HTTP 403');
  await Watch.ensure(env);assert.equal(failed,1);
  db.sqlite.exec('UPDATE google_calendar_watch_state SET retry_at=0,lease_until=0');
  mockWatch(t);assert.equal((await Watch.ensure(env)).status,'active');assert.equal((await Watch.status(env)).error,'');
});

test('invalid response and redirects never confirm a channel or leak an upstream body',async t=>{
  const {db,env}=setup(t);
  for(const response of [new Response('private',{status:302,headers:{location:'https://elsewhere.test'}}),Response.json({id:'wrong',resourceId:'private',expiration:'no'})]){
    db.sqlite.exec('UPDATE google_calendar_watch_state SET retry_at=0,lease_until=0');
    t.mock.method(globalThis,'fetch',async(_,options)=>{assert.equal(options.redirect,'manual');return response;});
    assert.equal((await Watch.ensure(env)).status,'failed');assert.equal((await Watch.status(env)).active,false);
    assert(!JSON.stringify(await Watch.status(env)).includes('private'));
  }
});

test('webhook remains disabled without explicit opt-in or valid HTTPS origin',async t=>{
  const {env}=setup(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected');});
  for(const changes of [{GOOGLE_CALENDAR_WEBHOOK_ENABLED:'false'},{SITE_URL:'http://localhost:8000'},{SITE_URL:origin+'/path'},{GOOGLE_SERVICE_ACCOUNT_JSON:''}])
    assert.equal((await Watch.ensure({...env,...changes})).status,'disabled');
  assert.equal(calls,0);
});

test('a notification arriving during import triggers another read instead of losing the change',async t=>{
  const {db,env,ctx,jobs}=setup(t),calls=mockWatch(t);await Watch.ensure(env);
  let reads=0;
  t.mock.method(globalThis,'fetch',async()=>{
    reads++;
    if(reads===1)assert.equal((await Watch.receive(request(calls[0]),env,ctx)).status,204);
    return Response.json({kind:'calendar#events',items:[]});
  });
  assert.equal((await Import.run(env)).status,'complete');await Promise.all(jobs);
  assert.equal(reads,2);assert.equal(revision(db).requested_revision,revision(db).completed_revision);
});

test('continuous change is bounded; the next cron still imports pending revisions',async t=>{
  const {db,env}=setup(t);let reads=0;
  t.mock.method(globalThis,'fetch',async()=>{
    reads++;db.sqlite.exec('UPDATE google_calendar_import SET requested_revision=requested_revision+1');
    return Response.json({kind:'calendar#events',items:[]});
  });
  await Import.run(env);assert.equal(reads,2);assert(revision(db).requested_revision>revision(db).completed_revision);
  t.mock.method(globalThis,'fetch',async()=>Response.json({kind:'calendar#events',items:[]}));
  await Import.run(env);assert.equal(revision(db).requested_revision,revision(db).completed_revision);
});

test('cron and authenticated manual retry maintain watches; public requests cannot register them',async t=>{
  const {env,ctx,jobs}=setup(t);let watches=0;
  t.mock.method(Watch,'ensure',async()=>{watches++;});t.mock.method(Import,'run',async()=>({status:'complete'}));
  t.mock.method(Sync,'run',async()=>({status:'complete'}));
  const endpoint=origin+'/api/admin/calendar-sync';
  assert.equal((await worker.fetch(new Request(endpoint,{method:'POST'}),env,ctx)).status,401);assert.equal(watches,0);
  assert.equal((await worker.fetch(new Request(endpoint,{method:'POST',headers:{Authorization:'Bearer test-admin'}}),env,ctx)).status,202);
  worker.scheduled({},env,ctx);await Promise.all(jobs);assert.equal(watches,2);
});

test('production robots permits the exact notification endpoint and continues excluding other APIs',async t=>{
  const {env}=setup(t);
  const robots=await (await SiteSeo.handle(new Request(origin+'/robots.txt'),env)).text();
  assert(robots.includes('Disallow: /api/\n'));assert(robots.includes('Allow: '+Watch.path+'\n'));
});
