#!/usr/bin/env node
// Personal account labels and lottery allocation regression (no login/network).
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'..','supabase',
  'lottery_private_application_accounts_v21_100.sql'),'utf8');

function extract(name){
  const start=app.indexOf('  function '+name+'(');
  const end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Function not found: '+name);
  return app.slice(start,end+'\n  }'.length);
}
const context={
  lpPrivateAccounts:new Map(),
  escape:x=>String(x).replace(/&/g,'&amp;').replace(/"/g,'&quot;')
                    .replace(/</g,'&lt;'),
};
const api=vm.runInNewContext([
 'lpPrivateAccountDefault','lpPrivateAccountRows',
 'lpTrackerAccountInput','lpTrackerAccountRowHtml','lpTrackerPrivateMarkup'
].map(extract).join('\n')+
 '\n({lpPrivateAccountDefault,lpPrivateAccountRows,lpTrackerPrivateMarkup})',
 context,{timeout:1000});

const past={application_count:4,won_count:2,lost_count:1,account_entries:[]};
assert.match(api.lpTrackerPrivateMarkup(past),/アカウントを登録/);
const id1='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';
context.lpPrivateAccounts.set(id1,{
 id:id1,label:'メイン',is_default:true,is_archived:false,created_at:'2026-10-20'
});
context.lpPrivateAccounts.set(id2,{
 id:id2,label:'サブ',is_default:false,is_archived:false,created_at:'2026-10-21'
});
assert.equal(api.lpPrivateAccountDefault().id,id1);
let html=api.lpTrackerPrivateMarkup(past);
assert.match(html,/未割当（以前の記録）/);
assert.match(html,/name="[^"]*"|data-lp-account-count="application_count"/);
assert.match(html,/id="lpTrackUnassigned"[\s\S]*?application_count"[^>]*value="4"/);
assert.match(html,/id="lpTrackUnassigned"[\s\S]*?won_count"[^>]*value="2"/);
assert.match(html,/id="lpTrackUnassigned"[\s\S]*?lost_count"[^>]*value="1"/);
assert.match(html,/data-lp-account-id required>/);
assert.match(html,/value="0"/);
assert.match(html,/selected[^>]*>メイン/);

const assigned={
 application_count:4,won_count:2,lost_count:1,
 account_entries:[{account_id:id2,application_count:3,won_count:1,lost_count:1}]
};
html=api.lpTrackerPrivateMarkup(assigned);
assert.match(html,/id="lpTrackUnassigned"[\s\S]*?application_count"[^>]*value="1"/);
assert.match(html,/id="lpTrackUnassigned"[\s\S]*?won_count"[^>]*value="1"/);
assert.match(html,/id="lpTrackUnassigned"[\s\S]*?lost_count"[^>]*value="0"/);
assert.match(html,/selected[^>]*>サブ/);
assert.doesNotMatch(html,/selected[^>]*>メイン/);

context.lpPrivateAccounts.get(id2).is_archived=true;
assert.match(api.lpTrackerPrivateMarkup(assigned),/サブ（非表示）/);
assert.equal(api.lpPrivateAccountDefault().id,id1);
context.lpPrivateAccounts.get(id1).is_archived=true;
assert.equal(api.lpPrivateAccountDefault(),null);

assert.match(schema,/enable row level security/);
assert.match(schema,/using \(\(select auth\.uid\(\)\) = user_id\)/);
assert.match(schema,/with check \(\(select auth\.uid\(\)\) = user_id\)/);
assert.match(schema,/SECURITY INVOKER/i);
assert.match(schema,/Private account does not belong to this user/);
assert.match(schema,/account_entries jsonb not null default/);
assert.match(app,/payload\.account_entries=values\.account_entries/);
assert.match(app,/\.select\('event_url,status,application_count,won_count,lost_count,account_entries/);
assert.match(app,/lpPrivateAccountDefault\(\)/);
assert.match(app,/lpTrackPrivateAccounts/);
assert.match(app,/lpPrivateAccountManage/);
assert.match(app,/未割当を既定アカウントへ移動/);
assert.doesNotMatch(app.slice(app.indexOf('function lpResultsRender()'),
  app.indexOf('async function lpResultsRefresh')),/lpPrivateAccounts|account_entries/);

// Exercise the same allocation collector used by the real modal, with tiny
// DOM stand-ins. No credentials or network are involved in this test.
function cells(values){
  const data=Object.fromEntries(Object.entries(values)
    .map(([key,value])=>[key,{value:String(value)}]));
  return {
    data,
    querySelector(selector){
      const m=selector.match(/data-lp-account-count="([^"]+)"/);
      return m?data[m[1]]:null;
    }
  };
}
function accountRow(id,values){
  const row=cells(values),select={value:id};
  return {
    select,
    cells:row.data,
    querySelector(sel){return sel==='[data-lp-account-id]'?select:row.querySelector(sel);}
  };
}
context.lpPrivateAccounts.get(id1).is_archived=false;
context.lpPrivateAccounts.get(id2).is_archived=false;
const privateHost={listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}};
const legacy=cells({application_count:1,won_count:0,lost_count:1});
const savedRow=accountRow(id1,{application_count:2,won_count:1,lost_count:0});
const activeRows=[savedRow];
const holder={
  querySelectorAll(selector){
    assert.equal(selector,'[data-lp-account-row]');return activeRows;
  },
  insertAdjacentHTML(){throw Error('Unexpected add-row in this test');}
};
const fieldElements={
  application_count:{value:'3',readOnly:false},
  won_count:{value:'1',readOnly:false},
  lost_count:{value:'1',readOnly:false}
};
const fakeForm={
  elements:fieldElements,
  querySelector(selector){return selector==='#lpTrackPrivateAccounts'?privateHost:null;}
};
const fakeItems={
  lpTrackPrivateAccounts:privateHost,
  lpTrackAccountRows:holder,
  lpTrackUnassigned:legacy,
  lpTrackEditorMessage:{textContent:''}
};
context.$=key=>fakeItems[key]||null;
const bindTest=vm.runInNewContext(
  extract('lpTrackerApplyOutcome')+'\n'+
  extract('lpTrackerPrivateBind')+'\n({lpTrackerPrivateBind})',
  {...context,
    lpPrivateAccountRows:api.lpPrivateAccountRows,
    lpPrivateAccountDefault:api.lpPrivateAccountDefault},
  {timeout:1000}
);
const controls=bindTest.lpTrackerPrivateBind(fakeForm,()=>{});
assert.equal(fieldElements.application_count.readOnly,true);
assert.equal(fieldElements.application_count.value,'3');
assert.equal(fieldElements.won_count.value,'1');
assert.equal(fieldElements.lost_count.value,'1');
let saved=controls.collect();
assert.equal(saved.application_count,3);
assert.equal(saved.won_count,1);
assert.equal(saved.lost_count,1);
assert.equal(saved.account_entries.length,1);
assert.equal(saved.account_entries[0].account_id,id1);
assert.equal(saved.account_entries[0].application_count,2);

// An incorrect outcome count must never be saved.
savedRow.cells.won_count.value='3';
assert.throws(()=>controls.collect(),/口数が不正/);
savedRow.cells.won_count.value='1';
const conflicting=accountRow(id1,{application_count:1,won_count:0,lost_count:0});
activeRows.push(conflicting);
assert.throws(()=>controls.collect(),/重複/);
activeRows.pop();
// Unapplying resets all per-account and legacy quantities consistently.
controls.adjustStatus('not_applied');
saved=controls.collect();
assert.equal(saved.application_count,0);
assert.equal(saved.account_entries.length,0);
assert.equal(fieldElements.won_count.value,'0');
// Selecting "applied" again uses the saved default instead of guessing the
// account behind previously unallocated historical tickets.
controls.adjustStatus('applied');
saved=controls.collect();
assert.equal(saved.application_count,1);
assert.equal(saved.account_entries[0].account_id,id1);


function pureFunction(name){
  const from=app.indexOf('  function '+name+'(');
  const until=app.indexOf('\n  }\n',from);
  assert(from>=0&&until>from,'Expected '+name);
  return app.slice(from,until+5);
}
const accounting=vm.runInNewContext(pureFunction('lpTrackerApplyOutcome')+
  '\n(lpTrackerApplyOutcome)',{},{timeout:1000});
const outcome=(bucket,status)=>{
  const v=accounting(bucket,status);
  return [...v].map(({application_count,won_count,lost_count})=>
    ({application_count,won_count,lost_count}));
};
const known=(app,won,lost,is_default=false)=>({
  application_count:app,won_count:won,lost_count:lost,is_default
});
assert.deepEqual(outcome([known(0,0,0,true),known(2,0,0)],'won'),
  [ {application_count:0,won_count:0,lost_count:0},
    {application_count:2,won_count:1,lost_count:0} ],
  'A historical pending ticket receives its own win, not an invented default owner');
assert.deepEqual(outcome([known(0,0,0,true),known(0,0,0)],'won'),
  [ {application_count:1,won_count:1,lost_count:0},
    {application_count:0,won_count:0,lost_count:0} ],
  'New first application can use the default account');
assert.deepEqual(outcome([known(1,0,1,true),known(0,0,0)],'won'),
  [ {application_count:2,won_count:1,lost_count:1},
    {application_count:0,won_count:0,lost_count:0} ],
  'A new win with no pending ticket adds an application and keeps per-account validity');
assert.deepEqual(outcome([known(1,0,0,true),known(1,0,0)],'lost'),
  [ {application_count:1,won_count:0,lost_count:1},
    {application_count:1,won_count:0,lost_count:0} ]);
assert.deepEqual(outcome([known(3,1,1,true),known(1,0,1)],'not_applied'),
  [ {application_count:0,won_count:0,lost_count:0},
    {application_count:0,won_count:0,lost_count:0} ]);
assert.deepEqual(outcome([known(3,1,1,true),known(1,0,1)],'won'),
  [ {application_count:3,won_count:1,lost_count:1},
    {application_count:1,won_count:0,lost_count:1} ],
  'Do not duplicate results when a saved won ticket already exists');
console.log('Private account allocation and owner isolation source tests passed');
