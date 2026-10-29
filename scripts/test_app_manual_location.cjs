#!/usr/bin/env node
// Regression: a Supabase-corrected location must not remain in the
// developer's "店名・都道府県 未確認" queue just because source JSON is unchanged.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function get(name) {
  const begin = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  }\n', begin);
  assert(begin !== -1 && end !== -1, 'Expected app helper: ' + name);
  return source.slice(begin, end + '\n  }'.length);
}
const functions = [
  'lotteryStoreEntries',
  'lotteryPrefectures',
  'lpLocationEffective',
  'lpLocationBaseList',
  'lpLocationNeedsManualReview'
].map(get).join('\n');

const URL='https://livepocket.jp/e/abcde';
const base = {url: URL, store_name:'店名未確認'};
const baseItems = [base];
const visibleItems = [];
const context = {
  lotteryBaseItems: baseItems,
  lotteryItems: visibleItems,
  lpCardOverrides: new Map(),
  isLivePocketEventUrl: value => typeof value === 'string' &&
    value.startsWith('https://livepocket.jp/e/')
};
const app=vm.runInNewContext(functions +
  '\n({lpLocationBaseList, lpLocationEffective, lpLocationNeedsManualReview})',
  context, {timeout: 1000});

assert.equal(app.lpLocationNeedsManualReview(base), true,
  'Original unknown-prefecture card is unresolved');
visibleItems.push({url:URL,store_name:'確認済み店舗',prefecture:'東京都'});
assert.equal(app.lpLocationNeedsManualReview(base), false,
  'Supabase corrected single-store card is resolved');
assert.equal(app.lpLocationEffective(base).prefecture, '東京都',
  'The effective card, not original JSON, supplies current prefecture');
assert.equal(app.lpLocationBaseList().length,1,
  'A corrected single-store card still appears as eligible source');

visibleItems[0]={url: URL, stores:[{name:'確認済み',prefecture:'栃木県'}]};
assert.equal(app.lpLocationNeedsManualReview(base), false,
  'Store-list override counts as a complete correction');
visibleItems[0]={url: URL, stores:[{name:'確認済み',prefecture:''}]};
assert.equal(app.lpLocationNeedsManualReview(base), true,
  'Missing prefecture remains actionable');

visibleItems[0]={url: URL, stores:[
  {name:'東京店',prefecture:'東京都'},
  {name:'栃木店',prefecture:'栃木県'}
]};
assert.equal(app.lpLocationBaseList().length,0,
  'Admin-corrected multi-store event must not enter single-store editor');

visibleItems.length=0;
baseItems[0]={url: URL, stores:[
  {name:'東京店',prefecture:'東京都'},
  {name:'栃木店',prefecture:'栃木県'}
]};
assert.equal(app.lpLocationBaseList().length,0,
  'Original multi-store records remain excluded from single-store editor');

// Administrator-hidden cards are never queued for location correction;
// un-hiding restores the original behavior without deleting the base event.
baseItems[0]={url:URL,store_name:'店名未確認'};
context.lpCardOverrides.set(URL,{event_url:URL,is_hidden:true});
assert.equal(app.lpLocationBaseList().length,0,
  'Hidden LivePocket cards must be excluded from the location review queue');
context.lpCardOverrides.set(URL,{event_url:URL,is_hidden:false});
assert.equal(app.lpLocationBaseList().length,1,
  'Restored cards return to the location review queue');

console.log('10 app manual-location regression checks passed');
