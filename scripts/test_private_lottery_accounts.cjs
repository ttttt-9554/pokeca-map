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
console.log('Private account allocation and owner isolation source tests passed');
