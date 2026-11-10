import assert from 'node:assert/strict';
import {recentLotteryLinks,RECENT_MS} from '../supabase/functions/lottery-discord-intake/links.mjs';

const now=Date.now(),stamp=offset=>new Date(now+offset).toISOString();
const msg=(content,offset=-1000)=>({content,timestamp:stamp(offset)});
const extracted=recentLotteryLinks([
  msg('https://www.livepocket.jp/e/test_1/?utm_source=discord https://shop.example.com/lottery/133/。'),
  msg('https://livepocket.jp/e/test_1',-2000),
  {...msg(''),embeds:[{url:'https://form.example.com/a',fields:[{value:'https://shop.example.com/lottery/133/'}]}]},
  msg('https://old.example.com/draw',-RECENT_MS-1),msg('https://future.example.com/draw',61000),
  msg('https://127.0.0.1/draw https://host.internal/draw https://user:pass@example.com/a https://example.com:22/a'),
  msg('https://x.com/name https://twitter.com/name https://discord.com/channels/123 https://ttttt-9554.github.io/pokeca-map/'),
],now);
assert.equal(extracted.length,3);
assert.equal(extracted.find(row=>row.url==='https://livepocket.jp/e/test_1').discord_posted_at,stamp(-2000));
assert(extracted.some(row=>row.url==='https://shop.example.com/lottery/133/'));
assert.equal(recentLotteryLinks([msg('https://example.com/'+ 'a'.repeat(2000))],now).length,0);

const env=new Map([['NOTIFY_SECRET','test-secret'],['DISCORD_BOT_TOKEN','test-bot'],
  ['SUPABASE_URL','https://project.supabase.co'],['SUPABASE_SERVICE_ROLE_KEY','test-service']]);
let handler;globalThis.Deno={env:{get:name=>env.get(name)},serve:fn=>{handler=fn}};
let calls=[],discordStatus=200,dbStatus=201;
globalThis.fetch=async(url,options)=>{
  calls.push({url,options});
  if(url.startsWith('https://discord.com/'))return new Response(JSON.stringify([msg('https://shop.example.com/new-draw')]),{status:discordStatus});
  assert.equal(url,'https://project.supabase.co/rest/v1/lottery_discord_intake_v1?on_conflict=url');
  return new Response(null,{status:dbStatus});
};
await import('../supabase/functions/lottery-discord-intake/index.ts');
const request=secret=>new Request('https://project.supabase.co/functions/v1/lottery-discord-intake',{
  method:'POST',headers:{'x-notify-secret':secret}});
assert.equal((await handler(request('wrong'))).status,401);assert.equal(calls.length,0);
let response=await handler(request('test-secret'));
assert.equal(response.status,200);assert.equal((await response.json()).links,1);
assert.equal(calls.length,2);assert.equal(calls[0].options.headers.Authorization,'Bot test-bot');
const stored=JSON.parse(calls[1].options.body);assert.equal(stored[0].url,'https://shop.example.com/new-draw');
assert.equal(calls[1].options.headers.Prefer,'resolution=ignore-duplicates,return=minimal');
assert(!calls.some(call=>call.url.includes('shop.example.com')),'intake must never crawl posted URLs');
calls=[];discordStatus=429;response=await handler(request('test-secret'));
assert.equal(response.status,503);assert.equal(calls.length,1,'Discord failure must not write a partial catalog');
discordStatus=200;dbStatus=503;response=await handler(request('test-secret'));
assert.equal(response.status,502,'database errors must be visible to the scheduler');
delete globalThis.Deno;
console.log('Discord intake: extraction, URL boundaries, auth, trusted endpoints, duplicate-safe writes and failures passed');
