/* Toreca Radar - public, read-only store sales-format reference for lottery cards. */
(function(){
  'use strict';
  const RPC='lottery_store_sales_reference_v1';
  const CACHE_MS=2*60*1000;
  const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
  // Keep matching consistent with the developer-only Information Plaza editor.
  // Deliberately match the branch name, not a shared chain prefix.
  const normalize=value=>String(value??'').normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/[\s　・･._－（）()【】「」-]+/g,'');
  const key=(genre,prefecture,name)=>
    [genre,prefecture,normalize(name)].join('\u001f');
  const isState=value=>['yes','no','unknown'].includes(value);
  const stateLabel=value=>value==='yes'?'あり':value==='no'?'なし':'未確認';
  const dateLabel=value=>{
    const n=Date.parse(String(value||''));
    if(!Number.isFinite(n))return '';
    return new Intl.DateTimeFormat('ja-JP',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).format(new Date(n));
  };
  let options=null,sessionId='',lastFetch=0,requestSeq=0;
  let rowsByKey=new Map(),loading=null,lastError='';
  function changed(){options?.onDataChanged?.();}

  function userId(){return String(options?.getUserId?.()||'');}
  function getClient(){return options?.getClient?.()||null;}
  // Public reference contains display fields only; admin editing remains separate.
  function canRead(){return !!getClient();}
  function rerender(){
    if(document.getElementById('lotteryView')?.classList.contains('active'))
      options?.renderCards?.();
  }
  function clear(){
    ++requestSeq;
    rowsByKey=new Map();
    lastFetch=0;
    lastError='';
    loading=null;
    rerender();
    changed();
  }
  function onAuthChanged(){
    const id=userId();
    if(id===sessionId)return;
    sessionId=id;
    clear();
    if(document.getElementById('lotteryView')?.classList.contains('active')||
       document.getElementById('infoPlazaView')?.classList.contains('active'))
      refresh(true);
  }
  async function refresh(force=false){
    if(!canRead()){
      if(sessionId){sessionId='';clear();}
      return false;
    }
    const id=userId();
    if(id!==sessionId){sessionId=id;clear();}
    if(loading){
      if(force){await loading;if(canRead()&&userId()===id)return refresh(true);}
      return loading;
    }
    if(!force&&lastFetch&&Date.now()-lastFetch<CACHE_MS)return true;
    const seq=++requestSeq;
    const work=(async()=>{
      try{
        const {data,error}=await getClient().rpc(RPC);
        if(error)throw error;
        if(seq!==requestSeq||userId()!==id)return false;
        if(!Array.isArray(data)||data.length>5000)
          throw Error('販売形態の参照データ形式を確認できません');
        const index=new Map();
        for(const row of data){
          if(!row||!['pokemon','onepiece'].includes(row.genre)||
             typeof row.store_name!=='string'||typeof row.prefecture!=='string'||
             typeof row.store_key!=='string')continue;
          const storeName=row.store_name.trim(),pref=row.prefecture.trim();
          if(!storeName||!pref||!normalize(storeName))continue;
          if(!isState(row.shrink_state)||!isState(row.peri_state)||
             !isState(row.tape_cut_state))continue;
          const selected=(row.genre==='pokemon'
            ?row.shrink_state!=='unknown'||row.peri_state!=='unknown'
            :row.tape_cut_state!=='unknown')||
            (typeof row.notes==='string'&&row.notes.trim().length>0);
          if(!selected)continue;
          // Index only rows whose normalized key agrees with their name.
          // Never let malformed or stale aliases match unrelated branches.
          if(normalize(row.store_key)!==normalize(storeName))continue;
          const canonical=globalThis.window?.TorecaStoreAliases?.resolve?.({
            name:storeName,prefecture:pref
          })||{name:storeName,prefecture:pref};
          const display={...row,store_name:canonical.name,prefecture:canonical.prefecture};
          const id=key(row.genre,canonical.prefecture,canonical.name);
          const existing=index.get(id);
          // Two historical aliases can point to the same shop/genre.
          // Display the newest entry instead of duplicating the branch.
          const nextDate=Date.parse(String(display.updated_at||''))||0;
          const lastDate=Date.parse(String(existing?.updated_at||''))||0;
          if(!existing||nextDate>=lastDate)index.set(id,display);
        }
        rowsByKey=index;
        lastFetch=Date.now();
        lastError='';
        rerender();
        changed();
        return true;
      }catch(error){
        if(seq===requestSeq&&userId()===id){
          console.warn('販売形態の参考情報を取得できませんでした:',error?.message||error);
          // A failed request must not display an arbitrarily stale record.
          rowsByKey=new Map();
          lastFetch=0;
          lastError='販売形態を取得できませんでした。';
          rerender();
          changed();
        }
        return false;
      }finally{
        if(loading===work){loading=null;changed();}
      }
    })();
    loading=work;
    changed();
    return work;
  }

  function match(item,stores,genre){
    if(!canRead()||!['pokemon','onepiece'].includes(genre)||
       !Array.isArray(stores)||!stores.length||!rowsByKey.size)return [];
    const found=[],seen=new Set();
    for(const store of stores){
      const name=String(store?.name||'').trim();
      // An event-wide prefecture must never be assigned to multiple branches.
      const prefecture=String(store?.prefecture||
        (stores.length===1?item?.prefecture:'')||'').trim();
      if(!name||!prefecture)continue;
      const canonical=globalThis.window?.TorecaStoreAliases?.resolve?.({
        name,prefecture
      })||{name,prefecture};
      const lookup=key(genre,canonical.prefecture,canonical.name);
      if(seen.has(lookup))continue;
      seen.add(lookup);
      const row=rowsByKey.get(lookup);
      if(row)found.push(row);
    }
    return found;
  }

  function entryHtml(row,genre){
    const fields=genre==='pokemon'
      ?[['シュリンク',row.shrink_state],['ペリ',row.peri_state]]
      :[['テプカ',row.tape_cut_state]];
    return '<div class="lp-sales-ref-entry">'+
      '<div class="lp-sales-ref-shop"><strong>'+escape(row.store_name)+'</strong>'+
        '<small>（'+escape(row.prefecture)+'）</small></div>'+
      '<div class="lp-sales-ref-values">'+fields.map(([label,value])=>
        '<span class="lp-sales-ref-value lp-sales-ref-'+value+'">'+
        escape(label)+'：<strong>'+escape(stateLabel(value))+'</strong></span>'
      ).join('')+'</div>'+
      (row.notes?'<p class="lp-sales-ref-memo"><strong>補足メモ：</strong>'+escape(row.notes)+'</p>':'')+
      (dateLabel(row.updated_at)?'<small class="lp-sales-ref-date">情報更新：'+
        escape(dateLabel(row.updated_at))+'</small>':'')+
      '</div>';
  }

  function render(item,stores,genre){
    const matched=match(item,stores,genre);
    if(!matched.length)return '';
    const note='<p class="lp-sales-ref-note">店舗別に登録された販売形態の参考情報です。'+
      '今回の抽選・販売条件を保証するものではありません。最新の条件は公式案内で確認してください。</p>';
    if(stores.length===1){
      return '<section class="lp-sales-ref-block" aria-label="店舗の販売形態（参考）">'+
        '<strong class="lp-sales-ref-title">📦 店舗の販売形態（参考）</strong>'+
        entryHtml(matched[0],genre)+note+'</section>';
    }
    return '<details class="lp-sales-ref-block lp-sales-ref-fold">'+
      '<summary>📦 店舗の販売形態（参考） <span>登録あり '+
        matched.length+' / 対象'+stores.length+'店舗</span></summary>'+
      '<div class="lp-sales-ref-details">'+matched.map(row=>entryHtml(row,genre)).join('')+
        note+'</div></details>';
  }

  function list(){
    return [...rowsByKey.values()].map(row=>({
      store_name:row.store_name,
      prefecture:row.prefecture,
      genre:row.genre,
      shrink_state:row.shrink_state,
      peri_state:row.peri_state,
      tape_cut_state:row.tape_cut_state,
      notes:row.notes||'',
      updated_at:row.updated_at
    }));
  }
  function status(){
    return {loaded:!!lastFetch,loading:!!loading,error:lastError,count:rowsByKey.size};
  }
  function init(config){
    options=config;
    onAuthChanged();
  }
  window.TorecaSalesReference={init,refresh,onAuthChanged,render,list,status};
})();
