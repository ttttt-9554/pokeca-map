#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dir=path.join(__dirname,'..'),app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
const html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const review=fs.readFileSync(path.join(dir,'dev_unified_review_v21_124.js'),'utf8');
const sql=fs.readFileSync(path.join(dir,'supabase/lottery_card_livepocket_visibility_v21_129.sql'),'utf8');
function get(name){const start=app.search(new RegExp('^  (?:async )?function '+name+'\\(','m')),end=app.indexOf('\n  }\n',start);
 assert(start>=0&&end>start,name+' helper is missing');return app.slice(start,end+'\n  }'.length);}
const url='https://livepocket.jp/e/sample-x',base={url,event_title:'元の抽選タイトル'};
const saved=new Map([[url,{event_url:url,is_hidden:true,edited_fields:[]}]]);
const {lpCardOverlay,lpCardShouldDelete}=vm.runInNewContext(
 get('lpCardOverlay')+'\n'+get('lpCardShouldDelete')+'\n({lpCardOverlay,lpCardShouldDelete})',
 {lpCardOverrides:saved,LOTTERY_SHARED_SCHEDULE_FIELDS:[]},{timeout:1000});
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
assert.match(app,/if\(item\.app_lottery_hidden\|\|item\.manual_card_hidden\)return false/);
assert.match(app,/hiddenUrls=new Set\(lotteryItems\.filter\(item=>[\s\S]{0,110}item\?\.manual_card_hidden/);
assert.match(review,/item\.manual_card_hidden/);
assert.match(html,/id="lpCardHide"/);
assert.match(html,/id="lpCardRestore"/);
assert.match(html,/id="lpCardHiddenPanel"/);
assert.match(html,/id="lpCardHiddenList"/);
assert.match(html,/id="lpCardEditorTabs"/);
assert.match(html,/id="lpCardEditTab"/);
assert.match(html,/id="lpCardHiddenTab"/);
assert.match(html,/id="lpCardHiddenPane"/);
assert.match(html,/id="lpCardHiddenModalList"/);
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
async function checkVisibilityActions(){
  const seven='https://7net.omni7.jp/general/027016/fair-hobby-pokemoncardgame30th.html';
  const rows=new Map(), nodes=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false});
    return nodes.get(id);
  };
  let approved=true, writes=0, failRead=false, failWrite=false, loseReply=false;
  function mutation(eventUrl,patch,create){
    return {select(){return {async maybeSingle(){
      writes++;
      if(failWrite)return {error:Error('更新できません')};
      const before=rows.get(eventUrl);
      if(!before&&!create)return {data:null,error:null};
      const row={event_url:eventUrl,edited_fields:[],...before,...patch};
      rows.set(eventUrl,row);
      return loseReply?{error:Error('応答切断')}:{data:{...row},error:null};
    }}}};
  }
  const table={
    upsert(patch,options){
      assert.equal(options.onConflict,'event_url');
      assert.deepEqual(Object.keys(patch).sort(),['event_url','is_hidden','updated_at','updated_by']);
      return mutation(patch.event_url,patch,true);
    },
    update(patch){return {eq(key,eventUrl){
      assert.equal(key,'event_url');
      assert.deepEqual(Object.keys(patch).sort(),['is_hidden','updated_at','updated_by']);
      return mutation(eventUrl,patch,false);
    }}}
  };
  const ctx=vm.createContext({
    URL, $:node, isDeveloper:()=>true, authUser:{id:'test-developer'}, confirm:()=>approved,
    lpCardReady:true, lpCardBusy:false, lpCardLoading:null,
    LP_CARD_TABLE:'lottery_card_overrides', LP_CARD_SELECT:'*',
    lpCardOverrides:new Map(), lpExtOverrides:new Map(), lpCloudApply:()=>{},
    supabaseClient:{from(name){assert.equal(name,'lottery_card_overrides');return table;}},
    lpCardRefresh:async()=>{
      if(failRead)return false;
      ctx.lpCardOverrides=new Map(rows);
      return true;
    }
  });
  const change=vm.runInContext(get('safeLotteryUrl')+'\n'+get('lpCardVisibilityChange')+'\nlpCardVisibilityChange',ctx);
  const feedback=node('lpCardHiddenModalFeedback');
  approved=false;
  assert.equal(await change(seven,true,true),false);
  approved=true;
  assert.equal(await change('javascript:alert(1)',true,true),false);
  ctx.lpCardReady=false;
  assert.equal(await change(seven,true,true),false);
  assert.match(feedback.textContent,/更新/);
  ctx.lpCardReady=true;
  assert.equal(writes,0);

  const hide=change(seven,true,true);
  assert.equal(await change(seven,true,true),false,'ignore a double tap while saving');
  assert.equal(await hide,true);
  assert.equal(writes,1);
  assert.equal(ctx.lpCardOverrides.get(seven).is_hidden,true);
  assert.match(feedback.textContent,/非表示にしました/);
  assert.equal(await change(seven,false,true),true);
  assert.equal(rows.get(seven).is_hidden,false);
  assert.match(feedback.textContent,/一覧に復元/);

  // Another editor saved field corrections after this client loaded the card.
  const corrected={event_url:seven,event_title:'修正した抽選名',edited_fields:['event_title'],review_complete:true};
  rows.set(seven,corrected);
  ctx.lpCardOverrides.clear();
  failRead=true;
  assert.equal(await change(seven,true,true),true);
  assert.equal(ctx.lpCardOverrides.get(seven).is_hidden,true,'apply the acknowledged row if reloading fails');
  assert.equal(ctx.lpCardOverrides.get(seven).event_title,corrected.event_title);
  failRead=false;
  failWrite=true;
  assert.equal(await change(seven,false,true),false);
  assert.equal(rows.get(seven).is_hidden,true);
  assert.match(feedback.textContent,/更新できません/);
  assert.equal(node('lpCardRestore').disabled,false);
  failWrite=false;
  loseReply=true;
  ctx.lpExtOverrides.set(seven,{state:'excluded'});
  assert.equal(await change(seven,false,true),true,'reconcile a lost write response');
  assert.equal(rows.get(seven).is_hidden,false);
  assert.equal(rows.get(seven).review_complete,true);
  assert.deepEqual(rows.get(seven).edited_fields,['event_title']);
  assert.match(feedback.textContent,/外部抽選の除外設定/);
  loseReply=false;
  assert.equal(await change(url,true),true);
  assert.equal(await change(url,false),true);
  assert.match(node('lpCardHiddenFeedback').textContent,/一覧に復元/);
}
checkVisibilityActions().then(()=>console.log('LivePocket and external card visibility, writes, and recovery verified'))
  .catch(error=>{console.error(error);process.exitCode=1;});
