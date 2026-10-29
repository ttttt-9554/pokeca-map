#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const code=fs.readFileSync(path.join(root,'store_analytics_v21_120.js'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sql=fs.readFileSync(path.join(root,'supabase/lottery_store_stats_privacy_v21_120.sql'),'utf8');
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
const client={rpc:async name=>{
 if(name==='lottery_store_stats_v1')return {data:[{
  store_name:'イエローサブマリン宇都宮店',prefecture:'栃木県',
  decided:40,won:20,lost:20,rate:50,applied:42,badge:true,
  keys:['栃木県|イエローサブマリン宇都宮店']}],error:null};
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
 assert.match(sql,/s\.contributors>=5 AND s\.decided>=20/);
 assert.match(sql,/e\.decided>=30/);
 assert.doesNotMatch(sql,/jsonb_build_object\([^;]*'user_id'/);
 console.log('Store master UI, privacy-gated stats and existing card badges passed');
})().catch(e=>{console.error(e);process.exitCode=1});
