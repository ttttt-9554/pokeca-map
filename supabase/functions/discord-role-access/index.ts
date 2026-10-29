import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { allowedRoleIds, discordIdentityId, hasAccess, snowflake } from "./access-utils.mjs";

// Preparation phase: no existing Supabase policies or application navigation
// are changed by deploying this endpoint. It fails closed until all the
// server-only DISCORD_* secrets are set and the Discord guild/role is verified.
// DO NOT move DISCORD_BOT_TOKEN or Supabase secret keys into app.js.
const ACCESS_SECONDS=120;
const DISCORD_TIMEOUT_MS=7000;

function getSecretKey(){
  try {
    const json=Deno.env.get("SUPABASE_SECRET_KEYS");
    const key=json && JSON.parse(json)?.default;
    if(typeof key==="string"&&key.startsWith("sb_secret_"))return key;
  }catch{/* fall back to legacy service role */}
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
}
function corsFor(req:Request){
  const origin=req.headers.get("Origin");
  const raw=Deno.env.get("APP_ALLOWED_ORIGINS") || "https://ttttt-9554.github.io";
  const list=raw.split(/[\s,]+/).map(x=>x.trim()).filter(Boolean);
  if(origin && !list.includes(origin)) return null;
  return {
    ...(origin?{"Access-Control-Allow-Origin":origin}:{}),
    "Vary":"Origin",
    "Access-Control-Allow-Methods":"POST, OPTIONS",
    "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "Cache-Control":"no-store, private",
  };
}
function json(body:Record<string,unknown>,status:number,headers:Record<string,string>){
  return new Response(JSON.stringify(body),{status,headers:{...headers,"Content-Type":"application/json; charset=utf-8"}});
}

Deno.serve(async(req:Request)=>{
  const headers=corsFor(req);
  if(!headers) return new Response(null,{status:403,headers:{"Cache-Control":"no-store"}});
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
  if(req.method!=="POST")return json({error:"method_not_allowed"},405,headers);

  const url=Deno.env.get("SUPABASE_URL")||"";
  const serviceKey=getSecretKey();
  // The owner-provided ID is a public Discord snowflake, not a secret.
  const guildId=Deno.env.get("DISCORD_GUILD_ID")||"1551557658618896444";
  const allowedRoles=allowedRoleIds(Deno.env.get("DISCORD_ALLOWED_ROLE_IDS")||"1565321684603637890");
  const botToken=Deno.env.get("DISCORD_BOT_TOKEN")||"";
  // No role ID or token? Deny. Never silently allow all Discord accounts.
  if(!url||!serviceKey||!snowflake(guildId)||!allowedRoles.length||!botToken)
    return json({allowed:false,error:"not_configured"},503,headers);
  const authorization=req.headers.get("Authorization")||"";
  const match=/^Bearer\s+([^\s]+)$/i.exec(authorization);
  if(!match||match[1].length>8192)
    return json({allowed:false,error:"login_required"},401,headers);

  const admin=createClient(url,serviceKey,{
    auth:{persistSession:false,autoRefreshToken:false}
  });
  // Auth-service validation (NOT browser-supplied Discord IDs, claims or roles).
  let userId:string;
  let discordId:string|null;
  try{
    const {data,error}=await admin.auth.getUser(match[1]);
    if(error||!data?.user?.id)return json({allowed:false,error:"login_required"},401,headers);
    userId=data.user.id;
    const lookup=await admin.auth.admin.getUserById(userId);
    if(lookup.error||!lookup.data?.user)
      return json({allowed:false,error:"identity_unavailable"},503,headers);
    discordId=discordIdentityId(lookup.data.user.identities);
  }catch{
    return json({allowed:false,error:"identity_unavailable"},503,headers);
  }

  const revoke=async()=>{
    // Best effort: stale tokens expire after at most ACCESS_SECONDS.
    try{await admin.from("discord_role_access_v1").delete().eq("user_id",userId);}catch{/* no credential logging */}
  };
  if(!discordId){
    await revoke();
    return json({allowed:false,error:"discord_login_required"},403,headers);
  }

  let member:unknown;
  try {
    const response=await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      {headers:{"Authorization":`Bot ${botToken}`},signal:AbortSignal.timeout(DISCORD_TIMEOUT_MS)}
    );
    if(response.status===404){
      await revoke();
      return json({allowed:false,error:"role_required"},403,headers);
    }
    if(!response.ok){
      await revoke();
      return json({allowed:false,error:"role_check_unavailable"},503,headers);
    }
    member=await response.json();
  }catch{
    await revoke();
    return json({allowed:false,error:"role_check_unavailable"},503,headers);
  }
  if(!hasAccess(member,allowedRoles)){
    await revoke();
    return json({allowed:false,error:"role_required"},403,headers);
  }
  // Only a service-role client can grant this short-lived backend access.
  const validUntil=new Date(Date.now()+ACCESS_SECONDS*1000).toISOString();
  try {
    const {error}=await admin.from("discord_role_access_v1").upsert({
      user_id:userId,valid_until:validUntil,verified_at:new Date().toISOString()
    },{onConflict:"user_id"});
    if(error)return json({allowed:false,error:"access_store_unavailable"},503,headers);
  }catch{
    return json({allowed:false,error:"access_store_unavailable"},503,headers);
  }
  return json({allowed:true,valid_for_seconds:ACCESS_SECONDS},200,headers);
});
