import {supportedUrl,extract,lotteryPageRequest,CUSTOMFORM_HOST,GEO_HOST} from './extract.mjs';
import {googleFormUrl,GoogleFormAccessError} from './google-forms.mjs';
import {readGoogleLottery} from './google-form-notices.mjs';
import {DMM_HOST,BANDAI_HOST,HOBBY_SEARCH_HOST,collectedOnlineShop,onlineShopUrl} from './online-shop-lottery.mjs';
import {storeNoticeUrl,fetchStoreNotice} from './store-notices.mjs';
const admin='0ba965da-445b-4055-8d8d-ead585fa0d09';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'};
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:cors});}

async function readPublicCatalog(){
 const response=await fetch('https://ttttt-9554.github.io/pokeca-map/other_lottery_public.json?t='+Date.now(),
  {cache:'no-store',signal:AbortSignal.timeout(6000)});
 if(!response.ok)throw Error('catalog unavailable');
 return await response.json();
}
function shopBackoff(catalog:any,url:string){
 return Array.isArray(catalog?.items)&&catalog.items.some((row:{url?:string,online_shop_retry_after?:string})=>
  onlineShopUrl(row?.url)?.hostname===onlineShopUrl(url)?.hostname&&Date.parse(row.online_shop_retry_after||'')>Date.now());
}
async function collectedBrowserPage(url:string,onlineShop=false,preloaded?:any,sourceBlocked=false) {
 const catalog=preloaded??await readPublicCatalog();
 const item=onlineShop?collectedOnlineShop(catalog,url):Array.isArray(catalog?.items)?catalog.items.find((row:{url?:string})=>row?.url===url):null;
 const verified=onlineShop?item?.online_shop_verified_at:item?.customform_verified_at;
 if(!verified||item.external_url_unverified!==false){
  if(onlineShop){
   const blocked=sourceBlocked||shopBackoff(catalog,url);
   return json({error:blocked?'取得先が定期収集サーバーからのアクセスを拒否しているため、現在は自動取得できません。元ページを開いて確認してください。':'ブラウザーによる自動収集を待っています。収集後にもう一度お試しください。'},422);
  }
  const blocked=Array.isArray(catalog?.items)&&catalog.items.some((row:{customform_last_error?:string,customform_retry_after?:string})=>
   row?.customform_last_error==='source_access_denied'&&Date.parse(row.customform_retry_after||'')>Date.now());
  if(blocked)return json({error:'取得先が定期収集サーバーからのアクセスを拒否しているため、現在は自動取得できません。元ページを開いて確認してください。'},422);
  return json({error:'ブラウザーによる自動収集を待っています。収集後にもう一度お試しください。'},422);
 }
 const fields:Record<string,unknown>={};
 for(const name of ['event_title','product_name','store_name','prefecture','review_category',
   'application_start_at','application_end_at','result_announcement_date','result_announcement_time',
   'purchase_start_date','purchase_start_time','purchase_end_date','purchase_end_time']){
  if(typeof item[name]==='string'&&item[name])fields[name]=item[name];
 }
 if(Array.isArray(item.stores))fields.stores=item.stores.slice(0,100).map((store:{name?:string,prefecture?:string})=>({
  name:typeof store?.name==='string'?store.name:'',prefecture:typeof store?.prefecture==='string'?store.prefecture:''
 }));
 if(typeof item.pokemon_map_type==='string')fields.product_type=item.pokemon_map_type;
 const collected=new Date(verified).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
 const method=onlineShop?'元ページで確認済みの保存情報です':'ブラウザーで自動収集した情報です';
 const warning=onlineShop&&(sourceBlocked||shopBackoff(catalog,url)||item.online_shop_last_error)?'最新情報の取得ができないため、前回確認した情報を表示しています。締切などの変更は元ページをご確認ください。':'';
 return json({fields,message:method+'（確認日時：'+collected+'、日本時間）。'+warning+'候補を確認してください。'});
}

Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(req.method!=='POST')return json({error:'許可されていない操作です。'},405);
 const auth=req.headers.get('Authorization')||'';
 if(!/^Bearer [A-Za-z0-9._-]+$/.test(auth))return json({error:'管理者ログインが必要です。'},401);
 const base=Deno.env.get('SUPABASE_URL')||'', key=Deno.env.get('SUPABASE_ANON_KEY')||'';
 if(!base||!key)return json({error:'認証サービスを利用できません。'},503);
 try{
  const r=await fetch(base+'/auth/v1/user',{headers:{Authorization:auth,apikey:key},signal:AbortSignal.timeout(5000)});
  if(!r.ok)return json({error:'ログインの確認に失敗しました。'},401);
  const user=await r.json();
  if(user.id!==admin)return json({error:'管理者のみ利用できます。'},403);
 }catch{return json({error:'ログインの確認に失敗しました。'},503);}
 let input;
 try{const raw=await req.text();if(raw.length>4096)throw Error();input=JSON.parse(raw);}catch{return json({error:'入力を確認してください。'},400);}
 if(typeof input?.url!=='string'||input.url.length>1000||!supportedUrl(input.url))
  return json({error:'このサイトは個別取得に未対応です。元ページを開いて確認してください。'},422);
 try{
  if(storeNoticeUrl(input.url)){
   const fields=await fetchStoreNotice(input.url);
   return json({fields,message:fields.event_title?'店舗の公式告知から取得しました。候補を確認してください。':'このページから抽選の受付案内を読み取れませんでした。'});
  }
  if(googleFormUrl(input.url)){
   const {fields,evidence,reviewedOn}=await readGoogleLottery(input.url,{parse:extract});
   if(evidence){
    const message=evidence==='official_post_and_form_screen'?
      '受付期間は店舗の公式告知から取得しました。発表・受取は'+reviewedOn+'に確認したフォーム画面の情報です。':
      reviewedOn+'に確認したフォーム画面の情報です。現在の受付期間は元ページをご確認ください。';
    return json({fields,message});
   }
   return json({fields,message:Object.keys(fields).length?'Googleフォームの案内から取得しました。記載のない日時は空欄です。':'公開された案内を読み取れませんでした。受付終了やログイン制限を確認してください。'});
  }
  const {url:source,headers}=lotteryPageRequest(input.url),host=source.hostname;
  if(host===CUSTOMFORM_HOST||host===BANDAI_HOST)return await collectedBrowserPage(input.url,host===BANDAI_HOST);
  let cachedCatalog;
  if(host===HOBBY_SEARCH_HOST){
   // Honor the existing collector's access-denial backoff; never retry through another route.
   try{cachedCatalog=await readPublicCatalog();}catch{}
   if(shopBackoff(cachedCatalog,input.url))return await collectedBrowserPage(input.url,true,cachedCatalog,true);
  }
  const response=await fetch(source,{redirect:'manual',headers,signal:AbortSignal.timeout(14000)});
  if(host===HOBBY_SEARCH_HOST&&[401,403,429].includes(response.status)){
   await response.body?.cancel();
   return await collectedBrowserPage(input.url,true,cachedCatalog,true);
  }
  if(response.status>=300&&response.status<400){
   await response.body?.cancel();
   if(host===DMM_HOST)return await collectedBrowserPage(input.url,true);
   if(host===HOBBY_SEARCH_HOST)return await collectedBrowserPage(input.url,true,cachedCatalog,true);
   return json({error:'別ページへの転送があるため、自動取得できませんでした。'},422);
  }
  if(host===GEO_HOST&&[403,429].includes(response.status))
   return json({error:`GEO公式サイトが自動取得を拒否しました（HTTP ${response.status}）。公式ページの案内を確認してください。`},422);
  if(!response.ok)return json({error:`取得先が応答しませんでした（HTTP ${response.status}）。`},422);
  const kind=response.headers.get('content-type')||'';
  if(!/text\/html|application\/xhtml\+xml/i.test(kind))return json({error:'ページ形式を確認できませんでした。'},422);
  if(Number(response.headers.get('content-length')||0)>2000000)return json({error:'ページが大きすぎるため取得できませんでした。'},422);
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(!reader)return json({error:'ページが空でした。'},422);
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2000000){await reader.cancel();return json({error:'ページが大きすぎるため取得できませんでした。'},422);}chunks.push(value);}
  const buf=new Uint8Array(size);let offset=0;for(const part of chunks){buf.set(part,offset);offset+=part.length;}
  const result=extract(new TextDecoder().decode(buf),input.url);
  return json({fields:result,message:Object.keys(result).length?'取得した候補を確認してください。':'読み取れる項目が見つかりませんでした。受付終了や取得先の仕様を確認してください。'});
 }catch(error){
  if(error instanceof GoogleFormAccessError)return json({error:error.message,code:error.code},422);
  return json({error:'ページを取得できませんでした。時間を置いて再度お試しください。'},422);
 }
});
