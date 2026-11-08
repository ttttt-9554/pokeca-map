#!/usr/bin/env node
'use strict';
// Offline event-lifecycle regression. No auth session, network or real user writes.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'lottery_application_return_v1.js'),'utf8');
const app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'style.css'),'utf8');
const ONE='https://livepocket.jp/e/return1',TWO='https://example.com/lottery/return2';
const KEY='toreca-lottery-application-return-v1',NOW=2000000000000;
const saved=(url=ONE,owner='user-a')=>({url,owner,openedAt:NOW,left:true});
class Events{
  constructor(){this.listeners=new Map();}
  addEventListener(type,fn){
    if(!this.listeners.has(type))this.listeners.set(type,[]);
    this.listeners.get(type).push(fn);
  }
  fire(type,properties={}){
    const event={type,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...properties};
    for(const fn of this.listeners.get(type)||[])fn(event);
    return event;
  }
}
function fixture(options={}){
  const document=new Events(),window=new Events(),nodes=[],timers=new Map();
  const storage=new Map(options.saved?[[KEY,JSON.stringify(options.saved)]]:[]);
  let now=NOW,sequence=0;
  const timerDelays=[];
  class Element extends Events{
    constructor(tag){super();this.tag=tag;this.open=false;this.textContent='';this.disabled=false;this.fields=new Map();}
    setAttribute(name,value){this[name]=value;}
    set innerHTML(value){
      this.markup=value;
      for(const selector of ['#lpApplicationReturnTitle','#lpApplicationReturnEvent',
        '#lpApplicationReturnStore','#lpApplicationReturnProduct',
        '#lpApplicationReturnDescription','#lpApplicationReturnHint','#lpApplicationReturnStatus',
        '[data-return-close]','[data-return-skip]','[data-return-register]'])
        this.fields.set(selector,new Element(selector));
    }
    querySelector(selector){return this.fields.get(selector)||null;}
    querySelectorAll(selector){return selector==='button'?[...this.fields].filter(([key])=>key.startsWith('[data-return-')).map(([,node])=>node):[];}
    focus(){document.activeElement=this;}
    showModal(){this.open=true;this.showCount=(this.showCount||0)+1;}
    close(){this.open=false;this.fire('close');document.fire('close',{target:this});}
  }
  document.visibilityState='visible';
  document.createElement=tag=>new Element(tag);
  document.body={append:node=>nodes.push(node)};
  document.querySelector=selector=>selector==='dialog[open]'?nodes.find(node=>node.open)||null:null;
  const state={uid:options.uid??'user-a',prepareResult:true,saveResult:true,prepareCalls:[],writes:[],editors:[],contexts:new Map()};
  for(const url of [ONE,TWO])state.contexts.set(url,{ready:true,eligible:true,registered:false,
    title:'抽選 '+url,storeLabel:'サンプル宇都宮店（栃木県）',productName:'サンプル拡張パック',needsEditor:false});
  const api={
    getUserId:()=>state.uid,
    getContext:url=>state.contexts.get(url),
    prepare:async owner=>{state.prepareCalls.push(owner);if(state.prepareHook)await state.prepareHook();return state.prepareResult;},
    register:async(url,owner)=>{state.writes.push({url,owner});if(state.saveHook)await state.saveHook();return state.saveResult;},
    openEditor:async(url,owner)=>{state.editors.push({url,owner});}
  };
  const context={window,document,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    Date:class extends Date{static now(){return now;}},
    setTimeout:(fn,delay)=>{const id=++sequence;timerDelays.push(delay);timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(source,context,{timeout:1000});
  window.TorecaApplicationReturn.init(api);
  const flush=async()=>{
    for(let n=0;n<20;n++){
      const queued=[...timers.values()];timers.clear();queued.forEach(fn=>fn());
      await Promise.resolve();
    }
  };
  const click=(url=ONE,properties={})=>{
    const link={dataset:{lpApplicationReturn:url},closest:selector=>selector==='#lpCards'&&!properties.outside?{}:null};
    return document.fire('click',{button:0,target:{closest:()=>properties.unrelated?null:link},...properties});
  };
  const away=()=>{document.visibilityState='hidden';document.fire('visibilitychange');window.fire('blur');};
  const back=()=>{document.visibilityState='visible';document.fire('visibilitychange');window.fire('focus');window.fire('pageshow');};
  const dialog=()=>nodes.find(node=>node.id==='lpApplicationReturnDialog');
  return {state,window,document,storage,flush,click,away,back,dialog,timerDelays,
    button:selector=>dialog().querySelector('[data-return-'+selector+']').fire('click'),
    changeUser:uid=>{state.uid=uid;window.TorecaApplicationReturn.onAuthChanged();},
    advance:ms=>{now+=ms;},otherDialog:()=>{const d=new Element('dialog');nodes.push(d);d.showModal();return d;}};
}
async function prompt(f,url=ONE){f.click(url);f.away();f.back();await f.flush();assert.equal(f.dialog()?.open,true);}
async function main(){
  let f=fixture();f.click();await f.flush();
  assert.equal(f.dialog(),undefined,'Opening a link alone must not prompt or save');
  assert.equal(f.state.writes.length,0);
  f.away();f.back();await f.flush();
  assert.equal(f.dialog().open,true);
  assert.equal(f.state.prepareCalls.length,0,'Returning uses loaded card data without waiting for cloud requests');
  assert.equal(Math.max(...f.timerDelays),0,'Return signals have no fixed display delay');
  assert.equal(f.dialog().querySelector('#lpApplicationReturnStore').textContent,'サンプル宇都宮店（栃木県）');
  assert.equal(f.dialog().querySelector('#lpApplicationReturnProduct').textContent,'サンプル拡張パック');
  assert.equal(f.dialog().showCount,1,'Overlapping focus, pageshow and visibility signals create one prompt');
  assert.equal(f.state.writes.length,0,'Returning alone must never register an application');
  f.button('skip');await f.flush();f.back();await f.flush();
  assert.equal(f.dialog().open,false);assert.equal(f.storage.has(KEY),false);assert.equal(f.state.writes.length,0);

  for(const option of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true},{outside:true},{unrelated:true}]){
    f=fixture();f.click(ONE,option);f.away();f.back();await f.flush();assert.equal(f.dialog(),undefined);
  }
  f=fixture();f.changeUser('');f.click();f.away();f.back();await f.flush();assert.equal(f.dialog(),undefined);
  f=fixture();f.state.contexts.get(ONE).registered=true;f.click();f.away();f.back();await f.flush();assert.equal(f.dialog(),undefined);
  f=fixture();f.click();f.state.contexts.get(ONE).registered=true;f.away();f.back();await f.flush();assert.equal(f.dialog(),undefined);
  f=fixture();f.click();f.state.contexts.get(TWO).registered=true;f.click(TWO);f.away();f.back();await f.flush();assert.equal(f.storage.has(KEY),false,'Ineligible links clear stale reminders');

  for(const action of ['close','cancel']){
    f=fixture();await prompt(f);
    if(action==='close')f.button('close');else assert.equal(f.dialog().fire('cancel').defaultPrevented,true);
    await f.flush();assert.equal(f.state.writes.length,0);assert.equal(f.storage.has(KEY),false);
  }
  f=fixture();await prompt(f);f.dialog().fire('click',{target:f.dialog()});assert.equal(f.dialog().open,true,'Backdrop taps do not register or dismiss');
  let release;f.state.saveHook=()=>new Promise(resolve=>{release=resolve;});
  f.button('register');f.button('register');await f.flush();
  assert.equal(f.state.writes.length,1,'Rapid confirmation cannot submit twice');
  f.dialog().fire('cancel');assert.equal(f.dialog().open,true,'Saving cannot be cancelled halfway');
  release();await f.flush();assert.equal(f.dialog().open,false);assert.equal(f.storage.has(KEY),false);

  f=fixture();f.state.contexts.get(ONE).needsEditor=true;await prompt(f);
  assert.equal(f.dialog().querySelector('[data-return-register]').textContent,'応募登録へ進む');
  f.button('register');await f.flush();assert.equal(f.state.editors.length,1);assert.equal(f.state.writes.length,0);
  assert.equal(f.dialog().open,false);
  f=fixture();await prompt(f);f.state.contexts.get(ONE).registered=true;f.button('register');await f.flush();assert.equal(f.state.writes.length,0,'Recheck cloud state before confirming');

  f=fixture();f.state.prepareResult=false;await prompt(f);
  assert.equal(f.state.prepareCalls.length,0,'A slow or offline cloud must not delay the confirmation');
  f.button('register');await f.flush();assert.equal(f.state.writes.length,0);
  assert.match(f.dialog().querySelector('#lpApplicationReturnStatus').textContent,/登録できませんでした/);
  f.state.prepareResult=true;
  f.state.saveResult=false;f.button('register');await f.flush();
  assert.equal(f.dialog().open,true);assert.match(f.dialog().querySelector('#lpApplicationReturnStatus').textContent,/登録できませんでした/);
  assert.equal(f.storage.has(KEY),true);f.state.saveResult=true;f.button('register');await f.flush();assert.equal(f.dialog().open,false);
  f=fixture();await prompt(f);f.state.prepareResult=false;f.button('register');await f.flush();assert.equal(f.state.writes.length,0);

  f=fixture();f.click();f.away();f.changeUser('user-b');f.back();await f.flush();assert.equal(f.dialog(),undefined);assert.equal(f.storage.has(KEY),false);
  f=fixture();await prompt(f);f.changeUser('');assert.equal(f.dialog().open,false);assert.equal(f.storage.has(KEY),false);
  f=fixture({saved:saved(),uid:''});await f.flush();assert.equal(f.dialog(),undefined);
  f.changeUser('user-a');await f.flush();assert.equal(f.dialog().open,true,'Same-user session restoration retains reminder');
  f=fixture({saved:{...saved(),openedAt:NOW-31*60*1000}});await f.flush();assert.equal(f.dialog(),undefined);assert.equal(f.storage.has(KEY),false);
  f=fixture();f.click();f.away();f.advance(31*60*1000);f.back();await f.flush();assert.equal(f.dialog(),undefined);

  f=fixture({saved:saved()});await f.flush();assert.equal(f.dialog().open,true,'A return after reload is supported');
  f=fixture({saved:{...saved(),left:false}});await f.flush();assert.equal(f.dialog(),undefined,'Visible reload without leaving is not a return');
  f=fixture();const other=f.otherDialog();f.click();f.away();f.back();await f.flush();assert.equal(f.dialog(),undefined);
  other.close();await f.flush();assert.equal(f.dialog().open,true,'Defer until the existing editor closes');

  f=fixture();f.state.prepareHook=()=>new Promise(()=>{});await prompt(f);
  assert.equal(f.state.prepareCalls.length,0,'An unresolved cloud refresh cannot hold up a ready card');
  f.button('register');await f.flush();assert.equal(f.state.prepareCalls.length,1);
  assert.equal(f.state.writes.length,0,'Registration still waits for the latest cloud records');

  f=fixture();let prepareRelease;f.state.contexts.get(ONE).ready=false;
  f.state.prepareHook=()=>new Promise(resolve=>{prepareRelease=resolve;});
  f.click();f.away();f.back();await f.flush();
  assert.equal(f.dialog(),undefined,'Reloads without local card data may still load the event first');
  f.click(TWO);f.away();f.back();await f.flush();
  assert.match(f.dialog().querySelector('#lpApplicationReturnEvent').textContent,/return2/,'Loaded cards bypass an older pending refresh');
  f.state.prepareHook=null;prepareRelease();await f.flush();
  assert.match(f.dialog().querySelector('#lpApplicationReturnEvent').textContent,/return2/,'Newest link wins after asynchronous refresh');
  f=fixture();f.state.contexts.get(ONE).ready=false;
  f.state.prepareHook=()=>new Promise(resolve=>{prepareRelease=resolve;});
  f.click();f.away();f.back();await f.flush();f.changeUser('user-b');prepareRelease();await f.flush();
  assert.equal(f.dialog(),undefined,'A delayed sync cannot reveal a previous user reminder');
  f=fixture();Object.assign(f.state.contexts.get(ONE),{title:'<img src=x onerror=alert(1)>',
    storeLabel:'<script>store</script>',productName:'<svg onload=alert(1)>'});await prompt(f);
  assert.equal(f.dialog().querySelector('#lpApplicationReturnEvent').textContent,'<img src=x onerror=alert(1)>');
  assert.equal(f.dialog().querySelector('#lpApplicationReturnStore').textContent,'<script>store</script>');
  assert.equal(f.dialog().querySelector('#lpApplicationReturnProduct').textContent,'<svg onload=alert(1)>');
  f=fixture();Object.assign(f.state.contexts.get(ONE),{storeLabel:'',productName:''});await prompt(f);
  assert.equal(f.dialog().querySelector('#lpApplicationReturnStore').textContent,'店舗未確認');
  assert.equal(f.dialog().querySelector('#lpApplicationReturnProduct').textContent,'商品名未確認');

  await testAppIntegration();
  assert.match(app,/class="lp-official" data-lp-application-return="'\+escape\(item.url\).*target="_blank" rel="noopener noreferrer"/);
  assert(html.indexOf('lottery_application_return_v1.js')<html.indexOf("document.write('<script src=\"app.js"),'Module loads before app initialization');
  assert.match(app,/TorecaApplicationReturn\?\.onAuthChanged/);
  assert.match(css,/#lpApplicationReturnDialog\{[^}]*max-height:calc\(100dvh - 40px\)[^}]*overflow:auto/s);
  assert.match(css,/\.lp-application-return-actions\{[^}]*flex-wrap:wrap/);
  console.log('Application return: immediate cached display, store/product names, consent, lifecycle, duplicates, auth, retry and private-save integration passed');
}
function fn(name){
  const start=app.search(new RegExp('  (?:async )?function '+name+'\\(')),end=app.indexOf('\n  }\n',start);
  assert(start>=0&&end>start,'Missing app helper '+name);return app.slice(start,end+5);
}
async function testAppIntegration(){
  const records=new Map(),writes=[],profile={id:'private-profile-a'};
  const item={url:ONE,state:'open',product_name:'サンプル拡張パック'},store={name:'サンプル宇都宮店',prefecture:'栃木県'};
  const ctx={authUser:{id:'user-a'},discordRoleAuthPending:false,lotteryTrackSaving:false,
    lotteryItems:[item],lotteryLoading:null,lotteryTrackUserId:'user-a',lotteryTrackError:'',
    lpPrivateAccountReady:true,lpPrivateAccountUser:'user-a',LP_TRACK_STATUSES:['not_applied','applied','won','lost','received'],LP_TRACK_SELECT:'mock',
    safeLotteryUrl:()=>true,lotteryState:x=>x.state,lotteryTrackItemName:()=>'<サンプル抽選>',lotteryTrackRecord:url=>records.get(url),
    lotteryTrackStoreLabel:()=> '店舗未確認',
    lpPrivateAccountDefault:()=>profile,lpTrackerCandidateStores:()=>[store],lotteryTrackAnnouncement:v=>({result_announcement_date:v.result_announcement_date||'',result_announcement_time:v.result_announcement_time||''}),
    lotteryPickupPeriodReversed:()=>false,lotteryTrackTableFor:()=> 'offline_private_entries',
    lotteryTrackClean:row=>row,lotteryTrackRecords:records,renderLotteryTrackerSummary(){},renderLottery(){},lpResultsRefresh(){},
    window:{},$:()=>null,alert:message=>{throw Error(message);},
    refreshLotteryTrackerForAccount:async force=>{assert.equal(force,true);},
    supabaseClient:{from:table=>({upsert:(payload)=>{
      assert.equal(table,'offline_private_entries');writes.push(payload);
      return {select:()=>({single:async()=>({data:payload,error:null})})};
    }})}
  };
  const helpers=vm.runInNewContext(['lotteryReturnContext','lotteryReturnPrepare','lotteryReturnRegister','lotteryTrackerSave'].map(fn).join('\n')+
    '\n({context:lotteryReturnContext,prepare:lotteryReturnPrepare,register:lotteryReturnRegister})',ctx,{timeout:1000});
  assert.equal(helpers.context(ONE).ready,true);
  assert.equal(helpers.context(ONE).productName,item.product_name);
  assert.equal(helpers.context(ONE).storeLabel,'サンプル宇都宮店（栃木県）');
  assert.equal(await helpers.prepare('user-a'),true);assert.equal(await helpers.prepare('user-b'),false);
  assert.equal(await helpers.register(ONE,'user-b'),false);
  records.set(ONE,{status:'not_applied',application_count:0,account_entries:[],note:'私用メモ',pickup_end:'2026-11-21',pickup_end_time:'18:00',result_announcement_date:'2026-11-14'});
  assert.equal(await helpers.register(ONE,'user-a'),true);
  assert.equal(writes.length,1);assert.equal(writes[0].application_count,1);assert.equal(writes[0].user_id,'user-a');
  assert.equal(writes[0].account_entries[0].account_id,profile.id,'Empty un-applied records still select the default profile');
  assert.equal(writes[0].account_entries[0].store_name,store.name);
  assert.equal(writes[0].note,'私用メモ');assert.equal(writes[0].pickup_end,'2026-11-21');assert.equal(writes[0].pickup_end_time,'18:00');assert.equal(writes[0].result_announcement_date,'2026-11-14');
  for(const status of ['applied','won','lost','received']){
    records.set(ONE,{status,application_count:1,won_count:status==='won'?1:0});
    assert.equal(await helpers.register(ONE,'user-a'),true);assert.equal(writes.length,1,'Existing outcomes remain untouched');
  }
  records.set(ONE,{status:'not_applied',application_count:2});assert.equal(helpers.context(ONE).registered,true);
  records.clear();item.state='upcoming';assert.equal(helpers.context(ONE).eligible,false);
  item.state='closed';assert.equal(helpers.context(ONE).eligible,false);assert.equal(helpers.context(ONE,true).eligible,true,'A deadline passing while away does not discard the reminder');
  ctx.lpTrackerCandidateStores=()=>[store,{name:'サンプル大宮店',prefecture:'埼玉県'}];
  assert.equal(helpers.context(ONE,true).storeLabel,'サンプル宇都宮店（栃木県）\nサンプル大宮店（埼玉県）');
  assert.equal(helpers.context(ONE,true).needsEditor,true);assert.equal(await helpers.register(ONE,'user-a'),false);assert.equal(writes.length,1);
  ctx.lpPrivateAccountDefault=()=>null;item.state='open';
  assert.equal(await helpers.register(ONE,'user-a'),true);assert.equal(writes.length,2);assert.equal(writes[1].account_entries,undefined,'Without a configured profile the existing unassigned flow remains available');
  ctx.lotteryTrackError='offline';assert.equal(await helpers.prepare('user-a'),false);
  ctx.lotteryTrackError='';ctx.lpPrivateAccountUser='user-b';assert.equal(await helpers.prepare('user-a'),false);
  ctx.lpTrackerCandidateStores=()=>[];delete item.product_name;
  assert.equal(helpers.context(ONE).storeLabel,'店舗未確認');assert.equal(helpers.context(ONE).productName,'');
  ctx.lotteryItems=[];assert.equal(helpers.context(ONE).ready,false);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
