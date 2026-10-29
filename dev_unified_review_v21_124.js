// v21.124: unified developer manual-review queue.
// Uses only effective public lottery metadata and existing administrator edits.
// No user-specific lottery accounts or personal notes are requested.
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const FIELD_LABELS={
    title:'抽選名',store:'対象店舗',area:'都道府県',
    start:'応募開始',deadline:'応募締切'
  };
  let api=null,limit=80,refreshing=false,lastRows=[];
  const text=value=>String(value??'').trim();
  const known=name=>!!name && !/^(未確認|不明|店舗未確認|対象店舗|店舗名未確認|情報未登録|未取得)$/i.test(text(name));

  function fieldsFor(base,item,diag,state){
    const url=base.url,saved=state.card.get(url),modified=new Set(saved?.edited_fields||[]);
    const loc=state.location.get(url),cloud=state.cloud.get(url);
    const stores=api.stores(item).filter(store=>known(store.name));
    const places=api.areas(item).filter(Boolean);
    const missing=[];
    const title=text(item?.event_title);
    const manualTitle=modified.has('event_title')||
      cloud?.resolution==='title'||state.external.get(url)?.event_title;
    const titleValid=api.validTitle(title)&&(!item.event_title_provisional||manualTitle);
    if(!titleValid || (diag?.missing?.includes('title')&&!manualTitle&&!saved?.review_complete))
      missing.push('title');
    if(!stores.length || (diag?.missing?.includes('store')&&
      !modified.has('stores')&&!modified.has('store_name')&&!loc?.store_name &&
      !saved?.review_complete))
      missing.push('store');
    if(!places.length||stores.some(store=>!text(store.prefecture)))missing.push('area');
    const start=Number.isFinite(Date.parse(item?.application_start_at||''));
    const deadline=Number.isFinite(Date.parse(item?.application_end_at||''));
    if(!start)missing.push('start');
    const noDeadline=saved?.review_complete===true &&
      saved.review_deadline_unpublished===true;
    if(!deadline&&!noDeadline)missing.push('deadline');
    return missing;
  }

  function collect(){
    if(!api||!api.isDeveloper())return [];
    const state=api.snapshot();
    const effective=new Map((state.items||[]).map(item=>[item.url,item]));
    const diagnostic=new Map((state.diagnostics||[]).map(row=>[row.url,row]));
    const now=Date.now(),out=[];
    for(const base of state.base||[]){
      if(!base?.url||base.app_lottery||!api.validUrl(base.url))continue;
      const item=effective.get(base.url);
      // No hidden, excluded, removed or expired lotteries are review tasks.
      if(!item||item.app_lottery_hidden||item.manual_page_unavailable||
         api.expired(base.url,base.application_end_at,now))continue;
      const missing=fieldsFor(base,item,diagnostic.get(base.url),state);
      const card=state.card.get(base.url);
      const manuallyTouched=!!(card?.review_complete||
        card?.edited_fields?.length||state.location.has(base.url)||
        state.cloud.has(base.url)||state.external.has(base.url));
      out.push({
        url:base.url,item,missing,
        touched:manuallyTouched,official:card?.review_complete===true,
        provider:api.isLivePocket(base.url)?'LivePocket':'外部抽選'
      });
    }
    return out;
  }

  function render(){
    const host=$('lpDevUnifiedList'),status=$('lpDevUnifiedStatus');
    if(!host||!api||!api.isDeveloper())return;
    const all=collect();
    lastRows=all;
    const pending=all.filter(r=>r.missing.length),done=all.filter(r=>!r.missing.length&&r.touched);
    const counts=Object.fromEntries(Object.keys(FIELD_LABELS).map(key=>[
      key,pending.filter(row=>row.missing.includes(key)).length
    ]));
    const summary=$('lpDevUnifiedCounts');
    if(summary)summary.innerHTML=
      '<span>🔎 未対応 '+pending.length+'件</span>'+
      '<span>✅ 修正・確認済み '+done.length+'件</span>'+
      Object.entries(FIELD_LABELS).map(([key,label])=>
        '<span>'+label+' '+counts[key]+'件</span>').join('');
    const query=text($('lpDevUnifiedSearch')?.value).toLocaleLowerCase('ja-JP');
    const filter=$('lpDevUnifiedFilter')?.value||'all';
    const contains=row=>!query||[
      row.url,row.item.event_title,row.item.product_name,row.item.store_name,
      row.item.prefecture,...api.stores(row.item).flatMap(s=>[s.name,s.prefecture])
    ].filter(Boolean).join(' ').toLocaleLowerCase('ja-JP').includes(query);
    const filtered=pending.filter(row=>contains(row)&&
      (filter==='all'||row.missing.includes(filter)));
    const completed=done.filter(contains);
    const pCount=$('lpDevUnifiedPendingCount'),dCount=$('lpDevUnifiedDoneCount');
    if(pCount)pCount.textContent=filtered.length+'件';
    if(dCount)dCount.textContent=completed.length+'件';
    function card(row){
      const label=text(row.item.event_title)||'抽選名未確認';
      return '<article class="lp-dev-unified-card">'+
        '<strong>'+api.escape(label)+'</strong>'+
        '<p class="hint">'+api.escape(row.provider)+' ／ 店舗：'+
        api.escape(api.stores(row.item).map(s=>s.name).join('・')||'未確認')+
        ' ／ 地域：'+api.escape(api.areas(row.item).join('・')||'未確認')+'</p>'+
        (row.missing.length?'<div class="lp-dev-unified-labels">'+
          row.missing.map(k=>'<span>⚠ '+FIELD_LABELS[k]+'未確認</span>').join('')+
          '</div>':'<p class="lp-dev-unified-done">✅ '+(row.official?
            '公式情報の確認完了':'手動修正済み・未確認事項なし')+'</p>')+
        '<div class="lp-dev-unified-card-actions">'+
          '<a href="'+api.escape(row.url)+
          '" target="_blank" rel="noopener noreferrer">元ページを開く ↗</a>'+
          '<button type="button" data-lp-dev-unified-edit="'+
            api.escape(row.url)+'">✏️ 修正・確認</button>'+
        '</div></article>';
    }
    host.innerHTML=filtered.length?filtered.slice(0,limit).map(card).join(''):
      '<p class="hint">✅ この条件の未確認事項はありません。</p>';
    const more=$('lpDevUnifiedMore');
    if(more){more.hidden=filtered.length<=limit;more.textContent='さらに表示（残り'+(filtered.length-limit)+'件）';}
    const completedHost=$('lpDevUnifiedCompletedList');
    if(completedHost)completedHost.innerHTML=completed.length?
      completed.slice(0,80).map(card).join(''):
      '<p class="hint">この条件の確認済み抽選はありません。</p>';
    status.textContent=refreshing?'🔄 公開抽選と修正記録を更新中…':
      '抽選名・店舗・地域・応募日時を現在の登録データで判定しています。'+
      '修正した項目は保存後に再集計します。正式な公式確認完了は確認方法を記録してください。';
  }

  async function refresh(){
    if(!api||!api.isDeveloper()||refreshing)return;
    refreshing=true;render();
    const button=$('lpDevUnifiedRefresh');
    if(button)button.disabled=true;
    try{
      await api.refreshSources();
      limit=80;
      render();
    }catch(error){
      render();
      const status=$('lpDevUnifiedStatus');
      if(status)status.textContent='⚠ 一部の情報を更新できませんでした：'+String(error?.message||error);
    }finally{
      refreshing=false;if(button)button.disabled=false;render();
    }
  }

  async function onEdit(event){
    const button=event.target.closest('button[data-lp-dev-unified-edit]');
    if(!button||!api?.isDeveloper())return;
    const url=button.dataset.lpDevUnifiedEdit;
    if(!api.validUrl(url))return;
    button.disabled=true;
    try{await api.openEditor(url);}
    catch(error){
      const status=$('lpDevUnifiedStatus');
      if(status)status.textContent='⚠ 編集画面を開けませんでした：'+String(error?.message||error);
    }finally{button.disabled=false;}
  }

  function init(options){
    api=options;
    if(!api.isDeveloper())return;
    $('lpDevUnifiedSearch')?.addEventListener('input',()=>{limit=80;render();});
    $('lpDevUnifiedFilter')?.addEventListener('change',()=>{limit=80;render();});
    $('lpDevUnifiedRefresh')?.addEventListener('click',refresh);
    $('lpDevUnifiedMore')?.addEventListener('click',()=>{limit+=80;render();});
    $('lpDevUnifiedList')?.addEventListener('click',onEdit);
    $('lpDevUnifiedCompletedList')?.addEventListener('click',onEdit);
    const container=$('lpDevUnifiedPanel')?.closest('details.dev-accordion');
    if(container){
      container.open=true;
      container.addEventListener('toggle',()=>{
        if(container.open&&!lastRows.length)refresh();
      });
    }
    render();
    if(!(options.snapshot().base||[]).length)refresh();
  }

  window.TorecaUnifiedReview={
    init,render,refresh,collect,fieldsFor,
    fieldLabels:FIELD_LABELS
  };
})();