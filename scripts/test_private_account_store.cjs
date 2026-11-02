#!/usr/bin/env node
'use strict';
// Offline regression: single store prefill, editable branches and multiple-store choice,
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
const APP='app-lottery://private-demo';
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
 lpPrivateAccounts:new Map([[A,profile]]),escape,
 lpAppEventId:url=>url===APP?'mock-app-id':'',
 lpTrackerCanonicalStore:store=>store
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
assert.match(html,/data-lp-manual-store-name[^>]*value="ふるいち宇都宮店"/);
assert.match(html,/data-lp-manual-store-pref[^>]*value="栃木県"/);
assert.match(html,/<input type="text" data-lp-manual-store-name/,'Single-store branches remain editable');
html=api.lpTrackerPrivateMarkup({event_url:MANY,application_count:1,
 won_count:0,lost_count:0,account_entries:[ticket]});
assert.match(html,/data-lp-account-store required/);
assert.doesNotMatch(html,/data-lp-manual-store-name/);
assert.doesNotMatch(html,/data-search-|tr-search-/);
html=api.lpTrackerPrivateMarkup({event_url:MANY,application_count:1,
 won_count:0,lost_count:0,account_entries:[{
 ...ticket,store_name:'大宮店',store_prefecture:'埼玉県'
}]});
assert.match(html,/<option value="1" selected>大宮店（埼玉県）<\/option>/);
html=api.lpTrackerPrivateMarkup({event_url:MANY,application_count:1,
 won_count:0,lost_count:0,account_entries:[{
 ...ticket,store_name:'過去の店舗',store_prefecture:'東京都'
}]});
assert.match(html,/以前の応募店舗：過去の店舗/);
assert.match(html,/<option value="" selected>/);
html=api.lpTrackerPrivateMarkup({event_url:UNKNOWN,application_count:1,
 won_count:0,lost_count:0,account_entries:[{
 ...ticket,store_name:'過去の店舗',store_prefecture:'東京都'
}]});
assert.match(html,/data-lp-manual-store-name[^>]*value="過去の店舗"/);

function collector(url,selected,previous=null,manual=null){
 const data=previous||{event_url:url,application_count:1,
  won_count:0,lost_count:0,account_entries:[ticket]};
 const originals=Object.fromEntries(['application_count','won_count','lost_count']
  .map(k=>[k,{value:'0'}]));
 const unassigned={hidden:true,querySelector(sel){
  const name=sel.match(/data-lp-account-count="([^"]+)"/)?.[1];
  return name?originals[name]:null;
 }};
 const choice={value:A}, outcome={value:'pending',checked:true},store={value:selected};
 const selectedStore=manual||(selected==='previous'?{
  name:data.account_entries[0].store_name,prefecture:data.account_entries[0].store_prefecture
 }:api.lpTrackerCandidateStores(url)[Number(selected===''?NaN:selected)])||
  (url===ONE?itemOne.stores[0]:{
   name:data.account_entries[0].store_name||'',
   prefecture:data.account_entries[0].store_prefecture||''
  });
 const row={
  querySelector(sel){
   if(sel==='[data-lp-account-id]')return choice;
   if(sel==='[data-lp-account-outcome]:checked')return outcome;
   if(sel==='[data-lp-manual-store-name]')return {value:selectedStore.name||''};
   if(sel==='[data-lp-manual-store-pref]')return {value:selectedStore.prefecture||''};
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
 ['account_id','application_count','lost_count','received_count','store_name','store_prefecture','won_count'].sort());
result=collector(ONE,'').collect();
assert.equal(result.account_entries[0].store_name,'ふるいち宇都宮店');
assert.equal(result.account_entries[0].store_prefecture,'栃木県');
const changedBranch=collector(ONE,'',null,{name:'ビックカメラ宇都宮店',prefecture:'栃木県'}).collect();
assert.equal(changedBranch.account_entries[0].store_name,'ビックカメラ宇都宮店');
assert.equal(changedBranch.account_entries[0].store_prefecture,'栃木県');
result=collector(UNKNOWN,'', {event_url:UNKNOWN,account_entries:[{
 ...ticket,store_name:'過去の店舗',store_prefecture:'東京都'
}]}).collect();
assert.equal(result.account_entries[0].store_name,'過去の店舗');
assert.throws(()=>collector(MANY,'previous',{event_url:MANY,account_entries:[{
 ...ticket,store_name:'旧店舗',store_prefecture:'群馬県'
}]}).collect(),/応募店舗を選択/);
assert.equal(collector(MANY,'1',null,{name:'任意の店舗',prefecture:'東京都'}).collect().account_entries[0].store_name,'大宮店','Registered choices take precedence over typed values');
assert.doesNotMatch(api.lpTrackerStoreControl(ticket,itemMany.stores,true),/data-lp-manual-store-name/,'Multi-store app lotteries also use registered choices');
assert.throws(()=>collector(MANY,'44').collect(),/応募店舗を選択/);
html=api.lpTrackerPrivateMarkup({event_url:APP,application_count:1,
 won_count:0,lost_count:0,account_entries:[ticket]});
assert.match(html,/data-lp-manual-store-name/);
assert.match(html,/data-lp-manual-store-pref/);
assert.doesNotMatch(html,/data-lp-account-store required/);
assert.throws(()=>collector(APP,'').collect(),/店舗名と地域/);
const entered=collector(APP,'',null,{name:'宇都宮店',prefecture:'栃木県'}).collect();
assert.equal(entered.account_entries[0].store_name,'宇都宮店');
assert.equal(entered.account_entries[0].store_prefecture,'栃木県');
const canonical=vm.runInNewContext(fn('productNorm')+'\n'+fn('lpTrackerCanonicalStore')+
 '\n(lpTrackerCanonicalStore)',{lotteryItems:[itemOne,itemMany],stores:[],lotteryStoreEntries:ctx.lotteryStoreEntries,
 cloudStores:[{name:'宇都宮店',prefecture:'東京都'}]});
assert.equal(canonical({name:'ふるいち宇都宮店',prefecture:'全国'}).prefecture,'栃木県');
assert.equal(canonical({name:'宇都宮店',prefecture:''}).prefecture,'',
 'Repeated store names do not select an arbitrary prefecture');
assert.equal(canonical({name:'宇都宮店',prefecture:'東京都'}).prefecture,'東京都');
assert.match(schema,/store_name/);
assert.match(schema,/store_prefecture/);
assert.match(schema,/Invalid application store/);
const results=app.slice(app.indexOf('  const LP_RESULTS_COUNT_RPC='),
 app.indexOf('  const LP_PRIVATE_ACCOUNT_TABLE='));
assert.doesNotMatch(results,/store_prefecture|account_entries|lpPrivateAccount/);
console.log('Private stores: editable prefill, typed branch, required multi, saved legacy and privacy OK');
