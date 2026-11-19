import assert from 'node:assert/strict';
import {supportedUrl, extract} from '../supabase/functions/lottery-individual-fetch/extract.mjs';
import {CENTER_DIRECTORY, pokemonCenterDirectory, centerNewsLinks, pokemonCenterNoticeUrl} from '../supabase/functions/lottery-individual-fetch/pokemon-center.mjs';
import {fetchStoreNotice} from '../supabase/functions/lottery-individual-fetch/store-notices.mjs';
import {collectStoreNotices} from './store_notice_lottery_enrich.mjs';

const profile = CENTER_DIRECTORY + 'shop/pokemoncenter-megatokyo/';
const path = new URL(profile).pathname;
const store = 'ポケモンセンターメガトウキョー';
const title = '11月27日（金）発売のポケモンカードゲーム関連商品の販売方法について';
const url = profile + 'news/202611/000709.html';
const line = 'https://miniapp.line.me/2010303568-gOTl69zY/events/a95bccc9-4a6a-474e-a461-25ffefba2efb';
const now = new Date('2026-11-19T05:30:00Z');
const identity = url => '<meta property="og:url" content="' + url + '">';
const notice = '<p>ポケモンカードゲーム関連商品の事前抽選を実施いたします。</p>' +
  '<p>＜対象商品＞<br>・ポケモンカードゲーム MEGA 拡張パック「ハドウシーカー」（お一人様20パックまで）</p>' +
  '<p>＜販売期間＞<br>11月27日（金）～11月28日（土）<br>11時00分～19時00分の間で30分単位でのご案内<br>当選された「呼出時間枠」内でのみご購入いただけます。</p>' +
  '<p>■受付期間<br>11月19日（木）14時00分～11月23日（月・祝）23時59分</p>' +
  '<p>■結果発表<br>11月25日（水）12時以降、順次LINEで発表</p>' +
  '<p>■'+store+' 申込ページ<br><a href="'+line+'">LINEで申し込む</a></p>';
const article = (source=url,body=notice) => identity(source) +
  '<nav>ポケモンセンターシブヤ ■受付期間 12月1日～12月9日</nav><main><div class="c-store-header">' +
  '<div class="c-store-header__title"><p>'+store+'</p></div><a href="'+path+'">店舗トップ</a></div>'+
  '<div class="l-container"><h1 class="c-heading opt-level1">'+title+'</h1><time datetime="2026-11-19"></time>'+
  '<div class="l-entry">'+body+'</div></div></main>';
const directoryCard = (href,name,address) => '<li><a href="'+href+'"><div class="c-store-list__info">'+
  '<p class="c-store-list__title">'+name+'</p><span>'+address+'</span></div></a></li>';
const directory = identity(CENTER_DIRECTORY) + '<ul class="c-store-list">' +
  directoryCard(path, store, '東京都豊島区東池袋3-1-2<br>サンシャインシティ 専門店街アルパ 2F')+
  directoryCard('/ja/shop/pokemoncenter-taipei/', 'ポケモンセンタータイペイ','台北市')+'</ul>';
const card = (href,date,subject) => '<li><a href="'+href+'"><p class="c-news-list__title">'+subject+'</p>'+
  '<time datetime="'+date+'"></time></a></li>';
const list = identity(profile+'news/')+'<ul class="c-news-list">'+
  card(new URL(url).pathname, '2026-11-19',title)+card(path+'news/202510/000500.html','2025-10-21',title)+
  card('/ja/shop/pokemoncenter-shibuya/news/202611/000724.html','2026-11-19',title)+
  card(path+'news/202611/000710.html','2026-11-19','営業時間変更のお知らせ')+'</ul>';
const pages = new Map([[CENTER_DIRECTORY,directory],[url,article()],[profile+'news/',list]]);
const calls=[];
const load = async input => { calls.push(input);assert(pages.has(input),input);return pages.get(input); };

assert(supportedUrl(url));
assert.equal(pokemonCenterNoticeUrl(url+'?utm_source=share').href,url);
for(const bad of [url+'?next=other',url+'#form',url.replace('https://','http://'),url.replace('/ja/','/en/'),
  url.replace('.co.jp','.co.jp.other.test'),url.replace('202611','202613'),profile,profile+'news/',line])
  assert.equal(supportedUrl(bad),false,bad);
assert.deepEqual([...pokemonCenterDirectory(directory).keys()],[profile]);
assert.deepEqual(centerNewsLinks(list,profile,now),[url]);
const expected = {
  event_title:title, store_name:store, stores:[{name:store,prefecture:'東京都'}], prefecture:'東京都',
  product_name:'ポケモンカードゲーム MEGA 拡張パック「ハドウシーカー」', product_type:'pack', review_category:'pokemon',
  application_start_at:'2026-11-19T14:00:00+09:00', application_end_at:'2026-11-23T23:59:00+09:00',
  application_url:line, result_announcement_date:'2026-11-25', store_notice_result_note:'12:00以降順次',
  purchase_start_date:'2026-11-27',purchase_end_date:'2026-11-28',store_notice_purchase_note:'11:00～19:00の間で30分単位、当選した時間枠のみ'
};
assert.deepEqual(await fetchStoreNotice(url,load),expected);
const run = markup => extract(markup,url);
assert.equal(run(article().replace('■受付期間<br>','■受付期間').replace('■結果発表<br>','■結果発表')).application_end_at,expected.application_end_at);
const inline = run(article().replace('（土）<br>11時','（土）11時'));
assert.equal(inline.purchase_end_time,undefined);
assert.equal(inline.store_notice_purchase_note,expected.store_notice_purchase_note);
assert.deepEqual(run(article().replace('（月・祝）','（日・祝）')),{});
assert.equal(run(article().replace('12時以降、順次LINE','12時30分にLINE')).result_announcement_time,'12:30');
const regional = run(article(url,notice.replace('■受付期間','■受け付け期間')
  .replace(' 申込ページ','申し込みページ').replace('お一人様','お1人様')));
assert.equal(regional.application_url,line);assert.equal(regional.product_name,expected.product_name);
const daySlots = run(article(url,notice.replace('11月27日（金）～11月28日（土）<br>11時00分～19時00分の間で30分単位',
  '11月27日（金）<br>11時～19時の間で30分単位<br>11月28日（土）<br>13時～19時の間で30分単位')));
assert.equal(daySlots.purchase_end_date,'2026-11-28');
assert.match(daySlots.store_notice_purchase_note,/11\/27 11:00.*11\/28 13:00/);
for (const body of [notice.replace('■受付期間','■資格期間'),notice.replace('■'+store+' 申込ページ','■ポケモンセンターシブヤ 申込ページ'),
  '通常販売のご案内<br>'+title,notice+'<p>今回の抽選は中止いたします。</p>']) assert.deepEqual(run(article(url,body)),{});
assert.deepEqual(run(article(url.replace('000709','000799'))),{});
assert.equal(run(article().replace('href="'+line+'"','href="https://example.com/"')).application_url,undefined);
assert.equal(run(article().replace('<a href="'+line+'">LINEで申し込む</a>',line)).application_url,undefined);
const offlineRegion=await fetchStoreNotice(url,async u=>u===url?article():directory.replaceAll(store,'別の店舗'));
assert.equal(offlineRegion.store_name,store);assert.equal(offlineRegion.prefecture,undefined);

const discovered={items:[]};
calls.length=0;
assert.deepEqual(await collectStoreNotices(discovered,load,now),{checked:1,updated:1,scanned:1,added:1});
assert.equal(calls.filter(url=>url===CENTER_DIRECTORY).length,1);
assert.equal(discovered.items[0].discord_posted_at,undefined);
assert.equal(discovered.items[0].external_url_unverified,false);
assert.equal(discovered.items[0].google_forms_verified_at,undefined);
assert.equal(discovered.items[0].application_url,line);
assert.deepEqual(await collectStoreNotices(discovered,()=>assert.fail('too early'),now),{checked:0,updated:0,scanned:0,added:0});
for(const row of [{url:url+'?utm_source=discord'},{url,manual_card_hidden:true}]) {
  const catalog={items:[row]};await collectStoreNotices(catalog,load,now);assert.equal(catalog.items.length,1);
  assert.equal(!!catalog.items[0].store_notice_verified_at,!row.manual_card_hidden);
}
const nonLottery={items:[]};
await collectStoreNotices(nonLottery,async u=>u===url?article(url,'通常販売のお知らせ'):load(u),now);
assert.deepEqual(nonLottery.items,[]);
const old={items:[]};
await collectStoreNotices(old,async u=>u===url?article(url,notice.replace('11月23日（月・祝）23時59分','11月19日（木）14時01分')):load(u),now);
assert.deepEqual(old.items,[]);
const updated={items:[{...discovered.items[0],store_notice_checked_at:'2026-11-18T00:00:00Z'}]};
await collectStoreNotices(updated,async u=>u===url?article(url,notice.replace('12時以降、順次','13時に').replace('href="'+line+'"','href="https://example.com/"')):load(u),now);
assert.equal(updated.items[0].result_announcement_time,'13:00');
assert.equal(updated.items[0].application_url,undefined);assert.equal(updated.items[0].store_notice_result_note,undefined);
console.log('Pokémon Center source identity, store directory, LINE links, slot schedules and discovery passed.');
