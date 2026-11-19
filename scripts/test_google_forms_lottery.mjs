import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {googleFormUrl,googleFormFields,fetchGoogleForm,GOOGLE_FORMS_PARSER_VERSION} from '../supabase/functions/lottery-individual-fetch/google-forms.mjs';
import {supportedUrl,extract} from '../supabase/functions/lottery-individual-fetch/extract.mjs';
import {enrichGoogleForms} from './google_forms_lottery_enrich.mjs';

const id='1FAIpQLSe-b5abHHuW9LMPzAwPsDDV-FaemaUx6KcMiB1dcqT_ntgMCA';
const url=`https://docs.google.com/forms/d/e/${id}/viewform`;
const now=new Date('2026-11-18T10:00:00Z');
const title='【バトロコ 川崎駅前店】11/21（土）発売 ワンピースカードゲーム「ブースターパック神の支配【OP-18】」 抽選販売応募フォーム';
// Only public headings and relevant description excerpts, no applicant data.
const description=`■抽選対象商品
ワンピースカードゲーム「 ブースターパック神の支配【OP-18】 」1BOX
■応募受付期間
11月18日（水）～11月19日（木）23:59まで
■当選発表
11月20日（金）に公式Xで発表
■商品購入期間
11月21日（土）～11月23日（月）閉店時間前まで（営業時間内）`;
function page(text=description,heading=title,questions=[],formId='e/'+id){
  const data=[];data[1]=[];data[1][0]=text;data[1][1]=questions;
  data[1][8]=heading;data[3]=heading;data[14]=formId;
  return '<title>抽選販売応募フォーム</title><body>公開案内</body><script>var FB_PUBLIC_LOAD_DATA_ = '+JSON.stringify(data)+';</script>';
}
const parse=(text,heading=title,options={})=>googleFormFields(page(text,heading),url,{referenceDate:now.toISOString(),...options});
const fields=parse(description);
assert.equal(fields.store_name,'バトロコ川崎駅前店');
assert.equal(fields.prefecture,'神奈川県');
assert.equal(fields.application_start_at,'2026-11-18');
assert.equal(fields.application_end_at,'2026-11-19T23:59:00+09:00');
assert.equal(fields.result_announcement_date,'2026-11-20');
assert.equal(fields.purchase_start_date,'2026-11-21');
assert.equal(fields.purchase_end_date,'2026-11-23');
assert.equal(fields.result_announcement_time,undefined);
assert.equal(fields.purchase_start_time,undefined);
assert.equal(fields.purchase_end_time,undefined);
assert.equal(fields.review_category,'onepiece');
assert.equal(fields.product_type,'pack');
assert(!fields.product_name.endsWith('1BOX'));
assert.deepEqual(extract(page(),url,{referenceDate:now.toISOString()}),fields);

const tachikawa=parse(`■応募受付期間
11月19日(木)23:59まで
■当選発表
11月20日(金)18:00頃
■商品購入期間
11月21日(土)閉店時間前まで（営業時間内）`,
  '【バトロコ立川駅前】ワンピースカードゲーム ブースターパック「神の支配」抽選販売応募フォーム');
assert.equal(tachikawa.store_name,'バトロコ立川駅前');
assert.equal(tachikawa.prefecture,'東京都');
assert.equal(tachikawa.application_start_at,undefined);
assert.equal(tachikawa.application_end_at,'2026-11-19T23:59:00+09:00');
assert.equal(tachikawa.result_announcement_date,'2026-11-20');
assert.equal(tachikawa.result_announcement_time,undefined);
assert.equal(tachikawa.purchase_start_date,undefined);
assert.equal(tachikawa.purchase_end_date,'2026-11-21');
assert.equal(tachikawa.google_forms_start_not_stated,true);
assert.equal(fields.google_forms_start_not_stated,false);

// Yokohama uses prose rather than the other branches' period headings.
const yokohamaText=`■受付〆切 : 11/19(木)23時59分まで
■当選者の発表は11/20(金) に公式Xにて発表致します。
■11/21(土)OPEN時より販売対応致します。
■11/22(日)閉店時までに店頭にて購入できる方のみのご応募に限らせていただきます。`;
const yokohamaTitle='【バトロコ横浜伊勢佐木町】ワンピースカード「神の支配」抽選販売応募フォーム';
const yokohama=parse(yokohamaText,yokohamaTitle);
assert.equal(yokohama.prefecture,'神奈川県');
assert.equal(yokohama.application_start_at,undefined);
assert.equal(yokohama.google_forms_start_not_stated,true);
assert.equal(yokohama.application_end_at,'2026-11-19T23:59:00+09:00');
assert.equal(yokohama.result_announcement_date,'2026-11-20');
assert.equal(yokohama.purchase_start_date,'2026-11-21');
assert.equal(yokohama.purchase_end_date,'2026-11-22');
for(const name of ['result_announcement_time','purchase_start_time','purchase_end_time'])
  assert.equal(yokohama[name],undefined,'Opening/closing words are not exact times');
assert.equal(parse('受付締め切り：11/19 23:59').application_end_at,'2026-11-19T23:59:00+09:00');
assert.equal(parse(yokohamaText+'\n応募開始：確認中').google_forms_start_not_stated,false);
assert.equal(parse(yokohamaText+'\n応募受付期間：11月18日以降').google_forms_start_not_stated,false);
assert.equal(parse('応募受付期間：11/18～11/19 25:00').google_forms_start_not_stated,false);
const conflict=parse(yokohamaText+'\n■受付〆切 : 11/20 23:59まで');
assert.equal(conflict.application_end_at,undefined);
assert.equal(conflict.google_forms_start_not_stated,false);
assert.equal(parse(yokohamaText+'\n■11/23(月)閉店時までに購入できる方のみ').purchase_end_date,undefined);
assert.equal(parse('■11/21(土)から購入できません。').purchase_start_date,undefined);
assert.equal(parse('■11/21(土)まで購入できません。').purchase_end_date,undefined);
const reversed=parse('■11/23(月)より販売します。\n■11/21(土)までに購入できる方のみ');
assert.equal(reversed.purchase_start_date,undefined);assert.equal(reversed.purchase_end_date,undefined);
const sectionForm=googleFormFields(page('',yokohamaTitle,[[1,'抽選の案内',yokohamaText,8]]),url,{referenceDate:now.toISOString()});
assert.equal(sectionForm.application_end_at,yokohama.application_end_at);
for(const name of ['バトロコ小田原駅前','バトロコ小田原駅前店','バトロコ横浜伊勢佐木町'])
  assert.equal(parse(description,'【'+name+'】ポケモンカード抽選応募').prefecture,'神奈川県');
assert.equal(parse(description,'【バトロコ高田馬場】ポケモンカード抽選応募').prefecture,'東京都');
assert.equal(parse(description,'【バトロコ小田原駅前別会場】ポケモンカード抽選応募').prefecture,undefined);

assert.equal(parse('応募期間：2026/11/18 10:30～2026/11/19 23:59').application_start_at,'2026-11-18T10:30:00+09:00');
assert.equal(parse('応募締切：１１月１９日 ２３：５９').application_end_at,'2026-11-19T23:59:00+09:00');
assert.equal(parse('当選発表：11月20日～22日 18時半').result_announcement_time,'18:30');
assert.equal(parse('当選発表：11月20日～22日 18時半').result_announcement_date,'2026-11-22');
assert.equal(parse('■当選発表\n11月20日(金)\n当選発表はX上で行います。').result_announcement_date,'2026-11-20');
assert.equal(parse('■当選発表\n11月20日(金)\n当選発表は11月21日(土)').result_announcement_date,undefined);
assert.equal(parse('購入期間：11月21日10時～23日20時30分').purchase_end_time,'20:30');
assert.equal(parse('応募期間：12/31～1/2 23:59',title,{referenceDate:'2026-12-30T01:00:00Z'}).application_end_at,'2027-01-02T23:59:00+09:00');
for(const text of ['応募期間：11/18～11/31 23:59','応募期間：11/18～11/19 25:00',
  '応募期間：11/19～11/18','応募期間：11/18(水)～11/19(月)23:59',
  '応募期間：11/18～11/19\n応募期間：11/18～11/20',
  '応募期間：5/18～5/19']){
  assert.equal(parse(text).application_end_at,undefined,text);
}
assert.deepEqual(googleFormFields(page(description,title,[],'e/not-the-requested-form'),url),{});
assert.deepEqual(googleFormFields(page()+page(),url),{});
assert.deepEqual(googleFormFields('<title>受付終了</title>',url),{});
assert.deepEqual(googleFormFields(page(description,'お問い合わせフォーム'),url),{});
assert.deepEqual(googleFormFields(page().replace('var FB_PUBLIC_LOAD_DATA_ = [','var FB_PUBLIC_LOAD_DATA_ = [(() => { throw Error(); })(),'),url),{});
const questions=[[1,'受取店舗を選択してください',null,3,[[2,[['バトロコ川崎駅前店'],['バトロコ立川駅前']]]]],
  [3,'氏名を入力してください',null,0,[[4]]]];
const multiple=googleFormFields(page(description,title,questions),url,{referenceDate:now.toISOString()});
assert.deepEqual(multiple.stores,[{name:'バトロコ川崎駅前店',prefecture:'神奈川県'},{name:'バトロコ立川駅前',prefecture:'東京都'}]);
assert.equal(multiple.prefecture,undefined);
assert.equal(parse(description,'【未登録の新店舗】ポケモンカード抽選応募').prefecture,undefined);

const short='https://forms.gle/Abcde12345xyz';
assert(supportedUrl(short));
assert.equal(googleFormUrl(url+'?usp=sf_link'),url);
for(const bad of [url+'?entry.123=private',url+'?next=https://example.com',url+'#response',
  url.replace('docs.google.com','docs.google.com.evil.test'),url.replace('https:','http:'),
  url.replace('/viewform','/formResponse'),url.replace('/viewform','/edit'),
  url.replace('docs.google.com','user@docs.google.com')])assert(!supportedUrl(bad),bad);
const requests=[];
const loaded=await fetchGoogleForm(short,async(input,options)=>{
  requests.push(input);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
  assert.equal(options.body,undefined);
  return input===short?new Response(null,{status:302,headers:{location:url+'?usp=sf_link'}}):
    new Response(page(),{headers:{'content-type':'text/html'}});
});
assert.equal(loaded.url,url);assert.deepEqual(requests,[short,url]);
for(const location of ['https://accounts.google.com/login','http://127.0.0.1/','https://example.com/']){
  let attempts=0;
  await assert.rejects(fetchGoogleForm(short,async()=>{attempts++;return new Response(null,{status:302,headers:{location}});}));
  assert.equal(attempts,1);
}
await assert.rejects(fetchGoogleForm(short,async()=>new Response(null,{status:302,headers:{location:short}})));
await assert.rejects(fetchGoogleForm(url,async()=>new Response('x',{headers:{'content-type':'application/json'}})));
await assert.rejects(fetchGoogleForm(url,async()=>new Response('x'.repeat(2000001),{headers:{'content-type':'text/html'}})));
await assert.rejects(fetchGoogleForm(url,async()=>new Response(null,{status:302,headers:{location:url.replace(id,'a'.repeat(30))}})));

const row={url,discord_posted_at:'2026-11-18T09:55:00Z',event_title:'仮の件名',external_url_unverified:true};
const catalog={items:[row]};
assert.deepEqual(await enrichGoogleForms(catalog,async()=>loaded,now),{checked:1,updated:1});
assert.equal(row.application_start_at,'2026-11-18');assert.equal(row.external_url_unverified,false);
assert.equal(row.official_event_title,fields.event_title);assert.equal(row.pokemon_map_type,'pack');
assert.deepEqual(await enrichGoogleForms(catalog,()=>assert.fail('retry too soon'),now),{checked:0,updated:0});
const oldParser={url,discord_posted_at:now.toISOString(),google_forms_checked_at:now.toISOString(),google_forms_parser_version:1};
assert.deepEqual(await enrichGoogleForms({items:[oldParser]},async()=>loaded,now),{checked:1,updated:1});
assert.equal(oldParser.google_forms_parser_version,GOOGLE_FORMS_PARSER_VERSION);
assert.deepEqual(await enrichGoogleForms({items:[oldParser]},()=>assert.fail('new version repeated'),now),{checked:0,updated:0});
await enrichGoogleForms(catalog,async()=>({url,html:'<title>受付終了</title>'}),new Date(+now+7*3600000));
assert.equal(row.store_name,'バトロコ川崎駅前店');assert.equal(row.google_forms_last_error,'closed_or_unavailable');
const partial={url,discord_posted_at:now.toISOString()};
await enrichGoogleForms({items:[partial]},async()=>({url,html:page('応募受付期間：11/19 23:59まで')}),now);
assert.equal(partial.application_start_at,undefined);assert.equal(partial.application_end_at,'2026-11-19T23:59:00+09:00');
const dueToday={url,application_end_at:'2026-11-18'};
assert.equal((await enrichGoogleForms({items:[dueToday]},async()=>loaded,now)).checked,1);
assert.equal((await enrichGoogleForms({items:[{url,application_end_at:'2026-11-17'},
  {url,first_detected_at:'2026-10-01T00:00:00Z'},{url,manual_page_unavailable:true},
  {url,manual_card_hidden:true}]},()=>assert.fail('historical/hidden form fetched'),now)).checked,0);
const many=Array.from({length:10},(_,i)=>({url,discord_posted_at:new Date(+now-i*60000).toISOString()})).reverse();
assert.deepEqual(await enrichGoogleForms({items:many},async()=>loaded,now),{checked:8,updated:8});
assert(!many[0].google_forms_checked_at);assert(many[9].google_forms_checked_at);

// Rendering and expiry must not turn an unspecified time into 09:00 UTC parsing.
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function appFunction(name){
  const begin=app.indexOf('function '+name+'('),end=app.indexOf('\n  }',begin);
  assert(begin>=0&&end>begin,name);return app.slice(begin,end+4);
}
const names=['lotteryDate','lotteryJapaneseDate','lotteryState','lpExtDateInput','lpApplicationExpired'];
const context={lpCardOverrides:new Map(),lotteryItems:[],lotteryBaseItems:[{url,application_end_at:'2026-11-18'}]};
const helpers=vm.runInNewContext(names.map(appFunction).join('\n')+'\n({'+names.join(',')+'})',context);
assert.equal(helpers.lotteryJapaneseDate('2026-11-18'),'2026/11/18');
assert.equal(helpers.lotteryJapaneseDate('2026-11-19T23:59:00+09:00'),'2026/11/19 23:59');
assert.equal(helpers.lotteryJapaneseDate('2026-11-31'),'');
assert.equal(helpers.lpExtDateInput('2026-11-18'),'');
assert.equal(helpers.lpExtDateInput('2026-11-19T23:59:00+09:00'),'2026-11-19T23:59');
const dates={application_start_at:'2026-11-18',application_end_at:'2026-11-19'};
assert.equal(helpers.lotteryState(dates,Date.parse('2026-11-17T23:59:59+09:00')),'upcoming');
assert.equal(helpers.lotteryState(dates,Date.parse('2026-11-18T00:00:00+09:00')),'open');
assert.equal(helpers.lotteryState(dates,Date.parse('2026-11-19T23:59:59+09:00')),'open');
assert.equal(helpers.lotteryState(dates,Date.parse('2026-11-20T00:00:00+09:00')),'closed');
assert.equal(helpers.lpApplicationExpired(url,'',Date.parse('2026-11-18T22:00:00+09:00')),false);
assert.equal(helpers.lpApplicationExpired(url,'',Date.parse('2026-11-19T00:00:00+09:00')),true);

const deliveryForm = `＜抽選販売応募受付期間＞
2026年11月20日(金) 10:00 締切
＜抽選結果発表＞
2026年11月22日(日)までにXで発表
＜商品＞
ワンピースカード ブースターパック 神の支配【OP-18】 5,760円（税込）
＜応募資格＞
2026年1月1日0:00～2026年11月18日23:59までに購入履歴がある方
商品の発送は発売日以降です。別途送料が発生します。
https://planetpocket.shop-pro.jp/?mode=sk`;
const deliveryTitle='ワンピースカード ブースターパック 神の支配【OP-18】 抽選販売';
const delivery=parse(deliveryForm, deliveryTitle);
assert.equal(delivery.application_start_at,undefined);
assert.equal(delivery.google_forms_start_not_stated,true);
assert.equal(delivery.application_end_at,'2026-11-20T10:00:00+09:00');
assert.equal(delivery.result_announcement_date,'2026-11-22');
assert.equal(delivery.purchase_start_date,undefined);
assert.equal(delivery.product_name,'ワンピースカード ブースターパック 神の支配【OP-18】');
assert.deepEqual(delivery.stores,[{name:'プラネットポケット',prefecture:'全国'}]);
assert.equal(parse(deliveryForm.replace('planetpocket.shop-pro.jp','other.shop-pro.jp'),deliveryTitle).store_name,undefined);

const mintStore = 'MINT大丸心斎橋店';
const mintProduct = 'ONE PIECE CARD GAME 神の支配【OP-18】';
const mintTitle = mintStore + ' ' + mintProduct + '抽選応募フォーム';
const mintNotice = [
  '入荷数が少量の為、' + mintStore + 'では抽選による販売を行います。',
  '■販売価格', '「' + mintProduct + '」…1BOX 5,760円（税込）',
  '■受付期間', '2026年11月19日（木）公開から', '2026年11月20日（金）10:00まで',
  '■当選者のご連絡', '2026年11月20日（金）を予定しております。',
  '当選通知はスクリーンショットなどの画像データは認められません。',
  '■購入期間：2026年11月21日（土）～2026年11月23日（月）',
  '※入荷遅れにより11月21日(土)10:00からの販売が難しい場合はお知らせします。',
  mintStore, '営業時間：10：00～20：00'
].join('\n');
const mintOption = '「' + mintProduct + '」…1BOX 5,760円（税込）※テープカットしてのお渡しです。';
const choice = (...options) => [1, '希望商品', null, 2, [[2, options.map(option => [option])]]];
const mintPage = page(mintNotice, mintTitle, [choice(mintOption)]);
const mint = extract(mintPage, url, {referenceDate: now.toISOString()});
assert.deepEqual(mint, {
  event_title: mintTitle, product_name: mintProduct, review_category: 'onepiece', product_type: 'pack',
  store_name: mintStore, prefecture: '大阪府', stores: [{name: mintStore, prefecture: '大阪府'}],
  application_start_at: '2026-11-19', application_end_at: '2026-11-20T10:00:00+09:00',
  google_forms_start_not_stated: false, result_announcement_date: '2026-11-20',
  purchase_start_date: '2026-11-21', purchase_end_date: '2026-11-23'
});
const previousMint = {url: url + '?usp=send_form', google_forms_checked_at: now.toISOString(),
  google_forms_parser_version: 3, application_start_at: null, application_end_at: null};
assert.deepEqual(await enrichGoogleForms({items:[previousMint]}, async()=>({html:mintPage,url}), now), {checked:1,updated:1});
assert.equal(previousMint.google_forms_source_url, url);
assert.equal(previousMint.application_end_at, mint.application_end_at);
assert.equal(previousMint.pokemon_map_type, 'pack');

assert.equal(parse('受付期間：11/19 公開から\n■購入期間：11/21～11/23', mintTitle).application_end_at, undefined);
assert.equal(parse('受付期間：11/19 公開から\n11/21から販売予定', mintTitle).application_end_at, undefined);
assert.equal(parse('受付期間：11/19公開から\n11/20 10:00まで\n受付期間：11/19公開から\n11/21 10:00まで', mintTitle).application_end_at, undefined);
assert.equal(parse('受付期間：11/19 18:00～\n11/20 10:00', mintTitle).application_start_at, '2026-11-19T18:00:00+09:00');
assert.equal(parse(mintNotice + '\n当選通知：未定', mintTitle).result_announcement_date, undefined);
assert.equal(parse('■購入期間：11/21～11/23\n大丸心斎橋店', mintTitle).store_name, undefined);
assert.equal(parse(mintNotice.replaceAll(mintStore, 'MINT別支店'), mintTitle.replace(mintStore, 'MINT別支店')).prefecture, undefined);
assert.equal(googleFormFields(page(mintNotice, mintTitle, [choice(mintOption, '別の商品')]), url).product_name, undefined);
assert.equal(googleFormFields(page(mintNotice, mintTitle, [choice('「別の商品」…1BOX')]), url).product_name, undefined);
console.log('Google Forms public metadata, safe redirects, date-only display and collection regressions passed');
