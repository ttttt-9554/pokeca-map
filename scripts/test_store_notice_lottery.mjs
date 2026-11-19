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

// Sevennet's application conditions, application dates, announcement and delivery are separate sections.
const fairUrl = 'https://7net.omni7.jp/general/027016/fair-hobby-pokemoncardgame30th.html';
const fairProduct = 'ポケモンカードゲーム MEGA 30th CELEBRATION プレミアムデッキセット エーフィ・ブラッキー';
const fairTitle = 'ポケモンカードゲーム抽選販売 30th CELEBRATION プレミアムデッキセット エーフィ・ブラッキー';
const fairPage = '<div class="st-ns_freecontainer"><script type="application/ld+json">'+
  JSON.stringify({'@type':'BreadcrumbList',itemListElement:[{item:{'@id':fairUrl,name:fairTitle}}]})+'</script>'+
  '<h1>ポケモンカードゲーム抽選販売</h1><h2>■対象商品</h2><p>'+fairProduct+'<br>販売価格：6,200円</p>'+
  '<h2>■応募条件</h2><p>2025年11月1日～2026年11月16日</p>'+
  '<h2>■応募期間</h2><p>2026年11月19日17:00～2026年11月23日23:59<br>※先着順ではありません。</p>'+
  '<h2>■当選発表</h2><p>2026年12月8日 19:00までにご連絡</p>'+
  '<h2>■商品のお届け・お支払いについて</h2><p>2026年12月17日より順次お届け予定です。</p></div>'+
  '<footer><h2>応募期間</h2><p>2025年1月1日～2025年1月2日</p></footer>';
assert(supportedUrl(fairUrl));
assert(supportedUrl('https://7net.omni7.jp/detail/2190054281.html'));
assert.equal(storeNoticeUrl(fairUrl+'?utm_source=discord').href,fairUrl);
for(const bad of [fairUrl.replace('7net.omni7.jp','7net.omni7.jp.example.com'),fairUrl+'?next=x',fairUrl.replace('/fair-','/help-')])
  assert(!supportedUrl(bad),bad);
const fairFields = extract(fairPage,fairUrl);
assert.equal(fairFields.event_title,fairTitle);assert.equal(fairFields.product_name,fairProduct);
assert.equal(fairFields.review_category,'pokemon');assert.equal(fairFields.product_type,'deck');
assert.deepEqual(fairFields.stores,[{name:'セブンイレブン',prefecture:'全国'}]);
assert.equal(fairFields.application_start_at,'2026-11-19T17:00:00+09:00');
assert.equal(fairFields.application_end_at,'2026-11-23T23:59:00+09:00');
assert.equal(fairFields.result_announcement_date,'2026-12-08');assert.equal(fairFields.result_announcement_time,'19:00');
assert.match(fairFields.store_notice_result_note,/まで/);
assert.equal(fairFields.delivery_start_date,'2026-12-17');assert.equal(fairFields.purchase_start_date,undefined);
for(const badPage of [fairPage.replace(fairUrl,fairUrl.replace('30th','other')),
  fairPage.replace('■応募期間','■応募条件'),fairPage.replace('11月23日23:59','11月31日23:59'),
  fairPage.replace('■当選発表','■応募期間'),fairPage.replace('ポケモンカードゲーム抽選販売</h1>','一般のお知らせ</h1>')])
  assert.deepEqual(extract(badPage,fairUrl),{});
const fairRow = {url:fairUrl};
assert.deepEqual(await enrichStoreNotices({items:[fairRow]},async url=>{assert.equal(url,fairUrl);return fairPage;},now),{checked:1,updated:1});
assert.equal(fairRow.application_start_at,fairFields.application_start_at);assert.equal(fairRow.pokemon_map_type,'deck');
assert.equal(fairRow.store_notice_source_url,fairUrl);assert.equal(fairRow.external_url_unverified,false);
console.log('Verified article identity, store participation, directory, dates and recurring collection.');
