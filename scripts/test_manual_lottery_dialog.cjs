#!/usr/bin/env node
'use strict';
// Regression: manual lottery dialog must stay open on backdrop tap and protect edits.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'style.css'),'utf8');
function fn(name){
 const start=app.indexOf('  function '+name+'(');
 const end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,'App helper not found: '+name);
 return app.slice(start,end+5);
}
assert.match(html,/<dialog id="lpAppDialog"[^>]+closedby="closerequest"/);
assert.match(html,/id="lpAppCloseX"[^>]+aria-label="手動抽選登録を閉じる"/);
assert.match(css,/#lpAppDialog \.lp-app-dialog-top\{[\s\S]*?position:sticky/);
assert.match(css,/#lpAppDialog #lpAppCloseX::before/);
assert.match(css,/#lpAppDialog #lpAppCloseX::after/);
assert.match(app,/\$\('lpAppCloseX'\)\.addEventListener\('click',lpAppRequestClose\)/);
assert.match(app,/\$\('lpAppCancel'\)\.addEventListener\('click',lpAppRequestClose\)/);
assert.match(app,/event\.preventDefault\(\);\s*lpAppRequestClose\(\);/);
assert.doesNotMatch(app,/if\(event\.target===\$\('lpAppDialog'\)[\s\S]{0,80}\.close\(\)/);
const inputs=[
 {name:'event_title',type:'text',value:'登録済みの抽選'},
 {name:'registration_method',type:'select-one',value:'app'}
];
const form={querySelectorAll:()=>inputs};
const dialog={open:true,close(){this.open=false}};
let busy=false,confirmed=false,confirmCount=0,closeCount=0;
const context={
 $:id=>id==='lpAppForm'?form:id==='lpAppDialog'?dialog:null,
 get lpAppBusy(){return busy},
 confirm(){confirmCount++;return confirmed},
 lpAppCloseEditor(){closeCount++;dialog.close()}
};
const api=vm.runInNewContext(
 'let lpAppInitialSnapshot=null;\n'+
 fn('lpAppFormSnapshot')+'\n'+fn('lpAppRequestClose')+
 '\n({snapshot:lpAppFormSnapshot,request:lpAppRequestClose,setBaseline:v=>{lpAppInitialSnapshot=v}})',
 context,{timeout:1000});
api.setBaseline(api.snapshot());
assert.equal(api.request(),true);
assert.equal(closeCount,1);
assert.equal(confirmCount,0);
dialog.open=true;
inputs[0].value='編集中の抽選';
assert.equal(api.request(),false,'Declining confirmation must preserve unsaved edits');
assert.equal(dialog.open,true);
assert.equal(closeCount,1);
assert.equal(confirmCount,1);
confirmed=true;
assert.equal(api.request(),true);
assert.equal(dialog.open,false);
assert.equal(closeCount,2);
dialog.open=true;busy=true;
assert.equal(api.request(),false,'Cannot close while save/delete is underway');
assert.equal(dialog.open,true);
assert.equal(closeCount,2);
console.log('Safe manual lottery dialog: backdrop, sticky X, unsaved edits, Escape guards passed');
