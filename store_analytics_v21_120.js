// v21.120 — Store matching statistics UI.
// No private account, user identifier or raw entry data is requested by this module.
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let getClient=()=>null, isDev=()=>false, renderCards=()=>{}, escape=s=>String(s);
  let stats=[],byKey=new Map(),fetching=null,lastFetch=0,error='';
  let masters=[],pairs=[],masterBusy=false;
  const clean=s=>String(s??'').trim();

  function normalize(name){
    let n=clean(name).toLocaleLowerCase('ja-JP')
      .replace(/[\s　・･._－（）()【】「」-]+/g,'')
      .replace(/様$/,'').replace(/^イエサブ/,'イエローサブマリン');
    if(n.startsWith('イエローサブマリン')&&!n.endsWith('店'))n+='店';
    return n;
  }
  function lookup(store){
    return byKey.get(clean(store?.prefecture)+'|'+normalize(store?.name))||null;
  }
  function storeBadge(store){
    const row=lookup(store);
    if(!row?.badge)return '';
    return '<span class="lp-store-high-badge" title="過去の全商品・全抽選の登録実績を基にした参考情報です。今回の当選を保証しません。">📈 過去実績高め</span>';
  }
  function cardBadge(stores){
    const eligible=(stores||[]).filter(store=>lookup(store)?.badge);
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
      '公開可能な店舗 '+stats.length+'件（当落判明20口以上・異なる登録者5人以上）';
    list.innerHTML=rows.length?rows.slice(0,120).map(row=>
      '<article class="lp-store-analytics-row"><div class="lp-store-analytics-head">'+
      '<strong>'+escape(row.store_name)+'</strong>'+
      '<strong class="lp-store-analytics-rate">'+Number(row.rate).toFixed(1)+'%</strong></div>'+
      '<p class="hint">📍 '+escape(row.prefecture)+' ／ 当選 '+row.won+'口・落選 '+
      row.lost+'口 ／ 当落判明 '+row.decided+'口</p>'+
      (row.badge?'<span class="lp-store-high-badge">📈 過去実績高め</span>':'')+
      '</article>').join(''):
      '<p class="hint">公開条件を満たす店舗がまだありません。店舗別の応募・当落データが増えると自動的に表示されます。</p>';
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
          Number.isFinite(Number(x.rate))&&Number(x.decided)>=20)
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
    const activePairs=pairs.filter(x=>!query||
      matches(x.left_name)||matches(x.right_name)||matches(x.prefecture));
    $('lpStoreMasterCount').textContent=live.length+'店舗';
    $('lpStoreMasterStatus').textContent='自動登録 '+live.length+'店舗 ／ 別名統合済み '+
      (masters.length-live.length)+'件 ／ 要確認 '+pairs.length+'組';
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
    const visible=masters.filter(row=>!query||
      matches(row.name)||matches(row.prefecture));
    list.innerHTML=visible.length?visible.slice(0,300).map(row=>
      '<div class="lp-store-master-item"><strong>'+escape(row.name)+
      '</strong><span>📍 '+escape(row.prefecture)+
      (row.merged_into?'（別名として統合済み）':'')+'</span>'+
      (row.merged_into?'<button type="button" data-store-unmerge="'+escape(row.id)+'">統合解除</button>':'')+
      '</div>').join(''):
      '<p class="hint">一致する店舗はありません。</p>';
    const choices=live.slice().sort((a,b)=>
      clean(a.prefecture).localeCompare(clean(b.prefecture),'ja')||
      clean(a.name).localeCompare(clean(b.name),'ja'));
    const options='<option value="">店舗を選択</option>'+choices.map(x=>
      '<option value="'+escape(x.id)+'">'+escape(x.prefecture+' / '+x.name)+'</option>').join('');
    for(const id of ['lpStoreMergeSource','lpStoreMergeTarget']){
      const select=$(id);
      if(!select)continue;
      const old=select.value;
      select.innerHTML=options;
      if(choices.some(x=>x.id===old))select.value=old;
    }
  }

  async function refreshMaster(){
    if(!isDev()||!getClient()||masterBusy)return false;
    masterBusy=true;
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
    }finally{masterBusy=false;}
  }

  async function submitReview(action,source,target){
    if(!isDev()||!getClient()||masterBusy)return false;
    if(!['merge','separate'].includes(action)||!source||!target||source===target)return false;
    if(!confirm(action==='merge'
      ?'同じ店舗として統合します。過去の当選統計もまとめ直します。よろしいですか？'
      :'この2件を別店舗として確定し、今後の照合候補から外しますか？'))return false;
    const {data,error:remote}=await getClient().rpc('lottery_store_review_v1',{
      p_source:source,p_target:target,p_action:action
    });
    if(remote){alert('保存できませんでした：'+String(remote.message||remote));return false;}
    if(data!==true){alert('変更結果を確認できませんでした。');return false;}
    await refreshMaster();
    if(action==='merge')await refresh(true);
    return true;
  }
  async function unmerge(id){
    if(!isDev()||!getClient()||!id||masterBusy)return false;
    if(!confirm('この店舗の統合を解除し、別店舗として再集計しますか？'))return false;
    try{
      const {data,error:remote}=await getClient().rpc('lottery_store_unmerge_v1',{
        p_source:id
      });
      if(remote)throw remote;
      if(data!==true)throw Error('解除結果が確認できませんでした');
      await refreshMaster();
      await refresh(true);
      return true;
    }catch(error){
      alert('統合解除に失敗しました：'+String(error?.message||error));
      return false;
    }
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
      const target=event.target.closest('button[data-store-unmerge]');
      if(target)unmerge(target.dataset.storeUnmerge);
    });
    $('lpStoreMasterMerge')?.addEventListener('click',()=>{
      const source=$('lpStoreMergeSource')?.value;
      const target=$('lpStoreMergeTarget')?.value;
      submitReview('merge',source,target);
    });
    $('lpStoreMasterPanel')?.closest('details.dev-accordion')?.addEventListener('toggle',event=>{
      if(event.currentTarget.open)refreshMaster();
    });
    renderStats();
  }
  window.TorecaStoreUI={init,refresh,refreshMaster,normalize,lookup,storeBadge,cardBadge};
})();
