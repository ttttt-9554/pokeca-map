import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.18.12";

// Official-only, waiting-room-respecting Pokemon Center stock monitor.
// Filtered listing = a CANDIDATE, never proof that checkout is enabled.
// Official product detail must verify an enabled purchase control.
// Pack and deck pages alternate every minute; up to two detail reads/run.
const SITE="pokemon";
const HOST="www.pokemoncenter-online.com";
const ORIGIN="https://"+HOST;
const CATEGORIES=[
  {key:"packs", url:ORIGIN+"/pokemon-card-game/booster-packs/?inStock=1&srule=top-new-product",
   heading:/(?:拡張|強化拡張|ハイクラス)パック/},
  {key:"decks",url:ORIGIN+"/pokemon-card-game/battle-decks/?inStock=1&srule=top-new-product",
   heading:/(?:構築|スターター|デッキ)/}
];
const ROBOTS=ORIGIN+"/robots.txt";
const WAITING_HOST="wr.pokemoncenter-online.com";
const UA="TorecaRadarFastMonitor/1.0";
const MAX_BYTES=2_000_000;
const MAX_CANDIDATES=70;
const MAX_DETAIL_CHECKS=2;
const POKECARD=/(?:ポケモンカードゲーム|ポケモンカード|ポケカ)/i;
const PACK=/(?:強化拡張パック|拡張パック|ハイクラスパック|ブースターパック|ブースターBOX|ブースターボックス|BOX|ボックス)/i;
const DECK=/(?:スターターデッキ|スタートデッキ|スターターセット|構築済みデッキ|構築デッキ|スペシャルデッキセット|プレミアムデッキセット)/i;
const EXCLUDE=/(?:予約|抽選|デッキケース|カードケース|スリーブ|プレイマット|ストレージ|ローダー|サプライ|ぬいぐるみ|フィギュア|キーホルダー|ステッカー|シール|タオル|文具|アパレル|バッグ|シングルカード|オリパ|福袋|ダウンロード)/i;
const OUT_OF_STOCK=/(?:品切れ|在庫なし|在庫切れ|売り切れ|販売終了|sold out)/i;
const clean=(x:unknown)=>String(x??"").replace(/\s+/g," ").trim();

function productKind(label:string):"pack"|"deck"|""{
  if(!label||!POKECARD.test(label)||EXCLUDE.test(label))return "";
  if(PACK.test(label))return "pack";
  if(DECK.test(label))return "deck";
  return "";
}
function productUrl(input:string,base:string):string {
  try {
    const u=new URL(input,base);
    if(u.protocol!=="https:"||u.hostname!==HOST||u.username||u.password||u.port||
       !/^\/[0-9]{6,20}(?:-[A-Za-z0-9_-]+)?\.html$/.test(u.pathname)) return "";
    if([...u.searchParams.keys()].some(x=>x.startsWith("dwvar_")))return "";
    return ORIGIN+u.pathname;
  }catch{return "";}
}
async function sha256(value:string):Promise<string>{
  const bytes=new TextEncoder().encode(value);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function robotsAllows(text:string,path:string):boolean {
  let applicable=false;
  for(const line of text.split(/\r?\n/).map(x=>x.trim())) {
    if(!line||line.startsWith("#"))continue;
    const agent=line.match(/^User-agent:\s*(.+)$/i);
    if(agent){applicable=agent[1].toLowerCase()==="*"||agent[1].toLowerCase()===UA.toLowerCase();continue;}
    if(!applicable)continue;
    const disallowed=line.match(/^Disallow:\s*(.*)$/i);
    if(disallowed){
      const prefix=disallowed[1].trim().replace(/\*.*$/,"");
      if(prefix&&path.startsWith(prefix))return false;
    }
  }
  return true;
}
async function readLimited(res:Response):Promise<string>{
  const content=await res.arrayBuffer();
  if(content.byteLength>MAX_BYTES)throw new Error("response_too_large");
  return new TextDecoder().decode(content);
}
function cooldown(minutes:number):string {
  return new Date(Date.now()+minutes*60000).toISOString();
}
function guardPage(doc:any):void {
  const title=clean(doc.querySelector("title")?.textContent).toLowerCase();
  if(/仮想待合室|waiting room|queue-it/.test(title))throw new Error("waiting");
  if(/access denied|captcha|just a moment|アクセス制限/.test(title))throw new Error("blocked");
}
type Candidate={url:string;product:string;notification_kind:"pack"|"deck"};
type Verification={status:"available"|"unavailable"|"unknown";product:string};

function catalogCandidates(html:string,category:(typeof CATEGORIES)[number]):Candidate[]{
  const {document}=parseHTML(html);
  guardPage(document);
  const heading=clean(document.querySelector("h1")?.textContent);
  if(!category.heading.test(heading))throw new Error("catalog_markup_unverified");
  const found=new Map<string,Candidate>();
  for(const a of [...document.querySelectorAll("a[href]")]){
    const url=productUrl(a.getAttribute("href")||"",category.url);
    if(!url||found.has(url))continue;
    let scope:any=a,node:any=a;
    for(let j=0;j<6&&node;j++){
      const children=[...node.querySelectorAll?.("a[href]")||[]]
        .map((n:any)=>productUrl(n.getAttribute("href")||"",category.url)).filter(Boolean);
      if(new Set(children).size>1)break;
      scope=node; node=node.parentElement;
    }
    const alt=[...a.querySelectorAll("img")].map((n:any)=>clean(n.getAttribute("alt")))
      .filter(Boolean).sort((x,y)=>y.length-x.length)[0]||"";
    const name=[clean(scope?.textContent),clean(a.textContent),alt]
      .sort((x,y)=>y.length-x.length)[0].slice(0,400);
    const kind=productKind(name);
    if(!kind||kind!==category.key.replace("packs","pack").replace("decks","deck"))continue;
    // Filtered listing may show lottery reservations, and sometimes even
    // "品切れ" labels; NONE of those are stock-confirmed purchase candidates.
    if(OUT_OF_STOCK.test(name))continue;
    found.set(url,{url,product:name,notification_kind:kind});
    if(found.size>=MAX_CANDIDATES)break;
  }
  return [...found.values()];
}
function detailVerification(html:string, expectedKind:"pack"|"deck"):Verification{
  const {document}=parseHTML(html);
  guardPage(document);
  const h1=document.querySelector("h1");
  const title=clean(h1?.textContent).slice(0,350);
  if(!h1||!title||productKind(title)!==expectedKind)
    return {status:"unknown",product:title};
  // Product-specific purchase controls only; do not use buttons in
  // recommendation cards, shopping cart overlays, or global site header.
  const root=h1.closest(".product-detail,.product-info,.product-information,.pdp-main")
    ||document.querySelector(".product-detail,.pdp-main");
  if(!root)return {status:"unknown",product:title};
  const body=clean(root.textContent);
  const start=Math.max(0,body.indexOf(title));
  const primary=body.slice(start+title.length,start+title.length+210);
  if(OUT_OF_STOCK.test(primary))return {status:"unavailable",product:title};
  const buttons=[...root.querySelectorAll("button,input")];
  const enabled=buttons.some((b:any)=>{
    const label=clean((b.textContent||"")+" "+(b.getAttribute("value")||""));
    if(!/(?:カートに入れる|カートへ入れる)/.test(label))return false;
    if(b.hasAttribute("disabled")||b.getAttribute("aria-disabled")==="true"||
       b.getAttribute("hidden")!==null)return false;
    if((b.getAttribute("class")||"").split(/\s+/).some((c:string)=>
        /^(?:disabled|is-disabled|d-none|hidden)$/.test(c)))return false;
    return true;
  });
  return {status:enabled?"available":"unknown",product:title};
}
function redirectStatus(location:string,base:string):string {
  try{return new URL(location,base).hostname===WAITING_HOST?"waiting":"redirect_blocked";}
  catch{return "redirect_blocked";}
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return new Response("Method Not Allowed",{status:405});
  const secret=Deno.env.get("NOTIFY_SECRET");
  if(!secret||req.headers.get("x-notify-secret")!==secret)
    return new Response("Unauthorized",{status:401});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return new Response("Server config missing",{status:500});
  const sb=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:target,error:targetError}=await sb.from("guerrilla_sale_monitor_targets")
    .select("enabled").eq("site_key",SITE).eq("mode","all").maybeSingle();
  if(targetError)return new Response("Target config unavailable",{status:503});
  if(!target?.enabled)return Response.json({status:"paused"});
  const {data:stored,error:stateError}=await sb.from("guerrilla_fast_state")
    .select("*").eq("site_key",SITE).maybeSingle();
  if(stateError)return new Response("Fast state unavailable",{status:503});
  const state:any=stored||{site_key:SITE,baseline_ready:false};
  if(state.cooldown_until&&Date.parse(state.cooldown_until)>Date.now())
    return Response.json({status:"cooldown",until:state.cooldown_until});

  const category=CATEGORIES[Math.floor(Date.now()/60000)%CATEGORIES.length];
  let fetchedCategory=false;
  let robotsText=String(state.robots_text||"");
  try {
    const robotAge=state.robots_checked_at?Date.now()-Date.parse(state.robots_checked_at):Infinity;
    if(!robotsText||robotAge>6*3600_000){
      const rr=await fetch(ROBOTS,{headers:{"User-Agent":UA,"Accept":"text/plain"},redirect:"manual"});
      if(rr.status!==200&&rr.status!==404)throw new Error("robots_http_"+rr.status);
      robotsText=rr.status===404?"User-agent: *\nAllow: /":await readLimited(rr);
      const {error:saveRobotsError}=await sb.from("guerrilla_fast_state").upsert({
        site_key:SITE,robots_text:robotsText,robots_checked_at:new Date().toISOString()
      });
      if(saveRobotsError)throw new Error("state_save_error");
    }
    if(!robotsAllows(robotsText,new URL(category.url).pathname))
      throw new Error("robots_denied");
    const headers={"User-Agent":UA,"Accept":"text/html"};
    // No conditional ETag shared across unrelated category URLs.
    const page=await fetch(category.url,{headers,redirect:"manual"});
    if(page.status>=300&&page.status<400)
      throw new Error(redirectStatus(page.headers.get("location")||"",category.url));
    if([403,429,500,502,503,504].includes(page.status))
      throw new Error("http_"+page.status);
    if(page.status!==200)throw new Error("catalog_http_"+page.status);

    const candidates=catalogCandidates(await readLimited(page),category);
    fetchedCategory=true;
    const baselineMap=state.category_baselines&&
      typeof state.category_baselines==="object"&&!Array.isArray(state.category_baselines)
      ?state.category_baselines:{};
    const priorMap=state.category_candidates&&
      typeof state.category_candidates==="object"&&!Array.isArray(state.category_candidates)
      ?state.category_candidates:{};
    const hadBaseline=baselineMap[category.key]===true;
    const previous=new Set(
      Array.isArray(priorMap[category.key])?priorMap[category.key].filter((x:unknown)=>typeof x==="string"):[]
    );

    const stockInfo=new Map<string,{confirmed_status:string|null;checked_at:string|null}>();
    if(candidates.length){
      const {data,error}=await sb.from("guerrilla_sale_products")
        .select("url,confirmed_status,checked_at")
        .eq("site_key",SITE)
        .in("url",candidates.map(c=>c.url));
      if(error)throw new Error("product_history_unavailable");
      for(const item of data||[])stockInfo.set(item.url,item);
    }

    const score=(row:Candidate):number=>{
      const current=stockInfo.get(row.url);
      if(hadBaseline&&!previous.has(row.url))return -2_000_000;
      if(current?.confirmed_status==="unavailable")return -1_000_000;
      return current?.checked_at?Date.parse(current.checked_at):0;
    };
    const prioritized=[...candidates].sort((a,b)=>score(a)-score(b));
    const checked=[];
    let verifiedCount=0;
    for(const candidate of prioritized.slice(0,MAX_DETAIL_CHECKS)){
      if(!robotsAllows(robotsText,new URL(candidate.url).pathname))
        throw new Error("robots_denied_detail");
      const res=await fetch(candidate.url,{headers,redirect:"manual"});
      if(res.status>=300&&res.status<400)
        throw new Error(redirectStatus(res.headers.get("location")||"",candidate.url));
      if([403,429,500,502,503,504].includes(res.status))
        throw new Error("http_"+res.status);
      if(res.status!==200)continue;
      const verified=detailVerification(await readLimited(res),candidate.notification_kind);
      if(verified.status!=="unknown")verifiedCount++;
      checked.push({
        ...candidate,
        id:await sha256(SITE+"|"+candidate.url),
        site_key:SITE,
        product:verified.product||candidate.product,
        status:verified.status,
        scopes:["fast_official_detail"],
        notify_new:hadBaseline&&!previous.has(candidate.url),
        notification_eligible:true,
        cooldown_minutes:60
      });
    }
    let emitted=0;
    if(checked.length){
      const {data,error}=await sb.rpc("guerrilla_sale_observe",{p_rows:checked});
      if(error)throw new Error("observe_failed");
      emitted=Number(data||0);
    }
    const timestamp=new Date().toISOString();
    const {error:saveError}=await sb.from("guerrilla_fast_state").upsert({
      site_key:SITE,
      category_baselines:{...baselineMap,[category.key]:true},
      category_candidates:{...priorMap,[category.key]:candidates.map(c=>c.url)},
      baseline_ready:true,
      cooldown_until:null,
      last_status:verifiedCount>0?"ok":"catalog_only",
      last_run_at:timestamp,
      ...(verifiedCount>0?{last_success_at:timestamp}:{}),
      last_product_count:verifiedCount,
      last_error:null,
      etag:null,last_modified:null
    });
    if(saveError)throw new Error("state_save_error");

    if(emitted>0){
      await fetch(url+"/functions/v1/guerrilla-push",{
        method:"POST",headers:{"Content-Type":"application/json","x-notify-secret":secret},
        body:JSON.stringify({type:"DRAIN"})
      }).catch(()=>{});
    }
    return Response.json({status:verifiedCount>0?"ok":"catalog_only",category:category.key,
      candidates:candidates.length,detail_checked:checked.length,
      officially_verified:verifiedCount,emitted,baseline_before:hadBaseline});
  }catch(error) {
    const msg=String((error as Error)?.message||error).slice(0,180);
    const waiting=msg==="waiting";
    const hard=/^http_(?:403|429|500|502|503|504)$|robots_|blocked|redirect_blocked/.test(msg);
    const now=new Date().toISOString();
    await sb.from("guerrilla_fast_state").update({
      last_status:waiting?"waiting":"error",
      last_run_at:now,last_error:msg,
      cooldown_until:cooldown(waiting?15:hard?30:5)
    }).eq("site_key",SITE);
    return Response.json({status:waiting?"waiting":"error",
      category:category.key,catalog_reached:fetchedCategory,error:msg});
  }
});