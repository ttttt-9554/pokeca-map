#!/usr/bin/env node
// Regression: public lottery results count application entries, not people.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const page=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function extract(name){
  const start=app.indexOf('  function '+name+'(');
  const end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing app helper '+name);
  return app.slice(start,end+'\n  }'.length);
}

const eventA={url:'https://livepocket.jp/e/test123',event_title:'抽選A'};
const eventB={url:'https://livepocket.jp/e/test456',event_title:'抽選B'};
const eventZero={url:'https://livepocket.jp/e/test789',event_title:'抽選C'};
const eventFinal={url:'https://livepocket.jp/e/testfinal',event_title:'抽選D'};
const counts=new Map([
  [eventA.url,{total_count:1,application_entries:5,won_entries:2,
               lost_entries:1,pending_entries:2,won_count:1,lost_count:1}],
  [eventB.url,{total_count:9,application_entries:3,won_entries:0,
               lost_entries:0,pending_entries:3,won_count:9,lost_count:9}],
  [eventZero.url,{total_count:1,application_entries:0,won_entries:0,
                  lost_entries:0,pending_entries:0,won_count:1,lost_count:1}],
  [eventFinal.url,{total_count:2,application_entries:2,won_entries:1,
                  lost_entries:1,pending_entries:0,won_count:1,lost_count:1}]
]);
const elements={
  lpResultsStatus:{textContent:''},
  lpResultsCounts:{innerHTML:''},
  lpResultsList:{innerHTML:''},
  lpResultsSearch:{value:''},
  lpResultsSearchClear:{hidden:true},
  lpResultsFilter:{value:'all'}
};
const context={
  lpResultsCounts:counts,
  lotteryItems:[eventA,eventB,eventZero,eventFinal],
  lpResultsStageOpen:{waiting:true,provisional:false,confirmed:false},
  authUser:{id:'test-user'}, supabaseClient:{},
  lpResultsReady:true, lpResultsError:'', lpResultsManualBusy:false,
  lpResultsManualError:'', lpResultsManualSuccessAt:'',
  LP_RESULTS_MIN_APPLICATION_ENTRIES:1,
  $:id=>elements[id],
  lpResultsAccount:()=>{},
  safeLotteryUrl:url=>typeof url==='string'&&url.startsWith('https://livepocket.jp/e/'),
  lotteryTrackItemName:url=>[eventA,eventB,eventFinal].find(item=>item.url===url)?.event_title||'未確認',
  lpResultsStoreHtml:()=>'<div class="lp-results-store">対象店舗</div>',
  lotteryStoreEntries:()=>[],
  lotteryFirstSeenTime:()=>0,
  escape:value=>String(value)
};
const api=vm.runInNewContext(
  [extract('lpResultsKnownEvents'),extract('lpResultsWinRate'),
   extract('lpResultsStage'),extract('lpResultsRender')].join('\n')+
  '\n({lpResultsKnownEvents,lpResultsWinRate,lpResultsStage,lpResultsRender})',context,{timeout:1000}
);
assert.equal(api.lpResultsKnownEvents().length,3,
  'Zero-ticket events are excluded regardless of registered user count');
api.lpResultsRender();
assert.match(elements.lpResultsCounts.innerHTML,/応募記録あり 1件/);
assert.match(elements.lpResultsCounts.innerHTML,/応募合計 3口/,
  'Top total excludes draws once any win OR loss is recorded');
assert.equal(api.lpResultsStage(counts.get(eventA.url)),'provisional');
assert.equal(api.lpResultsStage(counts.get(eventB.url)),'waiting');
assert.equal(api.lpResultsStage(counts.get(eventFinal.url)),'confirmed');
assert.match(elements.lpResultsList.innerHTML,/data-lp-results-stage="waiting" open/);
assert.match(elements.lpResultsList.innerHTML,/data-lp-results-stage="provisional"/);
assert.match(elements.lpResultsList.innerHTML,/data-lp-results-stage="confirmed"/);
assert.match(elements.lpResultsList.innerHTML,/集計待ち<\/span><span class="lp-results-stage-count">1件/);
assert.match(elements.lpResultsList.innerHTML,/暫定<\/span><span class="lp-results-stage-count">1件/);
assert.match(elements.lpResultsList.innerHTML,/確定<\/span><span class="lp-results-stage-count">1件/);
assert.match(elements.lpResultsList.innerHTML,/応募 5口/);
assert.match(elements.lpResultsList.innerHTML,/当選 2口/);
assert.match(elements.lpResultsList.innerHTML,/落選 1口/);
assert.match(elements.lpResultsList.innerHTML,/結果待ち 2口/);
assert.match(elements.lpResultsList.innerHTML,/当選率<\/span><strong>66\.7%<\/strong>/,
  '2 wins from 3 decided tickets must show 66.7 percent');
assert.match(elements.lpResultsList.innerHTML,/結果判明3口・暫定/,
  'Remaining pending tickets make the rate provisional');
assert.match(elements.lpResultsList.innerHTML,/当選率<\/span><strong>集計待ち<\/strong>/,
  'All pending tickets must not display an incorrect zero percent');
const sample=(applications,won,lost,pending)=>({
  application_entries:applications,won_entries:won,
  lost_entries:lost,pending_entries:pending
});
assert.equal(api.lpResultsWinRate(sample(1,0,1,0)).percentage,'0.0%',
  'A decided loss produces zero percent');
assert.equal(api.lpResultsWinRate(sample(1,1,0,0)).percentage,'100.0%',
  'A decided win produces 100 percent');
assert.equal(api.lpResultsWinRate(sample(8,2,2,4)).percentage,'50.0%',
  'Pending entries must not count as losses');
assert.equal(api.lpResultsWinRate(sample(4,0,0,4)).percentage,null,
  'Unknown results have no numerical win rate');
assert.equal(api.lpResultsWinRate(sample(8,2,2,4)).provisional,true);
assert.equal(api.lpResultsWinRate(sample(1,1,0,0)).provisional,false);
assert.equal(api.lpResultsWinRate(sample(3,2,2,-1)),null,
  'Invalid aggregate totals must not be displayed as valid');
assert.equal(api.lpResultsWinRate(sample(3,2,1,1)),null,
  'Inconsistent pending totals must fail closed');
assert.equal(api.lpResultsWinRate(sample(0,0,0,0)),null,
  'No submitted tickets means no denominator');

assert.doesNotMatch(elements.lpResultsList.innerHTML,/応募者|当選者|落選者|[0-9]+人/);
assert.doesNotMatch(elements.lpResultsCounts.innerHTML,/人から表示|応募者/);
assert.match(elements.lpResultsList.innerHTML,/抽選の詳細を開く/);

elements.lpResultsFilter.value='won';
api.lpResultsRender();
assert.match(elements.lpResultsList.innerHTML,/抽選A/);
assert.doesNotMatch(elements.lpResultsList.innerHTML,/抽選B/,
  'Even a high people-count cannot pass when won ticket count is zero');
assert.match(elements.lpResultsList.innerHTML,/抽選D/);
elements.lpResultsFilter.value='lost';
api.lpResultsRender();
assert.match(elements.lpResultsList.innerHTML,/抽選A/);
assert.match(elements.lpResultsList.innerHTML,/抽選D/);
assert.doesNotMatch(elements.lpResultsList.innerHTML,/抽選B/);
elements.lpResultsFilter.value='applied';
api.lpResultsRender();
assert.match(elements.lpResultsList.innerHTML,/抽選A/);
assert.match(elements.lpResultsList.innerHTML,/抽選B/);
assert.match(elements.lpResultsList.innerHTML,/抽選D/);
assert.match(page,/上の「応募記録あり」「応募合計」/);
assert.match(page,/応募・当選・落選・結果待ちをすべて口数で匿名集計/);
assert.doesNotMatch(page,/応募人数に加えて/);
assert.match(page,/当選口数÷（当選口数＋落選口数）×100/);
assert.match(page,/実際の抽選の当選確率を保証しません/);
assert.match(app,/<label>当選口数<input name="won_count"/);
assert.match(app,/<label>落選口数<input name="lost_count"/);
assert.doesNotMatch(app,/当選数|落選数/);
console.log('Lottery results use ticket entries only: UI and filter checks passed');
