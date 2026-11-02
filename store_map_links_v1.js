/* Toreca Radar — read-only Google Maps links for lottery card branches. */
(() => {
  'use strict';
  const RPC='lottery_store_map_addresses_v1';
  const CACHE_MS=2*60*1000;
  const $=id=>document.getElementById(id);
  const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
  const clean=value=>String(value??'').trim();
  const normalize=value=>clean(value).normalize('NFKC').toLocaleLowerCase('ja-JP')
    .replace(/[\s　・･._－（）()【】「」-]+/g,'')
    .replace(/様$/,'').replace(/^イエサブ/,'イエローサブマリン');
  const validPref=value=>/^(?:北海道|東京都|大阪府|京都府|.{2,3}県)$/.test(value);
  const key=(name,pref)=>pref+'\u001f'+normalize(name);
  const genericName=name=>
    /^(?:店舗未確認|未確認|対象者限定|対象店舗|全国|全店舗|不明|なし|30th)$/.test(name)||
    /[/／]/.test(name)||/^[^\s]{1,4}店$/.test(name)||name.length<3;
  let options=null,userId='',lastFetch=0,requestSeq=0;
  let addressByStore=new Map(),loading=null;

  function canRead(){
    return !!options?.getClient?.()&&!!options?.getUserId?.();
  }
  function active(){
    return !!$('lotteryView')?.classList.contains('active');
  }
  function rerender(){
    if(active())options?.renderCards?.();
  }
  function reset(){
    ++requestSeq;
    addressByStore=new Map();
    lastFetch=0;
    loading=null;
    rerender();
  }
  function onAuthChanged(){
    const nextId=clean(options?.getUserId?.());
    if(nextId!==userId){
      userId=nextId;
      reset();
    }
    if(userId&&active())void refresh();
  }
  async function refresh(force=false){
    if(!canRead())return false;
    const nextId=clean(options.getUserId());
    if(nextId!==userId){userId=nextId;reset();}
    if(!userId)return false;
    if(!force&&lastFetch&&Date.now()-lastFetch<CACHE_MS)return true;
    if(loading)return loading;
    const seq=++requestSeq,startedFor=userId;
    const work=(async()=>{
      try{
        const {data,error}=await options.getClient().rpc(RPC);
        if(error)throw error;
        if(seq!==requestSeq||startedFor!==clean(options.getUserId()))return false;
        if(!Array.isArray(data)||data.length>5000)
          throw Error('店舗住所データの形式が不正です');
        const index=new Map(),conflicts=new Set();
        for(const row of data){
          if(!row||typeof row.name!=='string'||
             typeof row.prefecture!=='string'||typeof row.address!=='string')continue;
          const name=clean(row.name),pref=clean(row.prefecture),address=clean(row.address);
          if(!name||!validPref(pref)||!address.startsWith(pref)||
             address.length>250||name.length>200)continue;
          const k=key(name,pref);
          if(index.has(k)&&index.get(k)!==address)conflicts.add(k);
          else index.set(k,address);
        }
        // Ambiguous normalized names must never resolve to an arbitrary branch.
        for(const k of conflicts)index.delete(k);
        addressByStore=index;
        lastFetch=Date.now();
        rerender();
        return true;
      }catch(error){
        if(seq===requestSeq&&startedFor===clean(options.getUserId())){
          console.warn('店舗住所を読み込めませんでした:',error?.message||error);
          addressByStore=new Map();
          lastFetch=0;
          rerender();
        }
        return false;
      }finally{
        if(loading===work)loading=null;
      }
    })();
    loading=work;
    return work;
  }

  function render(store,singleStorePref=''){
    if(!canRead()||!store)return '';
    const original={name:clean(store.name),prefecture:clean(store.prefecture||singleStorePref)};
    const canonical=globalThis.window?.TorecaStoreAliases?.resolve?.(original)||original;
    const name=clean(canonical.name),pref=clean(canonical.prefecture);
    if(!name||!validPref(pref)||name.length>200)return '';
    // A merged source always inherits the active master target's address.
    // Never use the source's old address after a merge or unmerge.
    const address=clean(canonical.address)||addressByStore.get(key(name,pref))||'';
    // A missing master address cannot identify an unqualified or ambiguous shop.
    if(!address&&genericName(name))return '';
    const query=address?name+', '+address:name+', '+pref;
    const href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(query);
    const label='📍 MAP';
    const explanation=address
      ?name+'の住所でGoogleマップを開く（別画面）'
      :name+'を'+pref+'で検索する（住所未登録・別画面）';
    return '<a class="lp-store-map-link" href="'+escape(href)+
      '" target="_blank" rel="noopener noreferrer" title="'+escape(explanation)+
      '" aria-label="'+escape(explanation)+'">'+label+'</a>';
  }
  function onTabChanged(tab){
    if(tab==='lottery'&&canRead())void refresh();
  }
  function init(config){
    options=config;
    onAuthChanged();
  }
  window.TorecaStoreMaps={init,onAuthChanged,onTabChanged,refresh,render};
})();
