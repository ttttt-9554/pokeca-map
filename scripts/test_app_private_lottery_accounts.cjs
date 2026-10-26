#!/usr/bin/env node
// Private account allocations must preserve old totals and never join public data.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const sql=fs.readFileSync(path.join(__dirname,'..','supabase/lottery_private_application_accounts_v21_100.sql'),'utf8');
function extract(name){
  const begin=app.indexOf('  function '+name+'(');
  const end=app.indexOf('\n  }\n',begin);
  assert(begin>=0&&end>begin,'Missing '+name);
  return app.slice(begin,end+5);
}
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const profiles=[
  {id:A,label:'メイン',is_default:true,is_archived:false},
  {id:B,label:'サブ2',is_default:false,is_archived:false}
];
const htmlEscape=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const context={
  escape:htmlEscape,
  lpPrivateAccountRows:()=>profiles,
  lpPrivateAccountDefault:()=>profiles[0]
};
const names=['lpTrackerAccountInput','lpTrackerAccountRowHtml','lpTrackerPrivateMarkup'];
const api=vm.runInNewContext(names.map(extract).join('\n')+
  '\n({lpTrackerPrivateMarkup,lpTrackerAccountRowHtml})',context,{timeout:1000});
const existing={application_count:2,won_count:1,lost_count:0,
  account_entries:[{account_id:A,application_count:1,won_count:1,lost_count:0}]};
const markup=api.lpTrackerPrivateMarkup(existing);
assert.match(markup,/アカウント別の応募口数/);
assert.match(markup,/メイン/);
assert.match(markup,/未割当（以前の記録）/);
assert.match(markup,/value="1"/); // A:1, historical remainder:1
assert.match(markup,/既定アカウントへ移動/);
assert.match(markup,/本人のみ/);
assert.doesNotMatch(markup,/パスワード.*value=/);
const historical=api.lpTrackerPrivateMarkup({
  application_count:2,won_count:0,lost_count:0,account_entries:[]});
assert.match(historical,/未割当/);
assert.match(historical,/value="2"/);
const initial=api.lpTrackerPrivateMarkup({
  application_count:0,won_count:0,lost_count:0,account_entries:[]});
assert.match(initial,/メイン/);
assert.doesNotMatch(initial,/アカウント不明/);

const privateAccountSummary=vm.runInNewContext(
  extract('lotteryTrackPrivateAccountSummary')+
  '\\n({lotteryTrackPrivateAccountSummary})',
  {authUser:{id:'test-user'},lpPrivateAccountReady:true,
   lpPrivateAccounts:new Map(profiles.map(row=>[row.id,row])),
   escape:htmlEscape},{timeout:1000}
).lotteryTrackPrivateAccountSummary;
let privateText=privateAccountSummary({
  application_count:3,won_count:1,lost_count:0,
  account_entries:[{account_id:A,application_count:2,won_count:1,lost_count:0}]
});
assert.match(privateText,/メイン：2口/);
assert.match(privateText,/未割当：1口/);
assert.match(privateText,/本人のみ/);
assert.doesNotMatch(privateAccountSummary({
  application_count:2,account_entries:[{account_id:B,application_count:2}]
}),/未割当/);
assert.match(app,/\\$\\{lotteryTrackPrivateAccountSummary\\(x\\)\\}/);
const privateSection=app.slice(app.indexOf('  const LP_RESULTS_COUNT_RPC='),
  app.indexOf('  const LP_PRIVATE_ACCOUNT_TABLE='));
assert(!/lottery_private_accounts|account_entries|account_id/.test(privateSection),
  'Public result UI must never include private allocation identifiers');
assert.match(app,/\.select\('event_url,status,application_count,won_count,lost_count,account_entries,/);
assert.match(app,/payload\.account_entries=values\.account_entries/);
assert.match(sql,/alter table public\.lottery_private_accounts enable row level security/i);
assert.match(sql,/auth\.uid\(\)/);
assert.match(sql,/new\.user_id and a\.id=v_account/);
console.log('Private account profiles, legacy totals, public-result isolation and RLS guards verified');
