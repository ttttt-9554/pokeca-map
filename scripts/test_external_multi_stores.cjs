#!/usr/bin/env node
'use strict';
// v21.141 — external lottery per-store name/prefecture edits, legacy records
// and the public store card/search behavior must remain compatible.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sql=fs.readFileSync(path.join(root,'supabase/lottery_external_multi_stores_v21_141.sql'),'utf8');
function fn(name){
  const a=app.indexOf('  function '+name+'(');
  const b=app.indexOf('\n  }\n',a);
  assert(a>=0&&b>a,'Missing helper '+name);
  return app.slice(a,b+5);
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[c]);
const fields=new Map([
  ['event_title','外部抽選のサンプル'],['review_category','pokemon'],
  ['product_type','pack'],['exclusion_reason',''],
  ['application_start_at',''],['application_end_at','']
]);
let storeRows=[];
const fakeForm={
 elements:{namedItem:n=>({value:fields.get(n)||''})},
 querySelectorAll:selector=>{
   assert.equal(selector,'[data-lp-ext-store-row]');
   return storeRows.map(entry=>({
     querySelector:attr=>{
       if(attr==='[data-lp-ext-store-name]')return {value:entry.name};
       if(attr==='[data-lp-ext-store-pref]')return {value:entry.prefecture};
       return null;
     }
   }));
 }
};
const ctx={
 $:id=>id==='lpExtForm'?fakeForm:null,
 lpExtEditing:'https://customform.jp/form/input/258452',
 safeLotteryUrl:url=>url.startsWith('https://'),
 isLivePocketEventUrl:()=>false,
 LP_MANUAL_AREAS:['東京都','大阪府','北海道','全国'],
 LP_EXT_MAX_STORES:100,
 lpExtDateSave:s=>s||null,
 lotteryStoreEntries:base=>{
   if(Array.isArray(base.stores))return base.stores;
   return base.store_name?[{name:base.store_name,prefecture:base.prefecture||''}]:[];
 },
 escape
};
const api=vm.runInNewContext([
 fn('lpExtNormalizeStores'),fn('lpExtStoredStores'),
 fn('lpExtStoreRowHtml'),fn('lpExtValidatedStores'),
 fn('lpExtFormRow'),
 '({lpExtNormalizeStores,lpExtStoredStores,lpExtStoreRowHtml,lpExtValidatedStores,lpExtFormRow})'
].join('\n'),ctx,{timeout:1000});
const plain=v=>JSON.parse(JSON.stringify(v));
function save(entries){
 storeRows=entries;
 return plain(api.lpExtFormRow());
}
const first=save([{name:'アニメイト池袋',prefecture:'東京都'}]);
assert.equal(first.store_name,'アニメイト池袋');
assert.equal(first.prefecture,'東京都');
assert.deepEqual(first.stores,[{name:'アニメイト池袋',prefecture:'東京都'}]);
const multiple=save([
 {name:'アニメイト池袋',prefecture:'東京都'},
 {name:'アニメイト梅田',prefecture:'大阪府'},
 {name:'札幌店',prefecture:'北海道'}
]);
assert.equal(multiple.stores.length,3);
// Render the edited stores through the SAME overlay and filter helpers used
// by the real lottery card, not just the form's validation code.
const rendered=vm.runInNewContext([
 fn('lpExtNormalizeStores'),fn('lotteryStoreEntries'),
 fn('lotteryPrefectures'),fn('lpLegacyApply'),
 '({lotteryStoreEntries,lotteryPrefectures,lpLegacyApply})'
].join('\n'),{
 lpExtReady:true,
 LP_EXT_MAX_STORES:100,
 lpExtOverrides:new Map([[
   'https://customform.jp/form/input/258452',
   {...multiple,event_url:'https://customform.jp/form/input/258452',state:'active'}
 ],[
   'https://famima-online.family.co.jp/item?itemCode=100163657179608640',
   {state:'active',stores:[{name:'ファマリーマート',prefecture:'全国'}]}
 ]]),
 isLivePocketEventUrl:()=>false,
 LP_MANUAL_AREAS:['東京都','大阪府','北海道','全国']
},{timeout:1000});
const externalCard=rendered.lpLegacyApply({
 url:'https://customform.jp/form/input/258452',
 event_title:'元のタイトル',store_name:'旧店舗',prefecture:'東京都'
});
assert.equal(externalCard.stores.length,3);
assert.deepEqual(plain(rendered.lotteryStoreEntries(externalCard)),multiple.stores);
assert.deepEqual(plain(rendered.lotteryPrefectures(externalCard)),
 ['東京都','大阪府','北海道'],
 'Every added prefecture must be available to the existing regional filter');
const famimaCard=rendered.lpLegacyApply({
 url:'https://famima-online.family.co.jp/item?itemCode=100163657179608640',
 famima_verified_at:'2026-11-04T00:00:00Z',store_name:'ファミリーマート',prefecture:'全国',
 application_start_at:'2026-11-04T10:00:00+09:00',application_end_at:'2026-11-09T23:59:00+09:00'
});
assert.equal(famimaCard.store_name,'ファミリーマート');
assert.equal(famimaCard.stores[0].name,'ファミリーマート');
assert.equal(famimaCard.application_end_at,'2026-11-09T23:59:00+09:00');

assert.equal(multiple.store_name,'アニメイト池袋',
 'Legacy store_name continues to represent the first store');
assert.deepEqual(multiple.stores.map(x=>x.prefecture),['東京都','大阪府','北海道']);
assert.deepEqual(plain(api.lpExtStoredStores({stores:multiple.stores},null)),multiple.stores,
 'All saved stores must reopen, not just the first one');
assert.deepEqual(plain(api.lpExtStoredStores({store_name:'以前の店舗',prefecture:'東京都'},null)),
 [{name:'以前の店舗',prefecture:'東京都'}],'Legacy records are still editable');
assert.deepEqual(plain(api.lpExtStoredStores(null,{
 stores:[{name:'店A',prefecture:'東京都'},{name:'店B',prefecture:'大阪府'}]
})),[{name:'店A',prefecture:'東京都'},{name:'店B',prefecture:'大阪府'}],
 'Unedited published multi-store data must be retained');
assert.deepEqual(plain(api.lpExtStoredStores({stores:[]},null)),[],
 'Explicitly empty stores do not silently repopulate from base data');
assert.equal(save([{name:'',prefecture:'東京都'}]).prefecture,'東京都',
 'Region-only historical corrections must remain possible');
assert.equal(save([{name:'',prefecture:''}]).stores.length,0,
 'Fully unknown single-store correction remains supported');
assert.equal(save([{name:'全国の対象店',prefecture:'全国'}]).prefecture,'全国');
assert.throws(()=>save([
 {name:'店舗A',prefecture:'東京都'},{name:'店舗A',prefecture:'東京都'}
]),/重複/);
assert.throws(()=>save([
 {name:'店舗A',prefecture:'東京都'},{name:'',prefecture:'大阪府'}
]),/店舗名/);
assert.throws(()=>save([{name:'店舗A',prefecture:'関東'}]),/都道府県/);
assert.throws(()=>save(Array.from({length:101},(_,i)=>({
 name:'店舗'+i,prefecture:'東京都'
}))),/1〜100件/);
assert.match(api.lpExtStoreRowHtml({name:'<script>x</script>',prefecture:'東京都'}),/&lt;script&gt;/);
assert.doesNotMatch(api.lpExtStoreRowHtml({name:'<script>x</script>'}),/<script>/);
assert.match(html,/id="lpExtStoresField"/);
assert.match(html,/id="lpExtStores"/);
assert.match(html,/id="lpExtStoreAdd"/);
assert.match(html,/lp-ext-store-grid/);
// Cache-busting version changes on every UI release. Validate that the
// stylesheet is linked with a nonempty version token, not one old release ID.
assert.match(html,/<link\s+rel="stylesheet"\s+href="style\.css\?v=[^"]+"\s*>/);
assert.doesNotMatch(html,/id="lpExtPrefecture"/);
assert.match(app,/item\.stores=stores;/);
assert.match(app,/const stores=lpExtNormalizeStores\(row\.stores\)/);
assert.match(app,/lpExtStoreRender\(lpExtStoredStores\(row,base\)\)/);
assert.match(app,/lpExtStoreAdd'\)\.addEventListener\('click'/);
assert.match(app,/remove\.closest\('\[data-lp-ext-store-row\]'\)\?\.remove/);
assert.match(app,/lpExtStoreUpdateControls\(\)/);
const select=app.match(/\.select\('event_url,state,event_title,store_name,prefecture,stores,review_category,product_type,application_start_at,application_end_at,exclusion_reason,updated_at'\)/g)||[];
assert.equal(select.length,2,'Both refresh and save-return must include full stores');
assert.match(sql,/ADD COLUMN IF NOT EXISTS stores jsonb/);
assert.match(sql,/lottery_ext_stores_array_max_100/);
assert.match(sql,/NEW\.stores IS DISTINCT FROM OLD\.stores/);
assert.match(sql,/'stores',coalesce\(NEW\.stores/);
// The external editor uses the same shared chain directory as manual entry.
const builtinSection=app.slice(app.indexOf('  const LP_YELLOW_SUBMARINE_STORES = ['),
 app.indexOf('  function lpIsBareGeoTochigiChain('));
const builtinPresets=vm.runInNewContext(builtinSection+'\nLP_BUILTIN_STORE_PRESETS');
let bulkDraft=[{name:'',prefecture:''}],bulkRenders=0,bulkDeveloper=true;
const bulkControls={
 lpExtStorePreset:{value:'wondergoo-shinseido-ganryu'},
 lpExtEditorStatus:{textContent:''},
 lpExtForm:{querySelectorAll:()=>bulkDraft.map(store=>({
   querySelector:selector=>({value:selector==='[data-lp-ext-store-name]'?store.name:store.prefecture})
 }))}
};
const bulkContext={
 $:id=>bulkControls[id],LP_BUILTIN_STORE_PRESETS:builtinPresets,
 LP_EXT_MAX_STORES:100,lpExtBusy:false,lpExtEditing:'https://customform.jp/form/input/258799',
 isDeveloper:()=>bulkDeveloper,
 lpExtStoreRender:rows=>{bulkDraft=plain(rows);bulkRenders++;}
};
const applyBulk=vm.runInNewContext([
 fn('lotteryCanonicalStore'),fn('lotteryCanonicalStores'),fn('lpPresetStoreKey'),
 fn('lpExtApplyStorePreset'),'lpExtApplyStorePreset'
].join('\n'),bulkContext,{timeout:1000});
applyBulk();
assert.equal(bulkDraft.length,46,'An empty placeholder becomes the full 46-store directory');
assert.ok(bulkDraft.every(store=>store.name&&store.prefecture));
ctx.LP_MANUAL_AREAS.push(...new Set(bulkDraft.map(store=>store.prefecture)));
const chainPayload=save(bulkDraft);
assert.equal(chainPayload.stores.length,46,'All chain stores survive the existing save payload');
assert.equal(chainPayload.store_name,bulkDraft[0].name);
const once=bulkRenders;
applyBulk();
assert.equal(bulkRenders,once,'Repeated bulk additions cannot duplicate stores');
assert.match(bulkControls.lpExtEditorStatus.textContent,/すでに/);
bulkDraft=[{name:'Ｇａｎｒｙｕ　秋葉原店',prefecture:'東京都'}];
applyBulk();
assert.equal(bulkDraft.length,46,'Normalized existing branch is not added twice');
assert.equal(bulkDraft[0].name,'Ｇａｎｒｙｕ　秋葉原店','Existing draft text is retained');
bulkDraft=[{name:'別途入力した店舗',prefecture:'大阪府'}];
applyBulk();
assert.equal(bulkDraft.length,47);
assert.equal(bulkDraft[0].name,'別途入力した店舗');
bulkDraft=Array.from({length:55},(_,i)=>({name:'手動店舗'+i,prefecture:'東京都'}));
const beforeLimit=JSON.stringify(bulkDraft),rendersBeforeLimit=bulkRenders;
applyBulk();
assert.equal(JSON.stringify(bulkDraft),beforeLimit,'Over-limit additions preserve all entered rows');
assert.equal(bulkRenders,rendersBeforeLimit);
assert.match(bulkControls.lpExtEditorStatus.textContent,/100店舗/);
bulkDraft=[{name:'',prefecture:'東京都'}];
applyBulk();
assert.equal(bulkDraft[0].prefecture,'東京都','Partial region edits cannot be silently discarded');
assert.equal(bulkRenders,rendersBeforeLimit);
assert.match(bulkControls.lpExtEditorStatus.textContent,/店舗名/);
bulkDraft=[{name:'',prefecture:''}];
bulkControls.lpExtStorePreset.value='';
applyBulk();
assert.equal(bulkRenders,rendersBeforeLimit);
assert.match(bulkControls.lpExtEditorStatus.textContent,/選択/);
bulkControls.lpExtStorePreset.value='wondergoo-shinseido-ganryu';
bulkDeveloper=false;
applyBulk();
bulkDeveloper=true;
bulkContext.lpExtBusy=true;
applyBulk();
assert.equal(bulkRenders,rendersBeforeLimit,'Authorization and active saves guard bulk additions');
assert.match(html,/id="lpExtStorePreset"/);
assert.match(html,/id="lpExtApplyStorePreset" type="button"/);
assert.ok(app.includes("$('lpExtApplyStorePreset')?.addEventListener('click',lpExtApplyStorePreset)"));
console.log('External chain presets: 46-store save, existing drafts, duplicates, limits and authorization passed');
console.log('External lottery multi-store edits: round-trip, legacy, remove, validation, regions and alerts passed');
