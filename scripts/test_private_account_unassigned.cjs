#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function source(name){
 const a=app.indexOf('  function '+name+'('),b=app.indexOf('\n  }\n',a);
 assert(a>=0&&b>a, 'Missing app function '+name);
 return app.slice(a,b+5);
}
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const profiles=[
 {id:A,label:'自分',is_archived:false,is_default:true},
 {id:B,label:'嫁',is_archived:false,is_default:false}
];
function cell(value){return {value:String(value)}}
function scenario(legacyCounts){
 const keys=['application_count','won_count','lost_count'];
 const left=Object.fromEntries(keys.map(k=>[k,cell(legacyCounts[k]||0)]));
 const legacy={
  hidden:false,
  querySelector(selector){
   const m=selector.match(/data-lp-account-count="([^"]+)"/);
   return m?left[m[1]]:null;
  }
 };
 const rows=[];
 function makeRow(id,outcome='pending'){
   let row;
   const checks=['pending','won','lost','received'].map(value=>({
    value,checked:value===outcome,
    matches:s=>s==='[data-lp-account-outcome]',
    closest:s=>s==='[data-lp-account-row]'?row:null
   }));
   row={id,choice:{value:id},checks,
    querySelector(sel){
     if(sel==='[data-lp-account-id]')return this.choice;
     if(sel==='[data-lp-account-outcome]:checked')
       return this.checks.find(c=>c.checked)||null;
     if(sel==='[data-lp-account-outcome][value="pending"]')
       return this.checks[0];
     return null;
    },
    querySelectorAll(sel){
      return sel==='[data-lp-account-outcome]'?this.checks:[];
    },
    remove(){const i=rows.indexOf(this);if(i>=0)rows.splice(i,1);}
   };
   return row;
 }
 const holder={
  querySelectorAll(sel){
   assert.equal(sel,'[data-lp-account-row]');
   return rows;
  },
  insertAdjacentHTML(_,html){
   const ids=[...html.matchAll(/<option value="([^"]+)" selected>/g)];
   const results=[...html.matchAll(/<input type="checkbox" data-lp-account-outcome value="(pending|won|lost|received)" checked/g)];
   assert(ids.length,'No selected account');
   rows.push(makeRow(ids[0][1],results[0]?.[1]||'pending'));
  }
 };
 const listeners={};
 const root={
  addEventListener(event,cb){listeners[event]=cb;},
  querySelector:()=>null
 };
 const form={elements:{
  application_count:cell(legacyCounts.application_count||0),
  won_count:cell(legacyCounts.won_count||0),
  lost_count:cell(legacyCounts.lost_count||0),
  status:{value:'applied'}
 }};
 const nodes={lpTrackPrivateAccounts:root,lpTrackAccountRows:holder,
  lpTrackUnassigned:legacy,lpTrackEditorMessage:{textContent:''}};
 let confirmResult=true,confirmCalls=0;
 const context={
  $:id=>nodes[id],
  lpPrivateAccountRows:()=>profiles,
  lpPrivateAccountDefault:()=>profiles[0],
  lpPrivateAccounts:new Map(profiles.map(x=>[x.id,x])),
  escape:x=>String(x),
  lpTrackerCandidateStores:()=>[],lpAppEventId:()=>'',
  confirm:()=>{confirmCalls++;return confirmResult}
 };
 const api=vm.runInNewContext([
  source('lpTrackerAccountInput'),source('lpTrackerStoreControl'),source('lpTrackerAccountRowHtml'),
  source('lpTrackerAllocateOne'),source('lpTrackerPrivateBind')
 ].join('\n')+'\n({lpTrackerPrivateBind})',context,{timeout:1000});
 const ctl=api.lpTrackerPrivateBind(form,()=>{});
 const button=(sel,row)=>{
  const target={
   closest(requested){
    if(requested===sel)return target;
    if(requested==='[data-lp-account-row]')return row||null;
    return null;
   }
  };
  return target;
 };
 function add(){listeners.click({target:button('#lpTrackAccountAdd')})}
 function remove(index){
  const row=rows[index];assert(row,'row not present');
  listeners.click({target:button('[data-lp-account-remove]',row)});
 }
 function change(index,value){
  const target=rows[index].checks.find(c=>c.value===value);
  assert(target,'Outcome option exists');
  target.checked=true;
  listeners.change({target});
 }
 return {add,remove,change,ctl,rows,form,legacy,left,
  confirmCount:()=>confirmCalls,confirmEnabled:v=>{confirmResult=v}};
}
const empty=scenario({});
assert.equal(empty.ctl.collect().application_count,0);
empty.add();
assert.equal(empty.ctl.collect().application_count,1);
assert.equal(empty.ctl.collect().account_entries[0].application_count,1);
assert.equal(empty.rows[0].choice.value,A);
assert.equal(empty.legacy.hidden,true);
empty.add();
assert.equal(empty.ctl.collect().application_count,2);
assert.equal(empty.rows[1].choice.value,B);
empty.change(0,'won');
empty.change(1,'lost');
assert.equal(empty.ctl.collect().won_count,1);
assert.equal(empty.ctl.collect().lost_count,1);
empty.confirmEnabled(false);empty.remove(1);
assert.equal(empty.rows.length,2,'Cancelled delete keeps the ticket');
empty.confirmEnabled(true);empty.remove(1);
assert.equal(empty.ctl.collect().application_count,1);
assert.equal(empty.ctl.collect().lost_count,0);
assert.equal(empty.ctl.collect().won_count,1);
empty.change(0,'received');
assert.equal(empty.ctl.collect().won_count,1,
 'A received account still counts as one winning ticket');
assert.equal(empty.ctl.collect().account_entries[0].received_count,1);
empty.change(0,'pending');
assert.equal(empty.ctl.collect().won_count,0);
assert.equal(empty.ctl.collect().account_entries[0].lost_count,0);

const old=scenario({application_count:2});
old.add();
assert.equal(old.left.application_count.value,'1');
assert.equal(old.ctl.collect().application_count,2);
assert.equal(old.legacy.hidden,false);
old.add();
assert.equal(old.left.application_count.value,'0');
assert.equal(old.ctl.collect().application_count,2);
assert.equal(old.legacy.hidden,true);
old.remove(0);
assert.equal(old.ctl.collect().application_count,1);
assert.equal(old.left.application_count.value,'0',
  'Accidental account deletion removes its ticket, not return to unassigned');
const decided=scenario({application_count:1,won_count:1});
decided.add();
assert.equal(decided.ctl.collect().won_count,1);
assert.equal(decided.ctl.collect().account_entries[0].won_count,1);
assert.equal(decided.left.won_count.value,'0');
assert.equal(decided.legacy.hidden,true);
const error=scenario({application_count:1,won_count:2});
error.add();
assert.equal(error.rows.length,0,'Invalid legacy outcomes must not be moved');
assert.throws(()=>error.ctl.collect(),/未割当/);
console.log('One ticket per added account, results, deletion and legacy transfer validated');
