#!/usr/bin/env node
'use strict';
// Exercise test-only Discord role verification without leaking session tokens.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function get(name,asyncKeyword=false){
 const start=app.indexOf('  '+(asyncKeyword?'async ':'')+'function '+name+'(');
 const end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,'Missing '+name);
 return app.slice(start,end+'\n  }'.length);
}
assert.match(html,/id="discordRoleCheck"[^>]*disabled/);
assert.match(html,/id="discordRoleStatus"/);
assert.match(html,/認証テストであり|まだ閲覧制限は有効になっていない/);
assert.match(app,/get\('discordRoleCheck'\)\.addEventListener\('click',checkDiscordRoleAccess\)/);
assert.match(app,/auth\.getSession\(\)/);
assert.match(app,/Authorization':'Bearer '\+accessToken/);
assert.match(app,/discord-role-access/);
assert.doesNotMatch(app,/console\.log\(accessToken\)/);

const nodes={
 discordRoleCheck:{disabled:false},
 discordRoleStatus:{textContent:''}
};
let callCount=0,endpoint='',seenAuth='';
const context={
 $:id=>nodes[id],
 supabaseClient:{auth:{getSession:async()=>({data:{session:{access_token:'fake-jwt'}},error:null})}},
 authUser:{id:'one'},
 SUPABASE_URL:'https://project.example',
 SUPABASE_KEY:'publishable-key-test',
 discordRoleCheckBusy:false,
 setTimeout,clearTimeout,AbortController,
 fetch:async (url,args)=>{
   callCount++;endpoint=url;seenAuth=args.headers.Authorization;
   return {ok:true,json:async()=>({allowed:true})};
 }
};
const script=get('discordRoleResultMessage')+'\n'+get('checkDiscordRoleAccess',true)+
 '\n({discordRoleResultMessage,checkDiscordRoleAccess})';
const api=vm.runInNewContext(script,context,{timeout:1000});
(async()=>{
 assert.match(api.discordRoleResultMessage('not_configured'),/DISCORD_BOT_TOKEN/);
 assert.match(api.discordRoleResultMessage('role_required'),/指定ロール/);
 assert.match(api.discordRoleResultMessage('',true),/確認できました/);
 await api.checkDiscordRoleAccess();
 assert.equal(callCount,1);
 assert.equal(endpoint,'https://project.example/functions/v1/discord-role-access');
 assert.equal(seenAuth,'Bearer fake-jwt');
 assert.match(nodes.discordRoleStatus.textContent,/✅/);
 assert.match(nodes.discordRoleStatus.textContent,/まだ完了していません/);
 assert.equal(nodes.discordRoleCheck.disabled,false);
 context.fetch=async()=>({ok:false,json:async()=>({error:'not_configured'})});
 await api.checkDiscordRoleAccess();
 assert.match(nodes.discordRoleStatus.textContent,/DISCORD_BOT_TOKEN/);
 context.fetch=async()=>({ok:false,json:async()=>({error:'role_required'})});
 await api.checkDiscordRoleAccess();
 assert.match(nodes.discordRoleStatus.textContent,/指定ロール/);
 context.authUser=null;
 await api.checkDiscordRoleAccess();
 assert.match(nodes.discordRoleStatus.textContent,/ログインが必要/);
 console.log('Discord role test UI: success, missing secret, rejected role, logout, auth token passed');
})().catch(e=>{console.error(e);process.exitCode=1});
