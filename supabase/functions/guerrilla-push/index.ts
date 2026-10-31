
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_URL = "https://ttttt-9554.github.io/pokeca-map/";
const sleep = (ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

async function sendOne(supabase:any, sub:any, event:any, vapid:any) {
  webpush.setVapidDetails(vapid.subject, vapid.public_key, vapid.private_key);
  const unconfirmed = event?.kind === "reported_unconfirmed";
  const state = unconfirmed ? "販売情報（未確認）"
    : event?.kind === "restock" ? "販売再開" : "新規販売";
  const payload = JSON.stringify({
    title: unconfirmed ? "⚠️ ポケセン販売情報・未確認" : "⚡ " + state + "を検知",
    body: unconfirmed
      ? ("独立した複数の販売報告があります。公式サイトの在庫は未確認です。 "
          + String(event?.product || "ポケモンカード商品")).slice(0,220)
      : String(event?.product || "トレカ商品").slice(0,220),
    icon: APP_URL + "icon-192.png?v=20261024-toreca-radar-icon",
    badge: APP_URL + "icon-192.png?v=20261024-toreca-radar-icon",
    url: event?.url || APP_URL,
    tag: "sale-" + String(event?.id || "notice"),
    site: event?.site_key || "",
    state
  });
  return await webpush.sendNotification(
    {endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},
    payload,
    {TTL:unconfirmed ? 180 : 90,urgency:"high"}
  );
}

Deno.serve(async (req:Request)=>{
  if(req.method!=="POST") return new Response("Method Not Allowed",{status:405});
  const secret=Deno.env.get("NOTIFY_SECRET");
  if(!secret || req.headers.get("x-notify-secret")!==secret) return new Response("Unauthorized",{status:401});

  const supabaseUrl=Deno.env.get("SUPABASE_URL");
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!serviceKey) return new Response("Server config missing",{status:500});
  const supabase=createClient(supabaseUrl,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});

  const {data:configs,error:configError}=await supabase.rpc("guerrilla_push_server_config");
  if(configError || !configs?.[0]) return new Response("Push config missing",{status:500});
  const vapid=configs[0];

  let payload:any={};
  try{payload=await req.json();}catch{}

  if(payload.type==="TEST"){
    const {data:subs,error}=await supabase.from("guerrilla_push_subscriptions")
      .select("id,endpoint,p256dh,auth").eq("enabled",true).order("updated_at",{ascending:false}).limit(5);
    if(error) return new Response("Subscription load failed",{status:500});
    let sent=0,expired=0;
    for(const sub of subs||[]){
      try{
        await sendOne(supabase,sub,{id:"test",kind:"new_product",product:"Toreca Radar Pushテスト",url:APP_URL},vapid);
        sent++;
      }catch(err){
        const code=Number((err as any)?.statusCode||0);
        console.error("Push test error",JSON.stringify({code,body:String((err as any)?.body||"").slice(0,300)}));
        if(code===404||code===410){
          await supabase.from("guerrilla_push_subscriptions").update({enabled:false,updated_at:new Date().toISOString()}).eq("id",sub.id);
          expired++;
        } else {
          return new Response(JSON.stringify({sent,expired,error_code:code,error_body:String((err as any)?.body||"").slice(0,300)}),{status:502,headers:{"Content-Type":"application/json"}});
        }
      }
    }
    return new Response(JSON.stringify({sent,expired}),{status:200,headers:{"Content-Type":"application/json"}});
  }

  const {data:jobs,error:claimError}=await supabase.rpc("guerrilla_sale_claim_push_notifications",{p_limit:10});
  if(claimError) return new Response("Queue unavailable",{status:503});
  let sent=0,retry=0,expired=0;
  for(const job of jobs||[]){
    let errorMessage:string|null=null;
    try{
      const [{data:event,error:eventError},{data:sub,error:subError}]=await Promise.all([
        supabase.from("guerrilla_sale_events").select("id,site_key,url,product,kind,detected_at").eq("id",job.event_id).maybeSingle(),
        supabase.from("guerrilla_push_subscriptions").select("id,endpoint,p256dh,auth,enabled").eq("id",job.subscription_id).maybeSingle()
      ]);
      if(eventError) throw eventError;
      if(subError) throw subError;
      if(!event || !sub || !sub.enabled){
        expired++;
      }else{
        try{
          await sendOne(supabase,sub,event,vapid);
          sent++;
        }catch(err){
          const code=Number((err as any)?.statusCode||0);
          if(code===404||code===410){
            await supabase.from("guerrilla_push_subscriptions").update({enabled:false,updated_at:new Date().toISOString()}).eq("id",sub.id);
            expired++;
          }else throw err;
        }
      }
    }catch(err){
      errorMessage=String(err).slice(0,400); retry++;
      console.error("Push delivery failed",errorMessage);
    }
    await supabase.rpc("guerrilla_sale_settle_push_notification",{
      p_event_id:job.event_id,p_subscription_id:job.subscription_id,p_attempts:job.attempts,
      p_sent:errorMessage===null,p_error:errorMessage,p_retry_seconds:Math.min(3600,Math.max(60,60*(2**Math.min(job.attempts-1,6))))
    });
    await sleep(50);
  }
  return new Response(JSON.stringify({claimed:(jobs||[]).length,sent,retry,expired}),{status:200,headers:{"Content-Type":"application/json"}});
});
