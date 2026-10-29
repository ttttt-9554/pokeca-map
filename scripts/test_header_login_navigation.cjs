#!/usr/bin/env node
'use strict';
// v21.133 — top login navigation must replace the old bottom share tab.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const guide=fs.readFileSync(path.join(root,'guide.html'),'utf8');
function extract(name){
 const a=app.indexOf('  function '+name+'('),b=app.indexOf('\n  }\n',a);
 assert(a>=0&&b>a,'Missing function '+name);
 return app.slice(a,b+'\n  }'.length);
}
const h1=html.indexOf('<header id="appFixedHeader">');
const h2=html.indexOf('</header>',h1);
const n1=html.indexOf('<nav aria-label="メインメニュー">');
const n2=html.indexOf('</nav>',n1);
assert(h1>=0&&h2>h1&&n1>h2&&n2>n1);
const header=html.slice(h1,h2),nav=html.slice(n1,n2);
assert.match(header,/<button id="appLoginOpen"[^>]*data-tab="group"[^>]*>👤 ログイン<\/button>/);
assert(header.indexOf('id="appLoginOpen"')<header.indexOf('id="appUpdateNow"'));
assert.equal((html.match(/data-tab="group"/g)||[]).length,1);
assert.doesNotMatch(nav,/data-tab="group"|<span>共有<\/span>/);
assert.match(nav,/data-tab="dev"/);
assert.match(html,/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(guide,/画面上部の「ログイン」/);
assert.match(app,/画面上部の「ログイン」ボタン/);

function node(id,tab){
 const c=new Set(),events={},attributes={};
 return {id,dataset:{tab},events,attributes,classList:{
  contains:v=>c.has(v),
  toggle(v,on){on?c.add(v):c.delete(v)}
 },setAttribute(k,v){attributes[k]=v;},
   removeAttribute(k){delete attributes[k];},
   addEventListener(k,cb){events[k]=cb;}
 };
}
const login=node('appLoginOpen','group'),map=node('navMap','map'),dev=node('navDev','dev');
const mapView=node('mapView',''),groupView=node('groupView',''),devView=node('devView','');
mapView.classList.toggle('active',true);
const buttons=[map,dev,login],views=[mapView,groupView,devView],scroll={scrollTop:50};
const document={
 querySelectorAll(q){
   if(q==='nav button[data-tab], #appLoginOpen[data-tab]')return buttons;
   if(q==='.view')return views;
   throw Error('Unrecognized selector '+q);
 },
 getElementById:id=>views.find(x=>x.id===id)||null
};
let renders=0,devRuns=0;
const runtime=vm.runInNewContext([
 "const LOTTERY_LOGIN_TABS=['lottery','lotteryManage','lotteryResults','appLottery'];",
 extract('appNavigationButtons'),extract('switchTab'),extract('bindAppNavigation'),
 '\n({switchTab,bindAppNavigation})'
 ].join('\n'),{
   document,$:id=>id==='appScrollArea'?scroll:null,
   authUser:null,discordRoleAuthPending:false,
   isDeveloper:()=>false,setMapFilterOpen:()=>{},
   render:()=>renders++,refreshMap:()=>{},
   loadLotteryDevResults:()=>devRuns++
 },{timeout:1000});
runtime.bindAppNavigation();
assert.equal(typeof login.events.click,'function','Header login click listener');
login.events.click();
assert(groupView.classList.contains('active'));
assert(!mapView.classList.contains('active'));
assert(login.classList.contains('active'));
assert.equal(login.attributes['aria-current'],'page');
assert.equal(scroll.scrollTop,0);
map.events.click();
assert(mapView.classList.contains('active'));
assert(!login.classList.contains('active'));
assert.equal(login.attributes['aria-current'],undefined);
assert.equal(renders,2);
assert.equal(devRuns,0);
console.log('Fixed-header login and bottom navigation regression verified');
