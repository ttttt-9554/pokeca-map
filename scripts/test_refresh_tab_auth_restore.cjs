#!/usr/bin/env node
'use strict';
// v21.140: Refresh must not navigate to Login just because Supabase is still
// restoring the saved Discord session; authorized users return to their tab.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function extract(name){
  const start=app.indexOf('  function '+name+'(');
  const end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing function '+name);
  return app.slice(start,end+'\n  }'.length);
}

const moves=[],context={
 authUser:null,discordRoleAuthPending:false,
 isDeveloper:()=>false,switchTab:tab=>moves.push(tab)
};
const source=[
 "let restoreTabAfterAuth='';",
 "const LOTTERY_LOGIN_TABS=['lottery','lotteryManage','lotteryResults','appLottery'];",
 extract('deferProtectedTabUntilAuth'),
 extract('restoreProtectedTabAfterAuth'),
 '({deferProtectedTabUntilAuth,restoreProtectedTabAfterAuth,',
 'get pending(){return restoreTabAfterAuth},',
 'clear(){restoreTabAfterAuth=""}})'
].join('\n');
const auth=vm.runInNewContext(source,context,{timeout:1000});
for(const tab of ['lottery','lotteryManage','lotteryResults','appLottery']){
 auth.clear();moves.length=0;context.authUser=null;
 assert.equal(auth.deferProtectedTabUntilAuth(tab),'map',tab+' must show neutral loading');
 assert.equal(auth.pending,tab);
 assert.equal(auth.restoreProtectedTabAfterAuth(),false);
 assert.deepEqual(moves,[],'Never open restricted tab before authentication');
 context.authUser={id:'member'};
 context.discordRoleAuthPending=true;
 assert.equal(auth.restoreProtectedTabAfterAuth(),false);
 context.discordRoleAuthPending=false;
 assert.equal(auth.restoreProtectedTabAfterAuth(),true);
 assert.deepEqual(moves,[tab],'Authenticated session restores original '+tab);
 assert.equal(auth.pending,'','Pending restoration must run only once');
 assert.equal(auth.restoreProtectedTabAfterAuth(),false);
}
auth.clear();moves.length=0;context.authUser=null;
assert.equal(auth.deferProtectedTabUntilAuth('dev'),'map');
context.authUser={id:'not-a-developer'};
assert.equal(auth.restoreProtectedTabAfterAuth(),false,
 'Developer tab must remain unavailable without developer permission');
assert.deepEqual(moves,[]);
context.isDeveloper=()=>true;
assert.equal(auth.deferProtectedTabUntilAuth('dev'),'map');
assert.equal(auth.restoreProtectedTabAfterAuth(),true);
assert.deepEqual(moves,['dev']);
auth.clear();
for(const tab of ['map','add','group','history']){
 assert.equal(auth.deferProtectedTabUntilAuth(tab),tab,
  'Public tabs and Login do not wait for authentication');
 assert.equal(auth.pending,'');
}

const begin=html.indexOf('      var activeView =');
const end=html.indexOf('      if (/^(map|',begin);
assert(begin>=0&&end>begin,'Manual update must save the actual visible view');
const snippet=html.slice(begin,end)+'\ncurrentTab';
function savedTab(activeId,fallBackTab=''){
 const fakeDoc={
  querySelector(selector){
    if(selector==='#appScrollArea main > .view.active[id$="View"]')
      return activeId?{id:activeId}:null;
    if(selector.includes('#appLoginOpen.active[data-tab]'))
      return fallBackTab?{dataset:{tab:fallBackTab}}:null;
    throw Error('Unexpected selector: '+selector);
  }
 };
 return vm.runInNewContext(snippet,{document:fakeDoc},{timeout:1000});
}
for(const name of ['map','add','group','lottery','lotteryManage',
  'lotteryResults','appLottery','dev']){
 assert.equal(savedTab(name+'View'),name,'Manual refresh preserves '+name);
}
assert.equal(savedTab(null,'group'),'group',
 'Login is still captured if view detection is unavailable');
assert.match(app,/initialTab=deferProtectedTabUntilAuth\(requestedTab\)/,
 'Startup must defer protected pages until Discord Auth completes');
assert.match(app,/initialTab=deferProtectedTabUntilAuth\('lottery'\)/,
 'Deep-linked lottery must also wait for login');
assert.match(app,/updateDeveloperTab\(\);[\s\S]{0,150}restoreProtectedTabAfterAuth\(\);/,
 'Only after displaying authenticated identity can a protected tab return');
assert.match(app,/restoreTabAfterAuth='';\s*switchTab\(button\.dataset\.tab\)/,
 'Explicit user navigation must cancel a pending automatic restore');
assert.match(app,/LOTTERY_LOGIN_TABS\.includes\(tab\)\&\&\(!authUser\|\|discordRoleAuthPending\)/,
 'Direct restricted navigation remains unauthorized while signed out');
assert.match(app,/if\(restoreTabAfterAuth\)switchTab\('group'\)/,
 'Lost session prompts Login rather than revealing a lottery tab');
assert.doesNotMatch(app,/restoreDeveloperTabPending/,
 'Old developer-only restoration code must be fully removed');
console.log('Manual update: login / lottery / results / management / developer / user navigation tests passed');
