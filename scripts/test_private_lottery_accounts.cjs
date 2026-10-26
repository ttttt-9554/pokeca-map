#!/usr/bin/env node
'use strict';
// Private accounts do not reveal identifiers in public lottery results.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'..','supabase',
  'lottery_private_application_accounts_v21_100.sql'),'utf8');
const migration=fs.readFileSync(path.join(__dirname,'..','supabase',
  'lottery_private_account_one_ticket_v21_101.sql'),'utf8');
function source(name){
 const start=app.indexOf('  function '+name+'(');
 const end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,'Function not found: '+name);
 return app.slice(start,end+5);
}
const one='11111111-1111-4111-8111-111111111111';
const two='22222222-2222-4222-8222-222222222222';
const context={lpPrivateAccounts:new Map(),escape:x=>String(x),
 lpTrackerCandidateStores:()=>[]};
const api=vm.runInNewContext([
 'lpPrivateAccountDefault','lpPrivateAccountRows',
 'lpTrackerAccountInput','lpTrackerStoreControl','lpTrackerAccountRowHtml',
 'lpTrackerPrivateMarkup','lpTrackerAllocateOne'
].map(source).join('\n')+
 '\n({lpPrivateAccountDefault,lpPrivateAccountRows,lpTrackerPrivateMarkup,lpTrackerAllocateOne})',
 context,{timeout:1000});
const legacy={application_count:2,won_count:0,lost_count:0,account_entries:[]};
assert.match(api.lpTrackerPrivateMarkup(legacy),/アカウントを登録/);
context.lpPrivateAccounts.set(one,{id:one,label:'自分',
 is_default:true,is_archived:false,created_at:'2026-10-25'});
context.lpPrivateAccounts.set(two,{id:two,label:'家族',
 is_default:false,is_archived:false,created_at:'2026-10-26'});
assert.equal(api.lpPrivateAccountDefault().id,one);
const markup=api.lpTrackerPrivateMarkup(legacy);
assert.match(markup,/未割当（以前の記録）/);
assert.match(markup,/応募アカウントを追加（1口）/);
assert.match(markup,/アカウントに1口|アカウントにつき応募1口/);
assert.doesNotMatch(markup,/id="lpTrackAccountRows"[\s\S]*?<select data-lp-account-id/,
 'No account is pre-assigned merely by opening an old application');
const saved=api.lpTrackerPrivateMarkup({
 application_count:2,won_count:1,lost_count:0,
 account_entries:[
  {account_id:one,application_count:1,won_count:1,lost_count:0},
  {account_id:two,application_count:1,won_count:0,lost_count:0}
 ]
});
assert.match(saved,/🎟️ 応募 1口（自動登録）/);
assert.match(saved,/value="won" selected>当選/);
assert.match(saved,/value="pending" selected>結果待ち/);
assert.match(saved,/data-lp-account-remove>削除/);
assert.match(saved,/id="lpTrackUnassigned" hidden/);
assert.doesNotMatch(saved,/id="lpTrackAccountRows"[\s\S]*?data-lp-account-count="application_count"/,
 'Saved profiles only show outcome selectors, not ticket count inputs');
const allocation=api.lpTrackerAllocateOne({application_count:2,won_count:0,lost_count:0});
assert.equal(allocation.remaining.application_count,1);
assert.equal(allocation.outcome,'pending');
const win=api.lpTrackerAllocateOne({application_count:1,won_count:1,lost_count:0});
assert.equal(win.outcome,'won');
assert.equal(win.remaining.application_count,0);
assert.equal(win.remaining.won_count,0);
const noLegacy=api.lpTrackerAllocateOne({application_count:0,won_count:0,lost_count:0});
assert.equal(noLegacy.outcome,'pending');
assert.equal(noLegacy.remaining.application_count,0);

assert.match(schema,/enable row level security/i);
assert.match(schema,/using \(\(select auth\.uid\(\)\) = user_id\)/);
assert.match(schema,/with check \(\(select auth\.uid\(\)\) = user_id\)/);
assert.match(schema,/Private account does not belong to this user/);
assert.match(migration,/v_app <> 1 or v_won > 1 or v_lost > 1/);
assert.match(app,/payload\.account_entries=values\.account_entries/);
assert.match(app,/lpPrivateAccountDefault\(\)/);
const publicSection=app.slice(app.indexOf('  const LP_RESULTS_COUNT_RPC='),
  app.indexOf('  const LP_PRIVATE_ACCOUNT_TABLE='));
assert(!/lottery_private_accounts|account_entries|account_id/.test(publicSection),
 'Public result aggregation must not contain private labels or account IDs');
console.log('Private one-ticket account markup and owner-only schema checks passed');
