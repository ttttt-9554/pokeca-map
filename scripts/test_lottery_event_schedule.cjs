'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(name) {
  const start = app.indexOf('function ' + name + '(');
  const end = app.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, 'Missing ' + name);
  return app.slice(start, end + 5);
}

const url = 'https://livepocket.jp/e/schedule1';
const item = {
  url, result_announcement_date: '2026-11-10',
  purchase_start_date: '2026-11-13', purchase_end_date: '2026-11-15',
};
const records = new Map();
const saved = [];
const names = [
  'isLivePocketEventUrl', 'lotteryScheduleDate', 'lotteryScheduleTime', 'lotteryScheduleText',
  'lotteryPurchasePeriodText', 'lotteryOfficialSchedule', 'lotteryCardScheduleHtml',
  'lotteryTrackRecord', 'lotteryTrackAnnouncement', 'lotteryTrackClean',
  'lotteryPickupPeriodReversed', 'lotteryTrackerSchedule', 'lotteryTrackerDefaults',
  'lotteryTrackerSave',
];
const api = vm.runInNewContext(names.map(name => (name === 'lotteryTrackerSave' ? 'async ' : '') +
  extract(name)).join('\n') + '\n({lotteryCardScheduleHtml,lotteryTrackClean,lotteryTrackerDefaults,lotteryTrackerSave})', {
  lotteryItems: [item],
  lotteryTrackRecords: records,
  escape: String,
  authUser: {id: 'test-user'},
  lotteryTrackSaving: false,
  safeLotteryUrl: () => true,
  LP_TRACK_STATUSES: ['not_applied', 'applied', 'won', 'lost', 'received'],
  LP_TRACK_SELECT: 'result_announcement_date,result_announcement_time',
  lotteryTrackTableFor: () => 'lottery_user_entries',
  renderLotteryTrackerSummary() {},
  renderLottery() {},
  lpResultsRefresh() {},
  window: {},
  $: () => null,
  supabaseClient: {
    from() {
      return {
        upsert(row) {
          saved.push(row);
          return {select: () => ({single: async () => ({data: row, error: null})})};
        },
      };
    },
  },
}, {timeout: 1000});

async function main() {
  const card = api.lotteryCardScheduleHtml(item);
  assert.equal(card, '<small>抽選発表日：2026/11/10</small><small>購入期間：2026/11/13～2026/11/15</small>');
  assert.equal(api.lotteryCardScheduleHtml({url}), '<small>抽選発表日：</small><small>購入期間：</small>');
  assert.match(api.lotteryCardScheduleHtml({...item, result_announcement_time: '19:15'}), /2026\/11\/10 19:15/);
  assert.equal(api.lotteryCardScheduleHtml({url:'https://example.com/lottery'}), '');
  assert.match(extract('lotteryTrackerOpenEditor'), /type="date" name="result_announcement_date"/);
  assert.match(extract('lotteryTrackerOpenEditor'), /type="time" name="result_announcement_time"/);

  const defaults = api.lotteryTrackerDefaults(url);
  assert.equal(defaults.result_announcement_date, '2026-11-10');
  assert.equal(defaults.result_announcement_time, '');
  assert.equal(defaults.pickup_start, '2026-11-13');
  assert.equal(defaults.pickup_end, '2026-11-15');
  await api.lotteryTrackerSave(url, {...defaults, status:'applied', application_count:1, account_entries:[]});
  assert.equal(saved[0].result_announcement_date, '2026-11-10');
  assert.equal(saved[0].result_announcement_time, null);
  assert.equal(saved[0].result_announcement_at, null);
  assert.equal(saved[0].pickup_end_time, null);
  assert.equal(api.lotteryTrackerDefaults(url).result_announcement_time, '');

  records.set(url, api.lotteryTrackClean({
    event_url: url, result_announcement_at: '2026-11-12 21:10:00',
    pickup_start: '2026-11-18', pickup_start_time: '12:00:00',
  }));
  const prior = api.lotteryTrackerDefaults(url);
  assert.equal(prior.result_announcement_date, '2026-11-12');
  assert.equal(prior.result_announcement_time, '21:10');
  assert.equal(prior.pickup_start, '2026-11-18');
  assert.equal(prior.pickup_start_time, '12:00');
  assert.equal(prior.pickup_end, '', 'Do not fill an end date earlier than the saved start');
  await api.lotteryTrackerSave(url, {...prior, account_entries:[]});
  assert.equal(saved[1].result_announcement_at, '2026-11-12T21:10');
  console.log('LivePocket card, separate announcement fields, autofill and private save verified');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
