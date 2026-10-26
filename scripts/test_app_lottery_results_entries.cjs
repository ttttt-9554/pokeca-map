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
const counts=new Map([
  [eventA.url,{total_count:1,application_entries:5,won_entries:2,
               lost_entries:1,pending_entries:2,won_count:1,lost_count:1}],
  [eventB.url,{total_count:9,application_entries:3,won_entries:0,
               lost_entries:0,pending_entries:3,won_count:9,lost_count:9}],
  [eventZero.url,{total_count:1,application_entries:0,won_entries:0,
                  lost_entries:0,pending_entries:0,won_count:1,lost_count:1}]
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
  lotteryItems:[eventA,eventB,eventZero],
  authUser:{id:'test-user'}, supabaseClient:{},
  lpResultsReady:true, lpResultsError:'', lpResultsManualBusy:false,
  lpResultsManualError:'', lpResultsManualSuccessAt:'',
  LP_RESULTS_MIN_APPLICATION_ENTRIES:1,
  $:id=>elements[id],
  lpResultsAccount:()=>{},
  safeLotteryUrl:url=>typeof url==='string'&&url.startsWith('https://livepocket.jp/e/'),
  lotteryTrackItemName:url=>url===eventA.url?'抽選A':'抽選B',
  lpResultsStoreHtml:()=>'<div class="lp-results-store">対象店舗</div>',
  lotteryStoreEntries:()=>[],
  lotteryFirstSeenTime:()=>0,
  escape:value=>String(value)
};
const api=vm.runInNewContext(
  [extract('lpResultsKnownEvents'),extract('lpResultsRender')].join('\n')+
  '\n({lpResultsKnownEvents,lpResultsRender})',context,{timeout:1000}
);
assert.equal(api.lpResultsKnownEvents().length,2,
  'Zero-ticket events are excluded regardless of registered user count');
api.lpResultsRender();
assert.match(elements.lpResultsCounts.innerHTML,/応募合計 8口/,
  'Total entry count sums across all visible events');
assert.match(elements.lpResultsList.innerHTML,/応募 5口/);
assert.match(elements.lpResultsList.innerHTML,/当選 2口/);
assert.match(elements.lpResultsList.innerHTML,/落選 1口/);
assert.match(elements.lpResultsList.innerHTML,/結果待ち 2口/);
assert.doesNotMatch(elements.lpResultsList.innerHTML,/応募者|当選者|落選者|[0-9]+人/);
assert.doesNotMatch(elements.lpResultsCounts.innerHTML,/人から表示|応募者/);
assert.match(elements.lpResultsList.innerHTML,/抽選の詳細を開く/);

elements.lpResultsFilter.value='won';
api.lpResultsRender();
assert.match(elements.lpResultsList.innerHTML,/抽選A/);
assert.doesNotMatch(elements.lpResultsList.innerHTML,/抽選B/,
  'Even a high people-count cannot pass when won ticket count is zero');
elements.lpResultsFilter.value='lost';
api.lpResultsRender();
assert.match(elements.lpResultsList.innerHTML,/抽選A/);
assert.doesNotMatch(elements.lpResultsList.innerHTML,/抽選B/);
elements.lpResultsFilter.value='applied';
api.lpResultsRender();
assert.match(elements.lpResultsList.innerHTML,/抽選A/);
assert.match(elements.lpResultsList.innerHTML,/抽選B/);
assert.match(page,/応募・当選・落選・結果待ちをすべて口数で匿名集計/);
assert.doesNotMatch(page,/応募人数に加えて/);
assert.match(app,/<label>当選口数<input name="won_count"/);
assert.match(app,/<label>落選口数<input name="lost_count"/);
assert.doesNotMatch(app,/当選数|落選数/);
console.log('Lottery results use ticket entries only: UI and filter checks passed');
