#!/usr/bin/env node
// Regression: expired admin-corrected lottery dates must be respected by
// historical review panels, even when the public JSON still has empty dates.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const begin = source.indexOf('  function lpApplicationExpired(');
const end = source.indexOf('\n  }\n', begin);
assert(begin >= 0 && end > begin, 'Expiry helper is present in app.js');
const functionBody = source.slice(begin, end + '\n  }'.length).trim();
const URL = 'https://livepocket.jp/e/exabc';
const NOW = Date.parse('2026-10-26T12:00:00+09:00');
const OLD = '2026-10-25T21:00:00+09:00';
const FUTURE = '2026-11-01T21:00:00+09:00';

function expired({publicEnd = null, visibleEnd = null,
                  edited = null, diagnostic = ''} = {}) {
  const lotteryBaseItems = [{url: URL, application_end_at: publicEnd}];
  const lotteryItems = visibleEnd === null ? [] :
    [{url: URL, application_end_at: visibleEnd}];
  const lpCardOverrides = new Map();
  if (edited !== null) lpCardOverrides.set(URL, edited);
  const lotteryDate = value => {
    const n = typeof value === 'string' && value ? Date.parse(value) : NaN;
    return Number.isFinite(n) ? n : NaN;
  };
  const check = vm.runInNewContext('(' + functionBody + ')', {
    lotteryBaseItems, lotteryItems, lpCardOverrides, lotteryDate
  }, {timeout: 1000});
  return check(URL, diagnostic, NOW);
}

assert.equal(expired({publicEnd: OLD}), true,
  'Published expired applications remain historical');
assert.equal(expired({diagnostic: OLD}), true,
  'Legacy diagnostic fallback is retained');
assert.equal(expired({}), false,
  'Unknown periods are never guessed as expired');
assert.equal(expired({visibleEnd: OLD}), true,
  'Merged visible manual dates are consulted');
assert.equal(expired({publicEnd: OLD, visibleEnd: FUTURE}), false,
  'A newer merged deadline supersedes stale public JSON');
assert.equal(expired({edited: {
  edited_fields: ['application_end_at'], application_end_at: OLD
}}), true, 'Expired Supabase card correction takes precedence');
assert.equal(expired({publicEnd: OLD, edited: {
  edited_fields: ['application_end_at'], application_end_at: FUTURE
}}), false, 'Future admin override keeps item active');
assert.equal(expired({publicEnd: OLD, diagnostic: OLD, edited: {
  edited_fields: ['application_end_at'], application_end_at: null
}}), false, 'An intentional administrator date clear stays unknown');
assert.equal(expired({publicEnd: OLD, edited: {
  edited_fields: ['stores'], application_end_at: FUTURE
}}), true, 'Unedited date columns never override public dates');

console.log('9 app manual-expiry regression checks passed');
