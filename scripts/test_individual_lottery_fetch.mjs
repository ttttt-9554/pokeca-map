import assert from 'node:assert/strict';
import {supportedUrl,extract} from '../supabase/functions/lottery-individual-fetch/extract.mjs';
import {enrichCloudPass} from './cloud_pass_lottery_enrich.mjs';
const g='https://docs.google.com/forms/d/e/1FAIpQLSd6O9PhrqOHX4xxcRV4APYy_B_0OyCAW_ZkTa-Rp7htUleUjQ/closedform';
assert(supportedUrl(g));
for(const url of ['https://docs.google.com.evil.test/forms/d/e/aaaaaaaaaaaaaaaaaaaa/viewform','http://docs.google.com/forms/d/e/aaaaaaaaaaaaaaaaaaaa/viewform','https://docs.google.com/forms/d/e/aaaaaaaaaaaaaaaaaaaa/viewform?foo=1','https://e-yamashiroya.com@localhost/a','https://e-yamashiroya.com/a?next=http://localhost'])assert(!supportedUrl(url),url);
const page='<html><title>【抽選販売】ポケモンカード MEGA ハドウシーカー</title><body>応募期間：2026年11月4日17:00～2026年11月9日23:59</body></html>';
assert.deepEqual(extract(page,'https://7net.omni7.jp/detail/2190054281.html'),{event_title:'【抽選販売】ポケモンカード MEGA ハドウシーカー',application_start_at:'2026-11-04T17:00:00+09:00',application_end_at:'2026-11-09T23:59:00+09:00',store_name:'セブンイレブン',prefecture:'全国'});
const form='<title>抽選応募フォーム</title><body>ヤマシロヤ オンラインショップの抽選応募</body>';
assert.equal(extract(form,g).store_name,'ヤマシロヤ オンラインショップ');
assert.equal(extract(form,g).prefecture,undefined);
assert.deepEqual(extract('<title>Verify you are human</title>verify you are human',g),{});
assert(!extract(page.replace('11月9日23:59','11月99日23:59'),'https://7net.omni7.jp/detail/2190054281.html').application_end_at);
const cloud = 'https://cloud-pass.jp/pr/' + 'a'.repeat(64);
assert(supportedUrl(cloud));
for (const url of [cloud + '?next=https://example.com', cloud + '#test',
  cloud.replace('cloud-pass.jp', 'cloud-pass.jp.example.com'), cloud.replace('/pr/', '/mypage/'),
  cloud.slice(0, -1), cloud.replace('https:', 'http:')]) assert(!supportedUrl(url), url);
const cloudTitle = '2611_【抽選】ポケモンカードゲーム MEGA 拡張パック ハドウシーカー 販売予約';
const cloudPeriod = '<dl class="date"><dt>申込期間</dt><dd class="date-translation">' +
  '2026年11月6日（金） 10:00 - 2026年11月8日（日） 23:59</dd></dl>';
const cloudPage = '<title>申込開始｜CLOUD PASS</title><h1><img alt="CLOUD PASS"></h1>' +
  '<h3 class="projectName primary-background">SHIBUYA TSUTAYA</h3>' +
  '<h3 class="projectName">SHIBUYA TSUTAYA</h3>' +
  '<div class="subject__detail"><h3 class="title">' + cloudTitle + '</h3>' + cloudPeriod + '</div>' +
  '<p>≪商品受取り日程≫</p><p>2026年11月27日(金)～2026年12月6日(日)</p>' +
  '<p>≪受取場所≫</p><p>POKÉMON CARD LOUNGE（SHIBUYA TSUTAYA 5F）</p>';
const cloudFields = {event_title: cloudTitle, application_start_at: '2026-11-06T10:00:00+09:00',
  application_end_at: '2026-11-08T23:59:00+09:00', store_name: 'SHIBUYA TSUTAYA',
  prefecture: '東京都', review_category: 'pokemon', product_type: 'pack'};
assert.deepEqual(extract(cloudPage, cloud), cloudFields);
assert.equal(extract(cloudPage.replace('申込期間', '受取期間'), cloud).application_start_at, undefined);
assert.equal(extract(cloudPage.replace(' 10:00', ''), cloud).application_start_at, undefined);
assert.equal(extract(cloudPage + cloudPeriod.replace('23:59', '22:59'), cloud).application_end_at, undefined);
assert.equal(extract(cloudPage.replace('SHIBUYA TSUTAYA 5F', '別会場'), cloud).store_name, undefined);
assert.deepEqual(extract(cloudPage.replace('【抽選】', ''), cloud), {});
assert.deepEqual(extract(cloudPage, cloud + '?next=https://example.com'), {});

const catalog = {items: [{url: cloud, event_title: '', external_url_unverified: true}, {url: g}]};
const now = new Date('2026-11-06T03:00:00Z');
assert.equal(await enrichCloudPass(catalog, async url => {
  assert.equal(url, cloud);
  return cloudPage;
}, now), 1);
assert.equal(catalog.items[0].official_event_title, cloudTitle);
assert.equal(catalog.items[0].pokemon_map_type, 'pack');
assert.equal(catalog.items[0].application_start_at, cloudFields.application_start_at);
assert.equal(catalog.items[0].external_url_unverified, false);
assert.equal(await enrichCloudPass(catalog, () => assert.fail('verified event refetched'), now), 0);
const unavailable = {items: [{url: cloud, external_url_unverified: true}]};
assert.equal(await enrichCloudPass(unavailable, async () => '<title>ログイン</title>', now), 1);
assert.equal(unavailable.items[0].external_url_unverified, true);
assert.equal(await enrichCloudPass(unavailable, () => assert.fail('retry interval ignored'), now), 0);
console.log('Individual lottery extraction, blocked pages and URL restrictions passed');
