'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const start=source.indexOf('  function lotteryPublicVersion(data) {');
const end=source.indexOf('  function renderLotteryDiscordIntake()',start);
assert(start>=0&&end>start);
const lp='./livepocket_public.json',ext='./other_lottery_public.json';
const raw='https://raw.githubusercontent.com/ttttt-9554/pokeca-map/main/';
const elements={lpRefresh:{disabled:false},lpLoadStatus:{textContent:''}};
let feeds={},requests=[],draws=0,overlays=0,gate=null;
const ctx={
  LP_JSON_URL:lp,LP_OTHER_JSON_URL:ext,LP_RAW_CATALOG:raw,LP_REFRESH_MS:300000,
  lotteryPublicCatalogs:new Map(),lotteryLoading:null,lotteryItems:[],lotteryBaseItems:[],
  lotteryLastFetch:0,Date,AbortController,setTimeout,clearTimeout,Intl,Promise,console,
  window:{location:{origin:'https://ttttt-9554.github.io'}},
  supabaseClient:{},$:id=>elements[id],
  fetch:async url=>{requests.push(url);if(gate)await gate;
    const key=url.replace(/\?.*$/,'');const data=feeds[key];
    if(data instanceof Error)throw data;
    return {ok:data!==undefined,status:data===undefined?503:200,text:async()=>JSON.stringify(data)};
  },
  safeLotteryUrl:url=>/^https:\/\//.test(url),
  isLivePocketEventUrl:url=>url.startsWith('https://livepocket.jp/e/'),
  lpAppMergedItems:()=>[],lpCloudApply:()=>{ctx.lotteryItems=ctx.lotteryBaseItems},
  lpExtRefresh:async()=>{overlays++},lpCardRefresh:async()=>{overlays++},lpAppRefresh:async()=>{overlays++},
  renderLotteryPrefectures:()=>{},renderLottery:()=>{draws++},lotteryJapaneseDate:()=>'',
  refreshLotteryOnsiteReports:()=>{},
};
const api=vm.runInNewContext(source.slice(start,end)+'\n({fetchLotteryPublicCatalog,checkLotteryPublicUpdate,loadLotteryEvents})',ctx);
const version='2026-11-10T10:00:00Z',later='2026-11-10T11:00:00Z';
const lpItem={url:'https://livepocket.jp/e/abcd1'};
const external={url:'https://example.com/draw'};
const setFeed=(path,data)=>{feeds[raw+path.slice(2)]=data};
(async()=>{
  setFeed(lp,{updated_at:version,items:[lpItem]});setFeed(ext,{collected_at:version,items:[]});
  await api.loadLotteryEvents(true);
  assert.equal(ctx.lotteryItems.length,1);assert.equal(overlays,3);
  assert(!elements.lpLoadStatus.textContent.includes('読み込めません'));
  assert(requests.every(url=>url.startsWith(raw)),'production reads collected files before Pages deploys');
  const firstDraws=draws;
  await api.checkLotteryPublicUpdate();
  assert.equal(draws,firstDraws,'unchanged catalogs must not redraw');
  assert.equal(overlays,3,'background checks must not reread all overlays');
  setFeed(ext,{collected_at:later,items:[external,lpItem,external,{url:'javascript:alert(1)'}]});
  await api.checkLotteryPublicUpdate();
  assert.equal(ctx.lotteryItems.length,2,'external-only updates appear, with duplicates and invalid URLs excluded');
  assert.equal(draws,firstDraws+1);assert.equal(overlays,3);
  setFeed(ext,new Error('offline'));feeds[ext]={collected_at:version,items:[]};
  await api.checkLotteryPublicUpdate();
  assert.equal(ctx.lotteryItems.length,2,'older Pages fallback must not roll back a newer catalog');
  feeds[ext]={collected_at:later,items:[]};
  await api.checkLotteryPublicUpdate();
  assert.equal(ctx.lotteryItems.length,2,'same-revision Pages fallback must not replace the raw revision');
  feeds[ext]=undefined;
  setFeed(lp,{updated_at:later,items:[lpItem,{url:'https://livepocket.jp/e/abcd2'}]});
  await api.checkLotteryPublicUpdate();
  assert.equal(ctx.lotteryItems.length,3,'one failed feed preserves its cached items while the other updates');
  const before=requests.length;let release;gate=new Promise(resolve=>{release=resolve});
  const first=api.checkLotteryPublicUpdate(),second=api.checkLotteryPublicUpdate();
  release();await Promise.all([first,second]);gate=null;
  assert.equal(requests.length-before,3,'overlapping checks share one pair of feed requests and fallback');
  ctx.window.location.origin='http://localhost:8000';
  feeds[lp]={updated_at:'2026-11-10T12:00:00Z',items:[]};
  const local=await api.fetchLotteryPublicCatalog(lp);
  assert.equal(local.url,lp,'local and fork previews keep their own data');
  assert.match(source,/void checkLotteryPublicUpdate\(\)/);
  assert.match(source,/setInterval\([\s\S]*checkLotteryPublicUpdate\(\)[\s\S]*?\}, 60000\)/);
  console.log('Lottery catalog polling: both feeds, no stale rollback, deduplication, failures and concurrent checks passed');
})().catch(error=>{console.error(error);process.exitCode=1});
