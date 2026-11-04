'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('dev_unified_review_v21_124.js','utf8'),nodes={},timers=[];
for(const id of ['lpDevUnifiedPanel','lpDevUnifiedSearch','lpDevUnifiedFilter','lpDevUnifiedCounts','lpDevUnifiedStatus','lpDevUnifiedList','lpDevUnifiedCompletedList','lpDevUnifiedRefresh','lpDevUnifiedMore','lpDevUnifiedPendingCount','lpDevUnifiedDoneCount'])nodes[id]={value:id==='lpDevUnifiedFilter'?'all':'',innerHTML:'',textContent:'',events:{},addEventListener(k,fn){(this.events[k]??=[]).push(fn)},closest(){return null}};
const window={},document={getElementById:id=>nodes[id]},url='https://livepocket.jp/e/test123',item={url,event_title:'抽選',application_start_at:'2026-11-01T10:00:00+09:00',application_end_at:'2026-11-08T10:00:00+09:00'};
vm.runInNewContext(src,{window,document,setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout:()=>{},console});
let status='none',selected=null;
const opts={isDeveloper:()=>true,snapshot:()=>({base:[item],items:[item],card:new Map(),location:new Map(),cloud:new Map(),external:new Map(),diagnostics:[]}),validUrl:()=>true,isLivePocket:u=>u.startsWith('https://livepocket.jp/'),stores:()=>[],areas:()=>[],validTitle:()=>true,expired:()=>false,escape:x=>String(x),openEditor:async()=>{},refreshSources:async()=>{},fetchOne:async()=>({livepocket:true,request_id:'id1',status:'pending',fields:{}}),getLivepocketFetches:async()=>status==='none'?[]:[{url,request_id:'id1',status:'success',fields:{stores:[{name:'確認店',prefecture:'東京都'}]},message:'取得しました'}],openFetchedEditor:async(u,f)=>{selected=f}};
(async()=>{
 window.TorecaUnifiedReview.init(opts);await Promise.resolve();await Promise.resolve();
 const handlers=nodes.lpDevUnifiedList.events.click,click={target:{closest:s=>s==='button[data-lp-dev-unified-fetch]'?{dataset:{lpDevUnifiedFetch:url}}:null}};
 await Promise.all(handlers.map(h=>h(click)));assert.match(nodes.lpDevUnifiedList.innerHTML,/取得待ち/);assert.match(nodes.lpDevUnifiedList.innerHTML,/次の収集/);
 status='done';assert(timers.length);timers.shift()();await new Promise(r=>setImmediate(r));
 assert.match(nodes.lpDevUnifiedList.innerHTML,/確認店（東京都）/);assert.match(nodes.lpDevUnifiedList.innerHTML,/取得候補を編集画面へ/);
 const use={target:{closest:s=>s==='button[data-lp-dev-unified-use]'?{dataset:{lpDevUnifiedUse:url}}:null}};
 await Promise.all(handlers.map(h=>h(use)));assert.equal(selected.stores[0].name,'確認店');
 console.log('LivePocket individual queue updates UI and passes store candidates');
})().catch(e=>{console.error(e);process.exitCode=1});
