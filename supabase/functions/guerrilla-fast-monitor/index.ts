
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.18.12";

const SITE="amenity";
const CATALOG="https://www.amenitydream.com/product-list";
const ROBOTS="https://www.amenitydream.com/robots.txt";
const HOST="www.amenitydream.com";
const UA="TorecaRadarFastMonitor/1.0";
const MAX_BYTES=2_000_000;

const CARD_CONTEXT=/(?:カードゲーム|TCG|OCG|ポケモンカード|ポケカ|ONE\s*PIECE|ワンピース|遊戯王|デュエル[・\s-]*マスターズ|UNION\s*ARENA|ユニオンアリーナ|ガンダムカード|ヴァンガード|hololive\s*OFFICIAL\s*CARD\s*GAME|ホロライブ|Xross\s*Stars|マジック[：:・\s-]*ザ[・\s-]*ギャザリング|\bMTG\b|Flesh\s*and\s*Blood|Lycee|ヴァイスシュヴァルツ|Reバース|ドラゴンボール|バトルスピリッツ|Disney\s*Lorcana|ロルカナ)/i;
const SEALED_PACK=/(?:強化拡張パック|拡張パック|ハイクラスパック|ブースターパック|エクストラブースター|コレクターブースター|ブースターBOX|ブースターボックス|BOX|ボックス)/i;
const SEALED_DECK=/(?:スターターデッキ|スタートデッキ|スターターセット|構築済みデッキ|構築デッキ|スペシャルデッキセット|プレミアムデッキセット|アルティメットデッキ)/i;
const EXCLUDE=/(?:\(予約\)|（予約）|予約商品|予約受付|デッキケース|カードケース|スリーブ|プレイマット|ストレージ|ローダー|サプライ|シングルカード|オリパ|福袋|\d+枚セット|枚セット\b)/i;
const SINGLE=/^\s*[（(]?[^】\]]*[）)]?\s*【(?:C|U|R|RR|RRR|SR|UR|HR|AR|SAR|SEC|PR|P|☆パラレル|パラレル|ミラー)】/i;

const clean=(v:any)=>String(v??"").replace(/\s+/g," ").trim();

function kind(text:string){
  if(!text||EXCLUDE.test(text)||SINGLE.test(text)||!CARD_CONTEXT.test(text)) return "";
  // An individual card can mention BOX or a deck in its set name.
  // The stock unit is stronger evidence than those product keywords.
  if(/在庫数\s*[:：]?\s*[\d,]+\s*枚/.test(text)) return "";
  if(SEALED_PACK.test(text)) return "pack";
  if(SEALED_DECK.test(text)) return "deck";
  return "";
}
function robotsAllows(text:string,path:string){
  const lines=text.split(/\r?\n/).map(x=>x.trim());
  let applies=false;
  for(const line of lines){
    if(!line||line.startsWith("#")) continue;
    const m=line.match(/^User-agent:\s*(.+)$/i);
    if(m){const ua=m[1].trim().toLowerCase();applies=(ua==="*"||ua===UA.toLowerCase());continue;}
    if(!applies) continue;
    const d=line.match(/^Disallow:\s*(.*)$/i);
    if(d){
      const rule=d[1].trim();
      if(rule&&path.startsWith(rule.replace(/\*.*$/,""))) return false;
    }
  }
  return true;
}
async function sha256(text:string){
  const bytes=new TextEncoder().encode(text);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function productUrl(raw:string){
  try{
    const u=new URL(raw,CATALOG);
    if(u.protocol!=="https:"||u.hostname!==HOST||!/^\/product\/\d+$/.test(u.pathname.replace(/\/$/,"")))return "";
    return "https://"+HOST+u.pathname.replace(/\/$/,"");
  }catch{return "";}
}
function parseCatalog(html:string){
  const {document}=parseHTML(html);
  const title=clean(document.querySelector("title")?.textContent).toLowerCase();
  if(/access denied|captcha|just a moment|アクセス制限/.test(title)) throw new Error("blocked");
  const map=new Map<string,{url:string,product:string,status:string,notification_kind:string}>();
  for(const a of [...document.querySelectorAll("a[href]")]){
    const url=productUrl(a.getAttribute("href")||"");
    if(!url) continue;
    let node:any=a;
    let scope:any=a;
    for(let i=0;i<7&&node;i++){
      const links=[...node.querySelectorAll?.("a[href]")||[]].map((x:any)=>productUrl(x.getAttribute("href")||"")).filter(Boolean);
      if(new Set(links).size>1) break;
      scope=node; node=node.parentElement;
    }
    const text=clean(scope?.textContent||a.textContent||"");
    const alt=[...a.querySelectorAll("img")].map((x:any)=>clean(x.getAttribute("alt"))).filter(Boolean).sort((x,y)=>y.length-x.length)[0]||"";
    const anchor=clean(a.textContent||"");
    const product=[text,anchor,alt].sort((x,y)=>y.length-x.length)[0].slice(0,500);
    const k=kind(product);
    if(!k) continue;
    const stocks=[...product.matchAll(/在庫数\s*[:：]?\s*([\d,]+)\s*(?:点|個|枚|箱|パック|セット)/g)].map(x=>Number(x[1].replace(/,/g,"")));
    const neg=stocks.includes(0)||/(在庫なし|在庫切れ|品切れ|sold out|販売終了)/i.test(product);
    const pos=stocks.some(x=>x>0);
    const status=pos&&!neg?"available":neg&&!pos?"unavailable":"unknown";
    if(status==="unknown") continue;
    map.set(url,{url,product,status,notification_kind:k});
  }
  return [...map.values()].slice(0,80);
}
async function readLimited(res:Response){
  const buf=await res.arrayBuffer();
  if(buf.byteLength>MAX_BYTES) throw new Error("response_too_large");
  return new TextDecoder().decode(buf);
}
function cooldown(minutes:number){return new Date(Date.now()+minutes*60000).toISOString();}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return new Response("Method Not Allowed",{status:405});
  const secret=Deno.env.get("NOTIFY_SECRET");
  if(!secret||req.headers.get("x-notify-secret")!==secret)return new Response("Unauthorized",{status:401});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return new Response("Server config missing",{status:500});
  const sb=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});

  const {data:target,error:targetError}=await sb.from("guerrilla_sale_monitor_targets")
    .select("enabled").eq("site_key",SITE).eq("mode","all").maybeSingle();
  if(targetError) return new Response("Target config unavailable",{status:503});
  if(!target?.enabled) return Response.json({status:"paused"});

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
      if(rr.status!==200&&rr.status!==404) throw new Error("robots_http_"+rr.status);
      robotsText=rr.status===404?"User-agent: *\nAllow: /":await readLimited(rr);
      if(!robotsAllows(robotsText,"/product-list")) throw new Error("robots_denied");
      await sb.from("guerrilla_fast_state").upsert({
        site_key:SITE,robots_text:robotsText,robots_checked_at:new Date().toISOString()
      });
    }else if(!robotsAllows(robotsText,"/product-list")) throw new Error("robots_denied");

    const headers:any={"User-Agent":UA,"Accept":"text/html"};
    if(state.etag)headers["If-None-Match"]=state.etag;
    if(state.last_modified)headers["If-Modified-Since"]=state.last_modified;
    const res=await fetch(CATALOG,{headers,redirect:"manual"});
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
    const html=await readLimited(res);
    const rows=parseCatalog(html);
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
    return Response.json({status:"ok",sealed_products:rows.length,emitted,baseline_before:baseline});
  }catch(err){
    const msg=String((err as Error)?.message||err).slice(0,300);
    const hard=/robots_denied|robots_http_|blocked/.test(msg);
    await sb.from("guerrilla_fast_state").update({
      last_status:"error",last_run_at:new Date().toISOString(),last_error:msg,cooldown_until:hard?cooldown(60):cooldown(5)
    }).eq("site_key",SITE);
    return new Response(JSON.stringify({status:"error",error:msg}),{status:200,headers:{"Content-Type":"application/json"}});
  }
});

