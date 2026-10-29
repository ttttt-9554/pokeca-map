#!/usr/bin/env node
'use strict';
// Simulate the deployed HTTP Auth Hook with signed payloads and a server-side
// session store. The Discord fetch must only happen on NEW logins or after
// the fourteen-day session authorization expires.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
(async()=>{
 const root=path.join(__dirname,'..');
 const policy=await import(pathToFileURL(path.join(root,
   'supabase/functions/discord-custom-access-token/policy.mjs')).href);
 const source=fs.readFileSync(path.join(root,
   'supabase/functions/discord-custom-access-token/index.ts'),'utf8');
 const start=source.indexOf('// HTTP Auth Hook:');
 assert(start>=0);
 const uid='22222222-2222-4222-8222-222222222222';
 const id='123456789012345678',role='1565321684603637890';
 const sessions=new Map();
 let handler,memberRequests=0,identityRequests=0,signatures=0,memberRoles=[role];
 class Webhook {
   constructor(secret){assert.equal(secret,'whsec_test_secret');}
   verify(payload,headers){
     signatures++;
     if(headers['webhook-signature']!=='v1,test')throw Error('Bad signature');
     return JSON.parse(payload);
   }
 }
 const admin={
   auth:{admin:{getUserById:async user=>{
     identityRequests++;
     return {data:{user:{id:user,identities:[
       {provider:'discord',identity_data:{provider_id:id}}]}},error:null};
   }}},
   from:table=>{
     assert.equal(table,'discord_remembered_sessions_v1');
     return {
       select:()=>({eq:(field,session)=>{
         assert.equal(field,'session_id');
         return {maybeSingle:async()=>({data:sessions.get(session)||null,error:null})};
       }}),
       upsert:async row=>{
         sessions.set(row.session_id,{...row});
         return {error:null};
       }
     };
   }
 };
 const env=new Map([
   ['DISCORD_ACCESS_TOKEN_HOOK_SECRET','v1,whsec_test_secret'],
   ['DISCORD_BOT_TOKEN','bot-test-secret'],
   ['SUPABASE_URL','https://project.example.supabase.co'],
   ['SUPABASE_SECRET_KEYS',JSON.stringify({default:'sb_secret_testing'})]
 ]);
 const sandbox={
   Deno:{env:{get:k=>env.get(k)},serve:fn=>{handler=fn}},
   Webhook,createClient:()=>admin,
   ...policy,
   fetch:async(url,options)=>{
     memberRequests++;
     assert(url.includes('/guilds/1551557658618896444/members/'+id));
     assert.equal(options.headers.Authorization,'Bot bot-test-secret');
     return {ok:true,status:200,json:async()=>({roles:memberRoles,pending:false})};
   },
   AbortSignal,Response,setTimeout,clearTimeout,Date
 };
 vm.runInNewContext(source.slice(start),sandbox,{timeout:1000});
 assert.equal(typeof handler,'function');
 const event=(method,session)=>({
   user_id:uid,authentication_method:method,claims:{
     sub:uid,session_id:session,role:'authenticated',is_anonymous:false,
     iss:'https://project.example.supabase.co/auth/v1',
     aud:'authenticated',iat:1000,exp:2000,aal:'aal1',email:'',phone:''
   }
 });
 const session1='11111111-1111-4111-8111-111111111111';
 const session2='33333333-3333-4333-8333-333333333333';
 async function run(obj,sig='v1,test'){
   const req={
     method:'POST',headers:new Headers({'webhook-signature':sig}),
     text:async()=>JSON.stringify(obj)
   };
   const response=await handler(req);
   return {status:response.status,body:await response.json()};
 }
 const first=await run(event('oauth',session1));
 assert.equal(first.status,200,'New Discord login is admitted after a role check');
 assert.equal(memberRequests,1);
 assert.equal(identityRequests,1);
 assert(sessions.has(session1),'Session grant is saved server-side');
 const until=first.body.claims.toreca_discord_role_until;
 assert.equal(until,Math.floor(Date.parse(sessions.get(session1).authorized_until)/1000));

 const second=await run(event('token_refresh',session1));
 assert.equal(second.status,200);
 assert.equal(second.body.claims.toreca_discord_role_until,until);
 assert.equal(memberRequests,1,'Remembered session skips Discord Bot');
 assert.equal(identityRequests,1,'Remembered session skips Auth Admin lookup');

 // A fresh OAuth login must not inherit an earlier session's authorization.
 const separate=await run(event('oauth',session2));
 assert.equal(separate.status,200);
 assert.equal(memberRequests,2,'A new device must verify its Discord role');

 // Removing role during a remembered grant does not retroactively remove it;
 // the change takes effect on the next authorization boundary.
 memberRoles=[];
 const stillRemembered=await run(event('token_refresh',session1));
 assert.equal(stillRemembered.status,200);
 assert.equal(memberRequests,2);
 sessions.set(session1,{...sessions.get(session1),
   authorized_until:new Date(Date.now()-1000).toISOString()});
 const afterExpiry=await run(event('token_refresh',session1));
 assert.equal(afterExpiry.status,403);
 assert.equal(memberRequests,3,'Expired grant is rechecked and rejected');

 const badSignature=await run(event('oauth',session2),'bad');
 assert.equal(badSignature.status,401,'Invalid webhook signatures are rejected');
 assert(signatures>=5);
 console.log('Auth Hook runtime: new OAuth, remembered refresh, separate login, role expiry and signatures passed');
})().catch(err=>{console.error(err);process.exitCode=1});
