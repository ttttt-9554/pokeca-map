#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dir=path.join(__dirname,'..'),app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const review=fs.readFileSync(path.join(dir,'dev_unified_review_v21_124.js'),'utf8');
const sql=fs.readFileSync(path.join(dir,'supabase/lottery_card_livepocket_visibility_v21_129.sql'),'utf8');
function get(name){const start=app.indexOf('  function '+name+'('),end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,name+' helper is missing');return app.slice(start,end+'\n  }'.length);}
const url='https://livepocket.jp/e/sample-x',base={url,event_title:'元の抽選タイトル'};
const saved=new Map([[url,{event_url:url,is_hidden:true,edited_fields:[]}]]);
const {lpCardOverlay,lpCardShouldDelete}=vm.runInNewContext(
 get('lpCardOverlay')+'\n'+get('lpCardShouldDelete')+'\n({lpCardOverlay,lpCardShouldDelete})',
 {lpCardOverrides:saved},{timeout:1000});
const hidden=lpCardOverlay(base);
assert.equal(hidden.manual_card_hidden,true);
assert.equal(hidden.event_title,base.event_title);
assert.equal(lpCardShouldDelete(false,0,false,saved.get(url)),false);
saved.set(url,{event_url:url,is_hidden:true,edited_fields:['event_title'],event_title:'正式名称'});
const corrected=lpCardOverlay(base);
assert.equal(corrected.manual_card_hidden,true);
assert.equal(corrected.event_title,'正式名称');
saved.set(url,{event_url:url,is_hidden:false,edited_fields:['event_title'],event_title:'正式名称'});
const restored=lpCardOverlay(base);
assert.equal(restored.manual_card_hidden,undefined);
assert.equal(restored.event_title,'正式名称');
saved.set(url,{event_url:url,is_hidden:false,edited_fields:[]});
assert.strictEqual(lpCardOverlay(base),base);
assert.match(app,/\.update\(payload\)\.eq\('event_url',url\)/);
assert.match(app,/\.insert\(\{event_url:url,\.\.\.payload\}\)/);
assert.match(app,/if\(item\.app_lottery_hidden\|\|item\.manual_card_hidden\)return false/);
assert.match(app,/hiddenUrls=new Set\(lotteryItems\.filter\(item=>[\s\S]{0,110}item\?\.manual_card_hidden/);
assert.match(review,/item\.manual_card_hidden/);
assert.match(html,/id="lpCardHide"/);
assert.match(html,/id="lpCardRestore"/);
assert.match(html,/id="lpCardHiddenPanel"/);
assert.match(html,/id="lpCardHiddenList"/);
const parentAt=html.indexOf('<section id="lpDevUnifiedPanel"');
const parentEnd=html.indexOf('</section>',parentAt);
const nestedAt=html.indexOf('<details id="lpCardHiddenPanel"',parentAt);
assert(parentAt>=0&&nestedAt>parentAt&&nestedAt<parentEnd,
  'The hidden LivePocket archive must live inside the unified review group');
assert.match(html.slice(parentAt,parentEnd),
  /<details id="lpCardHiddenPanel" class="lp-dev-unified-group">/,
  'Restore controls must start as an inner, collapsed group');
assert.equal((html.match(/id="lpCardHiddenPanel"/g)||[]).length,1,
  'No extra standalone hidden section may remain');
assert.match(app,/\$\('lpCardHiddenPanel'\)\?\.addEventListener\('toggle'/,
  'Open handler must be attached to the nested archive itself');
assert.doesNotMatch(app,/\$\('lpCardHiddenPanel'\)\?\.closest\('details\.dev-accordion'\)/);
assert.match(sql,/ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false/);
assert.match(sql,/GRANT SELECT \(is_hidden\)/);
assert.doesNotMatch(sql,/DROP TABLE|DELETE FROM|TRUNCATE/i);
console.log('Reversible LivePocket deletion: flags, records, views, and UI verified');
