'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8');
function extract(name){const start=app.indexOf('  async function '+name+'('),end=app.indexOf('\n  }\n',start);assert(start>=0&&end>start);return app.slice(start,end+4)}
const values={event_title:{value:'編集済みイベント'},product_name:{value:''},application_start_at:{value:'2026-11-01T10:00'},application_end_at:{value:''}};
let stores=[{name:'渋谷店',prefecture:''},{name:'秋葉原店',prefecture:'東京都'}],rendered=null,message='';
const starbox='https://shoplottery.e-starbox.com/lottery/entry?code=YJTlpkMz6h';
let opensCard=false;
const context={isLivePocketEventUrl:u=>u.includes('livepocket.jp'),lpDevUnifiedOpenEditor:async(_url,card)=>{opensCard=card},
 LOTTERY_SHARED_SCHEDULE_FIELDS:['result_announcement_date','purchase_end_date'],lotterySharedScheduleValue:(r,k)=>r[k],
 lotteryBaseItems:[{url:starbox,external_url_unverified:true}],lpCardOverrides:new Map(),lpExtOverrides:new Map(),
 $:id=>id==='lpCardForm'?{elements:{namedItem:n=>values[n]}}:id==='lpCardStoresFold'?{open:false}:null,
 lpExtDateInput:x=>x.slice(0,16),LP_MANUAL_AREAS:['東京都','千葉県'],LP_CARD_MAX_STORES:100,
 lpCardStoreRead:()=>stores.map(s=>({...s})),lpCardStoreRender:rows=>{rendered=rows},
 lpPresetStoreKey:s=>s.name.normalize('NFKC'),lpCardSetStatus:x=>{message=x}};
const open=vm.runInNewContext(extract('lpDevOpenFetchedEditor')+'\nlpDevOpenFetchedEditor',context);
(async()=>{
 await open('https://livepocket.jp/e/test123',{event_title:'別の名前',product_name:'商品A',application_start_at:'2026-11-02T09:00:00+09:00',application_end_at:'2026-11-07T23:59:00+09:00',stores:[{name:'渋谷店',prefecture:'千葉県'},{name:'追加店',prefecture:'東京都'}]});
 assert.equal(values.event_title.value,'編集済みイベント');assert.equal(values.product_name.value,'商品A');
 assert.equal(values.application_start_at.value,'2026-11-01T10:00');assert.equal(values.application_end_at.value,'2026-11-07T23:59');
 assert.equal(rendered.length,2);assert.equal(rendered[0].prefecture,'千葉県');assert.equal(rendered[1].name,'秋葉原店');
 assert.match(message,/確認して保存/);
 stores=[];rendered=null;await open('https://livepocket.jp/e/test123',{stores:[{name:'新規店舗',prefecture:'東京都'}]});
 assert.equal(rendered[0].name,'新規店舗');
 stores=[{name:'',prefecture:''}];rendered=null;
 values.event_title.value='Discordの省略タイトル…';
 values.result_announcement_date={value:''};values.purchase_end_date={value:''};
 await open(starbox,{event_title:'Starboxの正式な抽選名',store_name:'亀戸店',prefecture:'東京都',
   result_announcement_date:'2026-11-08',purchase_end_date:'2026-11-15'});
 assert.equal(opensCard,true);
 assert.equal(values.event_title.value,'Starboxの正式な抽選名');
 assert.equal(values.result_announcement_date.value,'2026-11-08');
 assert.equal(values.purchase_end_date.value,'2026-11-15');
 assert.equal(rendered[0].name,'亀戸店');
 context.lpCardOverrides.set(starbox,{edited_fields:['event_title']});
 values.event_title.value='管理者が確認した名前';
 await open(starbox,{event_title:'別の取得名',result_announcement_date:'2026-11-09'});
 assert.equal(values.event_title.value,'管理者が確認した名前');
 assert.equal(values.result_announcement_date.value,'2026-11-08');
 console.log('Lottery candidate handoff preserves manual values and fills Starbox dates');
})().catch(e=>{console.error(e);process.exitCode=1});
