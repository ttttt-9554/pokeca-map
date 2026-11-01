'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function extract(name){
  const start=app.indexOf('  function '+name+'('),end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing helper '+name);
  return app.slice(start,end+5);
}
const api=vm.runInNewContext([
  extract('lotteryTokyoDay'),extract('lotterySummaryCounts'),
  '({lotteryTokyoDay,lotterySummaryCounts})'
].join('\n'),{
  Date,lotteryDate:v=>v?Date.parse(v):NaN,
  lotteryGenre:item=>item.review_category||'unknown',
  lotteryState:item=>item.status||'unknown'
},{timeout:1000});
const now=Date.parse('2026-11-02T00:30:00+09:00');
assert.equal(api.lotteryTokyoDay(now),'2026-11-02');
assert.equal(api.lotteryTokyoDay(now-86400000),'2026-11-01');
const events=[
  {review_category:'pokemon',status:'open',first_detected_at:'2026-11-02T00:00:00+09:00'},
  {review_category:'onepiece',status:'closed',first_detected_at:'2026-11-01T15:29:00Z'},
  {review_category:'unknown',status:'open',first_detected_at:'2026-11-01T00:00:00+09:00'},
  {review_category:'yugioh',status:'closed',first_detected_at:'2026-10-31T15:00:00Z'},
  {review_category:'unknown',status:'closed',first_detected_at:'2026-10-31T23:59:59+09:00'},
  {review_category:'unknown',status:'closed',first_detected_at:'2026-11-02T00:31:00+09:00'},
  {review_category:'unknown',status:'closed'}
];
assert.deepEqual(JSON.parse(JSON.stringify(api.lotterySummaryCounts(events,now))),
  {open:2,today:2,yesterday:2,pokemon:1,onepiece:1,unknown:4});
assert.match(app,/const publicItems=lotteryItems\.filter\(x=>!x\.app_lottery_hidden&&!x\.manual_card_hidden\)/);
assert.match(app,/lotterySummaryCounts\(publicItems,now\)/);
const order=[...app.matchAll(/<small>(受付中|今日の新着|昨日の新着|ポケカ|ワンピース|未分類)<\/small>/g)]
  .slice(0,6).map(x=>x[1]);
assert.equal(order.join(','),'受付中,今日の新着,昨日の新着,ポケカ,ワンピース,未分類');
console.log('JST daily new arrivals, verified open and genre summary counts passed');
