#!/usr/bin/env node
'use strict';
// A personal account allocation should consume legacy tickets rather than
// inflate the public application total. Fully assigned zero-balance rows vanish.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');

function functionSource(name){
  const start=app.indexOf('  function '+name+'(');
  const end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,name+' not found in app.js');
  return app.slice(start,end+5);
}
const balance=vm.runInNewContext(
  functionSource('lpTrackerUnassignedAfterEdit')+
  '\n(lpTrackerUnassignedAfterEdit)',{},{timeout:1000});
assert.equal(balance(2,0,1),1);
assert.equal(balance(2,0,2),0);
assert.equal(balance(2,0,3),0); // excess is genuinely new
assert.equal(balance(1,1,2),0);
assert.equal(balance(0,2,1),1); // reversing an assignment
assert.equal(balance(2,2,0),4);
assert.equal(balance(2,-1,1),null);
assert.equal(balance(0,2,10000),null);

const fields=['application_count','won_count','lost_count'];
const accountId='11111111-1111-4111-8111-111111111111';
const profile={id:accountId,label:'自分',is_default:true,is_archived:false};
const makeInput=(field,value)=>({
  value:String(value),
  getAttribute(name){
    return name==='data-lp-account-count'?field:null;
  },
  matches(selector){return selector==='[data-lp-account-count]';},
  closest(){return this.row||null;}
});
function mockRow(values,id=null){
  const inputs=Object.fromEntries(fields.map(k=>[k,makeInput(k,values[k]||0)]));
  const row={
    id,
    inputs,
    querySelector(selector){
      const m=selector.match(/data-lp-account-count="([^"]+)"/);
      if(m)return inputs[m[1]];
      if(selector==='[data-lp-account-id]')return this.select;
      return null;
    },
    remove(){const i=active.indexOf(this);if(i>=0)active.splice(i,1);}
  };
  row.select={value:id||''};
  for(const key of fields)inputs[key].row=id?row:null;
  return row;
}
let active=[];
const unassigned=mockRow({application_count:2,won_count:0,lost_count:0});
const owned=mockRow({application_count:0,won_count:0,lost_count:0},accountId);
active=[owned];
const moveBtn={hidden:false};
const listeners={};
const root={
  addEventListener(type,cb){listeners[type]=cb;},
  querySelector(selector){return selector==='#lpTrackAssignLegacy'?moveBtn:null;}
};
const holder={
  querySelectorAll(selector){
    assert.equal(selector,'[data-lp-account-row]');return active;
  },
  insertAdjacentHTML(){throw Error('Adding extra rows is not part of this test');}
};
const el={
  lpTrackPrivateAccounts:root,
  lpTrackAccountRows:holder,
  lpTrackUnassigned:unassigned,
  lpTrackEditorMessage:{textContent:''}
};
const form={elements:Object.fromEntries(fields.map(k=>[k,{value:'0',readOnly:false}]))};
const accountContext={
  $:id=>el[id]||null,
  lpPrivateAccounts:new Map([[accountId,profile]]),
  lpPrivateAccountDefault:()=>profile,
  lpPrivateAccountRows:()=>[profile]
};
const api=vm.runInNewContext([
  functionSource('lpTrackerUnassignedAfterEdit'),
  functionSource('lpTrackerPrivateBind')
].join('\n')+'\n({lpTrackerPrivateBind})',accountContext,{timeout:1000});
const ctl=api.lpTrackerPrivateBind(form,()=>{});
const input=(field,next,row=owned)=>{
  const target=row.inputs[field];
  target.value=String(next);
  listeners.input({target});
};
assert.equal(unassigned.hidden,false);
assert.equal(moveBtn.hidden,false);
assert.equal(form.elements.application_count.value,'2');
assert.equal(ctl.collect().application_count,2);
input('application_count',1);
assert.equal(unassigned.inputs.application_count.value,'1');
assert.equal(owned.inputs.application_count.value,'1');
assert.equal(form.elements.application_count.value,'2');
assert.equal(unassigned.hidden,false);
input('application_count',2);
assert.equal(unassigned.inputs.application_count.value,'0');
assert.equal(form.elements.application_count.value,'2');
assert.equal(unassigned.hidden,true);
assert.equal(moveBtn.hidden,true);
assert.deepEqual(
  JSON.parse(JSON.stringify(ctl.collect().account_entries)),
  [{account_id:accountId,application_count:2,won_count:0,lost_count:0}]);
input('application_count',1);
assert.equal(unassigned.inputs.application_count.value,'1');
assert.equal(form.elements.application_count.value,'2');
assert.equal(unassigned.hidden,false);
assert.equal(moveBtn.hidden,false);
input('application_count',0);
assert.equal(unassigned.inputs.application_count.value,'2');
assert.equal(form.elements.application_count.value,'2');
input('application_count',3);
assert.equal(unassigned.inputs.application_count.value,'0');
assert.equal(form.elements.application_count.value,'3');
assert.equal(unassigned.hidden,true);
input('application_count',-1);
assert.equal(owned.inputs.application_count.value,'3');
assert.equal(form.elements.application_count.value,'3');
assert.match(el.lpTrackEditorMessage.textContent,/0～9999/);

// Returning allocated tickets and recorded outcomes to the unassigned pool.
input('application_count',2);
assert.equal(unassigned.inputs.application_count.value,'1');
unassigned.inputs.won_count.value='1';
unassigned.inputs.lost_count.value='0';
listeners.input({target:unassigned.inputs.won_count});
assert.equal(unassigned.hidden,false);
input('won_count',1);
assert.equal(unassigned.inputs.won_count.value,'0');
assert.equal(owned.inputs.won_count.value,'1');
assert.equal(unassigned.inputs.application_count.value,'1');
const saved=ctl.collect();
assert.equal(saved.application_count,3);
assert.equal(saved.won_count,1);
assert.equal(saved.account_entries[0].won_count,1);
input('application_count',3);
assert.equal(unassigned.hidden,true);
assert.equal(unassigned.inputs.application_count.value,'0');

// Existing rows with no unassigned tickets should render hidden up front.
const markup=vm.runInNewContext(
 [functionSource('lpTrackerAccountInput'),functionSource('lpTrackerAccountRowHtml'),
 functionSource('lpTrackerPrivateMarkup')].join('\n')+'\n(lpTrackerPrivateMarkup)',
 {lpPrivateAccountRows:()=>[profile],lpPrivateAccountDefault:()=>profile,
  escape:String},{timeout:1000});
const newly=markup({application_count:2,won_count:0,lost_count:0,
 account_entries:[{account_id:accountId,application_count:2,won_count:0,lost_count:0}]});
assert.match(newly,/id="lpTrackUnassigned" hidden/);
assert.match(newly,/id="lpTrackAssignLegacy" hidden/);
const historic=markup({application_count:2,won_count:0,lost_count:0,account_entries:[]});
assert.doesNotMatch(historic,/id="lpTrackUnassigned" hidden/);
console.log('Unassigned lottery balances transfer and hide correctly');
