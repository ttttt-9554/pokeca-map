'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const start=source.indexOf('  function renderLotteryDiscordIntake() {');
const end=source.indexOf('  function lotteryStatusText(',start);
const elements={lpDiscordIntake:{hidden:true},lpDiscordIntakeCount:{textContent:''},lpDiscordIntakeLinks:{innerHTML:''}};
const stamp=new Date().toISOString();
let requests=0,release=null,rows=[];
const ctx={
  Date,URL,console,authUser:{id:'member'},discordRoleAuthPending:false,
  LP_DISCORD_INTAKE_TABLE:'lottery_discord_intake_v1',lotteryDiscordIntakeLoading:null,
  lotteryBaseItems:[{url:'https://livepocket.jp/e/known/'}],
  lpCardReady:true,lpExtReady:true,
  lpCardOverrides:new Map([['https://hidden.example.com/a',{is_hidden:true}]]),
  lpExtOverrides:new Map([['https://excluded.example.com/a',{state:'excluded'}]]),
  lotteryDiscordIntake:[
    {url:'https://livepocket.jp/e/known',discord_posted_at:stamp},
    {url:'https://hidden.example.com/a',discord_posted_at:stamp},
    {url:'https://excluded.example.com/a',discord_posted_at:stamp},
    {url:'https://old.example.com/a',discord_posted_at:'2020-01-01T00:00:00Z'},
    {url:'https://livepocket.jp/e/new01',discord_posted_at:stamp},
    {url:'https://shop.example.com/a?x=<script>',discord_posted_at:stamp}
  ],
  $:id=>elements[id],lotteryDate:Date.parse,lotteryJapaneseDate:()=>stamp,
  escape:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  isLivePocketEventUrl:url=>url.startsWith('https://livepocket.jp/e/'),
  safeLotteryUrl:url=>/^https:\/\//.test(url),
  supabaseClient:{from:name=>{
    assert.equal(name,'lottery_discord_intake_v1');requests++;
    return {select:()=>({order:()=>({limit:()=>new Promise(resolve=>{release=()=>resolve({data:rows,error:null})})})})};
  }}
};
const api=vm.runInNewContext(source.slice(start,end)+'\n({renderLotteryDiscordIntake,lpDiscordIntakeRefresh})',ctx);
api.renderLotteryDiscordIntake();
assert.equal(elements.lpDiscordIntake.hidden,false);assert.equal(elements.lpDiscordIntakeCount.textContent,'2件');
assert(!elements.lpDiscordIntakeLinks.innerHTML.includes('<script>'),'posted URL labels must be escaped');
assert(!elements.lpDiscordIntakeLinks.innerHTML.includes('excluded.example'));
ctx.lotteryBaseItems.push({url:'https://livepocket.jp/e/new01'});api.renderLotteryDiscordIntake();
assert.equal(elements.lpDiscordIntakeCount.textContent,'1件','preview disappears when a complete card arrives');
ctx.lpExtReady=false;api.renderLotteryDiscordIntake();
assert.equal(elements.lpDiscordIntake.hidden,true,'wait for manual exclusions before showing external previews');
ctx.lpExtReady=true;ctx.discordRoleAuthPending=true;api.renderLotteryDiscordIntake();
assert.equal(elements.lpDiscordIntake.hidden,true);
ctx.discordRoleAuthPending=false;ctx.authUser=null;api.renderLotteryDiscordIntake();
assert.equal(elements.lpDiscordIntakeLinks.innerHTML,'','logout clears the preview DOM');
(async()=>{
  await api.lpDiscordIntakeRefresh();assert.equal(requests,0,'signed-out visitors must not query the intake');
  ctx.authUser={id:'member'};rows=[{url:'https://new.example.com/a',discord_posted_at:stamp}];
  const first=api.lpDiscordIntakeRefresh(),second=api.lpDiscordIntakeRefresh();
  assert.equal(requests,1,'overlapping refreshes must share a single query');
  ctx.authUser={id:'another-member'};release();await Promise.all([first,second]);
  assert(!ctx.lotteryDiscordIntake.some(row=>row.url==='https://new.example.com/a'),
    'a response for an old account must not update the next account');
  console.log('Discord previews: complete-card replacement, exclusions, escaping, logout and auth races passed');
})().catch(error=>{console.error(error);process.exitCode=1});
