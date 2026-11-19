import assert from 'node:assert/strict';
import {storeNoticeUrl, fetchStoreNotice, STORE_DIRECTORY} from '../supabase/functions/lottery-individual-fetch/store-notices.mjs';
import {supportedUrl, extract} from '../supabase/functions/lottery-individual-fetch/extract.mjs';
import {enrichStoreNotices} from './store_notice_lottery_enrich.mjs';

const skip = 'https://www.skip-tcg.com/view/news/20261118170202';
const otakara = 'https://www.otakarasouko.com/information/109459977/';
const header = url => '<link rel="canonical" href="' + url + '">';
const skipBody = `<div class="news-wrap"><h2 class="sec_ttl">スキップ ポケモンカード抽選予約販売</h2>
  <div class="news-content">2026.11.18<br>・対象商品<br>ポケモンカードゲーム『拡張パック ハドウシーカー』※店頭販売のみ<br>
  発売日：2026年11月27日(金)<br>応募期間：2026年11月19日(木)～2026年11月21日(土)12:00<br>
  当選発表：2026年11月22日(日)<br>購入期間：2026年11月27日(金)<br>
  2026年11月28日(土)<br>2026年11月29日(日)</div></div>`;
const otaBody = `<article class="article-detail"><div class="article-detail__date poppins">2026/11/19</div>
  <h1 class="article-detail__title">ポケモンカードゲーム「拡張パック ハドウシーカー」抽選販売に関して</h1>
  <section class="article-detail__cont article-detail__cont--column"><div>【抽選対象商品】</div>
  <p>ポケモンカードゲーム「拡張パック ハドウシーカー」</p>
  <div>【対象店舗一覧】</div><div>■ お宝創庫 店舗</div><table><tr><td>・安城店</td><td>・共和店</td></tr></table>
  <div>■ プレイズ 店舗</div><table><tr><td>・安城店<br>・京都駅前店</td></tr></table>
  <div>【お申し込み条件】</div><p>2025年11月18日～2026年11月18日に購入履歴</p>
  <div>【抽選受付期間】</div><p>2026年11月19日(木) ひる12時 ～ 2026年11月22日(日) 23時45分</p>
  <div>【当選通知】</div><p>当選された方には、2026年11月25日（水）頃に<br>アプリで通知</p>
  <div>【当選者購入期間】</div><p>2026年11月27日（金） ～ 2026年11月29日（日）</p>
  </section></article><aside>■ お宝創庫 店舗<br>・その他店</aside>`;
const directory = [
  ['お宝創庫 安城店','愛知県安城市'], ['お宝創庫 共和店','愛知県大府市'],
  ['プレイズ 安城店','愛知県安城市'], ['プレイズ 京都駅前店','京都市下京区'],
  ['お宝創庫 範囲外店','大阪府大阪市']
].map(([name,address]) => '<p class="name">'+name+'</p><p class="address">'+address+'</p>').join('');
for (const url of [skip, otakara]) assert(supportedUrl(url));
for (const url of ['http://www.skip-tcg.com/view/news/20261118170202',skip+'?next=other',otakara+'edit',STORE_DIRECTORY])
  assert.equal(storeNoticeUrl(url),null);
const skipPage = header(skip)+'<nav>購入期間：2026/12/31</nav>'+skipBody;
const otaPage = header(otakara)+otaBody;
const fields = extract(skipPage,skip);
assert.equal(fields.application_start_at,'2026-11-19');
assert.equal(fields.application_end_at,'2026-11-21T12:00:00+09:00');
assert.equal(fields.purchase_start_date,'2026-11-27');
assert.equal(fields.purchase_end_date,'2026-11-29');
assert.equal(fields.result_announcement_date,'2026-11-22');
assert.equal(fields.result_announcement_time,undefined);
assert.equal(fields.prefecture,'大阪府');
assert.equal(fields.review_category,'pokemon');
assert(!fields.product_name.includes('※'));
assert.equal(extract(skipPage.replace('2026年11月28日(土)<br>',''),skip).purchase_end_date,undefined);
assert.deepEqual(extract(otaPage,otakara.replace('9977','9999')),{});
assert.deepEqual(extract(header(skip)+'<h2>抽選</h2><p>応募期間：11/19～11/22</p>',skip),{});
const pages = new Map([[skip,skipPage],[otakara,otaPage],[STORE_DIRECTORY,directory]]);
const loads = [];
const load = async url => {loads.push(url);assert(pages.has(url));return pages.get(url);};
const ota = await fetchStoreNotice(otakara,load);
assert.equal(ota.application_start_at,'2026-11-19T12:00:00+09:00');
assert.equal(ota.application_end_at,'2026-11-22T23:45:00+09:00');
assert.equal(ota.result_announcement_date,'2026-11-25');
assert.equal(ota.purchase_end_time,undefined);
assert.equal(ota.purchase_end_date,'2026-11-29');
assert.deepEqual(ota.stores.map(s=>s.name),['お宝創庫 安城店','お宝創庫 共和店','プレイズ 安城店','プレイズ 京都駅前店']);
assert.deepEqual(ota.stores.map(s=>s.prefecture),['愛知県','愛知県','愛知県','京都府']);
const catalog = {items:[{url:skip},{url:otakara},{url:otakara,manual_card_hidden:true}]};
const now = new Date('2026-11-19T04:00:00Z');
assert.deepEqual(await enrichStoreNotices(catalog,load,now),{checked:2,updated:2});
assert.deepEqual(await enrichStoreNotices(catalog,load,now),{checked:0,updated:0});
assert.equal(catalog.items[1].external_url_unverified,false);
assert.equal(catalog.items[1].stores.length,4);
assert.equal(catalog.items[2].store_notice_verified_at,undefined);
const missingDirectory = async url => {if(url===STORE_DIRECTORY)throw Error('offline');return load(url);};
await enrichStoreNotices(catalog,missingDirectory,new Date(+now+7*3600000));
assert.equal(catalog.items[1].stores[3].prefecture,'京都府');
const offline = async () => {throw Error('offline');};
assert.deepEqual(await enrichStoreNotices(catalog,offline,new Date(+now+14*3600000)),{checked:2,updated:0});
assert.equal(catalog.items[0].purchase_end_date,'2026-11-29');
console.log('Verified article identity, store participation, directory, dates and recurring collection.');
