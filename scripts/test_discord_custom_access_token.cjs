#!/usr/bin/env node
'use strict';
// Guard against accidental bypass of the token issuance role gate.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const edge=fs.readFileSync(path.join(root,'supabase/functions/discord-custom-access-token/index.ts'),'utf8');
const sql=fs.readFileSync(path.join(root,'supabase/discord_remembered_sessions_v21_138.sql'),'utf8');
(async()=>{
 const p=await import(pathToFileURL(path.join(root,'supabase/functions/discord-custom-access-token/policy.mjs')).href);
 const uid='88888888-8888-4888-8888-888888888888';
 const event={user_id:uid,claims:{sub:uid,role:'authenticated',is_anonymous:false,aud:'authenticated'}};
 assert(p.isHookEvent(event));
 assert(!p.isHookEvent({...event,user_id:'something'}));
 assert(!p.isHookEvent({...event,claims:{...event.claims,role:'anon'}}));
 assert(!p.isHookEvent({...event,claims:{...event.claims,is_anonymous:true}}));
 assert(!p.isHookEvent({...event,claims:{...event.claims,sub:'a'}}));
 assert.equal(p.discordId([{provider:'discord',identity_data:{provider_id:'123456789012345678'}}]),'123456789012345678');
 assert.equal(p.discordId([{provider:'google',identity_data:{provider_id:'123456789012345678'}}]),null);
 assert.equal(p.discordId([{provider:'discord',identity_data:{provider_id:'not-a-snowflake'}}]),null);
 assert(p.permitted({roles:['123456789012345678'],pending:false},['123456789012345678']));
 assert(!p.permitted({roles:['323456789012345678']},['123456789012345678']));
 assert(!p.permitted({roles:['123456789012345678'],pending:true},['123456789012345678']));
 assert.deepEqual(p.roles('123456789012345678, 323456789012345678'),['123456789012345678','323456789012345678']);
 assert.deepEqual(p.roles('123456789012345678, wrong'),[]);
 assert.match(edge,/new Webhook\(key.slice\(3\)\)\.verify\(body,headers\)/);
 assert.match(edge,/Deno\.env\.get\('DISCORD_ACCESS_TOKEN_HOOK_SECRET'\)/);
 assert.match(edge,/auth\.admin\.getUserById\(event\.user_id\)/);
 assert.match(edge,/discordId\(response\.data\.user\.identities\)/);
 assert.match(edge,/permitted\(member,allowed\)/);
 assert.match(edge,/return json\(\{claims:authorizedClaims\(event\.claims,authorizedUntil\)\}\)/);
 assert.match(edge,/return json\(\{claims:authorizedClaims\(event\.claims,cached\.authorized_until\)\}\)/);
 assert.match(edge,/if\(event\.authentication_method==='token_refresh'\)/);
 assert.match(edge,/session_id:sessionId,user_id:event\.user_id/);
 assert.match(edge,/\.eq\('session_id',sessionId\)\.maybeSingle\(\)/);
 assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
 assert.match(sql,/REVOKE ALL ON TABLE public\.discord_remembered_sessions_v1/);
 assert.match(sql,/GRANT SELECT, INSERT, UPDATE, DELETE .*public\.discord_remembered_sessions_v1/s);
 assert.match(edge,/Discord role required/);
 assert.doesNotMatch(edge,/event\.claims\.user_metadata|user\.user_metadata|identity_data\s*=\s*event/);
 assert.doesNotMatch(edge,/console\.(log|warn|error)/);
 assert.doesNotMatch(edge,/verify_jwt\s*:\s*true/);
 // Grants are bound to an individual Supabase session and expire in 14 days.
 assert.equal(p.REMEMBER_DAYS,14);
 const now=Date.parse('2026-10-30T00:00:00Z');
 const sessionId='11111111-1111-4111-8111-111111111111';
 const refresh={...event,authentication_method:'token_refresh',
   claims:{...event.claims,session_id:sessionId}};
 const row={session_id:sessionId,user_id:uid,
   authorized_until:new Date(now+8*24*60*60*1000).toISOString()};
 assert(p.rememberedSessionAllowed(refresh,row,now));
 assert(!p.rememberedSessionAllowed({...refresh,authentication_method:'oauth'},row,now));
 assert(!p.rememberedSessionAllowed(refresh,{...row,user_id:'other'},now));
 assert(!p.rememberedSessionAllowed(refresh,{...row,session_id:'other'},now));
 assert(!p.rememberedSessionAllowed(refresh,{...row,authorized_until:new Date(now).toISOString()},now));
 assert(!p.rememberedSessionAllowed(refresh,{
   ...row,authorized_until:new Date(now+p.REMEMBER_MS+60000).toISOString()},now));
 assert(!p.rememberedSessionAllowed(refresh,null,now));
 const claims=p.authorizedClaims(refresh.claims,row.authorized_until);
 assert.equal(claims.sub,uid);
 assert.equal(claims.toreca_discord_role_until,Math.floor(Date.parse(row.authorized_until)/1000));
 assert.equal(refresh.claims.toreca_discord_role_until,undefined);
 console.log('Pre-session Discord hook: role verification, signed claims and 14-day session persistence passed');
})().catch(e=>{console.error(e);process.exitCode=1});
