#!/usr/bin/env node
'use strict';
// Approved master merges must be canonical everywhere without rewriting history.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const app=read('app.js'),aliases=read('store_aliases_v1.js');
const mapModule=read('store_map_links_v1.js');
const analytics=read('store_analytics_v21_120.js');
const info=read('info_plaza_sales_v1.js');
const reference=read('lottery_sales_reference_v1.js');
const migration=read('supabase/lottery_store_canonical_reference_v21_167.sql');
const index=read('index.html');

assert.match(migration,/s\.merged_into IS NOT NULL/);
assert.match(migration,/m\.id=s\.merged_into/);
assert.match(migration,/m\.address/);
assert.doesNotMatch(migration,/UPDATE\s+(?:public|private)\./i);
assert.match(app,/TorecaStoreAliases\?\.onAuthChanged/);
assert.match(app,/TorecaStoreAliases\?\.onTabChanged/);
assert.match(app,/canonicalizeStores/);
assert.match(app,/TorecaStoreAliases\?\.resolve/);
assert.match(index,/store_aliases_v1\.js/);
assert.match(analytics,/TorecaStoreAliases\?\.refresh/);
assert.match(analytics,/target\.address/);
assert.match(info,/onAliasesChanged/);
assert.match(reference,/canonical\.name/);
assert.match(mapModule,/canonical\.address/);

function extract(name){
 const start=app.indexOf('  function '+name+'('),end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,'Missing helper '+name);
 return app.slice(start,end+5);
}
let data=[
 {source_name:'TSUTAYAテクノ店',source_prefecture:'栃木県',
  name:'TSUTAYA 宇都宮テクノ店',prefecture:'栃木県',
  address:'栃木県宇都宮市ゆいの杜4-1-39'},
 {source_name:'イエローサブマリン横浜店',source_prefecture:'神奈川県',
  name:'イエローサブマリン横浜西口店',prefecture:'神奈川県',
  address:'神奈川県横浜市西区南幸2-7-15 横川ビル4階'},
 {source_name:'ヤマダ電機　インターパーク',source_prefecture:'栃木県',
  name:'ヤマダ電気　インターパーク',prefecture:'栃木県',address:null}
];
let auth='',changes=0,requests=0;
const window={},document={getElementById:id=>id==='lotteryView'
  ?{classList:{contains:tab=>tab==='active'}}:null};
const ctx={window,document,console,Date,Map,Set,Number,String};
vm.runInNewContext(aliases,ctx,{timeout:1000});
const canonical=window.TorecaStoreAliases;
const client={rpc:async name=>{
  requests++;
  if(name==='lottery_store_canonical_reference_v1')
    return {data,error:null};
  if(name==='lottery_store_map_addresses_v1')
    return {data:[{name:'TSUTAYA 宇都宮テクノ店',prefecture:'栃木県',
      address:'栃木県宇都宮市ゆいの杜4-1-39'}],error:null};
  throw Error('Unexpected RPC '+name);
}};
canonical.init({getClient:()=>client,getUserId:()=>auth,onChanged:()=>{changes++;}});
(async()=>{
  assert.equal(await canonical.refresh(true),true);
  assert.equal(canonical.name('TSUTAYAテクノ店','栃木県'),'TSUTAYA 宇都宮テクノ店');
  assert.equal(canonical.address('TSUTAYAテクノ店','栃木県'),'栃木県宇都宮市ゆいの杜4-1-39');
  assert.equal(canonical.name('TSUTAYAテクノ店','東京都'),'TSUTAYAテクノ店',
    'Never transfer an alias across different prefectures');
  assert.equal(canonical.name('イエローサブマリン横浜店','神奈川県'),
    'イエローサブマリン横浜西口店');
  assert.equal(canonical.name('ヤマダ電機　インターパーク','栃木県'),
    'ヤマダ電気　インターパーク');
  assert.equal(canonical.address('ヤマダ電機　インターパーク','栃木県'),'');
  const list=JSON.parse(JSON.stringify(canonical.canonicalizeStores([
    {name:'TSUTAYAテクノ店',prefecture:'栃木県'},
    {name:'TSUTAYA 宇都宮テクノ店',prefecture:'栃木県'},
    {name:'TSUTAYAテクノ店',prefecture:'東京都'}
  ])));
  assert.equal(list.length,2);
  assert.equal(list[0].name,'TSUTAYA 宇都宮テクノ店');

  const funcs=[
    extract('lotteryStoreEntries'),extract('lpAppStoredStores'),
    '({lotteryStoreEntries,lpAppStoredStores})'
  ].join('\n');
  const ui=vm.runInNewContext(funcs,{window,globalThis:{window}},{timeout:1000});
  const parsed=JSON.parse(JSON.stringify(ui.lotteryStoreEntries({
    stores:[
      {name:'TSUTAYAテクノ店',prefecture:'栃木県'},
      {name:'TSUTAYA 宇都宮テクノ店',prefecture:'栃木県'}
    ]
  })));
  assert.deepEqual(parsed,[{name:'TSUTAYA 宇都宮テクノ店',prefecture:'栃木県'}]);
  assert.equal(ui.lpAppStoredStores({
    store_name:'TSUTAYAテクノ店',prefecture:'栃木県'
  })[0].name,'TSUTAYA 宇都宮テクノ店');

  vm.runInNewContext(mapModule,ctx,{timeout:1000});
  const maps=window.TorecaStoreMaps;
  auth='u1';
  maps.init({getClient:()=>client,getUserId:()=>auth,renderCards:()=>{}});
  await maps.refresh(true);
  const link=maps.render({name:'TSUTAYAテクノ店',prefecture:'栃木県'});
  assert.match(link,/Googleマップ/);
  assert.match(decodeURIComponent(link),/TSUTAYA 宇都宮テクノ店/);
  assert.match(decodeURIComponent(link),/栃木県宇都宮市ゆいの杜4-1-39/);
  const noAddress=maps.render({name:'ヤマダ電機　インターパーク',
    prefecture:'栃木県'});
  assert.match(noAddress,/地図で検索/);

  // If the developer unmerges a store, the next refresh restores its old name.
  data=[];
  assert.equal(await canonical.refresh(true),true);
  assert.equal(canonical.name('TSUTAYAテクノ店','栃木県'),'TSUTAYAテクノ店');
  assert.equal(canonical.address('TSUTAYAテクノ店','栃木県'),'');
  assert.ok(changes>=2);
  assert.ok(requests>=3);
  console.log('Canonical store merges: master target, maps, dedup, private/legacy entries, unmerge, prefecture safety OK');
})().catch(error=>{console.error(error);process.exitCode=1});
