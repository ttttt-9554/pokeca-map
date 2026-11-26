import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {onlineShopUrl,onlineShopFields,collectedOnlineShop,DMM_HOST,BANDAI_HOST,HOBBY_SEARCH_HOST,ONLINE_SHOP_PARSER_VERSION} from '../supabase/functions/lottery-individual-fetch/online-shop-lottery.mjs';
import {supportedUrl,extract,lotteryPageRequest} from '../supabase/functions/lottery-individual-fetch/extract.mjs';
import {enrichDmm,shopCandidates,applyShopPage,fetchDmm} from './online_shop_lottery_enrich.mjs';

const dmm='https://www.dmm.com/mono/hobby/-/detail/=/cid=c260802009_lo2608_3/';
const dmm2=dmm.replace('c260802009','c260404065');
const bandai='https://p-bandai.jp/item/item-1000261368/';
const affiliate='https://al.dmm.com/?lurl='+encodeURIComponent(dmm)+'&af_id=LoveryLono-001&ch=toolbar_sp&ch_id=link';
const tracked=dmm+'?utm_medium=dmm_affiliate&utm_source=LoveryLono-001&utm_term=dmm.com&utm_campaign=affiliate_toolbar_sp&utm_content=link';
// Minimal public product headings and lottery panels from the supplied pages.
const dmmTitle='【BOX販売】ONE PIECEカードゲーム ブースタパック 蒼海の七傑【OP-14】';
const dmmPanel='<dl class="box-chuseninfo"><dt class="ttl-chuseninfo">抽選申し込み期間</dt>'+
  '<dd class="txt-chuseninfo"><p>2026年11月17日(火)15:00〜2026年11月24日(火)15:00</p></dd>'+
  '<dt>当選発表</dt><dd><p>2026年11月26日(木)から4日以内に当選者にのみメールにて順次ご連絡いたします。</p></dd></dl>';
const dmmPage='<meta property="og:url" content="'+dmm+'"><h1 id="title" class="item fn">'+dmmTitle+'</h1>'+dmmPanel;
const bandaiTitle='【抽選販売】ONE PIECEカードゲーム ブースターパック 世界最強の戦士【OP-17】【4次:2026年12月発送分】';
const bandaiPanel='<dl class="pb24-item-main__lotterycart--data"><dt>受付期間</dt>'+
  '<dd>2026年11月16日（月）12時～2026年11月22日（日）23時</dd><dt>当選発表</dt><dd>2026年11月下旬</dd></dl>';
const bandaiPage='<link rel="canonical" href="'+bandai+'"><h1 id="box" class="pb24-item-main__title">'+bandaiTitle+'</h1>'+bandaiPanel+
  '<table><tr><th>発送日</th><td>2026年12月発送予定</td></tr></table>';
const dmmFields=onlineShopFields(dmmPage,dmm),bandaiFields=onlineShopFields(bandaiPage,bandai);
assert.equal(dmmFields.store_name,'DMM通販');assert.equal(bandaiFields.store_name,'プレミアムバンダイ');
assert.equal(dmmFields.event_title,dmmTitle);assert.equal(bandaiFields.event_title,bandaiTitle);
assert.equal(dmmFields.application_start_at,'2026-11-17T15:00:00+09:00');
assert.equal(dmmFields.application_end_at,'2026-11-24T15:00:00+09:00');
assert.equal(bandaiFields.application_start_at,'2026-11-16T12:00:00+09:00');
assert.equal(bandaiFields.application_end_at,'2026-11-22T23:00:00+09:00');
for(const fields of [dmmFields,bandaiFields]){
  assert.equal(fields.prefecture,'全国');assert.equal(fields.review_category,'onepiece');assert.equal(fields.product_type,'pack');
  for(const key of ['result_announcement_date','result_announcement_time','purchase_start_date','purchase_end_date'])assert.equal(fields[key],undefined);
}
for(const url of [dmm,tracked,affiliate,bandai]){
  assert(supportedUrl(url));assert.equal(lotteryPageRequest(url).url.href,url===bandai?bandai:dmm);
}
assert.deepEqual(extract(dmmPage,affiliate),dmmFields);assert.deepEqual(extract(dmmPage,tracked),dmmFields);
const second=dmmPage.replaceAll(dmm,dmm2).replace(dmmTitle,'【BOX販売】ONE PIECEカードゲーム ブースターパック 受け継がれる意志【OP-13】');
assert(onlineShopFields(second,dmm2).event_title.includes('受け継がれる意志'));
for(const url of [dmm+'?next=https://example.com',dmm+'#form',dmm.replace('https:','http:'),
  dmm.replace('www.dmm.com','www.dmm.com.evil.test'),dmm.replace('www.dmm.com','user@www.dmm.com'),
  dmm.replace('/hobby/','/dvd/'),dmm.replace('www.dmm.com','www.dmm.com:444'),
  'https://al.dmm.com/?lurl='+encodeURIComponent('https://example.com/'),affiliate+'&lurl='+encodeURIComponent(dmm2),
  'https://al.dmm.com/?lurl='+encodeURIComponent(bandai),bandai+'?redirect=1',bandai.replace('/item/','/cart_add/')]){
  assert.equal(onlineShopUrl(url),null,url);assert.equal(supportedUrl(url),false,url);
}
for(const [page,url] of [[dmmPage,dmm2],[second,dmm],[bandaiPage,bandai.replace('1368','1369')],
  [dmmPage.replace(dmmPanel,''),dmm],[bandaiPage.replace(bandaiPanel,''),bandai],
  [dmmPage.replace('抽選申し込み期間','発売期間'),dmm],[bandaiPage.replace('受付期間','発送期間'),bandai],
  [dmmPage.replace('11月24日','11月31日'),dmm],[dmmPage.replace('15:00','25:00'),dmm],
  [dmmPage.replace('11月24日','11月14日'),dmm],[dmmPage.replace('15:00',''),dmm],
  [dmmPage+dmmPanel.replace('11月24日','11月25日'),dmm]])assert.deepEqual(onlineShopFields(page,url),{});
assert.deepEqual(onlineShopFields(dmmPage+'<h2>関連商品</h2><p>応募期間2026年12月1日10:00～2026年12月2日23:00</p>',dmm),dmmFields);
const translated=bandaiPage.replace('受付期間','<!--wovn-src:受付期間-->Application period')
  .replace('2026年11月16日（月）12時～2026年11月22日（日）23時','<!--wovn-src:2026年11月16日（月）12時～2026年11月22日（日）23時-->November 16 to November 22');
assert.deepEqual(onlineShopFields(translated,bandai),bandaiFields);
const dated=bandaiPage.replace('2026年11月下旬','2026年11月25日～2026年11月27日18時');
assert.equal(onlineShopFields(dated,bandai).result_announcement_date,'2026-11-27');
assert.equal(onlineShopFields(dated,bandai).result_announcement_time,'18:00');
const now=new Date('2026-11-18T11:00:00Z');
const row=url=>({url,event_title:'',external_url_unverified:true,discord_posted_at:'2026-11-18T10:30:00Z'});
const catalog={items:[row(affiliate),row(tracked),row(bandai)]};let reads=0;
assert.deepEqual(await enrichDmm(catalog,async()=>{reads++;return dmmPage;},now),{checked:2,updated:2});assert.equal(reads,1);
assert.equal(catalog.items[0].url,affiliate);assert.equal(catalog.items[0].external_url_unverified,false);
assert.equal(catalog.items[0].pokemon_map_type,'pack');
assert.equal(shopCandidates(catalog,DMM_HOST,now).length,0);assert.equal(shopCandidates(catalog,BANDAI_HOST,now).length,1);
assert(applyShopPage(catalog.items[2],bandaiPage,now));
assert.equal(collectedOnlineShop(catalog,bandai).store_name,'プレミアムバンダイ');
assert.equal(collectedOnlineShop(catalog,dmm).url,affiliate);
assert.equal(collectedOnlineShop(catalog,bandai.replace('1368','1369')),null);
assert.equal(collectedOnlineShop({items:[{...catalog.items[2],online_shop_parser_version:0}]},bandai),null);
const failed={items:[row(dmm)]};
await enrichDmm(failed,async()=>'<title>ログイン</title>',now);
assert.equal(failed.items[0].external_url_unverified,true);assert.equal(failed.items[0].online_shop_verified_at,undefined);
assert.equal(shopCandidates(failed,DMM_HOST,now).length,0);
const blocked={items:[row(dmm),row(dmm2)]};reads=0;
await enrichDmm(blocked,async()=>{reads++;throw Object.assign(Error(),{status:403});},now);
assert.equal(reads,1);assert.equal(shopCandidates(blocked,DMM_HOST,new Date(+now+7*3600000)).length,0);
assert.equal(shopCandidates({items:[{...row(dmm),application_end_at:'2026-11-10T15:00:00+09:00',discord_posted_at:'2026-11-01T00:00:00Z'}]},DMM_HOST,now).length,0);
assert.equal(shopCandidates({items:[{...row(dmm),manual_card_hidden:true}]},DMM_HOST,now).length,0);
let requested;
await fetchDmm(affiliate,async(url,opts)=>{requested=url;assert.equal(opts.redirect,'manual');return new Response(dmmPage,{headers:{'content-type':'text/html'}});});
assert.equal(requested,dmm);
await assert.rejects(fetchDmm(affiliate,async()=>new Response('',{status:302,headers:{location:'https://example.com/'}})));
await assert.rejects(fetchDmm(affiliate,async()=>new Response('',{status:302,headers:{location:'https://www.dmm.com/mono/-/order/'}})),error=>error.code==='source_login_required');
await assert.rejects(fetchDmm(affiliate,async()=>new Response('',{headers:{'content-type':'application/json'}})));
await assert.rejects(fetchDmm(affiliate,async()=>new Response('a'.repeat(2000001),{headers:{'content-type':'text/html'}})));
assert.equal(ONLINE_SHOP_PARSER_VERSION,catalog.items[0].online_shop_parser_version);
const edge=readFileSync(new URL('../supabase/functions/lottery-individual-fetch/index.ts',import.meta.url),'utf8');
assert(edge.includes('collectedBrowserPage(input.url,host===BANDAI_HOST)'));
assert(edge.includes('if(host===DMM_HOST)return await collectedBrowserPage(input.url,true)'));
console.log('DMM and Premium Bandai lottery parsing, URL safety, collection and cached retrieval passed.');


const hobby='https://www.1999.co.jp/11183978';
const hobbyTitle='〖抽選販売〗 ポケモンカードゲーム MEGA 拡張パック メガブレイブ (トレーディングカード)';
const hobbyPage='<link rel="canonical" href="'+hobby+'"><h1>'+hobbyTitle+'</h1>'+
 '<p>抽選申し込みは下記日時に開始します。</p><p>2026/11/27 17:00</p><p>こちらの抽選には参加条件がございます。</p>'+
 '<p>発売日：2025年8月上旬</p><h2>商品説明</h2><h2>関連商品</h2><p>抽選受付終了日時：2026/12/31 20:00</p>';
assert(supportedUrl(hobby));assert.equal(lotteryPageRequest(hobby+'?utm_source=discord').url.href,hobby);
const hf=extract(hobbyPage,hobby);
assert.equal(hf.store_name,'ホビーサーチ');assert.equal(hf.prefecture,'全国');
assert.equal(hf.product_name,'ポケモンカードゲーム MEGA 拡張パック メガブレイブ');
assert.equal(hf.review_category,'pokemon');assert.equal(hf.product_type,'pack');
assert.equal(hf.application_start_at,'2026-11-27T17:00:00+09:00');
assert.equal(hf.application_end_at,undefined);
const active=hobbyPage.replace('抽選申し込みは下記日時に開始します。','抽選受付期間：').replace('2026/11/27 17:00','2026/11/27 17:00 ～ 2026/11/29 23:59');
assert.equal(extract(active,hobby).application_end_at,'2026-11-29T23:59:00+09:00');
const deadline=hobbyPage.replace('抽選申し込みは下記日時に開始します。','抽選受付終了日時：').replace('2026/11/27 17:00','2026/11/29 23:59');
assert.equal(extract(deadline,hobby).application_end_at,'2026-11-29T23:59:00+09:00');
for(const url of [hobby+'?next=https://example.com',hobby+'#form',hobby.replace('https:','http:'),hobby.replace('www.1999.co.jp','www.1999.co.jp.evil.test'),'https://www.1999.co.jp/list/3352/7/1'])assert(!supportedUrl(url));
assert.deepEqual(extract(hobbyPage.replace(hobbyTitle,'ポケモンカードゲーム メガブレイブ'),hobby),{});
assert.deepEqual(extract(hobbyPage.replace('2026/11/27','2026/11/31'),hobby),{});
assert.deepEqual(extract(hobbyPage,hobby.replace('11183978','11183988')),{});
const hc={items:[{...row(hobby),discord_posted_at:'2026-11-26T12:46:00Z'}]};
const hn=new Date('2026-11-26T13:00:00Z');
assert.deepEqual(await enrichDmm(hc,async()=>hobbyPage,hn,HOBBY_SEARCH_HOST),{checked:1,updated:1});
assert.equal(hc.items[0].external_url_unverified,false);
assert.equal(shopCandidates(hc,HOBBY_SEARCH_HOST,new Date(+hn+29*60000)).length,0);
assert.equal(shopCandidates(hc,HOBBY_SEARCH_HOST,new Date(+hn+31*60000)).length,1);
assert(applyShopPage(hc.items[0],deadline,new Date('2026-11-27T08:05:00Z')));
assert.equal(hc.items[0].application_start_at,'2026-11-27T17:00:00+09:00');
assert.equal(hc.items[0].application_end_at,'2026-11-29T23:59:00+09:00');
console.log('Hobby Search scheduled/partial lotteries and refresh regressions passed');
