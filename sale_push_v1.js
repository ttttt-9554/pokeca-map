/* Developer-only iPhone/Web Push controls for guerrilla sale alerts. */
(() => {
  'use strict';
  const BASE='https://aypcmtlaaygmiexboypk.supabase.co';
  const KEY='sb_publishable_C0YESv-nDjR7PvAoMPscQg_uznt6foN';
  const SESSION='sb-aypcmtlaaygmiexboypk-auth-token';
  const DEVELOPER='0ba965da-445b-4055-8d8d-ead585fa0d09';
  const VAPID='BNS-RT7qpHWKR9SC-y-jtJ8Kuwelypliqm677Pr_d9iFnPdwrRr5b2RAPfEZ2dWwQcwB1POJX0ySzAEQ4jo3o9o';
  let busy=false;

  const token=()=>{try{const v=JSON.parse(localStorage.getItem(SESSION)||'null');return v?.access_token||v?.currentSession?.access_token||'';}catch(_){return '';}};
  const ios=()=>/iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  function b64(value){
    const pad='='.repeat((4-value.length%4)%4);
    const raw=atob((value+pad).replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
  }
  async function api(path,t,options={}){
    const res=await fetch(BASE+path,{
      method:options.method||'GET',cache:'no-store',
      headers:{apikey:KEY,Authorization:'Bearer '+t,'Content-Type':'application/json',Prefer:options.prefer||'return=representation'},
      body:options.body===undefined?undefined:JSON.stringify(options.body)
    });
    const text=await res.text();let data=null;
    try{data=text?JSON.parse(text):null;}catch(_){}
    if(!res.ok)throw new Error(res.status===401||res.status===403?'開発者ログインを確認してください。':'Push設定の保存に失敗しました（HTTP '+res.status+'）。');
    return data;
  }
  async function authorize(){
    const t=token();if(!t)throw new Error('開発者ログインが必要です。');
    const user=await api('/auth/v1/user',t);
    if(user?.id!==DEVELOPER)throw new Error('開発者専用です。');
    return t;
  }
  function supported(){
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  async function registration(){
    return navigator.serviceWorker.register('./sw.js?v=20261031-sale-push-v1',{scope:'./'});
  }
  async function current(){
    if(!supported())return {sub:null,reg:null};
    const reg=await registration();
    const sub=await reg.pushManager.getSubscription();
    return {sub,reg};
  }
  function status(text,error=false){
    const el=document.getElementById('salePushStatus');
    if(el){el.textContent=text;el.className=error?'sale-beta-warning':'hint';}
  }
  async function refresh(){
    const button=document.getElementById('salePushToggle');
    if(!button)return;
    if(!supported()){
      button.disabled=true;button.textContent='この端末はPush未対応';
      status('このブラウザではWeb Pushを利用できません。');return;
    }
    if(ios()&&!standalone()){
      button.disabled=true;button.textContent='ホーム画面アプリで設定';
      status('iPhoneではToreca Radarをホーム画面に追加し、ホーム画面のアイコンから開いて設定してください。');return;
    }
    try{
      const {sub}=await current();
      const on=Notification.permission==='granted'&&!!sub;
      button.disabled=false;
      button.textContent=on?'販売Push通知をOFF':'販売Push通知をON';
      if(Notification.permission==='denied'){
        status('通知が拒否されています。iPhoneの「設定 → 通知 → Toreca Radar」で許可してください。',true);
      }else if(on){
        status('販売Push通知：ON（未開封TCGパック・BOX・構築済みデッキのみ）');
      }else{
        status('販売Push通知：OFF');
      }
    }catch(e){button.disabled=false;status(e.message||String(e),true);}
  }
  async function enable(){
    const t=await authorize();
    const reg=await registration();
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw new Error('通知が許可されませんでした。');
    let sub=await reg.pushManager.getSubscription();
    if(!sub){
      sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(VAPID)});
    }
    const json=sub.toJSON();
    if(!json.endpoint||!json.keys?.p256dh||!json.keys?.auth)throw new Error('Push購読情報を取得できません。');
    await api('/rest/v1/guerrilla_push_subscriptions?on_conflict=endpoint',t,{
      method:'POST',prefer:'resolution=merge-duplicates,return=representation',
      body:{user_id:DEVELOPER,endpoint:json.endpoint,p256dh:json.keys.p256dh,auth:json.keys.auth,enabled:true,user_agent:navigator.userAgent.slice(0,500),updated_at:new Date().toISOString()}
    });
    try{if(typeof navigator.clearAppBadge==='function')await navigator.clearAppBadge();}catch(_){}
  }
  async function disable(){
    const t=await authorize();
    const {sub}=await current();
    if(sub){
      await api('/rest/v1/guerrilla_push_subscriptions?endpoint=eq.'+encodeURIComponent(sub.endpoint),t,{method:'DELETE',prefer:'return=minimal'});
      await sub.unsubscribe();
    }
    try{if(typeof navigator.clearAppBadge==='function')await navigator.clearAppBadge();}catch(_){}
  }
  async function toggle(){
    if(busy)return;
    const button=document.getElementById('salePushToggle');busy=true;if(button)button.disabled=true;
    try{
      const {sub}=await current();
      if(Notification.permission==='granted'&&sub)await disable();
      else await enable();
    }catch(e){status(e.message||String(e),true);}
    finally{busy=false;await refresh();}
  }
  function mount(){
    const root=document.getElementById('saleBetaV2');
    if(!root||document.getElementById('salePushCard'))return;
    const card=document.createElement('section');card.id='salePushCard';card.className='sale-beta-card';
    const title=document.createElement('h3');title.textContent='📱 iPhone販売Push通知';
    const p=document.createElement('p');p.id='salePushStatus';p.className='hint';p.textContent='状態を確認しています…';
    const b=document.createElement('button');b.type='button';b.id='salePushToggle';b.textContent='販売Push通知をON';b.addEventListener('click',toggle);
    const note=document.createElement('p');note.className='hint';note.textContent='iPhoneはホーム画面のToreca Radarから設定します。通知対象は未開封TCGパック・BOX・構築済みデッキのみです。';
    card.append(title,p,b,note);
    const sites=document.getElementById('saleBetaSites');
    root.insertBefore(card,sites||root.firstChild);
    refresh();
  }
  new MutationObserver(mount).observe(document.documentElement,{childList:true,subtree:true});
  addEventListener('focus',()=>{mount();refresh();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
