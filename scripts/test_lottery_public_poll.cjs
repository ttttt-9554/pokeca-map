'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const start=source.indexOf('  function lotteryPublicVersion(data) {');
const end=source.indexOf('  async function loadLotteryEvents(',start);
assert(start>=0&&end>start);
let response={updated_at:'one',items:[]},fetches=0,loads=0,gate=null;
const ctx={
  LP_JSON_URL:'./livepocket_public.json',lotteryPublicRevision:'one',
  lotteryPublicChecking:false,lotteryLoading:null,Date,
  fetch:async()=>{fetches++;if(gate)await gate;return {ok:true,json:async()=>response}},
  loadLotteryEvents:async force=>{assert.equal(force,true);loads++;ctx.lotteryPublicRevision=response.updated_at}
};
const check=vm.runInNewContext(source.slice(start,end)+'\ncheckLotteryPublicUpdate',ctx);
(async()=>{
  await check();assert.equal(loads,0,'unchanged public catalog must not reload overlays');
  response={updated_at:'two',items:[{url:'https://livepocket.jp/e/test123'}]};
  await check();assert.equal(loads,1,'published revision must refresh the screen');
  response={updated_at:'three'};await check();assert.equal(loads,1,'invalid catalog must not refresh');
  let release;gate=new Promise(resolve=>{release=resolve});response={updated_at:'four',items:[]};
  const first=check();await Promise.resolve();const second=check();release();await Promise.all([first,second]);
  assert.equal(loads,2);assert.equal(fetches,4,'overlapping checks must make only one request');
  assert.match(source,/renderLottery\(\); void checkLotteryPublicUpdate\(\)/);
  assert.match(source,/setInterval\([\s\S]*checkLotteryPublicUpdate\(\)[\s\S]*?\}, 60000\)/);
  console.log('Published lottery updates refresh the active view without redundant overlay reads');
})().catch(error=>{console.error(error);process.exitCode=1});
