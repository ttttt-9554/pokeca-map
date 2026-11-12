import assert from 'node:assert/strict';
import {supportedUrl, extract, lotteryPageRequest} from '../supabase/functions/lottery-individual-fetch/extract.mjs';
import {enrichCloudPass, enrichStarbox, enrichGeo, enrichRakutenBooks} from './cloud_pass_lottery_enrich.mjs';
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

const starbox = 'https://shoplottery.e-starbox.com/lottery/entry?code=YJTlpkMz6h';
assert(supportedUrl(starbox));
for (const url of [starbox + '&code=abcdefghij', starbox + '#entry', starbox.slice(0,-1),
  starbox.replace('shoplottery.e-starbox.com', 'shoplottery.e-starbox.com.example.org'),
  starbox.replace('/entry', '/apply'), starbox.replace('https:', 'http:')]) assert(!supportedUrl(url), url);
const starTitle = '【トレーディングカードピット亀戸店】拡張パック「見本」購入権抽選';
const starPeriod = '<h3>応募期間</h2><div>2026/11/06 10:00:00 ～ 2026/11/08 21:00:59</div>';
const starPage = '<h1>'+starTitle+'</h1><div id="lottery-detail">'+starPeriod+
  '<div>ポケモンカードゲームの抽選です。</div>'+
  '<div>11月9日(月) 開店時から11月15日(日) 閉店時までにお買い求めください。</div>'+
  '<div>▼抽選結果の発表に関して</div><div>11月8日(日)の21時30分ごろを予定しております。</div></div>'+
  '<div id="lottery-tutorial">応募について</div><label for="input-item_no-1">拡張パック 見本</label>';
const starFields = {event_title:starTitle, application_start_at:'2026-11-06T10:00:00+09:00',
  application_end_at:'2026-11-08T21:00:59+09:00', result_announcement_date:'2026-11-08',
  purchase_start_date:'2026-11-09', purchase_end_date:'2026-11-15',
  store_name:'トレーディングカードピット亀戸店', prefecture:'東京都', product_name:'拡張パック 見本',
  review_category:'pokemon', product_type:'pack'};
assert.deepEqual(extract(starPage, starbox), starFields);
assert.equal(extract(starPage.replace('21時30分ごろ', '21時30分'), starbox).result_announcement_time,'21:30');
const range = starPage.replace('11月8日(日)の21時30分ごろ', '11月8日～10日 18:00');
assert.equal(extract(range, starbox).result_announcement_date,'2026-11-10');
assert.equal(extract(range, starbox).result_announcement_time,'18:00');
const conflicting = starPage.replace(starPeriod,starPeriod+starPeriod.replace('21:00:59','20:00:00'));
assert.equal(extract(conflicting, starbox).application_end_at,undefined);
assert.equal(extract(starPage.replace('応募期間','購入期間'), starbox).application_start_at,undefined);
assert.equal(extract(starPage+'<label for="input-item_no-2">別商品</label>', starbox).product_name,undefined);
assert.deepEqual(extract(starPage, starbox+'&next=https://example.org'), {});
assert.deepEqual(extract('<h1>抽選ページが見つかりません</h1>', starbox), {});
const older = Array.from({length:4},(_,i)=>({url:starbox.replace('YJTlpkMz6h','abcdefghij'.slice(0,-1)+i),
  first_detected_at:'2026-11-05T03:00:00Z'}));
const starRow = {url:starbox, event_title:'仮のイベント名', external_url_unverified:true, discord_posted_at:'2026-11-06T01:00:00Z'};
const starCatalog = {items:[...older, starRow]};
const attempted = [];
assert.equal(await enrichStarbox(starCatalog, async url=>{
  attempted.push(url);
  if(url!==starbox)throw Error('temporary failure');
  return starPage;
},now),4);
assert.equal(attempted[0],starbox);
assert.equal(starRow.official_event_title,starTitle);
assert.equal(starRow.external_url_unverified,false);
assert.equal(starRow.purchase_end_date,'2026-11-15');
assert.equal(starRow.pokemon_map_type,'pack');
assert.equal(await enrichStarbox({items:[starRow,...older.slice(0,3)]},()=>assert.fail('Starbox retry policy ignored'),now),0);

const custom='https://customform.jp/form/input/258807?key=96371fe2';
assert(supportedUrl(custom));
assert(supportedUrl('https://customform.jp/form/input/258807'));
for(const url of [custom+'&next=https://example.com',custom+'#form',custom.replace('customform.jp','customform.jp.example.com'),
 custom.replace('https:','http:'),custom.replace('/input/','/result/'),custom.replace('96371fe2','bad')])
 assert(!supportedUrl(url),url);
const customTitle='11/21発売 ワンピースカード 神の支配 抽選販売 応募フォーム';
const customDescription='■抽選商品:ワンピースカード ブースターパック「神の支配」【OP-18】\n'+
 '■応募期間：11/7(土)10時00分～11/9(月)20時59分\n'+
 '■販売期間は、11/21(土)～11/22(日)の2日間です。\n'+
 '■販売期間終了後はキャンセル扱いです。\n'+
 '◆抽選は、11/16(月)12時以降に実施。\n当選メール案内期間：11/16(月)15時～';
const customData={data:{customform:[{customform_id:258807,title:customTitle,description:customDescription,
 close_time:'2026-11-09 21:00:00'}, {s:'arr'}],
 questions:[{stores:[{input_type:3,title:'抽選購入応募店舗を選択して下さい。',
 options:[['ＷＧひたちなか店','新星堂 アリオ深谷店'],{s:'arr'}]}],
 irrelevant:[{input_type:2,title:'店舗選択に同意します。',options:[['同意しました。'],{s:'arr'}]}]},
 {s:'arr'}],closed:false}};
const customPage=data=>'<main wire:snapshot="'+JSON.stringify(data).replaceAll('&','&amp;').replaceAll('"','&quot;')+
 '"><h1>'+customTitle+'</h1><div class="whitespace-pre-line">'+data.data.customform[0].description+'</div></main>';
const customFields=extract(customPage(customData),custom);
assert.equal(customFields.application_start_at,'2026-11-07T10:00:00+09:00');
assert.equal(customFields.application_end_at,'2026-11-09T20:59:00+09:00');
assert.equal(customFields.result_announcement_date,'2026-11-16');
assert.equal(customFields.result_announcement_time,'15:00');
assert.equal(customFields.purchase_start_date,'2026-11-21');
assert.equal(customFields.purchase_end_date,'2026-11-22');
assert.equal(customFields.purchase_start_time,undefined);
assert.equal(customFields.purchase_end_time,undefined);
assert.deepEqual(customFields.stores,[{name:'WonderGOOひたちなか店',prefecture:''},{name:'新星堂アリオ深谷店',prefecture:''}]);
assert.equal(customFields.review_category,'onepiece');
assert.equal(customFields.product_type,'pack');
const different=structuredClone(customData);different.data.customform[0].customform_id=258805;
assert.deepEqual(extract(customPage(different),custom),{});
const noClock=structuredClone(customData);noClock.data.customform[0].description=customDescription.replace('10時00分','');
assert.equal(extract(customPage(noClock),custom).application_start_at,undefined);
const ambiguous=structuredClone(customData);ambiguous.data.customform[0].description+='\n■応募期間：11/7(土)10時00分～11/9(月)18時00分';
assert.equal(extract(customPage(ambiguous),custom).application_end_at,undefined);
const noYear=structuredClone(customData);delete noYear.data.customform[0].close_time;
assert.equal(extract(customPage(noYear),custom).application_start_at,undefined);
assert.deepEqual(extract('<script>window.gokuProps={}</script>',custom),{});
const geo = 'https://draw.geo-online.co.jp/lottery/133/';
assert(supportedUrl(geo));
assert(supportedUrl(geo.slice(0, -1)));
for (const url of [geo + '?next=https://example.com', geo + '#results',
  geo.replace('draw.geo-online.co.jp', 'draw.geo-online.co.jp.example.org'),
  geo.replace('https:', 'http:'), geo.replace('133/', 'login/'), geo.replace('133/', '')]) {
  assert(!supportedUrl(url), url);
}
const geoProduct = 'ポケモンカードゲーム MEGA 拡張パック「見本」';
const geoPeriod = '<p>応募期間は「11/9(月) 11:00 ～ 11/12(木) 17:59」までとなります。</p>';
const geoPage = '<h1>ゲオ抽選販売専用サイト</h1><p>2026.11.06</p><h2>' + geoProduct + '</h2>' + geoPeriod +
  '<dl><dt>対象店舗</dt><dd>全国のゲオ店舗</dd><dt>当選者への連絡日</dt><dd>11月25日(水)</dd>' +
  '<dt>当選者へのお渡し期間</dt><dd>11/27(金) 開店時～11/29(日) 閉店時</dd></dl>';
const geoFields = {event_title: geoProduct, product_name: geoProduct, store_name: 'ゲオ', prefecture: '全国',
  application_start_at: '2026-11-09T11:00:00+09:00', application_end_at: '2026-11-12T17:59:00+09:00',
  result_announcement_date: '2026-11-25', purchase_start_date: '2026-11-27', purchase_end_date: '2026-11-29',
  review_category: 'pokemon', product_type: 'pack'};
assert.deepEqual(extract(geoPage, geo), geoFields);
assert.deepEqual(extract(geoPage.replace('<p>2026.11.06</p>', '').replace(geoPeriod,
  '<table><tr><th>抽選受付期間</th><td>2026年11月9日(月) 11:00～11月12日(木) 17:59</td></tr></table>'), geo), geoFields);
assert.deepEqual(extract(geoPage.replace('2026.11.06', ''), geo), {}, 'Do not infer the year from the fetch date');
assert.deepEqual(extract(geoPage.replace('応募期間', '購入期間'), geo), {}, 'Purchase dates cannot become the application period');
assert.deepEqual(extract(geoPage + geoPeriod.replace('17:59', '18:59'), geo), {}, 'Conflicting application periods must not be chosen');
assert.equal(extract(geoPage.replace('11月25日(水)', '11月25日(水)～11月26日(木) 18:00'), geo).result_announcement_date, '2026-11-26');
assert.equal(extract(geoPage.replace('11月25日(水)', '11月25日(水)～11月26日(木) 18:00'), geo).result_announcement_time, '18:00');
assert.equal(extract(geoPage.replace('全国のゲオ店舗', 'ゲオ宇都宮店'), geo).prefecture, undefined);
assert.equal(extract(geoPage.replace('全国のゲオ店舗', 'ゲオ宇都宮店'), geo).store_name, 'ゲオ宇都宮店');
assert.equal(extract(geoPage.replace('11:00', ''), geo).application_start_at, undefined);
assert.deepEqual(extract('<title>Access Denied</title><h1>Access Denied</h1>', geo), {});
assert.deepEqual(extract(geoPage, geo + '?redirect=https://example.com'), {});

const geoRow = {url: geo, external_url_unverified: true};
assert.equal(await enrichGeo({items: [geoRow]}, async () => geoPage, now), 1);
assert.equal(geoRow.official_event_title, geoProduct);
assert.equal(geoRow.external_url_unverified, false);
assert.equal(geoRow.pokemon_map_type, 'pack');
assert.equal(geoRow.geo_verified_at, now.toISOString());
const deniedGeo = {url: geo, external_url_unverified: true, event_title: '既存データ'};
const anotherGeo = {url: geo.replace('133', '132'), external_url_unverified: true};
const deniedCatalog = {items: [deniedGeo, anotherGeo]};
assert.equal(await enrichGeo(deniedCatalog, async () => {
  throw Object.assign(new Error('Forbidden'), {status: 403});
}, now), 1);
assert.equal(deniedGeo.event_title, '既存データ');
assert.equal(deniedGeo.external_url_unverified, true);
assert.equal(deniedGeo.geo_last_error, 'source_access_denied');
assert.equal(anotherGeo.geo_checked_at, undefined, 'Stop further GEO requests after access denial');
assert.equal(await enrichGeo(deniedCatalog, () => assert.fail('GEO cooldown ignored'), now), 0);
const rakuten = 'https://books.rakuten.co.jp/rb/18595282';
for (const url of [rakuten, rakuten + '/', rakuten + '/?bkts=1']) {
  assert(supportedUrl(url));
  const request = lotteryPageRequest(url);
  assert.equal(request.url.href, rakuten + '/?bkts=1');
  assert.equal(request.headers['Accept-Language'], 'ja');
}
for (const url of [rakuten + '?next=https://example.com', rakuten + '#lottery',
  rakuten.replace('books.rakuten.co.jp', 'books.rakuten.co.jp.example.org'),
  rakuten.replace('/rb/', '/event/'), rakuten.replace('https:', 'http:')]) {
  assert(!supportedUrl(url), url);
}
const rakutenTitle = 'ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION';
const rakutenSchedule = '<h5 class="lotteryItem__title">■抽選販売スケジュール</h5>' +
  '<p><b>抽選受付期間：2026/11/13(金) 10:00 〜 2026/11/18(水) 23:59<br>' +
  '当選者販売期間：2026/11/29(日) 10:00 〜 2026/12/03(木) 23:59<br></b></p>' +
  '<ul><li>※当落の結果は、販売開始日までにメールでご連絡します。</li></ul>';
const rakutenPage = '<h1 class="header-nav__logo"><img alt="楽天ブックス"></h1>' +
  '<h1 itemprop="name">' + rakutenTitle + '<br/><a class="authorLink">玩具</a></h1>' +
  '<p>販売期間：2026/09/16 10:00～2026/09/30 23:59</p>' +
  '<h2>商品説明</h2><div class="lotteryItem">' + rakutenSchedule +
  '<h5>■抽選対象商品</h5><p>同じページに掲載された別商品の名称</p></div>';
const rakutenFields = {
  event_title: rakutenTitle, product_name: rakutenTitle, store_name: '楽天ブックス', prefecture: '全国',
  application_start_at: '2026-11-13T10:00:00+09:00', application_end_at: '2026-11-18T23:59:00+09:00',
  purchase_start_date: '2026-11-29', purchase_start_time: '10:00',
  purchase_end_date: '2026-12-03', purchase_end_time: '23:59',
  review_category: 'pokemon', product_type: 'pack'
};
assert.deepEqual(extract(rakutenPage, rakuten + '/?bkts=1'), rakutenFields);
assert.deepEqual(extract(rakutenPage.replace(rakutenSchedule, ''), rakuten), {},
  'A normal sales window is not a lottery');
assert.deepEqual(extract(rakutenPage.replace('11/18(水)', '11/99(水)'), rakuten), {});
assert.deepEqual(extract(rakutenPage.replace('11/13(金) 10:00', '11/13(金)'), rakuten), {});
assert.deepEqual(extract(rakutenPage + rakutenSchedule.replace('11/18(水) 23:59', '11/19(木) 20:00'), rakuten), {},
  'Conflicting lottery schedules must be left unconfirmed');
const exactResult = rakutenPage.replace('</b></p>', '抽選結果発表期間：2026/11/27～2026/11/28 18:00</b></p>');
assert.equal(extract(exactResult, rakuten).result_announcement_date, '2026-11-28');
assert.equal(extract(exactResult, rakuten).result_announcement_time, '18:00');
assert.equal(extract(exactResult.replace('2026/11/27～2026/11/28 18:00', '2026/11/29まで'), rakuten)
  .result_announcement_date, undefined);

const rakutenNow = new Date('2026-11-12T05:00:00Z');
const rakutenRow = {url: rakuten, external_url_unverified: true, discord_posted_at: '2026-11-12T03:45:00Z'};
const staleRakuten = rakutenPage.replaceAll('2026/11/', '2026/10/');
assert.equal(await enrichRakutenBooks({items: [rakutenRow]}, async () => staleRakuten, rakutenNow), 1);
assert.equal(rakutenRow.external_url_unverified, true, 'An earlier lottery on the same product URL is stale');
const rakutenRetry = new Date(rakutenNow.getTime() + 60 * 60 * 1000);
assert.equal(await enrichRakutenBooks({items: [rakutenRow]}, async () => rakutenPage, rakutenRetry), 1);
assert.equal(rakutenRow.external_url_unverified, false);
assert.equal(rakutenRow.official_event_title, rakutenTitle);
assert.equal(rakutenRow.purchase_end_time, '23:59');
assert.equal(rakutenRow.pokemon_map_type, 'pack');
assert.equal(await enrichRakutenBooks({items: [rakutenRow]}, () => assert.fail('Verified Rakuten page was refetched'), rakutenRetry), 0);
console.log('Individual lottery extraction checks passed, including Rakuten Books');
