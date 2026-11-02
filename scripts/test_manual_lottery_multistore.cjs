#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sql=fs.readFileSync(path.join(root,'supabase/lottery_app_multi_stores_v21_166.sql'),'utf8');
function extract(name){
 const start=app.indexOf('  function '+name+'('),end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,'Missing '+name);return app.slice(start,end+5);
}
const values={registration_method:'app',app_name:'テスト公式アプリ',event_title:'抽選1',
 product_name:'テスト商品',store_name:'',prefecture:'',review_category:'pokemon',
 product_type:'pack',application_start_at:'',application_end_at:'',source_url:'',details:''};
let extra=[];
const form={elements:{namedItem:name=>({get value(){return values[name]||''}})}};
const $=id=>id==='lpAppForm'?form:id==='lpAppExtraStores'?{querySelectorAll:()=>extra}:null;
const row=(name,prefecture)=>({querySelector:sel=>({
 value:sel==='[data-lp-app-store-name]'?name:prefecture
})});
const api=vm.runInNewContext([
 ...['lpAppStoredStores','lpAppExtraStoreRows','lpAppStoreDraft','lpAppPayload','lpAppItem'].map(extract),
 '({lpAppStoredStores,lpAppStoreDraft,lpAppPayload,lpAppItem})'
].join('\n'),{$,LP_MANUAL_AREAS:['東京都','栃木県','全国'],
 lpExtDateSave:v=>v||null,safeLotteryUrl:u=>/^https?:\/\//.test(u),
 normalizeCatalogProductInput:()=>{},catalogProductCanonicalName:name=>name,
 lpAppUrl:id=>'https://example.com/?app_lottery='+id},{timeout:1000});
assert.equal(api.lpAppPayload().stores.length,0,'Optional app store remains optional');
values.prefecture='東京都';
assert.equal(api.lpAppPayload().prefecture,'東京都','Region-only app entry still supported');
values.store_name='宇都宮店';values.prefecture='栃木県';
extra=[row('インターパーク店','栃木県'),row('池袋店','東京都')];
let payload=api.lpAppPayload();
assert.equal(payload.stores.length,3);
assert.equal(payload.stores.map(x=>x.prefecture).join(','),'栃木県,栃木県,東京都');
assert.equal(payload.store_name,'宇都宮店');
assert.equal(payload.prefecture,'栃木県');
const item=api.lpAppItem({id:'new',app_name:'テスト公式アプリ',registration_method:'app',
 stores:payload.stores,event_title:'抽選1',created_at:'2026-11-02'});
assert.equal(item.stores.length,3);
assert.equal(item.stores[2].name,'池袋店');
const old=api.lpAppItem({id:'old',registration_method:'in_store',app_name:'古い店舗',
 store_name:'宇都宮店/インターパーク店',prefecture:'栃木県',event_title:'抽選'});
assert.equal(old.stores.length,1,'Do not split legacy store names automatically');
extra=[row('宇都宮店','栃木県')];
assert.throws(()=>api.lpAppPayload(),/重複/);
extra=[row('','東京都')];
assert.throws(()=>api.lpAppPayload(),/店舗名/);
extra=[row('池袋店','')];values.registration_method='in_store';
assert.throws(()=>api.lpAppPayload(),/都道府県/);
extra=[row('池袋店','東京都')];
payload=api.lpAppPayload();
assert.equal(payload.stores.length,2);
assert.equal(payload.app_name,'宇都宮店');
extra=Array.from({length:100},(_,i)=>row('店舗'+i,'東京都'));
assert.throws(()=>api.lpAppPayload(),/最大100件/);
assert.match(html,/id="lpAppAddStore"/);
assert.match(html,/id="lpAppExtraStores"/);
assert.match(app,/store_name,prefecture,stores,review_category/);
assert.ok(app.includes("lpAppExtraStores')?.addEventListener"));
assert.match(sql,/ADD COLUMN IF NOT EXISTS stores jsonb/);
assert.match(sql,/UPDATE OF store_name,prefecture,stores/);
console.log('Manual multi-store: 3 branches, old rows, regions, duplication and validation OK');
