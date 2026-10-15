import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { BookingApi } from '../src/booking_api.js';
import { BookingService as Service } from '../src/booking_service.js';

const date = '2026-10-15';
const adminToken = 'test-only-admin-token';
const input = { date, startTime: '14:30', endTime: '15:30', blockType: 'patient', menu: 'followup_60', customerName: ' 山田 太郎 ', note: ' 電話からの予約 ' };
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  t.mock.method(Date, 'now', () => Date.parse(date + 'T14:00:00+09:00'));
  t.mock.method(Service, 'todayJst', () => date);
  return { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind: (...values) => ({ first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }), run: async () => statement.run(...values) }) };
  }};
}
const envFor = db => ({ BOOKING_DB: db, ADMIN_TOKEN: adminToken });
const post = (body, token = adminToken) => new Request('https://example.test/api/admin/blocks', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('admin can save and reload a short-notice patient appointment with optional phone, without sending LINE', async t => {
  const db = database(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Admin appointments must not send external messages'); });
  const response = await BookingApi.handle(post(input), envFor(db));
  assert.equal(response.status, 201);
  const saved = (await response.json()).block;
  assert.equal(saved.blockType, 'patient');
  assert.equal(saved.customerName, '山田 太郎');
  assert.equal(saved.phone, '');
  assert.equal(saved.note, '電話からの予約');
  const read = await BookingApi.handle(new Request('https://example.test/api/admin/bookings?date=' + date,
    { headers: { Authorization: 'Bearer ' + adminToken } }), envFor(db));
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).blocks, [saved]);
});

test('patient phone is trimmed and persists, while private and legacy entries discard patient-only fields', async t => {
  const db = database(t);
  const patient = await BookingApi.handle(post({ ...input, phone: ' 090-1234-5678 ' }), envFor(db));
  assert.equal((await patient.json()).block.phone, '090-1234-5678');
  for (const [index, blockType] of ['private', undefined].entries()) {
    const response = await BookingApi.handle(post({ ...input, startTime: index ? '17:00' : '16:00', endTime: index ? '18:00' : '17:00', blockType, phone: '09012345678' }), envFor(db));
    assert.equal(response.status, 201);
    const saved = (await response.json()).block;
    assert.equal(saved.blockType, 'private');
    assert.equal(saved.customerName, '');
    assert.equal(saved.phone, '');
    assert.equal(saved.note, '電話からの予約');
  }
});

for (const values of [
  { blockType: 'unknown' }, { blockType: '' }, { blockType: null }, { blockType: ['patient'] },
  { customerName: '' }, { customerName: '  ' }, { customerName: '名'.repeat(81) }, { customerName: {} },
  { phone: 'abc' }, { phone: '090' }, { phone: '0'.repeat(31) }, { phone: 9012345678 }, { phone: null }
]) {
  test('invalid admin appointment is rejected before DB access: ' + JSON.stringify(values), async t => {
    database(t);
    const response = await BookingApi.handle(post({ ...input, ...values }), envFor({ prepare() { throw new Error('Must not access DB'); } }));
    assert.equal(response.status, 400);
  });
}

test('patient data requires admin authentication and public availability exposes times only', async t => {
  const db = database(t);
  const guarded = { prepare() { throw new Error('Unauthorized DB access'); } };
  assert.equal((await BookingApi.handle(post(input, ''), envFor(guarded))).status, 401);
  assert.equal((await BookingApi.handle(new Request('https://example.test/api/admin/bookings?date=' + date), envFor(guarded))).status, 401);
  await BookingApi.handle(post({ ...input, phone: '09012345678' }), envFor(db));
  const response = await BookingApi.handle(new Request(`https://example.test/api/availability?date=${date}&menu=first_visit`), envFor(db));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['contactSlots','date','slots']);
  assert.equal(body.contactSlots.includes('14:30'), false);
  assert.equal(body.contactSlots.includes('15:00'), false);
  assert.equal(JSON.stringify(body).includes('山田'), false);
  assert.equal(JSON.stringify(body).includes('09012345678'), false);
  assert.equal(JSON.stringify(body).includes('電話からの予約'), false);
});

test('patient appointments prevent overlapping bookings and private periods, and deleting restores availability', async t => {
  const db = database(t);
  const first = await BookingApi.handle(post(input), envFor(db));
  const saved = (await first.json()).block;
  assert.equal((await BookingApi.handle(post({ ...input, blockType: 'private' }), envFor(db))).status, 409);
  const times = Service.parseStart(date, '15:00', 60);
  const booking = { id: 'booking', bookingNumber: 'booking', idempotencyKey: 'booking', ...times,
    menu: 'followup_60', name: 'Web予約', phone: '09000000000', email: '', createdAt: Service.isoLocal(new Date()) };
  assert.equal((await Service.createBooking(db, booking)).row, null);
  const removed = await BookingApi.handle(new Request('https://example.test/api/admin/blocks/' + saved.id,
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminToken } }), envFor(db));
  assert.equal(removed.status, 200);
  assert.equal((await Service.listBlocks(db, date)).length, 0);
  assert.equal((await Service.getSlotAvailability(db, date, 'first_visit')).contactSlots.includes('14:30'), true);
  assert.equal((await Service.createBooking(db, booking)).created, true);
  assert.equal((await BookingApi.handle(post(input), envFor(db))).status, 409);
});

test('patient metadata migration preserves existing periods and bookings, defaulting old periods to private', t => {
  const sqlite = new DatabaseSync(':memory:');t.after(() => sqlite.close());
  for (const name of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(n => n.endsWith('.sql') && n.slice(0,4) < '0005').sort()) {
    sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url),'utf8'));
  }
  sqlite.prepare('INSERT INTO blocked_periods (id,start_at,end_at,note,created_at) VALUES (?,?,?,?,?)')
    .run('old-period',date+'T14:30:00+09:00',date+'T15:30:00+09:00','既存のメモ',date+'T13:00:00+09:00');
  sqlite.prepare(`INSERT INTO bookings (id,booking_number,idempotency_key,start_at,end_at,menu,customer_name,phone,created_at,updated_at,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed')`).run('old-booking','OLD','old-request',date+'T17:00:00+09:00',date+'T18:00:00+09:00',
      'followup_60','既存予約','09000000000',date+'T13:00:00+09:00',date+'T13:00:00+09:00');
  const before = sqlite.prepare('SELECT * FROM blocked_periods').get();
  const bookings = sqlite.prepare('SELECT * FROM bookings').all();
  sqlite.exec(fs.readFileSync(new URL('../migrations/0005_add_admin_patient_appointments.sql',import.meta.url),'utf8'));
  const after = sqlite.prepare('SELECT * FROM blocked_periods').get();
  assert.equal(after.block_type,'private');assert.equal(after.customer_name,'');assert.equal(after.phone,'');
  delete after.block_type;delete after.customer_name;delete after.phone;
  assert.deepEqual(after,before);
  assert.deepEqual(sqlite.prepare('SELECT * FROM bookings').all(),bookings);
});

function adminPage() {
  const sandbox = vm.createContext({ document:{ getElementById:()=>null },window:{},Headers,Date,appJa:{text:x=>x} });
  for (const file of ['weekly_calendar.js','admin_page.js']) vm.runInContext(fs.readFileSync(new URL('../public/js/'+file,import.meta.url),'utf8'),sandbox);
  return vm.runInContext('Object.create(AdminPage.prototype)',sandbox);
}

test('admin form switches required patient fields and does not submit hidden contact data for private entries', async t => {
  t.mock.method(Date, 'now', () => Date.parse(date+'T14:00:00+09:00'));
  const page = adminPage();
  Object.assign(page,{blockType:{value:'patient'},blockMenu:{value:'followup_60'},blockTimeFields:{},patientSlot:{},calendarHelp:{},blockPatientFields:{hidden:true},blockPatientName:{value:' 山田 太郎 '},
    blockPhone:{value:' 09012345678 '},blockSubmit:{disabled:false},blockDate:{value:date},blockStart:{value:'14:30'},
    blockEnd:{value:'15:30'},blockNote:{value:'電話予約'},dateInput:{},blockForm:{reportValidity:()=>true},
    showNotice(){},refresh:async()=>{}});
  page.updateBlockTypeFields();
  assert.equal(page.blockPatientFields.hidden,false);assert.equal(page.blockPatientName.required,true);
  assert.equal(page.blockPhone.required,undefined);assert.equal(page.blockPhone.disabled,false);
  page.patientSelection={date,time:'14:30',menu:'followup_60'};
  let body;
  page.request = async (path,options) => { body=JSON.parse(options.body); };
  await page.saveBlock({preventDefault(){}});
  assert.equal(body.customerName,'山田 太郎');assert.equal(body.phone,'09012345678');assert.equal(body.blockType,'patient');
  assert.equal(page.blockPatientName.value,'');assert.equal(page.blockPhone.value,'');
  page.blockType.value='private';page.blockPatientName.value='残った患者名';page.blockPhone.value='09012345678';
  page.updateBlockTypeFields();
  assert.equal(page.blockPatientFields.hidden,true);assert.equal(page.blockPatientName.required,false);
  assert.equal(page.blockPatientName.disabled,true);assert.equal(page.blockPhone.disabled,true);
  await page.saveBlock({preventDefault(){}});
  assert.equal(body.blockType,'private');assert.equal(body.customerName,'');assert.equal(body.phone,'');
});

test('patient courses determine the saved duration and cannot be overridden by client end times', async t => {
  const db=database(t);
  for (const [menu,startTime,endTime,durationMinutes] of [
    ['first_visit','14:30','15:50',80],['followup_60','17:00','18:00',60],['followup_90','19:00','20:30',90]
  ]) {
    const response=await BookingApi.handle(post({...input,menu,startTime,endTime:'23:30'}),envFor(db));
    assert.equal(response.status,201);
    const block=(await response.json()).block;
    assert.equal(block.menu,menu);assert.equal(block.endTime,endTime);assert.equal(block.durationMinutes,durationMinutes);
  }
  for(const menu of [undefined,'','first','__proto__',{}]) {
    const response=await BookingApi.handle(post({...input,menu}),envFor({prepare(){throw new Error('Invalid menu must not access DB');}}));
    assert.equal(response.status,400);
  }
});

test('admin availability includes short-notice times, requires authentication, and respects closing by course', async t => {
  const db=database(t);
  const url=`https://example.test/api/admin/availability?date=${date}&menu=first_visit`;
  assert.equal((await BookingApi.handle(new Request(url),envFor({prepare(){throw new Error('Unauthorized read');}}))).status,401);
  const response=await BookingApi.handle(new Request(url,{headers:{Authorization:'Bearer '+adminToken}}),envFor(db));
  assert.equal(response.status,200);
  const available=(await response.json()).slots;
  assert.equal(available[0],'14:30');assert.equal(available.at(-1),'22:30');
  const publicResponse=await BookingApi.getAvailability(new URL(url),envFor(db));
  assert.equal((await publicResponse.json()).slots[0],'17:00');
});

test('course appointments enforce the thirty-minute buffer for Web bookings, reschedules, and admin appointments', async t => {
  const db=database(t);
  const response=await BookingApi.handle(post({...input,menu:'first_visit'}),envFor(db));
  assert.equal(response.status,201);
  const slots=await Service.getSlotAvailability(db,date,'followup_60');
  assert.equal(slots.contactSlots.includes('16:00'),false);
  assert.equal(slots.contactSlots.includes('16:30'),true);
  const webBooking=(id,time)=>({id,bookingNumber:id,idempotencyKey:id,
    ...Service.parseStart(date,time,60),menu:'followup_60',name:'Web患者',phone:'09000000000',email:'',createdAt:Service.isoLocal(new Date())});
  assert.equal((await Service.createBooking(db,webBooking('too-close','16:00'))).row,null);
  const web=webBooking('reschedule','18:00');assert.equal((await Service.createBooking(db,web)).created,true);
  let times=Service.parseStart(date,'16:00',60);
  assert.equal(await Service.rescheduleBooking(db,web.id,times.startAt,times.endAt),null);
  times=Service.parseStart(date,'16:30',60);
  assert.ok(await Service.rescheduleBooking(db,web.id,times.startAt,times.endAt));
  await Service.cancelBooking(db,web.id);
  assert.equal((await BookingApi.handle(post({...input,startTime:'16:00'}),envFor(db))).status,409);
  assert.equal((await BookingApi.handle(post({...input,startTime:'16:30'}),envFor(db))).status,201);
});

test('admin course appointments also leave a buffer before an existing Web booking', async t => {
  const db=database(t);
  const times=Service.parseStart(date,'17:00',60);
  await Service.createBooking(db,{id:'web',bookingNumber:'web',idempotencyKey:'web',...times,menu:'followup_60',name:'Web患者',phone:'09000000000',email:'',createdAt:Service.isoLocal(new Date())});
  assert.equal((await BookingApi.handle(post({...input,startTime:'16:00'}),envFor(db))).status,409);
  assert.equal((await BookingApi.handle(post({...input,startTime:'15:30'}),envFor(db))).status,201);
});

test('course migration preserves older private and patient appointment times and their blocking behavior', t => {
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  for(const name of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n.slice(0,4)<'0006').sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  sqlite.prepare(`INSERT INTO blocked_periods (id,start_at,end_at,note,created_at,block_type,customer_name,phone) VALUES (?,?,?,?,?,?,?,?)`)
    .run('old',date+'T14:30:00+09:00',date+'T15:30:00+09:00','旧メモ',date+'T13:00:00+09:00','patient','既存患者','');
  const before=sqlite.prepare('SELECT * FROM blocked_periods').get();
  sqlite.exec(fs.readFileSync(new URL('../migrations/0006_add_admin_appointment_menu.sql',import.meta.url),'utf8'));
  const after=sqlite.prepare('SELECT * FROM blocked_periods').get();assert.equal(after.menu,'');delete after.menu;assert.deepEqual(after,before);
});

test('calendar selection derives the course end time and a changed course clears the selection', t => {
  t.mock.method(Date,'now',()=>Date.parse(date+'T14:00:00+09:00'));
  const page=adminPage();let focused=false;let renders=0;
  Object.assign(page,{config:{menus:{first_visit:{duration:80}}},blockType:{value:'patient'},blockMenu:{value:'first_visit'},patientSlot:{},
    patientAvailability:new Map([[date,new Set(['14:30'])]]),blockSubmit:{disabled:false},blockForm:{scrollIntoView(){}},blockPatientName:{focus(){focused=true;}},
    renderBookings(){renders++;}});
  page.choosePatientSlot(date,'14:30');
  assert.equal(page.patientSelection.menu,'first_visit');assert.equal(page.patientSelection.time,'14:30');
  assert.match(page.patientSlot.textContent,/14 : 30~15 : 50/);assert.equal(focused,true);assert.equal(renders,1);
  page.clearPatientSelection();assert.equal(page.patientSelection,null);
});
