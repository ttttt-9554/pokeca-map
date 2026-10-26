#!/usr/bin/env node
'use strict';
// Offline regression: single store auto-selection, multiple-store choice,
// legacy preservation and store metadata never reaching public results.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const schema=fs.readFileSync(path.join(__dirname,'..','supabase',
 'lottery_private_account_store_v21_102.sql'),'utf8');
function fn(name){
 const a=app.indexOf('  function '+name+'('),b=app.indexOf('\n  }\n',a);
 assert(a>=0&&b>a,'App helper '+name+' is required');
 return app.slice(a,b+5);
}
const A='11111111-1111-4111-8111-111111111111';
const ONE='https://livepocket.jp/e/one111';
const MANY='https://livepocket.jp/e/many22';
const UNKNOWN='https://livepocket.jp/e/unknown12';
const profile={id:A,label:'自分',is_default:true,is_archived:false};
const itemOne={url:ONE,stores:[{name:'ふるいち宇都宮店',prefecture:'栃木県'}]};
const itemMany={url:MANY,stores:[
 {name:'宇都宮店',prefecture:'栃木県'},
 {name:'宇都宮店',prefecture:'栃木県'}, // duplicate ignored
 {name:'大宮店',prefecture:'埼玉県'}
]};
const escape=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;')
 .replaceAll('"','&quot;').replaceAll("'",'&#39;');
const ctx={
 lotteryItems:[itemOne,itemMany],lotteryBaseItems:[],
 lotteryStoreEntries:item=>
   Array.isArray(item.stores)&&item.stores.length?item.stores:
   item.store_name?[{name:item.store_name,prefecture:item.prefecture||''}]:[],
 lpPrivateAccountRows:()=>[profile],
 lpPrivateAccountDefault:()=>profile,
 lpPrivateAccounts:new Map([[A,profile]]),escape
};
const functions=[
 'lpTrackerAccountInput','lpTrackerCandidateStores','lpTrackerStoreControl',
 'lpTrackerAccountRowHtml','lpTrackerPrivateMarkup','lpTrackerAllocateOne',
 'lpTrackerPrivateBind'
];
const api=vm.runInNewContext(functions.map(fn).join('\n')+
 '\n({lpTrackerCandidateStores,lpTrackerStoreControl,'+
 'lpTrackerAccountRowHtml,lpTrackerPrivateMarkup,lpTrackerPrivateBind})',
 ctx,{timeout:1000});
assert.equal(api.lpTrackerCandidateStores(ONE).length,1);
assert.equal(api.lpTrackerCandidateStores(MANY).length,2);
assert.equal(api.lpTrackerCandidateStores(UNKNOWN).length,0);

const ticket={account_id:A,application_count:1,won_count:0,lost_count:0};
let html=api.lpTrackerPrivateMarkup({event_url:ONE,application_count:1,
 won_count:0,lost_count:0,account_entries:[ticket]});
assert.match(html,/応募店舗：ふるいち宇都宮店（栃木県）（自動設定）/);
assert.doesNotMatch(html,/data-lp-account-store/,'Single store is never editable');
html=api.lpTrackerPrivateMarkup({event_url:MANY,application_count:1,
 won_count:0,lost_count:0,account_entries:[ticket]});
assert.match(html,/data-lp-account-store required/);
assert.match(html,/店舗を選択してください/);
assert.match(html,/宇都宮店（栃木県）/);
assert.match(html,/大宮店（埼玉県）/);
html=api.lpTrackerPrivateMarkup({event_url:MANY,application_count:1,
 won_count:0,lost_count:0,account_entries:[{
 ...ticket,store_name:'大宮店',store_prefecture:'埼玉県'
}]});
assert.match(html,/<option value="1" selected>大宮店（埼玉県）<\/option>/);
html=api.lpTrackerPrivateMarkup({event_url:MANY,application_count:1,
 won_count:0,lost_count:0,account_entries:[{
 ...ticket,store_name:'過去の店舗',store_prefecture:'東京都'
}]});
assert.match(html,/value="previous" selected/);
assert.match(html,/過去の店舗（東京都）/);
html=api.lpTrackerPrivateMarkup({event_url:UNKNOWN,application_count:1,
 won_count:0,lost_count:0,account_entries:[{
 ...ticket,store_name:'過去の店舗',store_prefecture:'東京都'
}]});
assert.match(html,/以前の登録を保持/);
assert.doesNotMatch(html,/data-lp-account-store/);

function collector(url,selected,previous=null){
 const data=previous||{event_url:url,application_count:1,
  won_count:0,lost_count:0,account_entries:[ticket]};
 const originals=Object.fromEntries(['application_count','won_count','lost_count']
  .map(k=>[k,{value:'0'}]));
 const unassigned={hidden:true,querySelector(sel){
  const name=sel.match(/data-lp-account-count="([^"]+)"/)?.[1];
  return name?originals[name]:null;
 }};
 const choice={value:A}, outcome={value:'pending'},store={value:selected};
 const row={
  querySelector(sel){
   if(sel==='[data-lp-account-id]')return choice;
   if(sel==='[data-lp-account-outcome]')return outcome;
   if(sel==='[data-lp-account-store]')return store;
   return null;
  }
 };
 const holder={querySelectorAll:()=>[row]};
 const root={addEventListener(){},querySelector(){return null}};
 const form={elements:{
  application_count:{value:'1'},won_count:{value:'0'},lost_count:{value:'0'},
  status:{value:'applied'}
 }};
 ctx.$=id=>({
  lpTrackPrivateAccounts:root,lpTrackAccountRows:holder,lpTrackUnassigned:unassigned
 }[id]||null);
 const binder=api.lpTrackerPrivateBind(form,()=>{},url,data);
 return binder;
}
assert.throws(()=>collector(MANY,'').collect(),/応募店舗を選択/);
let result=collector(MANY,'1').collect();
assert.equal(result.account_entries[0].store_name,'大宮店');
assert.equal(result.account_entries[0].store_prefecture,'埼玉県');
assert.equal(result.application_count,1);
assert.deepEqual(Object.keys(result.account_entries[0]).sort(),
 ['account_id','application_count','lost_count','store_name','store_prefecture','won_count'].sort());
result=collector(ONE,'').collect();
assert.equal(result.account_entries[0].store_name,'ふるいち宇都宮店');
assert.equal(result.account_entries[0].store_prefecture,'栃木県');
result=collector(UNKNOWN,'', {event_url:UNKNOWN,account_entries:[{
 ...ticket,store_name:'過去の店舗',store_prefecture:'東京都'
}]}).collect();
assert.equal(result.account_entries[0].store_name,'過去の店舗');
result=collector(MANY,'previous',{event_url:MANY,account_entries:[{
 ...ticket,store_name:'旧店舗',store_prefecture:'群馬県'
}]}).collect();
assert.equal(result.account_entries[0].store_name,'旧店舗');
assert.throws(()=>collector(MANY,'44').collect(),/応募店舗を選択/);
assert.match(schema,/store_name/);
assert.match(schema,/store_prefecture/);
assert.match(schema,/Invalid application store/);
const results=app.slice(app.indexOf('  const LP_RESULTS_COUNT_RPC='),
 app.indexOf('  const LP_PRIVATE_ACCOUNT_TABLE='));
assert.doesNotMatch(results,/store_prefecture|account_entries|lpPrivateAccount/);
console.log('Private store selector: auto single, required multi, saved legacy and privacy OK');
