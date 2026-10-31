
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.18.12";

const SITE="pokemon";
const CATALOG="https://www.pokemoncenter-online.com/pokemon-card-game/";
const ROBOTS="https://www.pokemoncenter-online.com/robots.txt";
const HOST="www.pokemoncenter-online.com";
const WAITING_HOST="wr.pokemoncenter-online.com";
const UA="TorecaRadarFastMonitor/1.0";
const MAX_BYTES=2_000_000;

const POKECARD=/(?:ポケモンカードゲーム|ポケモンカード|ポケカ)/i;
const PACK=/(?:強化拡張パック|拡張パック|ハイクラスパック|ブースターパック|ブースターBOX|ブースターボックス|BOX|ボックス)/i;
const DECK=/(?:スターターデッキ|スタートデッキ|構築済みデッキ|構築デッキ|スペシャルデッキセット|プレミアムデッキセット)/i;
const EXCLUDE=/(?:予約|抽選|デッキケース|カードケース|スリーブ|プレイマット|ストレージ|ローダー|サプライ|ぬいぐるみ|フィギュア|キーホルダー|ステッカー|シール|タオル|文具|アパレル|バッグ|シングルカード|オリパ|福袋)/i;

const clean=(v:any)=>String(v??"").replace(/\s+/g," ").trim();
function productKind(text:string){
  if(!text||!POKECARD.test(text)||EXCLUDE.test(text))return "";
  if(PACK.test(text))return "pack";
  if(DECK.test(text))return "deck";
  return "";
}
function productUrl(raw:string){
  try{
    const u=new URL(raw,CATALOG);
    if(u.protocol!=="https:"||u.hostname!==HOST||!/^\/[0-9]{6,20}(?:-[A-Za-z0-9_-]+)?\.html$/.test(u.pathname.replace(/\/$/,"")))return "";
    if([...u.searchParams.keys()].some(k=>k.startsWith("dwvar_")))return "";
    return "https://"+HOST+u.pathname.replace(/\/$/,"");
  }catch{return "";}
}
async function sha256(text:string){
  const bytes=new TextEncoder().encode(text);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function robotsAllows(text:string,path:string){
  const lines=text.split(/\r?\n/).map(x=>x.trim());
  let applies=false;
  for(const line of lines){
    if(!line||line.startsWith("#"))continue;
    const u=line.match(/^User-agent:\s*(.+)$/i);
    if(u){const ua=u[1].trim().toLowerCase();applies=(ua==="*"||ua===UA.toLowerCase());continue;}
    if(!applies)continue;
    const d=line.match(/^Disallow:\s*(.*)$/i);
    if(d){
      const rule=d[1].trim();
      if(rule&&path.startsWith(rule.replace(/\*.*$/,"")))return false;
    }
  }
  return true;
}
async function readLimited(res:Response){
  const buf=await res.arrayBuffer();
  if(buf.byteLength>MAX_BYTES)throw new Error("response_too_large");
  return new TextDecoder().decode(buf);
}
function cooldown(minutes:number){return new Date(Date.now()+minutes*60000).toISOString();}

function parseCatalog(html:string){
  const {document}=parseHTML(html);
  const title=clean(document.querySelector("title")?.textContent).toLowerCase();
  if(/仮想待合室|waiting room|queue-it/.test(title))throw new Error("waiting");
  if(/access denied|captcha|just a moment|アクセス制限/.test(title))throw new Error("blocked");

  const out=new Map<string,{url:string,product:string,status:string,notification_kind:string}>();
  for(const a of [...document.querySelectorAll("a[href]")]){
    const url=productUrl(a.getAttribute("href")||"");
    if(!url)continue;
    let scope:any=a;
    let node:any=a;
    for(let i=0;i<7&&node;i++){
      const links=[...node.querySelectorAll?.("a[href]")||[]].map((x:any)=>productUrl(x.getAttribute("href")||"")).filter(Boolean);
      if(new Set(links).size>1)break;
      scope=node; node=node.parentElement;
    }
    const text=clean(scope?.textContent||a.textContent||"");
    const alt=[...a.querySelectorAll("img")].map((x:any)=>clean(x.getAttribute("alt"))).filter(Boolean).sort((x,y)=>y.length-x.length)[0]||"";
    const product=[text,clean(a.textContent||""),alt].sort((x,y)=>y.length-x.length)[0].slice(0,500);
    const k=productKind(product);
    if(!k)continue;

    const negative=/(在庫なし|在庫切れ|品切れ|sold out|販売終了)/i.test(product);
    const positive=[...scope.querySelectorAll?.("button,input")||[]].some((el:any)=>{
      if(el.hasAttribute?.("disabled")||el.getAttribute?.("aria-disabled")==="true")return false;
      const label=clean((el.textContent||"")+" "+(el.getAttribute?.("value")||""));
      return /(カートに入れる|カートへ入れる)/.test(label);
    });
    const status=positive&&!negative?"available":negative&&!positive?"unavailable":"unknown";
    if(status==="unknown")continue;
    out.set(url,{url,product,status,notification_kind:k});
  }
  return [...out.values()].slice(0,80);
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return new Response("Method Not Allowed",{status:405});
  const secret=Deno.env.get("NOTIFY_SECRET");
  if(!secret||req.headers.get("x-notify-secret")!==secret)return new Response("Unauthorized",{status:401});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return new Response("Server config missing",{status:500});
  const sb=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});

  const {data:target,error:targetError}=await sb.from("guerrilla_sale_monitor_targets")
    .select("enabled").eq("site_key",SITE).eq("mode","all").maybeSingle();
  if(targetError)return new Response("Target config unavailable",{status:503});
  if(!target?.enabled)return Response.json({status:"paused"});

  const {data:stateRow,error:stateError}=await sb.from("guerrilla_fast_state").select("*").eq("site_key",SITE).maybeSingle();
  if(stateError)return new Response("Fast state unavailable",{status:503});
  const state=stateRow||{site_key:SITE,baseline_ready:false};
  if(state.cooldown_until&&Date.parse(state.cooldown_until)>Date.now()){
    return Response.json({status:"cooldown",until:state.cooldown_until});
  }

  try{
    let robotsText=String(state.robots_text||"");
    const robotsAge=state.robots_checked_at?Date.now()-Date.parse(state.robots_checked_at):Infinity;
    if(!robotsText||robotsAge>6*3600_000){
      const rr=await fetch(ROBOTS,{headers:{"User-Agent":UA,"Accept":"text/plain"},redirect:"manual"});
      if(rr.status!==200&&rr.status!==404)throw new Error("robots_http_"+rr.status);
      robotsText=rr.status===404?"User-agent: *\nAllow: /":await readLimited(rr);
      if(!robotsAllows(robotsText,"/pokemon-card-game/"))throw new Error("robots_denied");
      await sb.from("guerrilla_fast_state").upsert({site_key:SITE,robots_text:robotsText,robots_checked_at:new Date().toISOString()});
    }else if(!robotsAllows(robotsText,"/pokemon-card-game/"))throw new Error("robots_denied");

    const headers:any={"User-Agent":UA,"Accept":"text/html"};
    if(state.etag)headers["If-None-Match"]=state.etag;
    if(state.last_modified)headers["If-Modified-Since"]=state.last_modified;
    const res=await fetch(CATALOG,{headers,redirect:"manual"});

    if(res.status>=300&&res.status<400){
      const loc=res.headers.get("location")||"";
      let waiting=false;
      try{waiting=new URL(loc,CATALOG).hostname===WAITING_HOST;}catch{}
      const status=waiting?"waiting":"redirect_blocked";
      await sb.from("guerrilla_fast_state").update({
        last_status:status,last_run_at:new Date().toISOString(),last_error:status,
        cooldown_until:cooldown(waiting?15:60)
      }).eq("site_key",SITE);
      return Response.json({status});
    }
    if(res.status===304){
      await sb.from("guerrilla_fast_state").update({last_status:"not_modified",last_run_at:new Date().toISOString(),last_error:null}).eq("site_key",SITE);
      return Response.json({status:"not_modified"});
    }
    if([403,429,500,502,503,504].includes(res.status)){
      await sb.from("guerrilla_fast_state").update({
        last_status:"http_"+res.status,last_run_at:new Date().toISOString(),last_error:"http_"+res.status,cooldown_until:cooldown(15)
      }).eq("site_key",SITE);
      return Response.json({status:"backoff",code:res.status});
    }
    if(res.status<200||res.status>=300)throw new Error("http_"+res.status);

    const rows=parseCatalog(await readLimited(res));
    // A rendered page with zero verifiable products is not a monitored baseline.
    // Reject it rather than falsely reporting success or silently missing sales.
    if(!rows.length)throw new Error("catalog_no_verified_products");
    const baseline=Boolean(state.baseline_ready);
    const observed=[];
    for(const row of rows){
      observed.push({
        ...row,id:await sha256(SITE+"|"+row.url),site_key:SITE,scopes:["fast_front"],
        notify_new:baseline,notification_eligible:true,cooldown_minutes:60
      });
    }
    let emitted=0;
    if(observed.length){
      const {data,error}=await sb.rpc("guerrilla_sale_observe",{p_rows:observed});
      if(error)throw new Error("observe_"+error.message);
      emitted=Number(data||0);
    }
    await sb.from("guerrilla_fast_state").upsert({
      site_key:SITE,baseline_ready:true,etag:res.headers.get("etag"),last_modified:res.headers.get("last-modified"),
      cooldown_until:null,last_status:"ok",last_run_at:new Date().toISOString(),last_success_at:new Date().toISOString(),
      last_product_count:rows.length,last_error:null
    });
    if(emitted>0){
      await fetch(url+"/functions/v1/guerrilla-push",{
        method:"POST",headers:{"Content-Type":"application/json","x-notify-secret":secret},
        body:JSON.stringify({type:"DRAIN"})
      });
    }
    return Response.json({status:"ok",pokemon_card_products:rows.length,emitted,baseline_before:baseline});
  }catch(err){
    const msg=String((err as Error)?.message||err).slice(0,300);
    const hard=/robots_denied|robots_http_|blocked/.test(msg);
    await sb.from("guerrilla_fast_state").update({
      last_status:"error",last_run_at:new Date().toISOString(),last_error:msg,cooldown_until:hard?cooldown(60):cooldown(5)
    }).eq("site_key",SITE);
    return Response.json({status:"error",error:msg});
  }
});
