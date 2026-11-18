'use strict';
// Exercise the real editor and save path against local Postgres, without network
// requests, production records, or notification sends.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const {PGlite}=require('@electric-sql/pglite');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261118080126_lottery_tracker_standalone_store.sql'),'utf8');
const validator=fs.readFileSync(path.join(root,'supabase/lottery_private_account_store_v21_102.sql'),'utf8');
function extract(name){
  const match=new RegExp('  (?:async )?function '+name+'\\(').exec(app);
  assert(match,'Missing '+name);
  return app.slice(match.index,app.indexOf('\n  }\n',match.index)+5);
}
const user='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const account='33333333-3333-4333-8333-333333333333';
const one='https://livepocket.jp/e/storeone';
const many='https://example.com/lottery/many';
const unknown='https://example.com/lottery/unknown';
const stores=[{name:'東京 <本店>',prefecture:'東京都'},{name:'横浜店',prefecture:'神奈川県'}];
const tables=['lottery_user_entries','lottery_external_user_entries'];

async function main(){
  const db=new PGlite();
  await db.exec(`create role authenticated; create role anon;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    create table lottery_private_accounts(id uuid primary key,user_id uuid not null);
    grant select on lottery_private_accounts to authenticated;
    insert into lottery_private_accounts values ('${account}','${user}');`);
  // Match the existing production owner policies and account validation trigger.
  for(const table of tables){
    await db.exec(`create table ${table} (
      user_id uuid not null,event_url text not null,status text default 'not_applied',
      application_count int default 0,won_count int default 0,lost_count int default 0,
      account_entries jsonb not null default '[]',onsite_required boolean default false,
      onsite_done boolean default false,pickup_start date,pickup_end date,
      pickup_start_time time,pickup_end_time time,result_announcement_date date,
      result_announcement_time time,result_announcement_at timestamp,
      note text default '',updated_at timestamptz default now(),primary key(user_id,event_url));
      alter table ${table} enable row level security;
      create policy owner_select on ${table} for select to authenticated using ((select auth.uid())=user_id);
      create policy owner_insert on ${table} for insert to authenticated with check ((select auth.uid())=user_id);
      create policy owner_update on ${table} for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
      create policy owner_delete on ${table} for delete to authenticated using ((select auth.uid())=user_id);
      grant select,insert,update,delete on ${table} to authenticated;
      insert into ${table}(user_id,event_url) values ('${user}','https://example.com/old');`);
  }
  await db.exec(validator);
  for(const table of tables)await db.exec(`create trigger validate_accounts before insert or update on ${table}
    for each row execute function lottery_validate_private_account_entries();`);
  await db.exec(migration);
  await db.exec(migration); // Additive migration is safe to replay.
  for(const table of tables){
    const old=(await db.query(`select store_name,store_prefecture,account_entries from ${table}`)).rows[0];
    assert.deepEqual(old,{store_name:'',store_prefecture:'',account_entries:[]});
  }
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  const dom=new JSDOM('<dialog id="lpTrackerEditor"><h3 data-dialog-title-focus tabindex="-1">管理</h3><button id="lpTrackStickyClose"></button><div id="lpTrackerEditorBody"></div></dialog>',{url:'https://example.com/'});
  const {window}=dom;
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  const records=new Map(),profiles=new Map(),writes=[];
  const items=[{url:one,stores:[stores[0]]},{url:many,stores},{url:unknown}];
  const schedule={pickup_start:'',pickup_end:'',pickup_start_time:'',pickup_end_time:'',result_announcement_date:'',result_announcement_time:''};
  const context={window,document:window.document,FormData:window.FormData,
    $:id=>window.document.getElementById(id),requestAnimationFrame:fn=>fn(),
    escape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    alert:message=>{throw Error(message);},confirm:()=>true,
    authUser:{id:user},lotteryTrackSaving:false,lotteryTrackError:'',
    lotteryItems:items,lotteryBaseItems:[],lotteryTrackRecords:records,
    lotteryStoreEntries:item=>item.stores||[],lotteryTrackRecord:url=>records.get(url),
    lotteryTrackItemName:()=> '同じ商品名',
    lotteryTrackerSchedule:()=>schedule,lotteryTrackerScheduleOverrides:()=>({}),
    lotteryPickupPeriodReversed:()=>false,safeLotteryUrl:url=>/^https:\/\//.test(url),
    lotteryScheduleDate:value=>value||'',lotteryScheduleTime:value=>value||'',
    lpPrivateAccountReady:true,lpPrivateAccountUser:user,lpPrivateAccounts:profiles,
    lpPrivateAccountRows:()=>[...profiles.values()],lpPrivateAccountDefault:()=>[...profiles.values()][0],
    lpAppEventId:()=>'',lpTrackerCanonicalStore:store=>store,
    LP_TRACK_STATUSES:['not_applied','applied','won','lost','received'],LP_TRACK_LABELS:{},
    LP_TRACK_SELECT:'*',lotteryTrackTableFor:url=>url===one?tables[0]:tables[1],
    renderLotteryTrackerSummary(){},renderLottery(){},lpResultsRefresh(){},
    supabaseClient:{from(table){assert(tables.includes(table));return {upsert(payload){
      writes.push(JSON.parse(JSON.stringify(payload)));
      return {select(){return {single:async()=>{
        const keys=Object.keys(payload),values=keys.map(key=>Array.isArray(payload[key])?JSON.stringify(payload[key]):payload[key]);
        try{
          const result=await db.query(`insert into ${table} (${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')})
            on conflict(user_id,event_url) do update set ${keys.filter(key=>!['user_id','event_url'].includes(key)).map(key=>key+'=excluded.'+key).join(',')} returning *`,values);
          return {data:result.rows[0],error:null};
        }catch(error){return {data:null,error};}
      }}}};
    }}}}
  };
  const names=['lotteryTrackAnnouncement','lotteryTrackClean','lotteryTrackerDefaults',
    'showLotteryEditorDialog','lpTrackerExpandMemo','lpTrackerAccountInput','lpTrackerCandidateStores',
    'lpTrackerStoreControl','lpTrackerRecordStore','lpTrackerChosenStores','lpTrackerRecordStoreMarkup',
    'lpTrackerRecordStoreBind','lpTrackerAccountRowHtml','lpTrackerPrivateMarkup','lpTrackerAllocateOne',
    'lpTrackerPrivateBind','lotteryTrackStoreLabel','lotteryTrackerOpenEditor','lotteryTrackerSave'];
  const api=vm.runInNewContext(names.map(extract).join('\n')+'\n({lotteryTrackerOpenEditor,lotteryTrackerSave,lotteryTrackStoreLabel,lotteryTrackClean,lpTrackerChosenStores})',context);
  const form=()=>context.$('lpTrackerForm');
  const input=(element,value,type='input')=>{element.value=value;element.dispatchEvent(new window.Event(type,{bubbles:true}));};
  async function save(){
    assert(form().checkValidity(),'Editor must have no invalid hidden fields');
    form().dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
    for(let i=0;i<100&&context.lotteryTrackSaving;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(context.$('lpTrackEditorMessage').textContent,'保存中…');
    assert.equal(context.$('lpTrackerEditor').open,false,'Successful save closes editor');
  }
  async function reload(url){
    const table=context.lotteryTrackTableFor(url);
    const row=(await db.query(`select * from ${table} where event_url=$1`,[url])).rows[0];
    records.set(url,api.lotteryTrackClean(row));
    await api.lotteryTrackerOpenEditor(url);
  }
  await api.lotteryTrackerOpenEditor(one);
  assert(context.$('lpTrackRecordStore').textContent.includes(stores[0].name));
  assert.equal(context.$('lpTrackRecordStore').querySelector('input,select'),null,'Single store is fixed');
  assert.equal(context.$('lpTrackRecordStore').querySelector('本店'),null,'Store HTML is escaped');
  input(form().elements.status,'applied','change');
  await save();
  assert.equal(writes.at(-1).store_name,stores[0].name);
  assert.deepEqual(writes.at(-1).account_entries,[],'No profile is required or fabricated');
  await reload(one);
  assert.equal(form().elements.application_count.value,'1');
  assert.equal(records.get(one).store_name,stores[0].name);
  await api.lotteryTrackerOpenEditor(many);
  input(form().elements.application_count,'2');
  assert.equal(form().checkValidity(),false,'Multi-store applications require a choice');
  input(form().querySelector('[data-lp-record-store]'),'1','change');
  await save();
  assert.equal(writes.at(-1).store_name,stores[1].name);
  await reload(many);
  assert.equal(form().querySelector('[data-lp-record-store]').value,'1');
  assert.equal(api.lotteryTrackStoreLabel(many,records.get(many)),'横浜店（神奈川県）');
  profiles.set(account,{id:account,label:'本人用',is_default:true});
  await reload(many);
  assert.equal(form().elements.application_count.readOnly,false,'Existing profiles do not require per-event assignment');
  input(form().elements.application_count,'3');
  input(form().elements.won_count,'1');
  await save();
  assert.equal(writes.at(-1).application_count,3);
  assert.equal(writes.at(-1).status,'won','Unassigned wins are not auto-received');
  assert.deepEqual(writes.at(-1).account_entries,[]);
  await reload(many);
  context.$('lpTrackAccountAdd').click();
  assert.equal(form().querySelector('[data-lp-account-store]').value,'1','Moving a ticket preserves its chosen store');
  input(form().querySelector('[data-lp-account-store]'),'0','change');
  await save();
  assert.equal(writes.at(-1).application_count,3,'Moving to an account does not add a ticket');
  assert.equal(writes.at(-1).account_entries[0].store_name,stores[0].name);
  assert.equal(writes.at(-1).store_name,stores[1].name,'Unassigned store remains independent');
  assert.equal(api.lpTrackerChosenStores(records.get(many)).length,2);
  await reload(one);
  context.$('lpTrackAccountAdd').click();
  assert.equal(context.$('lpTrackRecordStore').hidden,true,'No duplicate store field when all tickets have accounts');
  assert(form().querySelector('[data-lp-account-row] [data-lp-store-fixed]'));
  await save();
  assert.equal(writes.at(-1).account_entries[0].store_name,stores[0].name);
  await api.lotteryTrackerOpenEditor(unknown);
  input(form().elements.application_count,'1');
  input(context.$('lpTrackRecordStore').querySelector('[data-lp-manual-store-name]'),'未掲載店');
  input(context.$('lpTrackRecordStore').querySelector('[data-lp-manual-store-pref]'),'千葉県');
  await save();
  await reload(unknown);
  assert.equal(context.$('lpTrackRecordStore').querySelector('[data-lp-manual-store-name]').value,'未掲載店');
  for(const table of tables){
    await assert.rejects(db.query(`update ${table} set store_name=$1`,['x'.repeat(201)]),/check constraint/);
    await assert.rejects(db.query(`update ${table} set store_name=$1`,['店\n舗']),/check constraint/);
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false);`);
    assert.equal((await db.query(`select * from ${table}`)).rows.length,0,'Other users cannot read choices');
    assert.equal((await db.query(`update ${table} set store_name='changed' returning *`)).rows.length,0);
    assert.equal((await db.query(`delete from ${table} returning *`)).rows.length,0);
    await assert.rejects(db.query(`insert into ${table}(user_id,event_url,store_name) values ($1,$2,$3)`,[user,'https://example.com/no','bad']),/row-level security/);
    await db.exec(`reset role; set role anon;`);
    await assert.rejects(db.query(`select store_name from ${table}`),/permission denied/);
    await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  }
  dom.window.close();
  await db.close();
  console.log('Standalone stores: actual editor/save/reload, fixed single, multi choice, optional accounts, mixed allocations and owner-only persistence passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
