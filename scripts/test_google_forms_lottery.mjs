import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {googleFormUrl,googleFormFields,fetchGoogleForm} from '../supabase/functions/lottery-individual-fetch/google-forms.mjs';
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

assert.equal(parse('応募期間：2026/11/18 10:30～2026/11/19 23:59').application_start_at,'2026-11-18T10:30:00+09:00');
assert.equal(parse('応募締切：１１月１９日 ２３：５９').application_end_at,'2026-11-19T23:59:00+09:00');
assert.equal(parse('当選発表：11月20日～22日 18時半').result_announcement_time,'18:30');
assert.equal(parse('当選発表：11月20日～22日 18時半').result_announcement_date,'2026-11-22');
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
console.log('Google Forms public metadata, safe redirects, date-only display and collection regressions passed');
