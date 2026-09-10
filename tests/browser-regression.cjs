// Run against a local server. Every Supabase request is replaced with an in-memory fake.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const mockClient = `
import { createInitialState, createDay, createEvent, localDateInTimezone } from './domain.js';
const copy = x => JSON.parse(JSON.stringify(x));
const initial = createInitialState();
const today = localDateInTimezone();
initial.days.push(createDay(today, initial.settings));
initial.days[0].events.push(createEvent(initial.days[0], 'BALANCE_LIQUID', new Date().toISOString()));
const health = [{id:'health-1', event_type:'urine', status:'ACTIVE', occurred_at:new Date().toISOString(), updated_at:new Date().toISOString(), recorded_by_name:'家族'}];
const sessions = JSON.parse(localStorage.getItem('test-mock-sessions') || 'null') || [{ id:'eye-1', local_date:today, scheduled_time:'10:00', status:'completed', eye_drop_steps:[{id:'step-1',step_order:1,drop_name:'点眼A',status:'completed',completed_at:new Date().toISOString(),completed_by_name:'家族'}]}];
const m = window.__mock = { state:initial, revision:1, health, sessions, callbacks:[], saves:0, holdNext:false, held:null };
const storedCloud = localStorage.getItem('test-mock-cloud'); if(storedCloud){const c=JSON.parse(storedCloud);m.state=c.state;m.revision=c.revision;}
m.remoteChange = () => { m.state = copy(m.state); m.state.days[0].note = '別端末のメモ'+m.revision; m.state.days[0].updatedAt = new Date().toISOString(); m.revision++; m.callbacks.forEach(fn=>fn({new:{revision:m.revision}})); };
const client = {
 auth:{ getSession:async()=>({data:{session:{user:{id:'user-1'}}}}),signInAnonymously:async()=>({data:{session:{user:{id:'user-1'}}}})},
 channel:()=>{const c={on:(event,filter,fn)=>{if(filter.table==='household_states')m.callbacks.push(fn);return c},subscribe:()=>c};return c},
 removeChannel:()=>{},
 from:(table)=>{ const filters={}; let single=false;
  const q={select:()=>q,eq:(key,value)=>{filters[key]=value;return q},gte:()=>q,lt:()=>q,order:()=>q,limit:()=>q,range:()=>q,
   single:()=>{single=true;return q},maybeSingle:()=>{single=true;return q},
   then:(resolve,reject)=>Promise.resolve({data:table==='household_states'?{state:copy(m.state),revision:m.revision}:
    table==='health_events'?copy(health):table==='eye_drop_sessions'?copy(sessions.filter(s=>!filters.local_date||s.local_date===filters.local_date)):
    table==='eye_drop_settings'?{drop_types:[],templates:[],interval_seconds:300}:{master_enabled:false,scheduled_eye_drop_enabled:true,active_eye_drop_timer_enabled:true}}).then(resolve,reject)};return q;
 },
 rpc:async(name,p={})=>{
  if(name==='get_my_household')return {data:[{household_id:'family-1',revision:m.revision}]};
  if(name==='ensure_care_profile')return {data:[{user_id:'user-1',household_id:'family-1',display_name:p.p_display_name||'家族',role:'admin'}]};
  if(name==='save_household_state'){
   m.saves++; const submitted=copy(p.p_state);
   if(m.holdNext){m.holdNext=false;await new Promise(resolve=>m.held=resolve);m.held=null;}
   if(p.p_expected_revision!==m.revision)return {data:[{saved:false,current_revision:m.revision,current_state:copy(m.state)}]};
   m.state=submitted;m.revision++;localStorage.setItem('test-mock-cloud',JSON.stringify({state:m.state,revision:m.revision}));return {data:[{saved:true,current_revision:m.revision}]};
  }
  if(name==='edit_health_event'){const h=health.find(h=>h.id===p.p_event_id);if(h.updated_at!==p.p_expected_updated_at)return {error:{message:'別端末で変更されています'}};h.occurred_at=p.p_occurred_at;h.note=p.p_note;h.updated_at=new Date(Date.now()+1000).toISOString();}
  if(name==='record_health_event_with_note' && !health.some(h=>h.id===p.p_id))health.unshift({id:p.p_id,event_type:p.p_event_type,occurred_at:p.p_occurred_at,note:p.p_note,status:'ACTIVE',recorded_by_name:'家族',updated_at:new Date().toISOString()});
  if(name==='void_health_event')health.find(h=>h.id===p.p_event_id).status='VOIDED';
  if(name==='save_notification_preferences')return {data:p};
  return {data:null};
 }
};
export async function getSupabaseClient(){return client;}
`;
(async()=>{
 const browser=await chromium.launch({downloadsPath:process.env.TEST_DOWNLOADS_PATH,executablePath:process.env.BROWSER_EXECUTABLE,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
  const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Tokyo',serviceWorkers:'block'});
  await context.route('**/*', async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==new URL(baseURL).origin)return route.abort();
   if(url.pathname.endsWith('/js/supabase-client.js'))return route.fulfill({contentType:'text/javascript',body:mockClient});
   return route.continue();
  });
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  await page.clock.setFixedTime(new Date('2026-09-06T01:00:00Z'));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',d=>d.accept());
  const click = async selector=>{await page.locator(selector).click();};
  const saved = async ()=>{await page.waitForFunction(()=>!document.querySelector('#action-dialog').open);await page.waitForTimeout(600);};
  const sync = async ()=>{await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('同期済み'));await page.waitForTimeout(650);};
  const remote = async ()=>{await page.evaluate(()=>window.__mock.remoteChange());await page.waitForTimeout(300);};
  await page.goto(baseURL+'/tests.html');
  await page.waitForFunction(()=>document.documentElement.dataset.tests);
  assert.equal(await page.locator('html').getAttribute('data-tests'),'passed');
  console.log(await page.locator('#test-summary').innerText());
  await page.addInitScript(() => {
    const original = Element.prototype.scrollIntoView;
    window.__scrolls = [];
    Element.prototype.scrollIntoView = function(options) {
      window.__scrolls.push(this.dataset.eyeSessionId); return original.call(this, options);
    };
  });
  await page.goto(baseURL);await sync();
  assert.deepEqual(await page.locator('.bottom-nav button span:last-child').allTextContents(),['食事','排泄','点眼','履歴','設定']);
  assert.equal(await page.locator('#today-view [data-health]').count(),0);
  {
  // Optional notes: safe text, preview/full text, editing, old records, cancellation and export.
  await click('.bottom-nav [data-route=health]');
  await click('[data-health=stool]');
  const note = '<img src=x onerror="window.noteInjected=true">茶色\n' + 'やわらかい便。'.repeat(20);
  await page.locator('#health-note').fill(note);
  await click('#action-form button[type=submit]');await saved();
  const healthId = await page.evaluate(()=>__mock.health[0].id);
  assert.equal(await page.evaluate(()=>__mock.health[0].note),note);
  assert.equal(await page.locator('.health-note img').count(),0);
  assert.equal(await page.evaluate(()=>window.noteInjected),undefined);
  await click('.bottom-nav [data-route=history]');await click('[data-history-kind=health]');
  await page.waitForSelector('#history-view .health-note');
  assert.match(await page.locator('#history-view .health-note summary').first().innerText(),/…/);
  await page.locator('#history-view .health-note summary').first().click();
  assert.equal(await page.locator('#history-view .health-note p').first().innerText(),note);
  await page.evaluate(()=>{__mock.health[0].occurred_at='2026-09-06T01:00:37.123Z';dispatchEvent(new Event('online'));});
  await page.waitForTimeout(700);
  await click(`#history-view [data-edit-health="${healthId}"]`);
  assert.equal(await page.locator('#health-note').inputValue(),note);
  await page.locator('#health-note').fill('黄色・形あり');
  await click('#action-form button[type=submit]');await saved();
  assert.equal(await page.evaluate(()=>__mock.health[0].note),'黄色・形あり');
  assert.equal(await page.evaluate(()=>__mock.health[0].occurred_at),'2026-09-06T01:00:37.123Z');
  await click(`#history-view [data-edit-health="${healthId}"]`);
  await page.locator('#health-note').fill('競合で保存されないメモ');
  await page.evaluate(()=>__mock.health[0].updated_at='2099-01-01T00:00:00Z');
  await click('#action-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('別端末'));
  assert.equal(await page.locator('#health-note').inputValue(),'競合で保存されないメモ');
  await click('[data-action=close-dialog]');await page.waitForTimeout(600);
  await click(`#history-view [data-void-health="${healthId}"]`);await page.waitForTimeout(650);
  assert.equal(await page.evaluate(()=>__mock.health[0].status),'VOIDED');
  assert.equal(await page.locator('#history-view .health-note summary').first().innerText(),'黄色・形あり（全文）');
  await click('.bottom-nav [data-route=health]');await click('[data-health=urine]');
  await click('#action-form button[type=submit]');await saved();
  assert.equal(await page.evaluate(()=>__mock.health[0].note),'');
  await click('.bottom-nav [data-route=settings]');
  const downloadPromise = page.waitForEvent('download');
  await click('[data-export=care-json]');
  const download = await downloadPromise;
  const exported = JSON.parse(require('node:fs').readFileSync(await download.path(),'utf8'));
  assert.equal(exported.healthEvents.find(h=>h.id===healthId).note,'黄色・形あり');
  // Several sessions force actual scrolling. Notification target wins over current time.
  await page.evaluate(()=> {
    __mock.sessions.splice(0, __mock.sessions.length, ...['06:00','08:00','10:00','12:00','14:00','16:00','18:00','20:00','22:00'].map(time=>({
      id:'eye-'+time, local_date:__mock.state.days[0].localDate, scheduled_time:time, status:'pending',
      eye_drop_steps:[{id:'step-'+time,step_order:1,drop_name:'点眼A',status:'pending'}]
    })));
    __mock.sessions[0].status='in_progress';
    localStorage.setItem('test-mock-sessions',JSON.stringify(__mock.sessions));
    dispatchEvent(new Event('online'));
  });
  await page.waitForTimeout(700);
  await click('.bottom-nav [data-route=eyedrops]');
  await page.waitForFunction(()=>window.__scrolls.at(-1)==='eye-10:00');
  assert.ok(await page.evaluate(()=>window.scrollY)>0);
  const scrollCount = await page.evaluate(()=>window.__scrolls.length);
  await page.evaluate(()=>{window.scrollTo(0,0);dispatchEvent(new Event('online'));});
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.__scrolls.length),scrollCount);
  assert.equal(await page.evaluate(()=>window.scrollY),0);
  await page.goto(baseURL+'/?eyeSession=eye-18:00');await sync();
  await page.waitForFunction(()=>window.__scrolls.includes('eye-18:00'));
  await page.goto(baseURL+'/?eyeSession=missing-session');await sync();
  await page.waitForFunction(()=>window.__scrolls.includes('eye-10:00'));
  await page.evaluate(()=>localStorage.removeItem('test-mock-sessions'));
  await page.goto(baseURL);await sync();
  }
  // Draft must survive remote replacement and sync status notifications.
  await click('.bottom-nav [data-route=settings]');
  await page.locator('[name=dogName]').fill('べぬ変更');await remote();
  assert.equal(await page.locator('[name=dogName]').inputValue(),'べぬ変更');
  await click('#settings-form button[value=future]');await sync();
  await click('.bottom-nav [data-route=today]');
  assert.match(await page.locator('#today-title').innerText(),/べぬ変更/);
  // Edit two fields while a remote update replaces every state object.
  await click('[data-edit-event]');
  await page.locator('#action-form [name=calories]').fill('30');await remote();
  await page.locator('#action-form [name=water]').fill('25');
  await click('#action-form button[type=submit]');await saved();await sync();
  assert.deepEqual(await page.evaluate(()=>[__mock.state.days[0].events[0].caloriesTenthKcal,__mock.state.days[0].events[0].countedWaterMl]),[300,25]);
  // Skip must use current state after remote replacement, persist and reset.
  const slotId=await page.locator('[data-slot-action=skip]').first().getAttribute('data-slot-id');
  await page.locator('[data-slot-action=skip]').first().click();await remote();
  await page.locator('#slot-reason').fill('休憩');await click('#action-form button[type=submit]');await saved();await sync();
  assert.equal(await page.evaluate(id=>__mock.state.days[0].slots.find(s=>s.id===id).status,slotId),'SKIPPED');
  await remote();
  assert.equal(await page.locator('[data-slot-action=reset]').count(),1);
  await click('[data-slot-action=reset]');await sync();
  assert.equal(await page.locator('[data-slot-action=reset]').count(),0);
  // Multi-unit entries and chosen time.
  await click('[data-record=SOLID_FOOD]');
  await page.locator('[name=unit]').selectOption('pieces');await page.locator('#simple-amount').fill('54');
  await page.locator('#record-time').fill('2026-09-06T08:45');
  assert.match(await page.locator('#amount-preview').innerText(),/29 kcal/);
  await click('#action-form button[type=submit]');await saved();await sync();
  assert.deepEqual(await page.evaluate(()=>{const e=__mock.state.days[0].events.find(e=>e.type==='SOLID_FOOD');return[e.caloriesTenthKcal,e.inputAmount,e.inputUnit,e.occurredAt]}),[290,54,'pieces','2026-09-05T23:45:00.000Z']);
  await click('[data-record=SOUP_SYRINGE]');await page.locator('#simple-amount').fill('12');
  await click('#action-form button[type=submit]');await saved();await sync();
  assert.deepEqual(await page.evaluate(()=>{const e=__mock.state.days[0].events.find(e=>e.type==='SOUP_SYRINGE');return[e.caloriesTenthKcal,e.countedWaterMl]}),[60,12]);
  // A time-only correction keeps snapshots; a soup amount correction recalculates kcal.
  const soupId = await page.evaluate(()=>__mock.state.days[0].events.find(e=>e.type==='SOUP_SYRINGE').id);
  await click('[data-edit-event="'+soupId+'"]');await page.locator('#action-form [name=occurredAt]').fill('2026-09-06T09:20');
  await click('#action-form button[type=submit]');await saved();await sync();
  assert.deepEqual(await page.evaluate(id=>{const e=__mock.state.days[0].events.find(e=>e.id===id);return[e.caloriesTenthKcal,e.countedWaterMl]},soupId),[60,12]);
  await click('[data-edit-event="'+soupId+'"]');await page.locator('#action-form [name=water]').fill('20');
  await click('#action-form button[type=submit]');await saved();await sync();
  assert.deepEqual(await page.evaluate(id=>{const e=__mock.state.days[0].events.find(e=>e.id===id);return[e.caloriesTenthKcal,e.countedWaterMl]},soupId),[100,20]);
  // A second record made during an in-flight save must be uploaded too.
  await page.evaluate(()=>__mock.holdNext=true);
  await click('[data-record=PLAIN_WATER]');await page.locator('#simple-amount').fill('3');
  await click('#action-form button[type=submit]');await saved();
  await page.waitForFunction(()=>!!__mock.held);
  await click('[data-record=PLAIN_WATER]');await page.locator('#simple-amount').fill('4');
  await click('#action-form button[type=submit]');await saved();
  await page.evaluate(()=>__mock.held());await sync();
  assert.deepEqual(await page.evaluate(()=>__mock.state.days[0].events.filter(e=>e.type==='PLAIN_WATER').map(e=>e.countedWaterMl)),[3,4]);
  // Optimistic-lock conflict response must also retain a later local record.
  await page.evaluate(()=>__mock.holdNext=true);
  await click('[data-record=SOUP_SYRINGE]');await page.locator('#simple-amount').fill('2');
  await click('#action-form button[type=submit]');await saved();await page.waitForFunction(()=>!!__mock.held);
  await page.evaluate(()=>__mock.remoteChange());
  await click('[data-record=SOUP_SYRINGE]');await page.locator('#simple-amount').fill('3');
  await click('#action-form button[type=submit]');await saved();
  await page.evaluate(()=>__mock.held());await sync();
  assert.deepEqual(await page.evaluate(()=>__mock.state.days[0].events.filter(e=>e.type==='SOUP_SYRINGE').map(e=>e.countedWaterMl)),[20,2,3]);
  // Offline input is durable and sent after reconnect.
  await context.setOffline(true);
  await click('[data-record=PLAIN_WATER]');await page.locator('#simple-amount').fill('2');
  await click('#action-form button[type=submit]');await saved();
  assert.match(await page.locator('#save-status').innerText(),/同期待ち/);
  await context.setOffline(false);await sync();
  // Medicine times remain configurable after reload.
  await click('.bottom-nav [data-route=settings]');
  await page.locator('[name=medicineTime1]').fill('07:30');await page.locator('[name=medicineTime2]').fill('13:00');
  await click('#settings-form button[value=today]');await sync();
  assert.deepEqual(await page.evaluate(()=>__mock.state.days[0].settingsSnapshot.medicine.scheduledTimes),['07:30','13:00']);
  // Distinct histories and health correction.
  await click('.bottom-nav [data-route=health]');await click('[data-edit-health]');
  await page.locator('#health-edit-time').fill('2026-09-06T09:15');await click('#action-form button[type=submit]');await saved();
  assert.match(await page.locator('#health-view').innerText(),/09:15/);
  await click('.bottom-nav [data-route=history]');await click('[data-history-kind=health]');
  await page.waitForSelector('#history-view [data-edit-health]');
  assert.equal(await page.locator('#history-view .eye-session').count(),0);
  await click('[data-history-kind=eyedrops]');await page.waitForSelector('#history-view .eye-session');
  assert.equal(await page.locator('#history-view [data-edit-health]').count(),0);
  await click('[data-history-kind=food]');assert.equal(await page.locator('#history-view .eye-session').count(),0);
  await page.screenshot({path:'/tmp/dogcalplan-history.png',fullPage:true});
  // Verify actual persisted local state (without a cloud reload).
  const stored=await page.evaluate(async()=>{const {loadState}=await import('/js/db.js');return loadState()});
  assert.equal(stored.settings.dogName,'べぬ変更');
  assert.deepEqual(stored.settings.medicine.scheduledTimes,['07:30','13:00']);
  assert.equal(stored.days[0].events.filter(e=>e.type==='PLAIN_WATER').length,3);
  await page.reload();await sync();
  assert.match(await page.locator('#today-title').innerText(),/べぬ変更/);
  assert.equal(await page.evaluate(()=>__mock.state.days[0].events.filter(e=>e.type==='PLAIN_WATER').length),3);
  // Cancellation stays visible in history and can be restored without changing nutrition.
  const waterId=await page.evaluate(()=>__mock.state.days[0].events.find(e=>e.type==='PLAIN_WATER').id);
  await click('[data-edit-event="'+waterId+'"]');await click('[data-action=void-event]');await saved();await sync();
  await click('.bottom-nav [data-route=history]');await page.locator('[data-history-day]').first().click();
  await click('[data-edit-event="'+waterId+'"]');await click('[data-action=restore-event]');await saved();await sync();
  assert.equal(await page.evaluate(id=>__mock.state.days[0].events.find(e=>e.id===id).status,waterId),'ACTIVE');
  await click('.bottom-nav [data-route=settings]');
  const downloadPromise=page.waitForEvent('download');await click('[data-export=events-csv]');
  const download=await downloadPromise;
  const csv=require('node:fs').readFileSync(await download.path(),'utf8');
  assert.match(csv,/入力単位/);assert.match(csv,/pieces/);
  assert.deepEqual(errors,[]);
  console.log('Browser regression: PASS (navigation, draft preservation, edit during sync, skip/reset, conversions, in-flight writes, medicine, separate histories, health notes/edit/conflict/export, nearest and notification scroll, IndexedDB)');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
