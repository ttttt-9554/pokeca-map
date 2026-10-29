#!/usr/bin/env node
'use strict';
// Guard against accidental bypass of the token issuance role gate.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const edge=fs.readFileSync(path.join(root,'supabase/functions/discord-custom-access-token/index.ts'),'utf8');
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
 assert.match(edge,/return json\(\{claims:event\.claims\}\)/);
 assert.match(edge,/Discord role required/);
 assert.doesNotMatch(edge,/event\.claims\.user_metadata|user\.user_metadata|identity_data\s*=\s*event/);
 assert.doesNotMatch(edge,/console\.(log|warn|error)/);
 assert.doesNotMatch(edge,/verify_jwt\s*:\s*true/);
 console.log('Pre-session Discord token hook role validation and signature checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
