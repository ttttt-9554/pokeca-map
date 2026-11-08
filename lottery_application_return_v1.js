// Browser tabs prompt on link clicks; installed apps prompt on return.
(() => {
  'use strict';
  const KEY='toreca-lottery-application-return-v1',TTL=30*60*1000;
  let api=null,pending=null,dialog=null,timer=null,checking=false,working=false;
  let lastUser='',bound=false,revision=0;
  const user=()=>String(api?.getUserId?.()||'');
  const visible=()=>document.visibilityState!=='hidden';
  const installed=()=>window.navigator?.standalone===true||
    window.matchMedia?.('(display-mode: standalone)')?.matches===true;
  const fresh=entry=>entry&&typeof entry.url==='string'&&typeof entry.owner==='string'&&
    Number.isFinite(entry.openedAt)&&Date.now()>=entry.openedAt&&Date.now()-entry.openedAt<TTL;
  function persist(){
    try{
      if(pending)sessionStorage.setItem(KEY,JSON.stringify(pending));
      else sessionStorage.removeItem(KEY);
    }catch(_){}
  }
  function clear(){
    revision++;pending=null;persist();
    if(dialog?.open)dialog.close();
  }
  function schedule(){
    if(timer)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;void check();},0);
  }
  function markAway(){
    if(!fresh(pending))return;
    pending.left=true;persist();
  }
  function eligible(context){return context?.eligible&&!context.registered;}
  function contextFor(entry){
    if(!fresh(entry)||user()!==entry.owner)return null;
    return api.getContext(entry.url,true);
  }
  function ensureDialog(){
    if(dialog)return dialog;
    dialog=document.createElement('dialog');
    dialog.id='lpApplicationReturnDialog';
    dialog.setAttribute('aria-labelledby','lpApplicationReturnTitle');
    dialog.setAttribute('aria-describedby','lpApplicationReturnDescription');
    dialog.setAttribute('closedby','closerequest');
    dialog.innerHTML='<div class="lp-application-return-header">'+
      '<h3 id="lpApplicationReturnTitle" tabindex="-1">応募を登録しますか？</h3>'+
      '<button type="button" data-return-close aria-label="確認を閉じる">×</button></div>'+
      '<p id="lpApplicationReturnEvent"></p>'+
      '<dl class="lp-application-return-details">'+
      '<div><dt>店舗名</dt><dd id="lpApplicationReturnStore"></dd></div>'+
      '<div><dt>商品名</dt><dd id="lpApplicationReturnProduct"></dd></div></dl>'+
      '<p id="lpApplicationReturnDescription">公式ページで応募が完了していれば、応募済みの記録を登録できます。</p>'+
      '<p id="lpApplicationReturnHint"></p>'+
      '<div class="lp-application-return-actions">'+
      '<button type="button" data-return-skip>今は登録しない</button>'+
      '<button type="button" data-return-register class="primary">応募済みに登録</button></div>'+
      '<p id="lpApplicationReturnStatus" role="status" aria-live="polite"></p>';
    document.body.append(dialog);
    dialog.querySelector('[data-return-close]').addEventListener('click',dismiss);
    dialog.querySelector('[data-return-skip]').addEventListener('click',dismiss);
    dialog.querySelector('[data-return-register]').addEventListener('click',()=>{
      if(working||!pending)return;
      if(pending.stage==='manage'){void register(true);return;}
      const context=contextFor(pending);
      if(!eligible(context)){clear();return;}
      pending.stage='manage';persist();show(pending,context);
      dialog.querySelector('#lpApplicationReturnTitle').focus({preventScroll:true});
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
    return dialog;
  }
  function dismiss(){
    if(working)return;
    if(pending?.stage==='manage')void register(false);
    else clear();
  }
  function show(entry,context,message=''){
    if(pending!==entry||!eligible(context))return;
    const d=ensureDialog();
    const manage=entry.stage==='manage';
    d.querySelector('#lpApplicationReturnTitle').textContent=manage?'管理画面を開きますか？':'応募を登録しますか？';
    d.querySelector('#lpApplicationReturnEvent').textContent=context.title||'抽選';
    d.querySelector('#lpApplicationReturnStore').textContent=context.storeLabel||'店舗未確認';
    d.querySelector('#lpApplicationReturnProduct').textContent=context.productName||'商品名未確認';
    d.querySelector('#lpApplicationReturnDescription').textContent=manage
      ? '応募済みとして1口を登録します。管理画面では応募アカウント・店舗・口数などを編集できます。'
      : '公式ページで応募が完了していれば、応募済みの記録を登録できます。';
    d.querySelector('#lpApplicationReturnHint').textContent=manage
      ? (context.needsEditor?'店舗が複数のため、店舗・アカウントは未割当で登録します。管理画面から設定できます。':'管理画面を開かずに登録することもできます。')
      : '「応募済みに登録」の後、管理画面を開くか選べます。';
    d.querySelector('[data-return-skip]').textContent=manage?'開かずに1口で登録':'今は登録しない';
    d.querySelector('[data-return-register]').textContent=manage?'管理画面を開く':'応募済みに登録';
    d.querySelector('#lpApplicationReturnStatus').textContent=message;
    if(!d.open){
      if(typeof d.showModal!=='function')return;
      try{d.showModal();d.querySelector('#lpApplicationReturnTitle').focus({preventScroll:true});}
      catch(_){} // The next focus/pageshow/close event can try again.
    }
  }
  async function check(){
    if(!api||working||dialog?.open||!pending||!pending.left||!visible())return;
    if(!fresh(pending)){clear();return;}
    if(!user())return;
    if(user()!==pending.owner){clear();return;}
    if(document.querySelector('dialog[open]'))return;
    const entry=pending,version=revision;
    // The card already has the display data. Do not block this confirmation
    // on a full cloud refresh; register() still refreshes before any write.
    const cached=contextFor(entry);
    if(cached?.ready!==false){
      if(eligible(cached))show(entry,cached);else clear();
      return;
    }
    if(checking)return;
    checking=true;
    try{
      if(!await api.prepare(entry.owner))return;
      if(version!==revision||pending!==entry||!visible()||document.querySelector('dialog[open]'))return;
      const context=contextFor(entry);
      if(!eligible(context)){clear();return;}
      show(entry,context);
    }catch(_){}finally{checking=false;if(pending&&pending!==entry)schedule();}
  }
  async function register(openEditor=false){
    if(working||!pending)return;
    const entry=pending,version=revision,d=ensureDialog();
    working=true;
    d.querySelectorAll('button').forEach(button=>{button.disabled=true;});
    d.querySelector('#lpApplicationReturnStatus').textContent='応募記録を確認しています…';
    try{
      if(!await api.prepare(entry.owner))throw Error('unavailable');
      if(version!==revision||pending!==entry)return;
      const context=contextFor(entry);
      if(!context?.eligible){clear();return;}
      d.querySelector('#lpApplicationReturnStatus').textContent='登録しています…';
      const saved=context.registered||await api.register(entry.url,entry.owner);
      if(version!==revision||pending!==entry)return;
      if(!saved)throw Error('save_failed');
      clear();
      if(openEditor&&user()===entry.owner)await api.openEditor(entry.url,entry.owner);
    }catch(_){
      if(version===revision&&pending===entry&&user()===entry.owner)
        d.querySelector('#lpApplicationReturnStatus').textContent='登録できませんでした。通信状況を確認して、もう一度お試しください。';
    }finally{
      working=false;
      d.querySelectorAll('button').forEach(button=>{button.disabled=false;});
    }
  }
  function click(event){
    if(event.defaultPrevented||(event.button!=null&&event.button!==0)||
       event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||working)return;
    const link=event.target?.closest?.('a[data-lp-application-return]');
    if(!link||!link.closest('#lpCards')||!user())return;
    const url=link.dataset.lpApplicationReturn,context=api.getContext(url);
    if(!eligible(context)){clear();return;}
    // Preserve the anchor's normal target/rel behavior; no window.opener access.
    revision++;
    pending={url,owner:user(),openedAt:Date.now(),left:!installed(),stage:'register'};persist();
    // Leave the anchor's default navigation untouched. The browser dialog
    // is already present in the original tab when the person returns.
    if(pending.left){
      if(visible()&&!document.querySelector('dialog[open]'))show(pending,context);
      else schedule();
    }
  }
  function onAuthChanged(){
    if(!api)return;
    const uid=user();
    if((uid&&pending&&uid!==pending.owner)||(!uid&&lastUser))clear();
    if(!uid&&dialog?.open)dialog.close();
    lastUser=uid;schedule();
  }
  function init(options){
    api=options;
    if(bound)return;
    bound=true;lastUser=user();
    try{const saved=JSON.parse(sessionStorage.getItem(KEY)||'null');if(fresh(saved))pending=saved;else persist();}catch(_){}
    document.addEventListener('click',click);
    document.addEventListener('visibilitychange',()=>{
      if(visible())schedule();else markAway();
    });
    document.addEventListener('close',()=>schedule(),true);
    window.addEventListener('blur',markAway);
    window.addEventListener('focus',schedule);
    window.addEventListener('pageshow',schedule);
    schedule();
  }
  window.TorecaApplicationReturn={init,onAuthChanged};
})();
