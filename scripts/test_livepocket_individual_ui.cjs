'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8');
function extract(name){const start=app.indexOf('  async function '+name+'('),end=app.indexOf('\n  }\n',start);assert(start>=0&&end>start);return app.slice(start,end+4)}
const values={event_title:{value:'編集済みイベント'},product_name:{value:''},application_start_at:{value:'2026-11-01T10:00'},application_end_at:{value:''}};
let stores=[{name:'渋谷店',prefecture:''},{name:'秋葉原店',prefecture:'東京都'}],rendered=null,message='';
const context={isLivePocketEventUrl:()=>true,lpDevUnifiedOpenEditor:async()=>{},
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
 console.log('LivePocket candidate handoff preserves existing values and stores');
})().catch(e=>{console.error(e);process.exitCode=1});
