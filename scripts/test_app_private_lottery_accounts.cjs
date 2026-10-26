#!/usr/bin/env node
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
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const profiles=[
 {id:A,label:'自分',is_default:true,is_archived:false},
 {id:B,label:'嫁',is_default:false,is_archived:false}
];
const context={
 escape:x=>String(x),
 lpPrivateAccountRows:()=>profiles,
 lpPrivateAccountDefault:()=>profiles[0]
};
const api=vm.runInNewContext([
 'lpTrackerAccountInput','lpTrackerAccountRowHtml','lpTrackerPrivateMarkup'
].map(extract).join('\n')+'\n({lpTrackerPrivateMarkup})',context,{timeout:1000});
const historical=api.lpTrackerPrivateMarkup({
 application_count:2,won_count:0,lost_count:0,account_entries:[]
});
assert.match(historical,/未割当/);
assert.match(historical,/application_count"[^>]*value="2"/);
assert.match(historical,/id="lpTrackAccountRows"><\/div>/);
assert.match(historical,/応募アカウントを追加（1口）/);
const saved=api.lpTrackerPrivateMarkup({
 application_count:2,won_count:1,lost_count:0,
 account_entries:[{account_id:A,application_count:1,won_count:1,lost_count:0}]
});
assert.match(saved,/data-lp-account-outcome/); // outcome selector exists
assert.match(saved,/当選/);
assert.match(saved,/結果待ち/);
assert.match(saved,/削除/);
assert.match(saved,/未割当/);
const both=api.lpTrackerPrivateMarkup({
 application_count:2,won_count:1,lost_count:1,
 account_entries:[
  {account_id:A,application_count:1,won_count:1,lost_count:0},
  {account_id:B,application_count:1,won_count:0,lost_count:1}
 ]
});
assert.match(both,/id="lpTrackUnassigned" hidden/);
assert.match(both,/selected>当選/);
assert.match(both,/selected>落選/);
const accountRows=both.slice(both.indexOf('id="lpTrackAccountRows"'));
assert.doesNotMatch(accountRows,/data-lp-account-count=/,
 'Account rows must have only outcome controls; no numeric entry fields');
assert.match(app,/lpPrivateAccountDefault\(\)/);
assert.match(app,/payload\.account_entries=values\.account_entries/);
assert.match(app,/lpPrivateAccountManage/);
const resultUI=app.slice(app.indexOf('function lpResultsRender()'),
 app.indexOf('async function lpResultsRefresh'));
assert(!/lpPrivateAccounts|account_entries|account_id/.test(resultUI));
assert.match(sql,/enable row level security/);
assert.match(sql,/auth\.uid\(\)/);
assert.match(sql,/new\.user_id and a\.id=v_account/);
console.log('Private per-account outcome UI and public result separation verified');
