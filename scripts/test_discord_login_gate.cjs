#!/usr/bin/env node
'use strict';
// Regression test: Discord OAuth is insufficient without server-approved role.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function extract(name,asyncFn=false){
 const begin=app.indexOf('  '+(asyncFn?'async ':'')+'function '+name+'(');
 const end=app.indexOf('\n  }\n',begin);
 assert(begin>=0&&end>begin,'Missing helper: '+name);
 return app.slice(begin,end+'\n  }'.length);
}
assert.match(app,/onAuthStateChange\(\(event,session\)\s*=>\s*\{/);
assert.match(app,/await requireDiscordRole\(data\.session\)/);
assert.match(app,/setTimeout\(async\(\)=>\{/);
assert.match(app,/data\?\.session\?\.access_token!==session\.access_token/);
assert.match(app,/await requireDiscordRole\(data\.session\)/);
assert.match(app,/if\(event==='SIGNED_OUT'\)/);
assert.doesNotMatch(app,/authUser = session\?\.user \|\| null/);
assert.doesNotMatch(app,/void renewDiscordRole\(\)/);
assert.doesNotMatch(app,/discordRoleVerifiedUntil/);
assert.doesNotMatch(app,/setInterval\(\(\)=>\{\s*if\(authUser/);
assert.match(app,/if\(!force&&authUser\?\.id===user\.id&&discordRoleVerifiedToken\)/);
assert.match(app,/await supabaseClient\.auth\.signOut\(\)/);
assert.match(app,/async function trustedDiscordRoleFromToken\(session\)/);
assert.match(app,/auth\.getClaims\(session\.access_token\)/);
assert.match(app,/toreca_discord_role_until/);
assert.match(app,/const remembered=!force&&await trustedDiscordRoleFromToken\(session\)/);
assert.match(app,/if\(\['role_required','discord_login_required','login_required'\]/);
assert.match(html,/Discordロール認証/);
assert.doesNotMatch(html,/アクセス権限の確認（テスト）/);

const source=[
extract('trustedDiscordRoleFromToken',true),
extract('discordRoleResultMessage'),
extract('discordRoleVerifyToken',true),
extract('requireDiscordRole',true),
extract('checkDiscordRoleAccess',true),
'({discordRoleResultMessage,discordRoleVerifyToken,requireDiscordRole,checkDiscordRoleAccess})'
].join('\n');
function harness(){
 let answer={ok:true,status:200,body:{allowed:true}};
 let calls=0,signouts=0,displays=0,groupRedirects=0,lastAuth='';
 const nodes={discordRoleCheck:{disabled:false},discordRoleStatus:{textContent:''}};
 const context={
  authUser:null,discordRoleAuthPending:false,discordRoleAuthError:'',
  discordRoleAuthGeneration:0,discordRoleVerifiedToken:'',discordRoleVerifiedUntil:0,
  discordRoleVerification:null,discordRoleCheckBusy:false,
  SUPABASE_URL:'https://api.example',SUPABASE_KEY:'sb_publishable_demo',
  $:id=>nodes[id],displayAuth:()=>{displays++},switchTab:tab=>{if(tab==='group')groupRedirects++},
  AbortController,setTimeout,clearTimeout,Date,
  supabaseClient:{auth:{
   getSession:async()=>({data:{session:{user:{id:'u1'},access_token:'token1'}},error:null}),
   signOut:async()=>{signouts++;return {error:null}}
  }},
  fetch:async(_url,options)=>{
    calls++;lastAuth=options.headers.Authorization;
    return {ok:answer.ok,status:answer.status,json:async()=>answer.body};
  }
 };
 const api=vm.runInNewContext(source,context,{timeout:1000});
 return {api,context,nodes,setAnswer:a=>{answer=a},stats:()=>({calls,signouts,displays,groupRedirects,lastAuth})};
}
const session={user:{id:'u1'},access_token:'token1'};
(async()=>{
 const positive=harness();
 assert.equal(await positive.api.requireDiscordRole(session),true);
 assert.equal(positive.context.authUser.id,'u1');
 assert.equal(positive.context.discordRoleAuthPending,false);
 assert.equal(positive.stats().signouts,0);
 assert.equal(positive.stats().lastAuth,'Bearer token1');
 assert.equal(await positive.api.requireDiscordRole(session),true);
 assert.equal(positive.stats().calls,1,'Duplicate auth event uses verified session');

 const denied=harness();
 denied.setAnswer({ok:false,status:403,body:{allowed:false,error:'role_required'}});
 assert.equal(await denied.api.requireDiscordRole(session),false);
 assert.equal(denied.context.authUser,null);
 assert.equal(denied.context.discordRoleAuthError,'role_required');
 assert.equal(denied.stats().signouts,1,'Unauthorized Discord login is signed out');
 assert.equal(denied.stats().groupRedirects,1);
 assert.match(denied.api.discordRoleResultMessage('role_required'),/ログインできません/);

 const fail=harness();
 fail.setAnswer({ok:false,status:503,body:{allowed:false,error:'role_check_unavailable'}});
 assert.equal(await fail.api.requireDiscordRole(session),false);
 assert.equal(fail.context.authUser,null,'Network/backend outage fails closed');
 assert.equal(fail.stats().signouts,0,
   'Temporary failure must retain the saved session for retry');
 assert.equal(fail.context.discordRoleAuthError,'role_check_unavailable');

 const check=harness();
 assert.equal(await check.api.requireDiscordRole(session),true);
 check.setAnswer({ok:false,status:403,body:{allowed:false,error:'role_required'}});
 await check.api.checkDiscordRoleAccess();
 assert.equal(check.context.authUser,null,'Rechecking a revoked role rejects the active login');
 assert.equal(check.stats().signouts,1);

 // A re-opened PWA with a properly signed, still-valid role claim needs
 // neither a Discord OAuth redirect nor an additional Bot API request.
 const restored=harness();
 let checkedToken='';
 restored.context.supabaseClient.auth.getClaims=async token=>{
   checkedToken=token;
   return {data:{claims:{sub:'u1',role:'authenticated',is_anonymous:false,
     toreca_discord_role_until:Math.floor(Date.now()/1000)+3600}},error:null};
 };
 assert.equal(await restored.api.requireDiscordRole(session),true);
 assert.equal(checkedToken,'token1');
 assert.equal(restored.context.authUser.id,'u1');
 assert.equal(restored.stats().calls,0,
   'A valid signed JWT restores login without a Discord round-trip');

 const expired=harness();
 expired.context.supabaseClient.auth.getClaims=async()=>({
   data:{claims:{sub:'u1',role:'authenticated',is_anonymous:false,
     toreca_discord_role_until:Math.floor(Date.now()/1000)-60}},error:null
 });
 assert.equal(await expired.api.requireDiscordRole(session),true);
 assert.equal(expired.stats().calls,1,
   'Expired remembered role proof must not bypass verification');

 const networkRetry=harness();
 networkRetry.setAnswer({ok:false,status:503,body:{error:'role_check_unavailable'}});
 assert.equal(await networkRetry.api.requireDiscordRole(session),false);
 assert.equal(networkRetry.stats().signouts,0);
 networkRetry.setAnswer({ok:true,status:200,body:{allowed:true}});
 await networkRetry.api.checkDiscordRoleAccess();
 assert.equal(networkRetry.context.authUser.id,'u1');
 assert.equal(networkRetry.stats().calls,2,'Manual retry recovers stored credentials');

 const tokenRefresh=harness();
 assert.equal(await tokenRefresh.api.requireDiscordRole(session),true);
 assert.equal(await tokenRefresh.api.requireDiscordRole({
   user:{id:'u1'},access_token:'token2'
 }),true,'Token rotation for an approved login is not a new Discord check');
 assert.equal(tokenRefresh.stats().calls,1,'No additional role lookup on token rotation');
 console.log('Discord login: 14-day restore, rejection, transient retry, JWT refresh and no polling passed');
})().catch(e=>{console.error(e);process.exitCode=1});
