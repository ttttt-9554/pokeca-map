'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
  const {scanAndDrainLottery}=await import('../supabase/functions/discord-notify/lottery-scan-flow.mjs');
  let drains=0,errors=0;
  const drain=async()=>{drains++;return {sent:1}};
  let result=await scanAndDrainLottery(async()=>({total:10,newlyQueued:0}),drain);
  assert.equal(drains,0);assert.equal(result.newlyQueued,0);
  result=await scanAndDrainLottery(async()=>({total:11,newlyQueued:1}),drain);
  assert.equal(drains,1);assert.equal(result.delivery.sent,1);
  result=await scanAndDrainLottery(async()=>({newlyQueued:1}),async()=>{throw Error('temporary')},()=>{errors++});
  assert.equal(result.deliveryPending,true);assert.equal(errors,1);
  await assert.rejects(scanAndDrainLottery(async()=>{throw Error('scan failed')},drain),/scan failed/);
  assert.equal(drains,1,'a failed scan must not send anything');
  const edge=fs.readFileSync('supabase/functions/discord-notify/index.ts','utf8');
  assert.match(edge,/https:\/\/ttttt-9554\.github\.io\/pokeca-map\/livepocket_public\.json/);
  assert.match(edge,/scanAndDrainLottery\(/);
  console.log('Only newly published lottery events trigger an immediate queue drain; failures retain retries');
})().catch(error=>{console.error(error);process.exitCode=1});
