#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'search_inputs_v1.js'),'utf8');
function fn(text,name){
  const start=text.indexOf('  function '+name+'('),end=text.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing '+name);return text.slice(start,end+5);
}
const ctx={
  config:{suggestions:()=>[
    {value:'神の支配',search:'OP-18',detail:'ワンピース'},
    {value:'神の支配',detail:'同一商品'},
    {value:'メガブレイブ',search:'めがぶれいぶ'},
    {value:'同じ店名',prefecture:'栃木県'},
    {value:'同じ店名',prefecture:'東京都'}
  ]},authUser:{id:'current'},lpSearchMasterUser:'current',
  lpSearchMasterStores:[{name:'ビックカメラ宇都宮店',prefecture:'栃木県'},
    {name:'同じ店名',prefecture:'栃木県'},{name:'同じ店名',prefecture:'東京都'}],
  lotteryItems:[],cloudStores:[],stores:[],lotteryStoreEntries:item=>item.stores||[]
};
const api=vm.runInNewContext([
  fn(app,'productNorm'),
  'const normalize=productNorm;',fn(ui,'candidates'),
  fn(app,'lpSearchStorePool'),fn(app,'lpSearchCanonicalStore'),
  '({candidates,lpSearchStorePool,lpSearchCanonicalStore})'
].join('\n'),ctx);
const query=value=>api.candidates({input:{value},nativeList:{options:[{value:'神の支配'}]}});
assert.equal(query('OP-18')[0].value,'神の支配','An alias selects the canonical product');
assert.equal(query('めがぶれいぶ')[0].value,'メガブレイブ','Kana spelling is searchable');
assert.equal(query('神の支配').length,1,'Datalist and master duplicates are suppressed');
assert.equal(query('同じ店名').length,2,'Different prefectures retain distinct choices');
assert.equal(query('該当なし').length,0);
assert.equal(api.lpSearchCanonicalStore({name:'ビックカメラ宇都宮店',prefecture:'全国'}).prefecture,'栃木県');
assert.equal(api.lpSearchCanonicalStore({name:'同じ店名',prefecture:''}).prefecture,'',
  'A repeated store name cannot choose an arbitrary prefecture');
assert.equal(api.lpSearchCanonicalStore({name:'同じ店名',prefecture:'東京都'}).prefecture,'東京都');
ctx.lpSearchMasterUser='former-user';
assert.equal(api.lpSearchStorePool().length,0,'Former-session master choices cannot linger');
ctx.config.suggestions=()=>Array.from({length:120},(_,i)=>({value:'商品'+i}));
assert.equal(query('').length,60,'Large lists stay bounded');
console.log('Search candidates: aliases, kana, dedup, distinct stores, session change and list bounds OK');
