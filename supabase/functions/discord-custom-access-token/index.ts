import {createClient} from 'npm:@supabase/supabase-js@2.95.0';
import {Webhook} from 'npm:standardwebhooks@1.1.1';
import {snowflake,roles,isHookEvent,discordId,permitted,
  uuid,REMEMBER_MS,rememberedSessionAllowed,authorizedClaims} from './policy.mjs';

// HTTP Auth Hook: runs BEFORE a Supabase Auth access token is issued.
// Only enable in Authentication > Hooks after configuring the signing secret.
// Service credentials and the Discord Bot token never reach the browser.
function json(body,status=200){
 return new Response(JSON.stringify(body),{status,
   headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
function deny(message,status=403){
 return json({error:{http_code:status,message}},status);
}
function adminKey(){
 try{
   const all=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
   if(typeof all.default==='string'&&all.default.startsWith('sb_secret_'))
     return all.default;
 }catch{}
 return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
}
function verify(body,headers,secret){
 if(typeof secret!=='string')throw Error('no secret');
 const keys=secret.split('|').filter(s=>s.startsWith('v1,whsec_'));
 if(!keys.length)throw Error('no secret');
 for(const key of keys){
   try{return new Webhook(key.slice(3)).verify(body,headers)}
   catch{/* rotated signing keys are tried independently */}
 }
 throw Error('signature invalid');
}
async function bounded(promise,ms){
 let t;
 try{return await Promise.race([promise,new Promise((_,reject)=>{
   t=setTimeout(()=>reject(Error('timeout')),ms);
 })])}finally{clearTimeout(t)}
}
Deno.serve(async req=>{
 if(req.method!=='POST')return deny('Method not allowed',405);
 const secret=Deno.env.get('DISCORD_ACCESS_TOKEN_HOOK_SECRET');
 if(!secret)return deny('Hook signature not configured',503);
 const raw=await req.text().catch(()=>'');
 if(!raw||raw.length>30000)return deny('Invalid payload',400);
 let event;
 try{event=verify(raw,Object.fromEntries(req.headers),secret)}
 catch{return deny('Invalid hook signature',401)}
 if(!isHookEvent(event))return deny('Discord account required',403);

 const url=Deno.env.get('SUPABASE_URL')||'';
 const key=adminKey();
 const bot=Deno.env.get('DISCORD_BOT_TOKEN')||'';
 const guild=Deno.env.get('DISCORD_GUILD_ID')||'1551557658618896444';
 const allowed=roles(Deno.env.get('DISCORD_ALLOWED_ROLE_IDS')||
   '1565321684603637890');
 if(!url||!key||!bot||!snowflake(guild)||!allowed.length)
   return deny('Discord verification unavailable',503);
 const admin=createClient(url,key,{auth:{
   persistSession:false,autoRefreshToken:false
 }});
 // Only a freshly confirmed session (or the same one renewing its token)
 // can use the fourteen-day grant. Another OAuth login always checks Discord.
 const sessionId=event.claims?.session_id;
 if(!uuid(sessionId))return deny('Invalid login session',403);
 if(!['oauth','oauth_provider/authorization_code','token_refresh']
       .includes(event.authentication_method))
   return deny('Discord OAuth is required',403);

 const table='discord_remembered_sessions_v1';
 let cached=null;
 try{
   const {data,error}=await bounded(admin.from(table)
     .select('session_id,user_id,authorized_until')
     .eq('session_id',sessionId).maybeSingle(),1000);
   if(error)return deny('Session authorization unavailable',503);
   cached=data;
 }catch{return deny('Session authorization unavailable',503)}
 if(rememberedSessionAllowed(event,cached)){
   return json({claims:authorizedClaims(event.claims,cached.authorized_until)});
 }

 // Identity comes from trusted Supabase Auth admin data, not user_metadata.
 // Never write to auth.users during a token hook; that can lock the flow.
 let identity;
 try{
   const response=await bounded(admin.auth.admin.getUserById(event.user_id),2300);
   if(response.error||response.data?.user?.id!==event.user_id)
     return deny('Discord identity unavailable',503);
   identity=discordId(response.data.user.identities);
 }catch{return deny('Discord identity unavailable',503)}
 if(!identity)return deny('Discord role required',403);
 try{
   const result=await fetch(
     `https://discord.com/api/v10/guilds/${guild}/members/${identity}`,
     {headers:{Authorization:`Bot ${bot}`},
      signal:AbortSignal.timeout(2200)}
   );
   if(result.status===404)return deny('Discord role required',403);
   if(!result.ok)return deny('Discord verification unavailable',503);
   const member=await result.json();
   if(!permitted(member,allowed))return deny('Discord role required',403);
 }catch{return deny('Discord verification unavailable',503)}
 // A successful, freshly checked login starts (or renews) a two-week period
 // during which token refreshes reuse this SAME server-authorized session.
 // A new login uses a new session UUID and must pass Discord verification.
 const authorizedUntil=new Date(Date.now()+REMEMBER_MS).toISOString();
 try{
   const {error}=await bounded(admin.from(table).upsert({
     session_id:sessionId,user_id:event.user_id,
     authorized_at:new Date().toISOString(),authorized_until:authorizedUntil
   },{onConflict:'session_id'}),1400);
   if(error)return deny('Session authorization unavailable',503);
 }catch{return deny('Session authorization unavailable',503)}
 // Keep every required Supabase claim, adding only the server-issued expiry.
 return json({claims:authorizedClaims(event.claims,authorizedUntil)});
});
