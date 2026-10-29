#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'style.css'),'utf8');
function extract(name) {
  const start=app.indexOf('  function '+name+'(');
  const end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing function: '+name);
  return app.slice(start,end+'\n  }'.length);
}
const makeNode=()=>({hidden:false,tabIndex:0,scrollTop:44,innerHTML:'',textContent:'',
 attributes:{},setAttribute(name,val){this.attributes[name]=val}});
const nodes=new Map([
  ['lpCardForm',makeNode()],['lpCardHiddenPane',makeNode()],
  ['lpCardEditTab',makeNode()],['lpCardHiddenTab',makeNode()],
  ['lpCardDialog',makeNode()],['lpCardHiddenList',makeNode()],
  ['lpCardHiddenCount',makeNode()],['lpCardHiddenModalList',makeNode()],
  ['lpCardHiddenModalCount',makeNode()],['lpCardHiddenTabCount',makeNode()]
]);
let refreshes=0;
const tabs=vm.runInNewContext(extract('lpCardSelectTab')+
  '\n({lpCardSelectTab})',{
    $:id=>nodes.get(id),isDeveloper:()=>true,
    lpCardHiddenRender:()=>{refreshes++;}
  },{timeout:1000});
assert.equal(tabs.lpCardSelectTab('hidden'),true);
assert.equal(nodes.get('lpCardForm').hidden,true);
assert.equal(nodes.get('lpCardHiddenPane').hidden,false);
assert.equal(nodes.get('lpCardEditTab').attributes['aria-selected'],'false');
assert.equal(nodes.get('lpCardHiddenTab').attributes['aria-selected'],'true');
assert.equal(nodes.get('lpCardHiddenTab').tabIndex,0);
assert.equal(nodes.get('lpCardDialog').scrollTop,0);
assert.equal(refreshes,1);
assert.equal(tabs.lpCardSelectTab('edit'),true);
assert.equal(nodes.get('lpCardForm').hidden,false);
assert.equal(nodes.get('lpCardHiddenPane').hidden,true);
assert.equal(nodes.get('lpCardEditTab').attributes['aria-selected'],'true');
assert.equal(nodes.get('lpCardHiddenTab').tabIndex,-1);
assert.equal(refreshes,1);
assert.equal(tabs.lpCardSelectTab('bad'),false);

const url='https://livepocket.jp/e/sample-x',name='非表示のテスト抽選';
const hidden=new Map([[url,{event_url:url,is_hidden:true,event_title:name}]]);
const snapshot=vm.runInNewContext(extract('lpCardHiddenRender')+
  '\n({lpCardHiddenRender})',{
    $:id=>nodes.get(id),isDeveloper:()=>true,lpCardReady:true,
    lpCardOverrides:hidden,lotteryBaseItems:[{url,event_title:name}],
    isLivePocketEventUrl:value=>String(value).startsWith('https://livepocket.jp/e/'),
    escape:value=>String(value)
  },{timeout:1000});
snapshot.lpCardHiddenRender();
assert.equal(nodes.get('lpCardHiddenCount').textContent,'1件');
assert.equal(nodes.get('lpCardHiddenModalCount').textContent,'1件');
assert.equal(nodes.get('lpCardHiddenTabCount').textContent,'1件');
assert.match(nodes.get('lpCardHiddenModalList').innerHTML,/data-lp-card-hidden-restore/);
assert.doesNotMatch(nodes.get('lpCardHiddenModalList').innerHTML,/data-lp-card-hidden-edit/,
  'Editing another lottery from an open modal is intentionally disabled');
assert.match(nodes.get('lpCardHiddenList').innerHTML,/data-lp-card-hidden-edit/,
  'Developer archive retains its existing edit capability');
assert.match(html,/<form id="lpCardForm"[^>]*role="tabpanel"/);
assert.match(html,/id="lpCardHiddenPane"[^>]*role="tabpanel"/);
assert.match(html,/id="lpCardEditorTabs"[^>]*role="tablist"/);
assert.match(html,/<button[^>]*id="lpCardHiddenTab"[^>]*role="tab"/);
assert.match(app,/lpCardSelectTab\('edit'\)/);
assert.match(app,/lpCardVisibilityChange\(button\.dataset\.lpCardHiddenRestore,false,true\)/);
assert.doesNotMatch(app,/if\(fromDialog&&\$\('lpCardDialog'\)\?\.open\)\$\('lpCardDialog'\)\.close\(\)/,
  'Visibility changes within the modal must keep the tab open');
assert.match(css,/#lpCardDialog #lpCardHiddenPane\[hidden\]/);
console.log('Lottery-card edit/hidden tabs, count sync, and recovery controls verified');
