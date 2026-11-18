import {readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {onlineShopUrl,onlineShopFields,ONLINE_SHOP_PARSER_VERSION,DMM_HOST,BANDAI_HOST} from '../supabase/functions/lottery-individual-fetch/online-shop-lottery.mjs';

const catalogPath='other_lottery_public.json';
const discovered=item=>Date.parse(item.discord_posted_at||item.first_detected_at||'');
export function shopCandidates(catalog,host,now=new Date()) {
  if(catalog.items.some(item=>onlineShopUrl(item.url)?.hostname===host && Date.parse(item.online_shop_retry_after)>+now)) return [];
  return [...catalog.items].filter(item=>{
    if(onlineShopUrl(item.url)?.hostname!==host||item.manual_page_unavailable||item.manual_card_hidden)return false;
    const end=Date.parse(item.application_end_at||'');
    // Do not revisit old rounds unless a new Discord post has discovered one.
    if(end<+now && !(discovered(item)>end))return false;
    if(discovered(item)<+now-14*86400000 && !Number.isFinite(end))return false;
    return item.online_shop_parser_version!==ONLINE_SHOP_PARSER_VERSION ||
      !(+now-Date.parse(item.online_shop_checked_at||'')<6*3600000);
  }).sort((a,b)=>(discovered(b)||0)-(discovered(a)||0)).slice(0,host===DMM_HOST?8:3);
}

export function applyShopPage(item,html,now=new Date()) {
  item.online_shop_checked_at=now.toISOString();
  item.online_shop_parser_version=ONLINE_SHOP_PARSER_VERSION;
  const {product_type,...fields}=onlineShopFields(html,item.url);
  if(!fields.event_title || Date.parse(fields.application_end_at)<=discovered(item)){
    item.online_shop_last_error='closed_or_unavailable';return false;
  }
  Object.assign(item,fields,{official_event_title:fields.event_title,event_title_provisional:false,
    external_url_unverified:false,online_shop_verified_at:now.toISOString(),
    online_shop_source_url:onlineShopUrl(item.url).href});
  if(product_type)item.pokemon_map_type=product_type;
  delete item.online_shop_last_error;delete item.online_shop_retry_after;
  return true;
}

export async function fetchDmm(value,request=fetch) {
  const source=onlineShopUrl(value);
  if(source?.hostname!==DMM_HOST)throw Error('Unsupported DMM product');
  const response=await request(source.href,{redirect:'manual',headers:{Accept:'text/html,application/xhtml+xml',
    'Accept-Language':'ja-JP,ja;q=0.9','User-Agent':'TorecaRadar/1.0'},signal:AbortSignal.timeout(14000)});
  if(!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type')||'') ||
    Number(response.headers.get('content-length')||0)>2000000 || !response.body){
    await response.body?.cancel();const error=new Error('DMM page unavailable');error.status=response.status;throw error;
  }
  const decoder=new TextDecoder();let html='',size=0;
  for await(const chunk of response.body){
    size+=chunk.byteLength;if(size>2000000)throw Error('Page too large');
    html+=decoder.decode(chunk,{stream:true});
  }
  return html+decoder.decode();
}

export async function enrichDmm(catalog,load=fetchDmm,now=new Date()) {
  let checked=0,updated=0;
  // A direct URL and an affiliate URL for the same product need one page read.
  const pages=new Map();
  for(const item of shopCandidates(catalog,DMM_HOST,now)){
    item.online_shop_checked_at=now.toISOString();item.online_shop_parser_version=ONLINE_SHOP_PARSER_VERSION;checked++;
    try{
      const source=onlineShopUrl(item.url).href;
      if(!pages.has(source))pages.set(source,await load(item.url));
      updated+=Number(applyShopPage(item,pages.get(source),now));
    }catch(error){
      item.online_shop_last_error='page_unavailable';
      if([401,403,429].includes(error?.status)){
        item.online_shop_last_error='source_access_denied';
        item.online_shop_retry_after=new Date(+now+86400000).toISOString();break;
      }
    }
  }
  return {checked,updated};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const mode=process.argv[2]||'dmm';
  if(mode==='parse'){
    let data='';for await(const chunk of process.stdin)data+=chunk;
    const {html,url}=JSON.parse(data);process.stdout.write(JSON.stringify(onlineShopFields(html,url)));
  }else{
    const catalog=JSON.parse(await readFile(catalogPath,'utf8')),now=new Date();
    if(mode==='plan-bandai'){
      process.stdout.write(JSON.stringify(shopCandidates(catalog,BANDAI_HOST,now).map(item=>({url:item.url,source:onlineShopUrl(item.url).href}))));
    }else{
      let result;
      if(mode==='apply-bandai'){
        let data='';for await(const chunk of process.stdin)data+=chunk;
        const pages=JSON.parse(data);result={checked:0,updated:0};
        for(const page of pages){
          if(onlineShopUrl(page.url)?.hostname!==BANDAI_HOST)continue;
          const item=catalog.items.find(row=>row.url===page.url);if(!item)continue;
          result.checked++;result.updated+=Number(applyShopPage(item,page.html||'',now));
          if(page.blocked){item.online_shop_last_error='source_access_denied';item.online_shop_retry_after=new Date(+now+86400000).toISOString();}
        }
      }else if(mode==='dmm')result=await enrichDmm(catalog);
      else throw Error('Unsupported collector mode');
      if(result.checked){
        await writeFile(catalogPath+'.tmp',JSON.stringify(catalog,null,2)+'\n','utf8');
        await rename(catalogPath+'.tmp',catalogPath);
      }
      console.log('Online shop lottery pages:',result);
    }
  }
}
