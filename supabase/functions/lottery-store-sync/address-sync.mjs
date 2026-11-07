import { VERIFIED_ADDRESSES } from './verified-addresses.mjs';

export const WONDER_URL='https://www.wonder.co.jp/tcg/';
const SHINSEIDO_AREAS={宮城県:'miyagi',山形県:'yamagata',栃木県:'tochigi',埼玉県:'saitama',
  千葉県:'chiba',東京都:'tokyo',神奈川県:'kanagawa',石川県:'ishikawa',愛知県:'aichi',広島県:'hiroshima'};
const PREFS=('北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県').split(' ');
const OFFICIAL_HOSTS=new Set(['www.wonder.co.jp','shinseido.co.jp','www.furu1.net',
  'www.kidsrepublic.jp','map.pokemon-card.com','store-tsutaya.tsite.jp']);
const clean=value=>typeof value==='string'?value.trim():'';
export const normalizeName=value=>clean(value).normalize('NFKC').toLocaleLowerCase('ja-JP')
  .replace(/[\s　・･._－（）()【】「」-]+/g,'');
const key=row=>row.prefecture+'|'+normalizeName(row.name);
function text(html){
  return html.replace(/<!--[^]*?-->|<script\b[^]*?<\/script>|<style\b[^]*?<\/style>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_,e)=>{
      const fixed={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
      if(e[0]!=='#')return fixed[e.toLowerCase()]||'';
      const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);
      return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
    }).replace(/\s+/g,' ').trim();
}
function validRecord(row){
  if(!row||!clean(row.name)||row.name.length>200||!PREFS.includes(row.prefecture)||
    typeof row.address!=='string'||row.address.length>250||
    !row.address.startsWith(row.prefecture)||!/[0-9０-９]/.test(row.address)||/[<>\r\n]/.test(row.address))return false;
  try{const url=new URL(row.source_url);return url.protocol==='https:'&&!url.username&&!url.password&&
    !url.port&&OFFICIAL_HOSTS.has(url.hostname);}catch{return false;}
}
export function parseWonder(html){
  const rows=[];
  for(const [,heading,body] of html.matchAll(/<dt\b[^>]*>([^]*?)<\/dt>\s*<dd\b[^>]*>([^]*?)<\/dd>/gi)){
    const title=text(heading),address=text(body.split(/<br\s*\/?\s*>/i)[0]).replace(/^住所\s*[：:]\s*/,''),
      prefecture=PREFS.find(pref=>address.startsWith(pref));
    if(!prefecture||!/^住所\s*[：:]/.test(text(body)))continue;
    const names=[];
    const wonder=title.match(/WonderGOO(?:\s+PLUS[+＋])?\s*([^()（）]+?店)(?:内)?(?:[)）]|$)/i);
    const ganryu=title.match(/(?:Duel\s+Stade\s*)?Ganryu\s*([^()（）]+?店)/i);
    if(wonder)names.push('WonderGOO'+wonder[1].trim());
    if(ganryu)names.push('Ganryu'+ganryu[1].trim());
    for(const name of names){const row={name,prefecture,address,source_url:WONDER_URL};if(validRecord(row))rows.push(row);}
  }
  return rows;
}
export function parseShinseido(html,url){
  const rows=[];
  for(const block of html.split(/<li\b[^>]*class=["']shop-item["'][^>]*>/i).slice(1)){
    const heading=block.match(/<h[23]\b[^>]*>([^]*?)<\/h[23]>/i);
    if(!heading)continue;
    for(const [,label,value] of block.matchAll(/<th\b[^>]*>([^]*?)<\/th>\s*<td\b[^>]*>([^]*?)<\/td>/gi)){
      if(text(label)!=='所在地')continue;
      const address=text(value),prefecture=PREFS.find(pref=>address.startsWith(pref));
      const row={name:'新星堂'+text(heading[1]),prefecture,address,source_url:url};
      if(validRecord(row))rows.push(row);
      break;
    }
  }
  return rows;
}
export async function fetchOfficialPage(url){
  const allowed=new Set([WONDER_URL,...Object.values(SHINSEIDO_AREAS).map(area=>
    'https://shinseido.co.jp/shop/list/'+area+'/')]);
  if(!allowed.has(url))throw Error('Unsupported official directory');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
    const response=await fetch(url,{redirect:'error',signal:controller.signal,
      headers:{'User-Agent':'TorecaRadar/1.0 (+https://ttttt-9554.github.io/pokeca-map/)'}});
    if(!response.ok)throw Error('Official directory HTTP '+response.status);
    const reader=response.body?.getReader();if(!reader)throw Error('Empty official directory');
    const decoder=new TextDecoder();let html='',size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;
      size+=value.length;if(size>350000)throw Error('Official directory too large');
      html+=decoder.decode(value,{stream:true});}
      return html+decoder.decode();
    }finally{await reader.cancel().catch(()=>{});}
  }finally{clearTimeout(timer);}
}
export async function findAddresses(pending,loadPage=fetchOfficialPage){
  if(!Array.isArray(pending)||pending.length>1200)throw Error('Unexpected pending store list');
  const wanted=pending.filter(row=>row&&typeof row.name==='string'&&row.name.length<=200&&
    PREFS.includes(row.prefecture)&&!row.merged_into&&!clean(row.address));
  const reviewed=new Map();
  for(const row of VERIFIED_ADDRESSES)if(validRecord(row)){
    for(const name of [row.name,...(row.aliases||[])])reviewed.set(key({...row,name}),{...row,name});
  }
  const need=wanted.filter(row=>!reviewed.has(key(row))),pages=[];
  if(need.some(row=>/^(wondergoo|ganryu)/.test(normalizeName(row.name))))pages.push({url:WONDER_URL,parse:parseWonder});
  for(const pref of new Set(need.filter(row=>row.name.startsWith('新星堂')).map(row=>row.prefecture))){
    const area=SHINSEIDO_AREAS[pref];if(area)pages.push({url:'https://shinseido.co.jp/shop/list/'+area+'/',parse:parseShinseido});
  }
  const directory=[],errors=[];let next=0;
  await Promise.all(Array.from({length:Math.min(4,pages.length)},async()=>{
    while(next<pages.length){const page=pages[next++];
      try{const html=await loadPage(page.url);const rows=page.parse(html,page.url);
        if(!rows.length)throw Error('No validated shop addresses');directory.push(...rows);
      }catch(error){errors.push(page.url+': '+String(error?.message||error).slice(0,120));}
    }
  }));
  const index=new Map(),conflicts=new Set();
  for(const row of directory){
    const id=key(row);if(reviewed.has(id))continue;
    if(index.has(id)&&normalizeName(index.get(id).address)!==normalizeName(row.address))conflicts.add(id);
    else index.set(id,row);
  }
  for(const id of conflicts)index.delete(id);
  for(const [id,row] of reviewed)index.set(id,row);
  const rows=[];
  for(const store of wanted){const found=index.get(key(store));
    if(found)rows.push({name:store.name,prefecture:store.prefecture,address:found.address,source_url:found.source_url});
  }
  return {rows,pending:wanted.length,unresolved:wanted.length-rows.length,sources:pages.length,errors};
}
export async function syncAddresses(client,loadPage=fetchOfficialPage){
  const pending=await client.rpc('lottery_store_address_pending_v1');
  if(pending.error)throw pending.error;
  const result=await findAddresses(pending.data,loadPage);
  let updated=0;
  if(result.rows.length){
    const saved=await client.rpc('lottery_store_address_fill_v1',{p_stores:result.rows});
    if(saved.error)throw saved.error;
    if(!Number.isInteger(saved.data?.updated)||saved.data.updated<0||saved.data.updated>result.rows.length)
      throw Error('Invalid saved address count');
    updated=saved.data.updated;
  }
  return {pending:result.pending,matched:result.rows.length,updated,unresolved:result.unresolved,
    sources:result.sources,errors:result.errors};
}
