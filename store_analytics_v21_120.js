// v21.128 — Store results shown independent of user count; small samples flagged.
// No private account, user identifier or raw entry data is requested by this module.
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let getClient=()=>null, isDev=()=>false, renderCards=()=>{}, escape=s=>String(s);
  let stats=[],byKey=new Map(),fetching=null,lastFetch=0,error='';
  let masters=[],pairs=[],masterBusy=false,addressSaving=false;
  let mergeTargetId='',mergeBusy=false,mergeMessage='';
  const mergeSources=new Set();
  const clean=s=>String(s??'').trim();

  function normalize(name){
    let n=clean(name).toLocaleLowerCase('ja-JP')
      .replace(/[\s　・･._－（）()【】「」-]+/g,'')
      .replace(/様$/,'').replace(/^イエサブ/,'イエローサブマリン');
    if(n.startsWith('イエローサブマリン')&&!n.endsWith('店'))n+='店';
    return n;
  }
  function lookup(store){
    const canonical=globalThis.window?.TorecaStoreAliases?.resolve?.(store)||store;
    return byKey.get(clean(canonical?.prefecture)+'|'+normalize(canonical?.name))||
      byKey.get(clean(store?.prefecture)+'|'+normalize(store?.name))||null;
  }
  function storeBadge(store){
    const row=lookup(store);
    if(!row?.badge||row.decided<30)return '';
    return '<span class="lp-store-high-badge" title="過去の全商品・全抽選の登録実績を基にした参考情報です。今回の当選を保証しません。">📈 過去実績高め</span>';
  }
  function cardBadge(stores){
    const eligible=(stores||[]).filter(store=>{
      const row=lookup(store);
      return row?.badge===true&&row.decided>=30;
    });
    if(!eligible.length)return '';
    return '<span class="lp-store-card-badge" title="匿名統計から算出した過去実績です。今回の当選確率ではありません。">'+
      (stores.length===1?'📈 過去実績高め':'📈 実績高め店舗あり')+'</span>';
  }

  function renderStats(){
    const list=$('lpStoreAnalyticsList'),status=$('lpStoreAnalyticsStatus');
    if(!list||!status)return;
    const query=clean($('lpStoreAnalyticsSearch')?.value).toLocaleLowerCase('ja-JP');
    const order=$('lpStoreAnalyticsSort')?.value||'high';
    const rows=stats.filter(x=>!query||
      (clean(x.store_name)+' '+clean(x.prefecture)).toLocaleLowerCase('ja-JP').includes(query));
    if(order==='low')rows.sort((a,b)=>a.rate-b.rate||b.decided-a.decided);
    else if(order==='samples')rows.sort((a,b)=>b.decided-a.decided||b.rate-a.rate);
    else rows.sort((a,b)=>b.rate-a.rate||b.decided-a.decided);
    $('lpStoreAnalyticsCount').textContent=stats.length+'店舗';
    status.textContent=error?'⚠ 店舗統計を取得できません：'+error:
      '集計対象 '+stats.length+'店舗（人数制限なし・当落判明1口から表示）';
    list.innerHTML=rows.length?rows.slice(0,120).map(row=>
      '<article class="lp-store-analytics-row"><div class="lp-store-analytics-head">'+
      '<strong>'+escape(row.store_name)+'</strong>'+
      '<strong class="lp-store-analytics-rate">'+Number(row.rate).toFixed(1)+'%</strong></div>'+
      '<p class="hint">📍 '+escape(row.prefecture)+' ／ 当選 '+row.won+'口・落選 '+
      row.lost+'口 ／ 当落判明 '+row.decided+'口'+
      (row.decided<20?' ／ ※少数データ・参考値':'')+'</p>'+
      (row.badge&&row.decided>=30?'<span class="lp-store-high-badge">📈 過去実績高め</span>':'')+
      '</article>').join(''):
      '<p class="hint">当落が確定した応募記録のある店舗はまだありません。当選・落選の記録が増えると表示されます。</p>';
  }

  async function refresh(force=false){
    const client=getClient();
    if(!client){renderStats();return false;}
    if(fetching)return fetching;
    if(!force&&lastFetch&&Date.now()-lastFetch<60000)return true;
    const work=(async()=>{
      try{
        const {data,error:remote}=await client.rpc('lottery_store_stats_v1');
        if(remote)throw remote;
        const raw=Array.isArray(data)?data:[];
        stats=raw.filter(x=>x&&typeof x.store_name==='string'&&
          Number.isFinite(Number(x.rate))&&Number(x.decided)>=1)
          .map(x=>({...x,rate:Number(x.rate),decided:Number(x.decided),
            won:Number(x.won),lost:Number(x.lost),badge:x.badge===true}));
        byKey=new Map();
        for(const row of stats){
          for(const key of (Array.isArray(row.keys)?row.keys:[])){
            if(typeof key==='string')byKey.set(key,row);
          }
        }
        error='';lastFetch=Date.now();renderStats();renderCards();return true;
      }catch(e){
        error=String(e?.message||e);renderStats();return false;
      }
    })();
    fetching=work;
    try{return await work;}finally{if(fetching===work)fetching=null;}
  }

  function renderMaster(){
    if(!isDev())return;
    const list=$('lpStoreMasterList'),pending=$('lpStoreMasterCandidates');
    if(!list||!pending)return;
    const query=clean($('lpStoreMasterSearch')?.value).toLocaleLowerCase('ja-JP');
    const matches=text=>clean(text).toLocaleLowerCase('ja-JP').includes(query);
    const live=masters.filter(x=>!x.merged_into);
    const withAddress=live.filter(x=>clean(x.address)).length;
    const activePairs=pairs.filter(x=>!query||
      matches(x.left_name)||matches(x.right_name)||matches(x.prefecture));
    $('lpStoreMasterCount').textContent=live.length+'店舗';
    $('lpStoreMasterStatus').textContent='自動登録 '+live.length+'店舗 ／ 別名統合済み '+
      (masters.length-live.length)+'件 ／ 要確認 '+pairs.length+'組 ／ 住所登録 '+withAddress+'件 ／ 未登録 '+(live.length-withAddress)+'件';
    pending.innerHTML=activePairs.length?activePairs.slice(0,100).map(row=>
      '<div class="lp-store-master-pair" data-store-left="'+escape(row.left_id)+
      '" data-store-right="'+escape(row.right_id)+'">'+
      '<strong>📍 '+escape(row.prefecture)+'</strong>'+
      '<p>'+escape(row.left_name)+' ／ '+escape(row.right_name)+
      ' <small>類似度 '+Math.round(Number(row.similarity||0)*100)+'%</small></p>'+
      '<label>統合後の正式な名前<select data-store-target>'+
      '<option value="'+escape(row.left_id)+'">'+escape(row.left_name)+'</option>'+
      '<option value="'+escape(row.right_id)+'">'+escape(row.right_name)+'</option>'+
      '</select></label>'+
      '<div class="lp-store-master-buttons">'+
      '<button type="button" data-store-review="merge">同じ店舗として統合</button>'+
      '<button type="button" data-store-review="separate">別店舗として確定</button>'+
      '</div></div>').join(''):
      '<p class="hint">確認が必要な類似店舗はありません。完全一致と既知の略称は自動で統一されます。</p>';
    const byId=new Map(masters.map(row=>[row.id,row]));
    const visible=masters.filter(row=>{
      const target=row.merged_into?byId.get(row.merged_into):null;
      return !query||matches(row.name)||matches(row.prefecture)||matches(row.address)||
        (target&&(matches(target.name)||matches(target.address)));
    });
    list.innerHTML=visible.length?visible.slice(0,500).map(row=>{
      const target=(row.merged_into&&byId.get(row.merged_into))||row;
      return '<div class="lp-store-master-item" data-store-master-id="'+escape(row.id)+'">'+
      '<div class="lp-store-master-meta"><strong>'+escape(target.name)+
      '</strong><span>📍 '+escape(target.prefecture)+
      (row.merged_into?'（統合済み）':'')+'</span>'+
      (row.merged_into?'<small>統合元の表記：'+escape(row.name)+'</small>':'')+
      '<span class="lp-store-master-address">🏠 '+(target.address?escape(target.address):'住所未登録')+'</span>'+
      (target.address_source==='legacy_csv_unverified'
        ?'<small>既存CSV照合・現住所は未確認</small>':
         target.address_source==='developer_entry'
        ?'<small>開発者入力</small>':'')+
      '</div>'+
      (row.merged_into
        ?'<button type="button" data-store-unmerge="'+escape(row.id)+'">統合解除</button>'
        :'<div class="lp-store-master-actions"><button type="button" data-store-address-edit="'+escape(row.id)+'">'+
          (row.address?'住所を編集':'住所を登録')+'</button>'+
          '<button type="button" data-store-merge-target="'+escape(row.id)+'">統合先にする</button></div>')+
      '</div>';
    }).join(''):
      '<p class="hint">一致する店舗はありません。</p>';
    renderManualMerge();
  }

  function mergeFold(value){
    return clean(value).normalize('NFKC').toLocaleLowerCase('ja-JP')
      .replace(/[\s　・･._－（）()【】「」-]+/g,'');
  }
  function mergeMatches(row,query){
    const haystack=mergeFold([row.name,row.prefecture,row.address].join(' '));
    return clean(query).normalize('NFKC').split(/\s+/).filter(Boolean)
      .every(word=>haystack.includes(mergeFold(word)));
  }
  function mergeTarget(){return masters.find(row=>row.id===mergeTargetId&&!row.merged_into)||null;}
  function selectedMergeRows(){
    return masters.filter(row=>mergeSources.has(row.id)&&!row.merged_into);
  }
  function renderMergeSelection(){
    const list=$('lpStoreMergeSources');
    if(!list)return;
    const target=mergeTarget(),selected=selectedMergeRows();
    const busy=masterBusy||mergeBusy||addressSaving||!isDev()||!getClient();
    $('lpStoreMergeSelectedCount').textContent=selected.length+'件';
    $('lpStoreMergeTargetPreview').innerHTML=target
      ?'<small>この正式名称にまとめます</small><strong>'+escape(target.name)+
        '</strong><small>📍 '+escape(target.prefecture)+'</small><small>🏠 '+
        escape(target.address||'住所未登録')+'</small>'
      :'<p class="hint">正式名称として残す店舗を選んでください。</p>';
    $('lpStoreMergeSelected').innerHTML=selected.length?selected.map(row=>
      '<button type="button" data-store-merge-remove="'+escape(row.id)+'"'+
      (busy?' disabled':'')+' aria-label="'+escape(row.name+'を選択から外す')+'">'+
      escape(row.name)+' ×</button>').join(''):'<span class="hint">まだ選択されていません。</span>';
    for(const id of ['lpStoreMergePrefecture','lpStoreMergeTargetSearch','lpStoreMergeTarget'])$(id).disabled=busy;
    $('lpStoreMergeSourceSearch').disabled=busy||!target;
    for(const side of ['Target','Source']){
      $('lpStoreMerge'+side+'SearchClear').disabled=busy||
        !clean($('lpStoreMerge'+side+'Search').value)||(side==='Source'&&!target);
    }
    $('lpStoreMergeClear').disabled=busy||!selected.length;
    list.querySelectorAll('[data-store-merge-source]').forEach(input=>{
      input.checked=mergeSources.has(input.dataset.storeMergeSource);
      input.disabled=busy||!target;
      input.closest('label')?.classList.toggle('is-selected',input.checked);
    });
    const button=$('lpStoreMasterMerge');
    button.disabled=busy||!target||!selected.length;
    button.textContent=mergeBusy?'統合中…':selected.length
      ?selected.length+'店舗をこの正式店舗へ統合':'統合する店舗を選択';
    $('lpStoreMergeStatus').textContent=mergeMessage||(!target?'統合先を選ぶと、同じ都道府県の店舗だけ表示します。':
      selected.length?'選択した'+selected.length+'店舗 → '+target.name:'まとめる店舗にチェックしてください。複数選択できます。');
  }
  function renderManualMerge(){
    if(!isDev()||!$('lpStoreMergeSources'))return;
    const live=masters.filter(row=>!row.merged_into);
    const target=mergeTarget();
    if(!target){mergeTargetId='';mergeSources.clear();}
    for(const id of mergeSources){
      if(!live.some(row=>row.id===id&&row.id!==target?.id&&row.prefecture===target?.prefecture))mergeSources.delete(id);
    }
    const area=$('lpStoreMergePrefecture');
    const previous=target?.prefecture||area.value;
    const areas=[...new Set(live.map(row=>row.prefecture))].sort((a,b)=>clean(a).localeCompare(clean(b),'ja'));
    area.innerHTML='<option value="">すべての都道府県</option>'+areas.map(pref=>
      '<option value="'+escape(pref)+'">'+escape(pref)+'</option>').join('');
    area.value=areas.includes(previous)?previous:'';
    const sort=(a,b)=>clean(a.name).localeCompare(clean(b.name),'ja');
    const matches=live.filter(row=>(!area.value||row.prefecture===area.value)&&
      mergeMatches(row,$('lpStoreMergeTargetSearch').value)).sort(sort);
    const choices=[...(target?[target]:[]),...matches.filter(row=>row.id!==target?.id)].slice(0,180);
    $('lpStoreMergeTarget').innerHTML='<option value="">統合先を選択'+
      (matches.length?'（検索結果 '+matches.length+'件）':'')+'</option>'+choices.map(row=>
      '<option value="'+escape(row.id)+'">'+escape(row.prefecture+' / '+row.name)+'</option>').join('');
    $('lpStoreMergeTarget').value=mergeTargetId;
    const similar=new Set(pairs.flatMap(pair=>pair.left_id===target?.id?[pair.right_id]:
      pair.right_id===target?.id?[pair.left_id]:[]));
    const candidates=target?live.filter(row=>row.id!==target.id&&row.prefecture===target.prefecture&&
      mergeMatches(row,$('lpStoreMergeSourceSearch').value))
      .sort((a,b)=>Number(similar.has(b.id))-Number(similar.has(a.id))||sort(a,b)):[];
    $('lpStoreMergeSourceCount').textContent=target
      ?target.prefecture+' ／ '+candidates.length+'件'+(candidates.length>120?'（上位120件を表示・検索で絞り込めます）':'')
      :'統合先を先に選んでください。';
    $('lpStoreMergeSources').innerHTML=candidates.length?candidates.slice(0,120).map(row=>
      '<label class="lp-store-merge-option'+(mergeSources.has(row.id)?' is-selected':'')+'">'+
      '<input type="checkbox" data-store-merge-source="'+escape(row.id)+'"'+
      (mergeSources.has(row.id)?' checked':'')+'><span><strong>'+escape(row.name)+'</strong>'+
      '<small>'+escape(row.prefecture)+(similar.has(row.id)?' ／ 類似候補':'')+'</small>'+
      '<small>🏠 '+escape(row.address||'住所未登録')+'</small></span></label>').join(''):
      '<p class="hint">'+(target?'一致する統合元はありません。検索条件を変えてください。':'統合先を選ぶと候補が表示されます。')+'</p>';
    renderMergeSelection();
  }
  function chooseMergeTarget(id,reveal=false){
    if(!isDev()||masterBusy||mergeBusy||addressSaving)return;
    const row=masters.find(item=>item.id===id&&!item.merged_into);
    mergeTargetId=row?.id||'';mergeSources.clear();mergeMessage='';
    if($('lpStoreMergePrefecture')&&row)$('lpStoreMergePrefecture').value=row.prefecture;
    if($('lpStoreMergeSourceSearch'))$('lpStoreMergeSourceSearch').value='';
    if(reveal&&row){
      $('lpStoreMergeTargetSearch').value=row.name;
      $('lpStoreManualMerge').open=true;
    }
    renderManualMerge();
    if(reveal){
      $('lpStoreManualMerge')?.scrollIntoView?.({block:'start',behavior:'smooth'});
      $('lpStoreMergeTargetPreview')?.focus?.({preventScroll:true});
    }
  }
  async function mergeManualSelection(){
    if(!isDev()||masterBusy||mergeBusy||addressSaving)return false;
    const target=mergeTarget(),sources=selectedMergeRows();
    if(!target||!sources.length)return false;
    const text='次の'+sources.length+'店舗を、下記の正式店舗へ統合します。\n\n統合先：'+
      target.prefecture+' / '+target.name+(target.address?'\n住所：'+target.address:'')+
      '\n\n統合する店舗：\n'+sources.map(row=>'・'+row.name).join('\n')+
      '\n\n過去の当選統計とアプリ内の店舗表示にも反映します。統合しますか？';
    if(!confirm(text))return false;
    return applyReviews('merge',sources.map(row=>row.id),target.id);
  }

  async function refreshMaster(allowDuringMerge=false){
    if(!isDev()||!getClient()||masterBusy||(mergeBusy&&allowDuringMerge!==true))return false;
    masterBusy=true;
    renderMergeSelection();
    const status=$('lpStoreMasterStatus');
    if(status)status.textContent='店舗マスターを確認しています…';
    try{
      const {data,error:remote}=await getClient().rpc('lottery_store_admin_v1');
      if(remote)throw remote;
      masters=Array.isArray(data?.masters)?data.masters:[];
      pairs=Array.isArray(data?.candidates)?data.candidates:[];
      renderMaster();return true;
    }catch(e){
      if(status)status.textContent='⚠ マスターの取得に失敗：'+String(e?.message||e);
      return false;
    }finally{masterBusy=false;renderMergeSelection();}
  }

  async function submitReview(action,source,target){
    if(!isDev()||!getClient()||masterBusy||mergeBusy||addressSaving)return false;
    if(!['merge','separate'].includes(action)||!source||!target||source===target)return false;
    if(!confirm(action==='merge'
      ?'同じ店舗として統合します。過去の当選統計もまとめ直します。よろしいですか？'
      :'この2件を別店舗として確定し、今後の照合候補から外しますか？'))return false;
    const saved=await applyReviews(action,[source],target);
    if(!saved)alert(mergeMessage||'変更結果を確認できませんでした。');
    return saved;
  }
  async function applyReviews(action,sourceIds,targetId){
    if(!isDev()||!getClient()||masterBusy||mergeBusy||addressSaving)return false;
    const ids=[...new Set(sourceIds)],target=masters.find(row=>row.id===targetId&&!row.merged_into);
    const sources=ids.map(id=>masters.find(row=>row.id===id&&!row.merged_into));
    if(!['merge','separate'].includes(action)||!target||!ids.length||
       (action==='separate'&&ids.length!==1)||sources.some(row=>!row||row.id===targetId||row.prefecture!==target.prefecture)){
      mergeMessage='⚠ 店舗の選択内容を確認してください。同じ都道府県の店舗のみ統合できます。';
      renderMergeSelection();return false;
    }
    const client=getClient(),completed=new Set();
    let problem='',reloaded=false,viewsUpdated=true;
    mergeBusy=true;renderMergeSelection();
    try{
      try{
        for(const id of ids){
          if(!isDev())throw Error('ログイン状態が変更されました。');
          mergeMessage='処理中 '+(completed.size+1)+' / '+ids.length+'件…';renderMergeSelection();
          const {data,error:remote}=await client.rpc('lottery_store_review_v1',{
            p_source:id,p_target:targetId,p_action:action
          });
          if(remote)throw remote;
          if(data!==true)throw Error('変更結果を確認できませんでした。');
          completed.add(id);mergeSources.delete(id);
          if(action==='merge')masters=masters.map(row=>row.id===id?{...row,merged_into:targetId}:row);
        }
      }catch(error){problem=String(error?.message||error);}
      reloaded=await refreshMaster(true);
      // A lost response can still have committed. Reconcile with the saved
      // master before offering a retry; only unfinished selections remain.
      if(action==='merge'&&reloaded){
        for(const row of masters)if(ids.includes(row.id)&&row.merged_into===targetId){
          completed.add(row.id);mergeSources.delete(row.id);
        }
      }
      if(action==='merge'&&completed.size){
        try{
          for(const module of [globalThis.window?.TorecaStoreAliases,globalThis.window?.TorecaStoreMaps,
                               globalThis.window?.TorecaSalesReference]){
            if(module?.refresh&&await module.refresh(true)===false)viewsUpdated=false;
          }
          if(!await refresh(true))viewsUpdated=false;
        }catch(_){viewsUpdated=false;}
      }
      const finished=completed.size===ids.length;
      mergeMessage=finished?(action==='merge'
        ?'✅ '+completed.size+'店舗を「'+target.name+'」へ統合しました。'
        :'✅ 別店舗として確定しました。'):
        '⚠ '+completed.size+' / '+ids.length+'店舗を保存しました。未完了の店舗は選択に残しています。\n'+problem;
      if(!reloaded||!viewsUpdated)mergeMessage+='\n表示を再取得できませんでした。「更新・照合」で確認してください。';
      const status=$('lpStoreMasterStatus');if(status)status.textContent+=' ／ '+mergeMessage;
      return finished;
    }finally{mergeBusy=false;renderManualMerge();}
  }
  async function unmerge(id){
    if(!isDev()||!getClient()||!id||masterBusy||mergeBusy||addressSaving)return false;
    if(!confirm('この店舗の統合を解除し、別店舗として再集計しますか？'))return false;
    mergeBusy=true;renderMergeSelection();
    try{
      const {data,error:remote}=await getClient().rpc('lottery_store_unmerge_v1',{
        p_source:id
      });
      if(remote)throw remote;
      if(data!==true)throw Error('解除結果が確認できませんでした');
      await refreshMaster(true);
      await globalThis.window?.TorecaStoreAliases?.refresh?.(true);
      await globalThis.window?.TorecaStoreMaps?.refresh?.(true);
      await globalThis.window?.TorecaSalesReference?.refresh?.(true);
      await refresh(true);
      return true;
    }catch(error){
      alert('統合解除に失敗しました：'+String(error?.message||error));
      return false;
    }finally{mergeBusy=false;renderManualMerge();}
  }


  function openAddressEditor(id,button){
    if(!isDev()||!getClient()||addressSaving||masterBusy||mergeBusy)return;
    const row=masters.find(x=>x.id===id&&!x.merged_into);
    const holder=button.closest('.lp-store-master-item');
    if(!row||!holder)return;
    $('lpStoreMasterList')?.querySelectorAll('.lp-store-address-editor')
      .forEach(node=>node.remove());
    const form=document.createElement('form');
    form.className='lp-store-address-editor';
    const label=document.createElement('label');
    label.textContent=row.name+'（'+row.prefecture+'）の住所';
    const input=document.createElement('input');
    input.type='text';
    input.required=false;
    input.maxLength=250;
    input.autocomplete='street-address';
    input.placeholder=row.prefecture+'○○市○○町1-2-3';
    input.value=clean(row.address);
    label.append(input);
    const help=document.createElement('p');
    help.className='hint';
    help.textContent='都道府県から始まる住所を入力してください。空欄で保存すると住所を削除します。店舗の住所は他の支店へコピーしません。';
    const status=document.createElement('p');
    status.className='hint';
    status.setAttribute('role','status');
    const actions=document.createElement('div');
    actions.className='lp-store-address-actions';
    const save=document.createElement('button');
    save.type='submit';
    save.textContent='住所を保存';
    const cancel=document.createElement('button');
    cancel.type='button';
    cancel.textContent='キャンセル';
    cancel.addEventListener('click',()=>form.remove());
    actions.append(save,cancel);
    form.append(label,help,actions,status);
    holder.append(form);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(addressSaving||masterBusy||mergeBusy||!isDev()||!getClient())return;
      const address=clean(input.value);
      if(address&&!address.startsWith(row.prefecture)){
        status.textContent='⚠ 住所は「'+row.prefecture+'」から入力してください。';
        return;
      }
      if(!address&&row.address&&!confirm('この店舗の登録住所を削除しますか？'))return;
      addressSaving=true;
      renderMergeSelection();
      save.disabled=true;
      status.textContent='住所を保存しています…';
      try{
        const {data,error:remote}=await getClient().rpc('lottery_store_address_update_v1',{
          p_store_id:row.id,p_address:address
        });
        if(remote)throw remote;
        if(data?.success!==true)throw Error('保存結果を確認できませんでした');
        addressSaving=false;
        renderMergeSelection();
        await refreshMaster();
        await globalThis.window?.TorecaStoreAliases?.refresh?.(true);
        await globalThis.window?.TorecaStoreMaps?.refresh?.(true);
        const mainStatus=$('lpStoreMasterStatus');
        if(mainStatus)mainStatus.textContent+=' ／ ✅ 住所を保存しました';
      }catch(error){
        status.textContent='⚠ 住所を保存できませんでした：'+String(error?.message||error);
      }finally{
        addressSaving=false;
        renderMergeSelection();
        if(form.isConnected)save.disabled=false;
      }
    });
    input.focus();
  }

  function onCandidateClick(event){
    const button=event.target.closest('button[data-store-review]');
    if(!button)return;
    const row=button.closest('[data-store-left][data-store-right]');
    if(!row)return;
    const target=row.querySelector('[data-store-target]')?.value;
    const source=target===row.dataset.storeLeft?row.dataset.storeRight:row.dataset.storeLeft;
    submitReview(button.dataset.storeReview,source,target);
  }

  function init(options){
    getClient=options.getClient;isDev=options.isDev;
    renderCards=options.renderCards;escape=options.escape;
    $('lpStoreAnalyticsSearch')?.addEventListener('input',renderStats);
    $('lpStoreAnalyticsSort')?.addEventListener('change',renderStats);
    $('lpStoreAnalyticsReload')?.addEventListener('click',()=>refresh(true));
    $('lpStoreMasterReload')?.addEventListener('click',refreshMaster);
    $('lpStoreMasterSearch')?.addEventListener('input',renderMaster);
    $('lpStoreMasterCandidates')?.addEventListener('click',onCandidateClick);
    $('lpStoreMasterList')?.addEventListener('click',event=>{
      const target=event.target.closest('button[data-store-unmerge],button[data-store-address-edit],button[data-store-merge-target]');
      if(!target)return;
      if(target.dataset.storeUnmerge)unmerge(target.dataset.storeUnmerge);
      else if(target.dataset.storeMergeTarget)chooseMergeTarget(target.dataset.storeMergeTarget,true);
      else if(target.dataset.storeAddressEdit)openAddressEditor(target.dataset.storeAddressEdit,target);
    });
    for(const side of ['Target','Source']){
      const input=$('lpStoreMerge'+side+'Search');
      input?.addEventListener('input',()=>{
        if(masterBusy||mergeBusy||addressSaving)return;
        mergeMessage='';renderManualMerge();
      });
      $('lpStoreMerge'+side+'SearchClear')?.addEventListener('click',()=>{
        if(masterBusy||mergeBusy||addressSaving||!input)return;
        input.value='';mergeMessage='';renderManualMerge();input.focus?.({preventScroll:true});
      });
    }
    $('lpStoreMergePrefecture')?.addEventListener('change',()=>{
      if(masterBusy||mergeBusy||addressSaving)return;
      mergeTargetId='';mergeSources.clear();mergeMessage='';renderManualMerge();
    });
    $('lpStoreMergeTarget')?.addEventListener('change',()=>chooseMergeTarget($('lpStoreMergeTarget').value));
    $('lpStoreMergeSources')?.addEventListener('change',event=>{
      if(!isDev()||masterBusy||mergeBusy||addressSaving)return;
      const input=event.target.closest('[data-store-merge-source]'),target=mergeTarget();
      const source=input&&masters.find(row=>row.id===input.dataset.storeMergeSource&&!row.merged_into);
      if(!source||!target||source.id===target.id||source.prefecture!==target.prefecture)return;
      if(input.checked)mergeSources.add(source.id);else mergeSources.delete(source.id);
      mergeMessage='';renderMergeSelection();
    });
    $('lpStoreMergeSelected')?.addEventListener('click',event=>{
      if(masterBusy||mergeBusy||addressSaving)return;
      const button=event.target.closest('[data-store-merge-remove]');
      if(button){mergeSources.delete(button.dataset.storeMergeRemove);mergeMessage='';renderMergeSelection();}
    });
    $('lpStoreMergeClear')?.addEventListener('click',()=>{
      if(masterBusy||mergeBusy||addressSaving)return;
      mergeSources.clear();mergeMessage='';renderMergeSelection();
    });
    $('lpStoreMasterMerge')?.addEventListener('click',mergeManualSelection);
    $('lpStoreMasterPanel')?.closest('details.dev-accordion')?.addEventListener('toggle',event=>{
      if(event.currentTarget.open)refreshMaster();
    });
    renderStats();
  }
  window.TorecaStoreUI={init,refresh,refreshMaster,normalize,lookup,storeBadge,cardBadge};
})();
