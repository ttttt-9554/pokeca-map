#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
function take(name){const i=app.indexOf('  function '+name+'('),j=app.indexOf('\n  }\n',i);
  assert(i>=0&&j>i,name+' helper missing');return app.slice(i,j+'\n  }'.length);}
const context={window:{TorecaUnifiedReview:{
  validStore:x=>!!x&&!['店舗未確認','店名未確認','未確認'].includes(x),
  validArea:x=>['栃木県','東京都','全国'].includes(x)
}},LP_MANUAL_AREAS:['栃木県','東京都','全国']};
const {lpCardShouldDelete:del,lpCardVerifiedStores:valid}=vm.runInNewContext(
  take('lpCardShouldDelete')+'\n'+take('lpCardVerifiedStores')+
  '\n({lpCardShouldDelete,lpCardVerifiedStores})',context,{timeout:1000});
assert.equal(del(false,0,false,{review_complete:true,edited_fields:['stores']}),false);
assert.equal(del(false,0,false,{review_complete:true,edited_fields:[]}),false);
assert.equal(del(false,0,false,{review_complete:false}),true);
assert.equal(del(false,2,false,{review_complete:false}),false);
assert.equal(del(false,0,true,null),false);
assert.equal(del(true,0,false,{review_complete:true}),true);
assert.equal(valid([{name:'宇都宮店',prefecture:'栃木県'}]),true);
assert.equal(valid([{name:'宇都宮店',prefecture:'全国'}]),true);
assert.equal(valid([{name:'店名未確認',prefecture:'栃木県'}]),false);
assert.equal(valid([{name:'宇都宮店',prefecture:'未確認県'}]),false);
assert.equal(valid([{name:'宇都宮店',prefecture:'東京都'},{name:'',prefecture:'栃木県'}]),false);
assert.equal(valid([]),false);
console.log('12 confirmation preservation and store validation checks passed');
