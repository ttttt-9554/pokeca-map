#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function source(name){
  const start=app.indexOf('  function '+name+'('),end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing helper '+name);
  return app.slice(start,end+5);
}
const product={id:'onepiece-op18',name:'ONE PIECEカードゲーム ブースターパック 神の支配',genre:'onepiece',category:'pack'};
const sample={url:'https://livepocket.jp/e/b0pdj',review_category:'onepiece',
  event_title:'ONE PIECEカードゲーム ブースターパック 神の支配【OP-18】【事前入店申込・抽選】11月21日(土)JUMP SHOP池袋店'};
const ctx={cloudProducts:[product],cloudProductAliases:[],cloudProductIndex:new Map(),cloudProductById:new Map(),lotteryMasterTerms:[]};
const api=vm.runInNewContext([
  'catalogProductKey','catalogProductIdentity','catalogProductMatch',
  'rebuildCatalogProductIndex','lotteryMasterKey','lotteryMasterParts','lotteryMasterVariantTail',
  'buildLotteryMasterTerms','lotteryMasterMatches','lotteryGenre','resolveLotteryProductMaster'
].map(source).join('\n')+'\n({rebuildCatalogProductIndex,resolveLotteryProductMaster})',ctx);
api.rebuildCatalogProductIndex();
assert.equal(api.resolveLotteryProductMaster(sample).product_name,product.name);
assert.equal(api.resolveLotteryProductMaster(sample).catalog_product_id,product.id);
const repeated=api.resolveLotteryProductMaster(api.resolveLotteryProductMaster(sample));
assert.equal(repeated.catalog_product_from_title,true);
assert.equal(repeated.product_name_original,'');
assert.equal(sample.product_name,undefined,'Collected source stays unchanged');
assert.equal(api.resolveLotteryProductMaster({...sample,event_title_provisional:true}).product_name,undefined);
assert.equal(api.resolveLotteryProductMaster({...sample,manual_card_product:true,product_name:''}).product_name,'');
assert.equal(api.resolveLotteryProductMaster({...sample,review_category:'pokemon'}).catalog_product_id,undefined);
assert.equal(api.resolveLotteryProductMaster({...sample,product_name:'別の商品',manual_card_product:true}).product_name,'別の商品');
assert.equal(api.resolveLotteryProductMaster({...sample,product_name:'ワンピースカードゲーム'}).product_name,product.name);
assert.equal(api.resolveLotteryProductMaster({...sample,review_category:'unknown'}).review_category,'onepiece');
assert.equal(api.resolveLotteryProductMaster({...sample,external_url_unverified:true}).catalog_product_id,undefined);
const alias={product_id:product.id,genre:'onepiece',alias_name:'神の支配 OP-18'};
ctx.cloudProductAliases=[alias];api.rebuildCatalogProductIndex();
assert.equal(api.resolveLotteryProductMaster({...sample,event_title:'「神の支配 OP-18」入店抽選'}).product_name,product.name);
ctx.cloudProducts.push({id:'another',name:'別の商品セット',genre:'onepiece',category:'pack'});
api.rebuildCatalogProductIndex();
assert.equal(api.resolveLotteryProductMaster({...sample,event_title:sample.event_title+'・別の商品セット'}).catalog_product_id,undefined,
  'Multiple products must not resolve to an arbitrary product');
const master=(id,name,genre,source='manual',category='pack')=>({id,name,genre,source,category});
const op=master('op18','神の支配','onepiece','manual_lottery');
const variant=master('legacy-op18','ワンピースカードゲーム【OP-18】ブースターパック「神の支配」','onepiece','lottery_sync','unknown');
const brave=master('brave','メガブレイブ','pokemon','map_import');
const braveImport=master('legacy-brave','拡張パック「メガブレイブ」','pokemon','lottery_sync');
const celebration=master('30th','30th CELEBRATION','pokemon','manual_lottery');
const futuristic=master('futuristic','30th CELEBRATION FUTURISTIC BOX','pokemon','lottery_sync');
const heroines=master('heroines','Heroines Edition','onepiece','lottery_sync');
const heroines2=master('heroines2','Heroines Edition vol.2','onepiece','manual_lottery');
ctx.cloudProducts=[op,variant,brave,braveImport,celebration,futuristic,heroines,heroines2];
ctx.cloudProductAliases=[
  {product_id:op.id,genre:op.genre,alias_name:'ブースターパック 神の支配 OP18'},
  {product_id:heroines2.id,genre:heroines2.genre,alias_name:'Heroines Edition vol.2【EB-05】'}
];
api.rebuildCatalogProductIndex();
const resolve=(event_title,fields={})=>api.resolveLotteryProductMaster({event_title,...fields});
assert.equal(resolve('キデイランド吉祥寺店 拡張パック「ＯＰ１８ 神の支配」購入券 抽選',
  {product_name:'ワンピースカードゲーム',review_category:'onepiece'}).catalog_product_id,op.id);
assert.equal(resolve('【OP-18】ブースターパック「神の支配」購入権抽選',
  {product_name:variant.name,review_category:'onepiece'}).product_name,op.name);
assert.equal(resolve('【竹の塚店】『神の支配』BOX 抽選予約').review_category,'onepiece');
assert.equal(resolve('OP-19 神の支配 抽選予約').catalog_product_id,undefined,
  'Do not match a different explicitly stated set code');
assert.equal(resolve('OP-19 神の支配 抽選予約',{product_name:op.name}).catalog_product_id,undefined,
  'A generic collected name must not override the code in the verified title');
assert.equal(resolve('メガブレイブ 購入権抽選',{product_name:braveImport.name}).product_name,brave.name);
assert.equal(resolve('30th CELEBRATION FUTURISTIC BOX 抽選',{product_name:celebration.name}).product_name,futuristic.name,
  'A verified variant in the title disambiguates a shortened collected product name');
assert.equal(resolve('30th CELEBRATION カードセット 未登録の種類 抽選',{product_name:celebration.name}).catalog_product_id,undefined);
assert.equal(resolve('30th CELEBRATION カードセット／メガブレイブ抽選').catalog_product_ambiguous,true,
  'A known pack must not stand in for an independently named card set');
assert.equal(resolve('Heroines Edition vol.2【EB-05】抽選販売').product_name,heroines2.name);
assert.equal(resolve('Heroines Edition vol.3 抽選販売',{product_name:heroines.name}).catalog_product_id,undefined);
assert.equal(resolve('30th CELEBRATION FUTURISTIC BOX とメガブレイブの抽選').catalog_product_ambiguous,true);
assert.equal(resolve('メガブレイブ・30th CELEBRATION抽選',{product_name:brave.name}).product_name,'');
assert.equal(resolve('入荷予定の新商品',{product_name:'未登録の新商品'}).product_name,'未登録の新商品');
assert.equal(resolve('メガブレイブ抽選',{product_name:'',manual_card_product:true}).product_name,'');
assert.equal(resolve('メガブレイブ抽選',{product_name:'手動で確認した商品',app_lottery:true}).product_name,'手動で確認した商品');
assert.equal(resolve('メガブレイブ抽選',{review_category:'unknown',manual_card_genre:true}).review_category,'unknown');
assert.doesNotMatch(app,/catalog_product_sync_batch_v1/,'Opening the catalog does not register guessed product names');
assert.match(app,/item\.manual_card_product = true/,'An explicit manual clear suppresses title matching');

async function live(){
  const url=app.match(/const SUPABASE_URL = '([^']+)'/)[1];
  const key=app.match(/const SUPABASE_KEY = '([^']+)'/)[1];
  const read=async resource=>{
    const response=await fetch(url+'/rest/v1/'+resource,{headers:{apikey:key},signal:AbortSignal.timeout(20000)});
    assert(response.ok,'Read-only catalog request: '+response.status);
    return response.json();
  };
  const [products,aliases]=await Promise.all([
    read('catalog_products?select=id,name,genre,category,source'),
    read('catalog_product_aliases?select=product_id,genre,alias_name')
  ]);
  ctx.cloudProducts=products;ctx.cloudProductAliases=aliases;api.rebuildCatalogProductIndex();
  const resolved=api.resolveLotteryProductMaster(sample);
  assert(resolved.catalog_product_id,'Screenshot event resolves with the current public catalog');
  const expected=aliases.find(a=>a.genre==='onepiece'&&a.alias_name==='ONE PIECEカードゲーム ブースターパック 神の支配【OP-18】');
  if(expected)assert.equal(resolved.catalog_product_id,expected.product_id);
  console.log('Live read-only catalog: '+products.length+' products, '+aliases.length+' aliases; OP-18 resolves');
}
console.log('Product resolution: registered aliases, duplicate spellings, variants, ambiguity and manual overrides OK');
if(process.argv.includes('--live'))live().catch(error=>{console.error(error);process.exitCode=1;});
