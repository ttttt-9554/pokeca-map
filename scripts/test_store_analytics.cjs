#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const code=fs.readFileSync(path.join(root,'store_analytics_v21_120.js'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sql=fs.readFileSync(path.join(root,'supabase/lottery_store_stats_all_results_v21_128.sql'),'utf8');
const nodes=new Map();
for(const id of ['lpStoreAnalyticsList','lpStoreAnalyticsStatus','lpStoreAnalyticsSearch',
  'lpStoreAnalyticsSort','lpStoreAnalyticsCount','lpStoreAnalyticsReload',
  'lpStoreMasterPanel','lpStoreMasterReload','lpStoreMasterSearch',
  'lpStoreMasterCandidates','lpStoreMasterList','lpStoreMasterStatus',
  'lpStoreMasterCount','lpStoreMergeSource','lpStoreMergeTarget','lpStoreMasterMerge']){
 nodes.set(id,{value:id==='lpStoreAnalyticsSort'?'high':'',innerHTML:'',textContent:'',
  addEventListener(){},closest(){return null}});
}
const window={};
const document={getElementById:id=>nodes.get(id)||null};
vm.runInNewContext(code,{window,document,confirm:()=>true,alert:()=>{}},{timeout:1000});
const ui=window.TorecaStoreUI;
assert.equal(ui.normalize('イエサブ 宇都宮'),'イエローサブマリン宇都宮店');
assert.equal(ui.normalize('イエローサブマリン宇都宮店'),'イエローサブマリン宇都宮店');
assert.notEqual(ui.normalize('ビックカメラ宇都宮店'),ui.normalize('コジマ×ビックカメラ宇都宮本店'));
let adminCalls=0,renderCount=0;
let sampleData=[{
 store_name:'イエローサブマリン宇都宮店',prefecture:'栃木県',
 decided:40,won:20,lost:20,rate:50,applied:42,badge:true,
 keys:['栃木県|イエローサブマリン宇都宮店']}];
const client={rpc:async name=>{
 if(name==='lottery_store_stats_v1')return {data:sampleData,error:null};
 adminCalls++;return {error:new Error('Admin RPC must not be requested'),data:null};
}};
ui.init({getClient:()=>client,isDev:()=>false,renderCards:()=>renderCount++,
 escape:v=>String(v)});
(async()=>{
 assert.equal(ui.cardBadge([{name:'イエサブ宇都宮',prefecture:'栃木県'}]),'');
 await ui.refresh(true);
 assert.match(ui.cardBadge([{name:'イエサブ宇都宮',prefecture:'栃木県'}]),/過去実績高め/);
 assert.equal(ui.cardBadge([{name:'イエサブ宇都宮',prefecture:'東京都'}]),'');
 assert.match(ui.storeBadge({name:'イエサブ宇都宮',prefecture:'栃木県'}),/実績高め/);
 assert.match(nodes.get('lpStoreAnalyticsList').innerHTML,/50\.0%/);
 assert.equal(renderCount,1);
 await ui.refreshMaster();assert.equal(adminCalls,0);
 assert.match(html,/id="lpStoreMasterPanel"/);
 assert.match(html,/id="lpStoreAnalytics"/);
 assert.match(app,/TorecaStoreUI\?\.cardBadge/);
 assert.match(app,/TorecaStoreUI\?\.storeBadge/);
 assert.match(code,/lottery_store_unmerge_v1/);
 assert.match(code,/data-store-unmerge/);
 assert.match(sql,/WHERE s\.decided>=1/);
 assert.doesNotMatch(sql,/contributors>=5|count\(DISTINCT user_id\)/);
 assert.match(sql,/WHERE decided>=20/);
 assert.match(sql,/e\.decided>=30/);
 assert.doesNotMatch(sql,/user_id/);
 sampleData=[
  {store_name:'サンプル店舗A',prefecture:'栃木県',decided:1,won:1,lost:0,rate:100,
   badge:false,keys:['栃木県|サンプル店舗a']},
  {store_name:'サンプル店舗B',prefecture:'東京都',decided:2,won:0,lost:2,rate:0,
   badge:true,keys:['東京都|サンプル店舗b']}
 ];
 await ui.refresh(true);
 assert.match(nodes.get('lpStoreAnalyticsCount').textContent,/2店舗/);
 assert.match(nodes.get('lpStoreAnalyticsStatus').textContent,/人数制限なし/);
 assert.match(nodes.get('lpStoreAnalyticsList').innerHTML,/100\.0%/);
 assert.match(nodes.get('lpStoreAnalyticsList').innerHTML,/少数データ・参考値/);
 assert.equal(ui.cardBadge([{name:'サンプル店舗B',prefecture:'東京都'}]),'',
   'A low-sample entry never earns an optimistic badge');
 assert.equal(ui.storeBadge({name:'サンプル店舗B',prefecture:'東京都'}),'');
 nodes.get('lpStoreAnalyticsSort').value='low';
 await ui.refresh(true);
 const listHtml=nodes.get('lpStoreAnalyticsList').innerHTML;
 assert(listHtml.indexOf('サンプル店舗B')<listHtml.indexOf('サンプル店舗A'),
   'Low-rate sort works with small samples');
 assert.match(html,/登録人数に関係なく/);
 console.log('Store master, unrestricted small-sample stats, safety badges verified');
})().catch(e=>{console.error(e);process.exitCode=1});
