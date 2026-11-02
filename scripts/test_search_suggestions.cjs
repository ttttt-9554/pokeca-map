#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'search_inputs_v1.js'),'utf8');
const plaza=fs.readFileSync(path.join(root,'info_plaza_sales_v1.js'),'utf8');
function fn(text,name){
  const start=text.indexOf('  function '+name+'('),end=text.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing '+name);return text.slice(start,end+5);
}
const ctx={config:{suggestions:()=>[
  {value:'神の支配',search:'OP-18',detail:'ワンピース'},
  {value:'神の支配',detail:'同一商品'},
  {value:'メガブレイブ',search:'めがぶれいぶ'},
  {value:'同じ店名',prefecture:'栃木県'},
  {value:'同じ店名',prefecture:'東京都'}
]}};
const api=vm.runInNewContext([
  fn(app,'productNorm'),'const normalize=productNorm;',fn(ui,'candidates'),
  fn(ui,'close'),fn(ui,'renderMatches'),
  '({candidates,renderMatches})'
].join('\n'),ctx);
const query=value=>api.candidates({input:{value},nativeList:{options:[{value:'神の支配'}]}});
assert.equal(query('').length,0,'Focus on an empty input never lists everything');
assert.equal(query('　 ').length,0,'Whitespace also keeps suggestions closed');
assert.equal(query('一致しない文字').length,0);
assert.equal(query('OP-18')[0].value,'神の支配','Aliases select the canonical name');
assert.equal(query('めがぶれいぶ')[0].value,'メガブレイブ');
assert.equal(query('神の支配').length,1,'Master and native-list duplicates are suppressed');
assert.equal(query('同じ店名').length,2,'Same-name branches retain separate prefectures');
for(const value of ['', '存在しない']){
  const attributes={};
  const state={input:{value,setAttribute:(k,v)=>{attributes[k]=v},removeAttribute:k=>delete attributes[k]},
    list:{hidden:false},revision:0,active:1,composing:false};
  api.renderMatches(state);
  assert.equal(state.list.hidden,true);
  assert.equal(attributes['aria-expanded'],'false');
}
ctx.config.suggestions=()=>Array.from({length:120},(_,i)=>({value:'商品'+i}));
assert.equal(query('商品').length,60,'Matching lists are bounded');

// The existing Information Plaza store picker follows the same condition.
const field={value:'',setAttribute(){}},dropdown={hidden:false},toggle={setAttribute(){}};
const info={
  $:id=>({infoSalesStore:field,infoSalesStoreSuggestions:dropdown,infoSalesStoreToggle:toggle}[id]),
  authorized:true,canAccess:()=>true,normalize:value=>String(value).trim(),
  masterChoices:new Map([['栃木県｜宇都宮店',{name:'宇都宮店',prefecture:'栃木県'}]]),
  matchingMasterChoices:[],masterSuggestionsOpen:false,masterSuggestionIndex:-1,
  masterLoaded:true,masterBusy:false,escape:value=>String(value)
};
const infoApi=vm.runInNewContext(fn(plaza,'hideStoreSuggestions')+'\n'+
  fn(plaza,'renderStoreSuggestions')+'\n({renderStoreSuggestions})',info);
infoApi.renderStoreSuggestions(true);assert.equal(dropdown.hidden,true);
field.value='宇都宮';infoApi.renderStoreSuggestions(true);assert.equal(dropdown.hidden,false);
field.value='一致なし';infoApi.renderStoreSuggestions(true);assert.equal(dropdown.hidden,true);
field.value='';infoApi.renderStoreSuggestions(true);assert.equal(dropdown.hidden,true);
console.log('Search suggestions: empty/whitespace/unmatched stay closed; aliases, kana and matching stores pass');
