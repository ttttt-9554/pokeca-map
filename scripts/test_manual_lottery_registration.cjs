#!/usr/bin/env node
'use strict';
// Store-front and app lottery registrations must retain their semantics.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function extract(name){
 const start=app.indexOf('  function '+name+'(');
 const end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,'Missing '+name);
 return app.slice(start,end+5);
}
const values={registration_method:'app',app_name:'テスト公式アプリ',event_title:'テスト抽選',
 product_name:'テストパック',store_name:'',prefecture:'',review_category:'pokemon',
 product_type:'pack',application_start_at:'',application_end_at:'',source_url:'',details:''};
const input=name=>({get value(){return values[name]||''}});
const controls={appNameField:{hidden:false},storeTitle:{textContent:''},areaTitle:{textContent:''},hint:{textContent:''}};
const appInput={required:true,disabled:false},storeInput={required:false},areaInput={required:false},
 detailsInput={placeholder:''};
const form={elements:{namedItem(name){return {
 app_name:appInput,store_name:storeInput,prefecture:areaInput,details:detailsInput
 }[name]||input(name);}}};
Object.defineProperty(appInput,'value',{get:()=>values.app_name});
Object.defineProperty(storeInput,'value',{get:()=>values.store_name});
Object.defineProperty(areaInput,'value',{get:()=>values.prefecture});
Object.defineProperty(detailsInput,'value',{get:()=>values.details});
const nodes={lpAppForm:form,lpAppAppNameField:controls.appNameField,
 lpAppStoreNameTitle:controls.storeTitle,lpAppPrefectureTitle:controls.areaTitle,
 lpAppMethodHint:controls.hint};
const context={$:id=>nodes[id],safeLotteryUrl:u=>/^https?:\/\//.test(u),
 LP_MANUAL_AREAS:['東京都','栃木県','全国'],lpExtDateSave:v=>v||null,
 lpAppUrl:id=>'https://example.com/?app_lottery='+id};
const api=vm.runInNewContext(['lpAppSyncMethod','lpAppPayload','lpAppItem']
 .map(extract).join('\n')+'\n({lpAppSyncMethod,lpAppPayload,lpAppItem})',context,{timeout:1000});
api.lpAppSyncMethod();
assert.equal(controls.appNameField.hidden,false);
assert.equal(appInput.required,true);
let payload=api.lpAppPayload();
assert.equal(payload.registration_method,'app');
assert.equal(payload.app_name,'テスト公式アプリ');
values.registration_method='in_store';values.store_name='テストショップ宇都宮店';
api.lpAppSyncMethod();
assert.equal(controls.appNameField.hidden,true);
assert.equal(appInput.required,false);
assert.equal(appInput.disabled,true);
assert.equal(storeInput.required,true);
assert.equal(areaInput.required,true);
assert.throws(()=>api.lpAppPayload(),/都道府県/);
values.prefecture='栃木県';
payload=api.lpAppPayload();
assert.equal(payload.app_name,values.store_name);
assert.equal(payload.registration_method,'in_store');
const store=api.lpAppItem({id:'mock',registration_method:'in_store',
 app_name:payload.app_name,store_name:values.store_name,prefecture:'栃木県',
 event_title:values.event_title,created_at:'2026-10-26'});
assert.equal(store.manual_registration_method,'in_store');
assert.match(store.source_site,/店頭応募/);
const legacy=api.lpAppItem({id:'old',app_name:'旧アプリ',event_title:'既存抽選'});
assert.equal(legacy.manual_registration_method,'app');
assert.match(legacy.source_site,/アプリ抽選/);
assert.match(html,/手動抽選<br>登録/);
assert.match(html,/value="in_store"/);
assert.match(app,/storeName\.required=inStore/);
assert.match(app,/manual_registration_method==='in_store'/);

const navStart=html.indexOf('<nav aria-label="メインメニュー">');
const navEnd=html.indexOf('</nav>',navStart);
assert(navStart>=0&&navEnd>navStart,'Bottom navigation is present');
const navMarkup=html.slice(navStart,navEnd);
const navOrder=[...navMarkup.matchAll(/data-tab="([^"]+)"/g)].map(x=>x[1]);
assert.equal(navOrder.join(','),'map,add,lottery,lotteryResults,lotteryManage,appLottery,dev',
 'The bottom menu keeps its tab order and the login/share tab is moved to the header');
assert.doesNotMatch(navMarkup,/data-tab="group"/);
const headerStart=html.indexOf('<header id="appFixedHeader">');
const headerEnd=html.indexOf('</header>',headerStart);
assert(headerStart>=0&&headerEnd>headerStart,'The fixed header exists');
assert.match(html.slice(headerStart,headerEnd),
 /id="appLoginOpen"[^>]*data-tab="group"[^>]*>👤 ログイン<\/button>/);
assert.match(navMarkup,/data-tab="lotteryResults"[^>]*>\s*🏆\s*<span>抽選結果<\/span>/);
assert.match(navMarkup,/data-tab="appLottery"[^>]*>\s*📝\s*<span>手動抽選<br>登録<\/span>/);
assert.equal((navMarkup.match(/data-tab="lotteryResults"/g)||[]).length,1);
assert.equal((navMarkup.match(/data-tab="appLottery"/g)||[]).length,1);
assert.match(html,/<section id="lotteryResultsView"/);
assert.match(html,/<section id="appLotteryView"/);

console.log('Manual lottery registration: app legacy, store entry, required inputs, public labels OK');
