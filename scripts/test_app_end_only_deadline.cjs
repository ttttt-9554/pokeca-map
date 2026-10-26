#!/usr/bin/env node
// Explicit end-only deadlines are visible but must never be advertised as open.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function extract(name) {
  const begin = source.indexOf('  function ' + name + '(');
  const end = source.indexOf('\n  }\n', begin);
  assert(begin >= 0 && end > begin, 'Expected app function: ' + name);
  return source.slice(begin, end + '\n  }'.length);
}
const functions = ['lotteryDate', 'lotteryState'].map(extract).join('\n');
const { lotteryState } = vm.runInNewContext(
  functions + '\n({lotteryState})', {}, {timeout: 1000});

const now = Date.parse('2026-10-26T12:00:00+09:00');
const start = '2026-10-25T10:00:00+09:00';
const future = '2026-10-27T21:00:00+09:00';
const past = '2026-10-25T21:00:00+09:00';

assert.equal(lotteryState({application_end_at: future}, now), 'unknown',
  'A deadline alone cannot prove registration has opened');
assert.equal(lotteryState({application_end_at: past}, now), 'closed',
  'End-only event correctly becomes historical after expiry');
assert.equal(lotteryState({application_start_at: start, application_end_at: future}, now),
  'open', 'An explicit complete active period is open');
assert.equal(lotteryState({
  application_start_at: '2026-10-27T10:00:00+09:00',
  application_end_at: future
}, now), 'upcoming', 'Both dates show an unstarted application period');
assert.equal(lotteryState({
  application_end_at: future, manual_page_unavailable: true
}, now), 'unavailable', 'Missing-page administrator decisions win');
assert.equal(lotteryState({application_end_at: 'not-a-date'}, now), 'unknown',
  'Malformed deadlines never appear active');
console.log('6 safe end-only lottery status checks passed');
