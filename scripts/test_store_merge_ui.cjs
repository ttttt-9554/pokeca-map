#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),code=fs.readFileSync(path.join(root,'store_analytics_v21_120.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class Node {
  constructor(id){this.id=id;this.value='';this.textContent='';this.disabled=false;this.listeners={};this.checks=[];}
  set innerHTML(value){
    this.markup=value;
    if(this.id==='lpStoreMergeSources')this.checks=[...value.matchAll(/<input\b([^>]+)>/g)].map(([,attrs])=>{
      const id=attrs.match(/data-store-merge-source="([^"]+)"/)?.[1];
      const label={classList:{toggle(){}}};
      return {dataset:{storeMergeSource:id},checked:/\bchecked\b/.test(attrs),disabled:false,
        closest:selector=>selector==='label'?label:this.checks.find(x=>x.dataset.storeMergeSource===id)};
    });
  }
  get innerHTML(){return this.markup||'';}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  async fire(type,event={}){for(const fn of this.listeners[type]||[])await fn({target:this,...event});}
  querySelectorAll(){return this.id==='lpStoreMergeSources'?this.checks:[];}
  closest(){return null;}
  focus(){} scrollIntoView(){}
}
const fixture=()=>[
  {id:'official',name:'TSUTAYA東仙台店 ２階トレカコーナー',prefecture:'宮城県',address:'宮城県仙台市宮城野区東仙台1-2-3'},
  {id:'variant-a',name:'TSUTAYA 東仙台 2Fトレカ',prefecture:'宮城県',address:'宮城県仙台市宮城野区東仙台1-2-3'},
  {id:'variant-b',name:'ＴＳＵＴＡＹＡ東仙台店２階',prefecture:'宮城県',address:null},
  {id:'unrelated',name:'別の店舗<img src=x onerror=alert(1)>',prefecture:'宮城県',address:'<svg onload=alert(1)>'},
  {id:'tokyo',name:'TSUTAYA田町店',prefecture:'東京都',address:'東京都港区芝1-2-3'},
  {id:'old',name:'旧TSUTAYA東仙台',prefecture:'宮城県',merged_into:'official'}
];
function harness(){
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
  const nodes=new Map(ids.map(id=>[id,new Node(id)]));
  let masters=fixture(),dev=true,confirmResult=true,failSource='',loseResponse='',gate=null;
  const calls=[],confirmations=[],refreshed=[];
  const client={rpc:async(name,args)=>{
    calls.push({name,args:copy(args||{})});
    if(name==='lottery_store_admin_v1')return {data:{masters:copy(masters),candidates:[{
      left_id:'official',right_id:'variant-a',left_name:masters[0].name,right_name:masters[1].name,
      prefecture:'宮城県',similarity:.91}]},error:null};
    if(name==='lottery_store_stats_v1')return {data:[],error:null};
    assert.equal(name,'lottery_store_review_v1');
    assert.equal(dev,true,'Every saved merge must be authorized');
    if(gate)await gate;
    if(failSource===args.p_source){failSource='';return {data:null,error:{message:'一時的な通信エラー'}};}
    const source=masters.find(row=>row.id===args.p_source),target=masters.find(row=>row.id===args.p_target);
    assert(source&&target&&source.id!==target.id&&!source.merged_into&&!target.merged_into);
    assert.equal(source.prefecture,target.prefecture,'Never merge across prefectures');
    if(args.p_action==='merge')source.merged_into=target.id;
    if(loseResponse===source.id){loseResponse='';return {data:null,error:{message:'応答を受信できませんでした'}};}
    return {data:true,error:null};
  }};
  const window={};
  for(const key of ['TorecaStoreAliases','TorecaStoreMaps','TorecaSalesReference'])
    window[key]={refresh:async()=>{refreshed.push(key);return true;}};
  vm.runInNewContext(code,{window,document:{getElementById:id=>nodes.get(id)||null},
    confirm:text=>{confirmations.push(text);return confirmResult;},alert:()=>{}},{timeout:1000});
  const ui=window.TorecaStoreUI;
  ui.init({getClient:()=>client,isDev:()=>dev,renderCards:()=>{},escape});
  const node=id=>{assert(nodes.has(id),id);return nodes.get(id);};
  return {ui,calls,confirmations,refreshed,node,
    load:()=>ui.refreshMaster(),
    target:async id=>{node('lpStoreMergeTarget').value=id;await node('lpStoreMergeTarget').fire('change');},
    search:async(side,value)=>{const input=node('lpStoreMerge'+side+'Search');input.value=value;await input.fire('input');},
    check:async(id,checked=true)=>{
      const input=node('lpStoreMergeSources').checks.find(x=>x.dataset.storeMergeSource===id);
      assert(input,'Missing candidate '+id);input.checked=checked;
      await node('lpStoreMergeSources').fire('change',{target:input});
    },
    reviewCalls:()=>calls.filter(x=>x.name==='lottery_store_review_v1'),
    setDev:value=>{dev=value;},setConfirm:value=>{confirmResult=value;},
    fail:id=>{failSource=id;},lose:id=>{loseResponse=id;},defer:value=>{gate=value;}
  };
}
(async()=>{
  const h=harness();await h.load();
  assert.equal(h.node('lpStoreMasterMerge').disabled,true);
  await h.target('official');
  let candidates=h.node('lpStoreMergeSources').innerHTML;
  assert.match(candidates,/variant-a/);assert.match(candidates,/variant-b/);
  assert.doesNotMatch(candidates,/data-store-merge-source="(?:official|tokyo|old)"/);
  assert.match(h.node('lpStoreMergeTargetPreview').innerHTML,/宮城野区/);
  assert.doesNotMatch(candidates,/<img |<svg /);assert.match(candidates,/&lt;img /);
  await h.search('Source','ｔｓｕｔａｙａ 東仙台');
  assert.equal(h.node('lpStoreMergeSources').checks.length,2,'Width/case and multiple search terms are supported');
  await h.check('variant-a');
  await h.search('Source','見つからない店舗');
  assert.equal(h.node('lpStoreMergeSources').checks.length,0);
  assert.match(h.node('lpStoreMergeSelected').innerHTML,/TSUTAYA 東仙台/,'Filtering cannot hide selected-store review');
  assert.equal(h.node('lpStoreMasterMerge').disabled,false);
  await h.search('Target','検索結果なし');
  assert.equal(h.node('lpStoreMergeTarget').value,'official','Selected destination stays pinned while filtering');
  await h.node('lpStoreMergeSourceSearchClear').fire('click');
  await h.check('variant-b');
  assert.equal(h.node('lpStoreMergeSelectedCount').textContent,'2件');
  assert.equal(h.reviewCalls().length,0,'Searching and selecting never save a merge');
  h.setConfirm(false);await h.node('lpStoreMasterMerge').fire('click');
  assert.equal(h.reviewCalls().length,0,'Cancellation preserves the unsaved selection');
  assert.match(h.confirmations.at(-1),/統合先：宮城県/);
  assert.match(h.confirmations.at(-1),/variant|TSUTAYA 東仙台/);
  assert.match(h.confirmations.at(-1),/ＴＳＵＴＡＹＡ東仙台/);
  h.setConfirm(true);await h.node('lpStoreMasterMerge').fire('click');
  assert.deepEqual(h.reviewCalls().map(x=>x.args.p_source),['variant-a','variant-b']);
  assert(h.reviewCalls().every(x=>x.args.p_target==='official'&&x.args.p_action==='merge'));
  assert.equal(h.calls.filter(x=>x.name==='lottery_store_admin_v1').length,2,'One master refresh for the whole group');
  assert.equal(h.refreshed.length,3,'Aliases, addresses and sales references update once per group');
  assert.equal(h.node('lpStoreMergeSelectedCount').textContent,'0件');
  assert.match(h.node('lpStoreMergeStatus').textContent,/2店舗を.*統合しました/);

  const partial=harness();await partial.load();await partial.target('official');
  await partial.check('variant-a');await partial.check('variant-b');partial.fail('variant-b');
  await partial.node('lpStoreMasterMerge').fire('click');
  assert.match(partial.node('lpStoreMergeStatus').textContent,/1 \/ 2店舗/);
  assert.equal(partial.node('lpStoreMergeSelectedCount').textContent,'1件');
  assert.match(partial.node('lpStoreMergeSelected').innerHTML,/variant-b/);
  assert.doesNotMatch(partial.node('lpStoreMergeSelected').innerHTML,/variant-a/);
  await partial.node('lpStoreMasterMerge').fire('click');
  assert.deepEqual(partial.reviewCalls().map(x=>x.args.p_source),['variant-a','variant-b','variant-b'],
    'Retry sends only the unfinished source');

  const lost=harness();await lost.load();await lost.target('official');await lost.check('variant-a');lost.lose('variant-a');
  await lost.node('lpStoreMasterMerge').fire('click');
  assert.match(lost.node('lpStoreMergeStatus').textContent,/1店舗を.*統合しました/);
  assert.equal(lost.node('lpStoreMergeSelectedCount').textContent,'0件','Confirmed save is not offered twice after a lost response');

  const changing=harness();await changing.load();await changing.target('official');await changing.check('variant-a');
  await changing.target('variant-b');
  assert.equal(changing.node('lpStoreMergeSelectedCount').textContent,'0件','Changing destination clears stale source selections');
  changing.node('lpStoreMergePrefecture').value='東京都';await changing.node('lpStoreMergePrefecture').fire('change');
  assert.equal(changing.node('lpStoreMergeTarget').value,'');
  assert.equal(changing.node('lpStoreMasterMerge').disabled,true);
  const forged={dataset:{storeMergeSource:'tokyo'},checked:true,closest(){return this;}};
  await changing.target('official');await changing.node('lpStoreMergeSources').fire('change',{target:forged});
  assert.equal(changing.node('lpStoreMergeSelectedCount').textContent,'0件','Cross-prefecture checkbox injection is ignored');
  const quick={dataset:{storeMergeTarget:'official'},closest(){return this;}};
  await changing.node('lpStoreMasterList').fire('click',{target:quick});
  assert.equal(changing.node('lpStoreManualMerge').open,true);
  assert.equal(changing.node('lpStoreMergeTarget').value,'official');

  const busy=harness();await busy.load();await busy.target('official');await busy.check('variant-a');
  let release;busy.defer(new Promise(resolve=>{release=resolve;}));
  const saving=busy.node('lpStoreMasterMerge').fire('click');await new Promise(setImmediate);
  assert.equal(busy.node('lpStoreMasterMerge').disabled,true);
  await busy.node('lpStoreMasterMerge').fire('click');
  assert.equal(busy.reviewCalls().length,1,'A second click cannot start another group');
  release();await saving;
  const denied=harness();denied.setDev(false);await denied.load();await denied.node('lpStoreMasterMerge').fire('click');
  assert.equal(denied.calls.length,0,'Non-developers cannot request master reads or merges');
  console.log('Manual store merge UI: searchable choices, retained multi-selection, region guards, group save, partial retry, lost responses and authorization passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
