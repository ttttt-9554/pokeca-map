#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=fs.readFileSync(path.join(root,'dev_unified_review_v21_124.js'),'utf8');
assert.match(html,/id="lpDevUnifiedPanel"/);
assert.match(html,/id="lpDevUnifiedList"/);
const unifiedStart=html.indexOf('<section id="lpDevUnifiedPanel"');
const unifiedEnd=html.indexOf('</section>',unifiedStart);
const archive=html.indexOf('id="lpCardHiddenPanel"',unifiedStart);
assert(archive>unifiedStart&&archive<unifiedEnd,
  'The recovery panel is nested inside the developer review accordion');
assert.match(html,/dev_unified_review_v21_124\.js/);
assert.match(app,/TorecaUnifiedReview\?\.render/);
assert.match(app,/TorecaUnifiedReview\?\.fieldsFor/);
assert.match(app,/lpDevAdvancedTools/);
assert.match(app,/cardStoresEdited\(x\.url\)/);
assert.match(app,/if\(confirmed\)\{/);
assert.match(app,/lpCardShouldDelete\(reset,edited.length,lpCardReviewUrl===url,saved\)/);
assert.match(app,/lpCardVerifiedStores\(desiredStores\)/);
assert.doesNotMatch(app,/if\(!review\|\|!confirmed\|\|/);
const nodes=new Map();
for(const id of ['lpDevUnifiedPanel','lpDevUnifiedSearch','lpDevUnifiedFilter',
 'lpDevUnifiedCounts','lpDevUnifiedStatus','lpDevUnifiedList','lpDevUnifiedCompletedList',
 'lpDevUnifiedRefresh','lpDevUnifiedMore','lpDevUnifiedPendingCount','lpDevUnifiedDoneCount']){
 nodes.set(id,{value:id==='lpDevUnifiedFilter'?'all':'',textContent:'',innerHTML:'',
  hidden:false,disabled:false,events:{},
  addEventListener(name,fn){this.events[name]=fn;},closest(){return null}});
}
const window={},document={getElementById:id=>nodes.get(id)};
vm.runInNewContext(script,{window,document},{timeout:1000});
const ui=window.TorecaUnifiedReview,url='https://livepocket.jp/e/test888';
const base={url,event_title:'仮イベント名',event_title_provisional:true,
 application_start_at:'2026-11-01T10:00:00+09:00',
 application_end_at:null,store_name:'',prefecture:''};
const state={base:[base],items:[{...base}],card:new Map(),
 location:new Map(),cloud:new Map(),external:new Map(),
 diagnostics:[{url,missing:['title','store','deadline']}]};
let authorized=false;
const opts={isDeveloper:()=>authorized,snapshot:()=>state,validUrl:x=>x.startsWith('https://'),
 isLivePocket:()=>true,stores:item=>Array.isArray(item.stores)?item.stores:
   item.store_name?[{name:item.store_name,prefecture:item.prefecture}]:[],
 areas:item=>item.prefecture?[item.prefecture]:item.stores?.map(s=>s.prefecture).filter(Boolean)||[],
 validTitle:x=>String(x||'').trim().length>=5,
 expired:()=>false,escape:x=>String(x),openEditor:async()=>{},refreshSources:async()=>{}};
ui.init(opts);
assert.equal(typeof nodes.get('lpDevUnifiedRefresh').events.click,'function',
 'Controls must be bound even before Discord authentication');
assert.equal(ui.collect().length,0,'No developer login means no review data');
authorized=true;ui.onAuthChanged();
let rows=ui.collect();
assert.equal(rows.length,1);
for(const kind of ['title','store','area','deadline'])assert(rows[0].missing.includes(kind),kind);
assert(!rows[0].missing.includes('start'));
assert.equal(ui.validArea('未確認県'),false);
assert.equal(ui.validArea('栃木県'),true);
assert.equal(ui.validArea('全国'),true);
assert.equal(ui.validStore('店舗未確認'),false);
assert.match(nodes.get('lpDevUnifiedCounts').innerHTML,/未対応 1件/);

// Supplied placeholder labels must never be treated as verified shop/location.
// Published diagnostics may lag behind a corrected card, so test the effective
// values independently with no diagnostic hints.
const earlierItems=state.items,earlierDiagnostics=state.diagnostics;
state.diagnostics=[];
state.items=[{...base,event_title:'正式な抽選の名前',event_title_provisional:false,
 store_name:'店名未確認',prefecture:'都道府県未確認'}];
rows=ui.collect();
assert(rows[0].missing.includes('store'),
 'Store-name placeholder must remain unresolved');
assert(rows[0].missing.includes('area'),
 'Prefecture placeholder must remain unresolved');
state.items=[{...state.items[0],store_name:'確認済み宇都宮店',
 prefecture:'栃木県'}];
rows=ui.collect();
assert(!rows[0].missing.includes('store')&&!rows[0].missing.includes('area'),
 'Real store and prefecture resolve these two fields without waiting for diagnostic JSON');
// Source diagnostics may lag behind the effective corrected card.
state.diagnostics=earlierDiagnostics;
rows=ui.collect();
assert(!rows[0].missing.includes('store')&&!rows[0].missing.includes('area'));
state.items=[{...state.items[0],prefecture:'未確認県'}];
assert(ui.collect()[0].missing.includes('area'),'Reject fake prefecture');
state.items=[{...state.items[0],prefecture:'全国'}];
assert(!ui.collect()[0].missing.includes('area'),'Accept nationwide');
state.items=earlierItems;state.diagnostics=earlierDiagnostics;
state.card.set(url,{edited_fields:['event_title','stores','application_end_at']});
state.items=[{...base,event_title:'修正完了イベント名',event_title_provisional:false,
 stores:[{name:'確認済み店舗',prefecture:'栃木県'}],prefecture:'栃木県',
 application_end_at:'2026-11-07T20:00:00+09:00'}];
ui.render();rows=ui.collect();
assert.equal(rows[0].missing.length,0);
assert.match(nodes.get('lpDevUnifiedCounts').innerHTML,/未対応 0件/);
assert.match(nodes.get('lpDevUnifiedCompletedList').innerHTML,/手動修正済み/);
state.card.set(url,{edited_fields:['event_title'],review_complete:true,
 review_deadline_unpublished:true});
state.items=[{...state.items[0],application_end_at:null}];
rows=ui.collect();
assert(!rows[0].missing.includes('deadline'),'Confirmed missing deadline must be resolved');
console.log('Unified developer review and card-save sync verified');
