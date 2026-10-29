// v21.127: unified developer review with effective-card field synchronization.
// Uses only effective public lottery metadata and existing administrator edits.
// No user-specific lottery accounts or personal notes are requested.
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const FIELD_LABELS={
    title:'抽選名',store:'対象店舗',area:'都道府県',
    start:'応募開始',deadline:'応募締切'
  };
  let api=null,limit=80,refreshing=false,lastRows=[],bound=false;
  const text=value=>String(value??'').trim();
  // Placeholder texts are not actual stores or prefectures.
  const known=name=>!!text(name)&&
    !/^(未確認|不明|店名未確認|店舗未確認|店舗名未確認|店舗名不明|店名不明|対象店舗|対象店舗未確認|情報未登録|未取得|店舗情報なし|店舗情報未確認|未設定|なし)$/i.test(text(name));
  // Only the 47 real prefectures and the supported nationwide area are valid.
  const KNOWN_AREAS=new Set(('北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 '+
    '栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 '+
    '山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 '+
    '奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 '+
    '高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県 全国').split(' '));
  const knownArea=area=>KNOWN_AREAS.has(text(area));

  function fieldsFor(base,item,_diagnostic,state){
    const url=base.url,saved=state.card.get(url),modified=new Set(saved?.edited_fields||[]);
    const manualTitle=modified.has('event_title')||
      state.cloud.get(url)?.resolution==='title'||state.external.get(url)?.event_title;
    const title=text(item?.event_title);
    const titleValid=api.validTitle(title)&&(!item.event_title_provisional||manualTitle)&&
      !/^(?:未確認|不明|抽選名未確認|イベント名未確認|イベントタイトル未確認|仮イベント名)$/.test(title);
    const rawStores=api.stores(item);
    const stores=rawStores.filter(store=>known(store.name));
    const places=api.areas(item).filter(knownArea),missing=[];
    // Judge the latest merged card, not a stale GitHub extraction report.
    // A corrected field is resolved; unrelated missing fields stay pending.
    if(!titleValid)missing.push('title');
    if(!stores.length||rawStores.some(store=>!known(store.name)))missing.push('store');
    if(!places.length||stores.some(store=>!knownArea(store.prefecture)))missing.push('area');
    if(!Number.isFinite(Date.parse(item?.application_start_at||'')))missing.push('start');
    const noDeadline=saved?.review_complete===true&&saved.review_deadline_unpublished===true;
    if(!Number.isFinite(Date.parse(item?.application_end_at||''))&&!noDeadline)
      missing.push('deadline');
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
      if(!item||item.app_lottery_hidden||item.manual_card_hidden||item.manual_page_unavailable||
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
        (row.missing.length&&row.touched?'<p class="lp-dev-unified-done">✅ 現在入力済み：'+
          Object.keys(FIELD_LABELS).filter(k=>!row.missing.includes(k))
            .map(k=>FIELD_LABELS[k]).join('・')+'</p>':'')+
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

  function onAuthChanged(){
    if(!api?.isDeveloper())return;
    const container=$('lpDevUnifiedPanel')?.closest('details.dev-accordion');
    if(container&&!container.open)container.open=true;
    render();
    if(!(api.snapshot().base||[]).length)refresh();
  }

  function init(options){
    api=options;
    if(bound){onAuthChanged();return;}
    bound=true;
    // Bind once even before Discord login; authorization is checked per action.
    $('lpDevUnifiedSearch')?.addEventListener('input',()=>{limit=80;render();});
    $('lpDevUnifiedFilter')?.addEventListener('change',()=>{limit=80;render();});
    $('lpDevUnifiedRefresh')?.addEventListener('click',refresh);
    $('lpDevUnifiedMore')?.addEventListener('click',()=>{limit+=80;render();});
    $('lpDevUnifiedList')?.addEventListener('click',onEdit);
    $('lpDevUnifiedCompletedList')?.addEventListener('click',onEdit);
    const container=$('lpDevUnifiedPanel')?.closest('details.dev-accordion');
    if(container){
      container.addEventListener('toggle',()=>{
        if(container.open&&api.isDeveloper()&&!lastRows.length)refresh();
      });
    }
    onAuthChanged();
  }

  window.TorecaUnifiedReview={
    init,onAuthChanged,render,refresh,collect,fieldsFor,
    fieldLabels:FIELD_LABELS,validStore:known,validArea:knownArea
  };
})();