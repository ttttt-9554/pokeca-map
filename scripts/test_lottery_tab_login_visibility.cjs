#!/usr/bin/env node
'use strict';
// v21.136: Signed-out users cannot see or enter lottery-related tabs.
// A valid Discord login restores them without requiring a page reload.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function extract(name){
 const begin=app.indexOf('  function '+name+'(');
 const end=app.indexOf('\n  }\n',begin);
 assert(begin>=0&&end>begin,'Missing function: '+name);
 return app.slice(begin,end+'\n  }'.length);
}
const tabs=['lottery','lotteryManage','lotteryResults','appLottery'];
for(const tab of tabs){
 assert.match(html,new RegExp('data-tab="'+tab+'" hidden aria-label='),
  tab+' must begin hidden before JavaScript runs');
}
assert.match(app,/LOTTERY_LOGIN_TABS\.includes\(tab\)\&\&\(!authUser\|\|discordRoleAuthPending\)/);
assert.match(app,/updateLotteryVisibility\(\);\s*initDevAccordions\(\)/);
assert.match(app,/\$\('discordLogout'\)\.hidden = !authUser;\s*updateLotteryVisibility\(\);/);
assert.doesNotMatch(app,/if\(authUser\)void renewDiscordRole\(\)/);
assert.doesNotMatch(app,/setInterval\(\(\)=>\{\s*if\(authUser/);

const node=(id,tab)=>{
 const classes=new Set();
 const attrs={};
 return {id,hidden:false,dataset:{tab},attrs,
 classList:{
  contains:c=>classes.has(c),
  toggle(c,enabled){if(enabled)classes.add(c);else classes.delete(c)}
 },setAttribute(k,v){attrs[k]=v;},
 removeAttribute(k){delete attrs[k]},
 };
};
const buttons=new Map([...tabs,'map','add','dev'].map(tab=>[tab,node('button-'+tab,tab)]));
const login=node('appLoginOpen','group');
const views=new Map([...tabs,'map','group','add','dev'].map(tab=>[tab,node(tab+'View',null)]));
views.get('map').classList.toggle('active',true);
const scroll={scrollTop:50},loginMock={authUser:null,discordRoleAuthPending:false};
const document={
 querySelector(s){
  const match=/^nav button\[data-tab="([^"]+)"\]$/.exec(s);
  if(match)return buttons.get(match[1])||null;
  throw Error('Unrecognized selector '+s);
 },
 querySelectorAll(s){
  if(s==='.view')return [...views.values()];
  if(s==='nav button[data-tab], #appLoginOpen[data-tab]')
    return [...buttons.values(),login];
  throw Error('Unrecognized selector '+s);
 },
 getElementById:id=>{
  if(id.endsWith('View'))return views.get(id.slice(0,-4))||null;
  return null;
 }
};
let rendered=0;
const context={
 ...loginMock,document,$:id=>id==='appScrollArea'?scroll:null,
 isDeveloper:()=>false,setMapFilterOpen:()=>{},
 render:()=>{rendered++},refreshMap:()=>{},
 loadLotteryEvents:()=>{},lpCloudRefresh:()=>{},lpLocationRefresh:()=>{},
 lpExtRefresh:()=>{},lpCardRefresh:()=>{},
 refreshLotteryTrackerForAccount:()=>{},
 refreshLotteryOnsiteReports:()=>{},refreshLotteryOnsiteArchive:()=>{},
 lpAppRefresh:()=>{},renderLotteryTrackerSummary:()=>{},
 lpResultsRefresh:()=>{},lpResultsRender:()=>{},
 loadLotteryDevResults:()=>{},refreshDeveloperSalePreview:()=>{}
};
const script=[
 "const LOTTERY_LOGIN_TABS=['lottery','lotteryManage','lotteryResults','appLottery'];",
 extract('appNavigationButtons'),extract('updateLotteryVisibility'),
 extract('switchTab'),'({updateLotteryVisibility,switchTab})'
].join('\n');
const api=vm.runInNewContext(script,context,{timeout:1000});
api.updateLotteryVisibility();
for(const tab of tabs){
 assert(buttons.get(tab).hidden,tab+' button must be hidden without login');
 assert(views.get(tab).hidden,tab+' view must be hidden without login');
}
api.switchTab('lottery');
assert(views.get('group').classList.contains('active'),'Direct unauthorized navigation redirects to Login');
assert(!views.get('lottery').classList.contains('active'));
context.discordRoleAuthPending=true;
context.authUser={id:'abc'};
api.updateLotteryVisibility();
for(const tab of tabs)assert(buttons.get(tab).hidden,'Checking role does not reveal '+tab);
context.discordRoleAuthPending=false;
api.updateLotteryVisibility();
for(const tab of tabs){
 assert.equal(buttons.get(tab).hidden,false,'Authorized button restored '+tab);
 assert.equal(views.get(tab).hidden,false,'Authorized view restored '+tab);
}
api.switchTab('lottery');
assert(views.get('lottery').classList.contains('active'),'Authorized login can enter lottery');
context.authUser=null;
api.updateLotteryVisibility();
assert(views.get('group').classList.contains('active'),'Logout removes active lottery view');
for(const tab of tabs){
 assert(buttons.get(tab).hidden,'Logout hides '+tab);
 assert(views.get(tab).hidden,'Logout hides view '+tab);
}
assert(!buttons.get('map').hidden&&!buttons.get('add').hidden,
 'Map and discovery registration remain available without login');
assert(rendered>=3);
console.log('Lottery tab login visibility: startup, direct route, pending, login and logout verified');
