/* v21.55 Shared onsite comment alerts: separate read-only client, no SQL changes. */
(function install(){
  'use strict';
  const STORAGE='pokeca-onsite-comment-alerts-v21_55';
  // The old table keeps its LivePocket comments; the new table stores other sites.
  const SOURCES=['lottery_onsite_reports','lottery_external_onsite_reports'];
  const API_URL='https://aypcmtlaaygmiexboypk.supabase.co';
  const API_KEY='sb_publishable_C0YESv-nDjR7PvAoMPscQg_uznt6foN';
  const get=id=>document.getElementById(id);
  const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validUrl=u=>{
    if(typeof u!=='string'||u.length<12||u.length>2000||
       /[\\\s\u0000-\u001f]/.test(u))return false;
    try{
      const url=new URL(u);
      const host=url.hostname.toLowerCase().replace(/\.$/,'');
      return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&
        /^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(host)&&
        !['x.com','twitter.com','t.co','fxtwitter.com','vxtwitter.com','fixupx.com']
          .some(x=>host===x||host.endsWith('.'+x))&&
        !host.endsWith('.local')&&!host.endsWith('.internal')&&!host.endsWith('.localhost');
    }catch(_){return false;}
  };
  const displayDate=v=>{const t=Date.parse(v||'');return Number.isFinite(t)?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(t)):'';};
  let state={initialized:false,seen:{},notices:[]},client,busy=false,unreadToast=0;
  function restore(){
    try{
      const saved=JSON.parse(localStorage.getItem(STORAGE)||'null');
      if(saved?.initialized===true && saved.seen && typeof saved.seen==='object' && !Array.isArray(saved.seen) && Array.isArray(saved.notices)){
        state={initialized:true,seen:saved.seen,notices:saved.notices.filter(n=>validUrl(n?.url)&&typeof n.details==='string').slice(0,80)};
      }
    }catch(e){console.warn('現地対応お知らせ復元失敗',e);}
  }
  function save(){try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch(e){console.warn('現地対応お知らせ保存失敗',e);}}
  function draw(){
    const unread=state.notices.filter(n=>!n.read).length;
    const badge=get('onsiteCommentBadge');
    badge.hidden=unread===0;badge.textContent=unread>99?'99+':String(unread);
    get('onsiteCommentCount').textContent=unread+'件';
    get('onsiteCommentReadAll').disabled=!unread;
    const list=get('onsiteCommentList');
    list.innerHTML=state.notices.length?state.notices.map((n,i)=>
      '<article class="onsite-comment-notice'+(n.read?' is-read':'')+'">'+
      '<strong>'+(n.read?'既読':'🆕 新着')+'：'+safe(n.store)+'</strong>'+
      '<p>'+(n.requirement==='required'?'現地対応が必要':'現地対応は不要')+'との共有コメント</p>'+
      '<p>'+safe(n.details)+'</p><small>'+safe(displayDate(n.time)||'日時未確認')+'</small>'+
      '<div class="onsite-comment-actions">'+
      (!n.read?'<button type="button" data-onsite-read="'+i+'">既読にする</button>':'')+
      '<a href="'+safe(n.url)+'" target="_blank" rel="noopener noreferrer">抽選の公式ページ ↗</a>'+
      '</div></article>').join(''):
      '<p class="hint">新しい現地対応コメントが投稿されると、ここに表示されます。</p>';
    get('onsiteCommentStatus').textContent=unread?'未読 '+unread+'件':'未読はありません';
  }
  function reconcile(rows){
    const current={},active=[];
    for(const row of rows){
      if(!validUrl(row.event_url)||!row.user_id)continue;
      const id=row.event_url+'|'+row.user_id,details=String(row.details||'').trim();
      current[id]=details;
      if(details)active.push({id,details,row});
    }
    if(!state.initialized){
      state={initialized:true,seen:current,notices:[]};save();draw();return;
    }
    const changed=active.filter(x=>state.seen[x.id]!==x.details);
    const changedIds=new Set(changed.map(x=>x.id));
    state.notices=state.notices.filter(n=>Object.prototype.hasOwnProperty.call(current,n.id) &&
      current[n.id]===n.details && !changedIds.has(n.id));
    for(const {id,details,row} of changed){
      state.notices.unshift({id,url:row.event_url,details,store:String(row.store_name||row.event_title||'店舗名未確認').slice(0,130),requirement:row.requirement,time:row.updated_at||new Date().toISOString(),read:false});
    }
    state.seen=current;
    state.notices=state.notices.slice(0,80);
    save();draw();
    if(changed.length){
      unreadToast+=changed.length;
      get('onsiteCommentToastText').textContent=unreadToast+'件の新しい現地対応コメントがあります';
      get('onsiteCommentToast').hidden=false;
    }
  }
  async function poll(){
    if(busy||!client||document.visibilityState==='hidden')return;
    busy=true;
    try{
      const rows=[];
      for(const table of SOURCES){
        for(let offset=0;offset<10000;offset+=500){
          const {data,error}=await client.from(table)
            .select('user_id,event_url,requirement,details,store_name,event_title,updated_at')
            .order('updated_at',{ascending:false}).range(offset,offset+499);
          if(error)throw error;
          rows.push(...(data||[]));
          if(!data||data.length<500)break;
        }
      }
      reconcile(rows);
    }catch(e){
      get('onsiteCommentStatus').textContent='コメント取得失敗：'+String(e?.message||e);
      console.warn('現地対応お知らせ取得失敗',e);
    }finally{busy=false;}
  }
  function showCenter(){
    unreadToast=0;get('onsiteCommentToast').hidden=true;
    document.querySelector('nav button[data-tab="lottery"]')?.click();
    const panel=get('onsiteCommentCenter');panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function init(){
    const anchor=get('lpSummary'),nav=document.querySelector('nav button[data-tab="lottery"]');
    if(!anchor||!nav||!window.supabase?.createClient)return;
    if(get('onsiteCommentCenter'))return;
    const style=document.createElement('style');
    style.textContent=`
    #onsiteCommentCenter{border:1px solid var(--app-border,#b6c3d2);border-radius:12px;margin:12px 0;background:var(--app-surface,#fff);color:var(--app-text,#172033)}
    #onsiteCommentCenter>summary{cursor:pointer;padding:13px;font-weight:800}
    .onsite-comment-body{padding:0 12px 12px}
    .onsite-comment-tools,.onsite-comment-actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:8px 0}
    .onsite-comment-notice{border:1px solid var(--app-border,#b6c3d2);padding:11px;margin:9px 0;border-radius:10px;background:var(--app-surface2,#f7f9fc);color:var(--app-text,#172033)}
    .onsite-comment-notice.is-read{opacity:.75}
    .onsite-comment-notice p{font-size:13px;margin:5px 0;overflow-wrap:anywhere}
    .onsite-comment-notice small{color:var(--app-muted,#64748b)}
    .onsite-comment-actions button,.onsite-comment-tools button{min-height:38px}
    nav button[data-tab="lottery"]{position:relative}
    #onsiteCommentBadge{position:absolute;right:2px;top:1px;background:#e02636;color:white;border-radius:999px;padding:1px 5px;font-size:10px;font-weight:900}
    #onsiteCommentToast{position:fixed;z-index:5000;left:10px;right:10px;bottom:calc(80px + env(safe-area-inset-bottom));padding:12px;border-radius:12px;border:2px solid var(--app-border,#b6c3d2);background:var(--app-surface,#fff);color:var(--app-text,#172033);box-shadow:0 4px 25px #0004}
    #onsiteCommentToast[hidden],#onsiteCommentBadge[hidden]{display:none!important}`;
    document.head.appendChild(style);
    anchor.insertAdjacentHTML('afterend',`<details id="onsiteCommentCenter"><summary>🔔 現地対応のお知らせ（未読 <span id="onsiteCommentCount">0件</span>）</summary><div class="onsite-comment-body"><div class="onsite-comment-tools"><span id="onsiteCommentStatus"></span><button type="button" id="onsiteCommentReadAll">すべて既読</button></div><div id="onsiteCommentList"></div></div></details>`);
    nav.insertAdjacentHTML('beforeend','<span id="onsiteCommentBadge" hidden>0</span>');
    document.body.insertAdjacentHTML('beforeend',`<div id="onsiteCommentToast" hidden role="status" aria-live="polite"><strong>🔔 現地対応の新着コメント</strong><p id="onsiteCommentToastText"></p><div class="onsite-comment-actions"><button type="button" id="onsiteCommentToastOpen">お知らせを見る</button><button type="button" id="onsiteCommentToastClose">閉じる</button></div></div>`);
    get('onsiteCommentReadAll').addEventListener('click',()=>{state.notices.forEach(n=>{n.read=true;});save();draw();});
    get('onsiteCommentList').addEventListener('click',e=>{const b=e.target.closest('button[data-onsite-read]');if(!b)return;const n=state.notices[Number(b.dataset.onsiteRead)];if(n){n.read=true;save();draw();}});
    get('onsiteCommentToastOpen').addEventListener('click',showCenter);
    get('onsiteCommentToastClose').addEventListener('click',()=>{unreadToast=0;get('onsiteCommentToast').hidden=true;});
    restore();draw();
    client=window.supabase.createClient(API_URL,API_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    poll();setInterval(poll,60000);
    window.addEventListener('focus',poll);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll();});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
