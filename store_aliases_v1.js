/* Toreca Radar: one canonical store name per approved store-master merge. */
(() => {
  'use strict';
  const RPC='lottery_store_canonical_reference_v1';
  const CACHE_MS=90*1000;
  const clean=value=>String(value??'').trim();
  const norm=value=>clean(value).normalize('NFKC').toLocaleLowerCase('ja-JP')
    .replace(/[\s　・･._－（）()【】「」-]+/g,'');
  const key=(prefecture,name)=>clean(prefecture)+'\u001f'+norm(name);
  let options=null,sessionId='',lastFetch=0,requestSeq=0,loading=null;
  let byStore=new Map(),uniqueByName=new Map(),version=0;

  function resolve(store,prefecture=''){
    const original=typeof store==='string'
      ?{name:clean(store),prefecture:clean(prefecture)}
      :{name:clean(store?.name),prefecture:clean(store?.prefecture||prefecture)};
    if(!original.name)return {...original,address:'',merged:false};
    const entry=byStore.get(key(original.prefecture,original.name))||
      (!original.prefecture?uniqueByName.get(norm(original.name)):null);
    return entry
      ?{name:entry.name,prefecture:entry.prefecture||original.prefecture,
         address:entry.address||'',merged:true}
      :{...original,address:'',merged:false};
  }
  function canonicalizeStores(stores){
    if(!Array.isArray(stores))return [];
    const seen=new Set(),output=[];
    for(const item of stores){
      if(!item||typeof item.name!=='string')continue;
      const result=resolve(item);
      if(!result.name)continue;
      const id=key(result.prefecture,result.name);
      if(seen.has(id))continue;
      seen.add(id);
      output.push({...item,name:result.name,prefecture:result.prefecture});
    }
    return output;
  }
  function name(value,prefecture=''){return resolve(value,prefecture).name;}
  function address(value,prefecture=''){return resolve(value,prefecture).address;}
  function canRead(){return !!options?.getClient?.();}
  function onAuthChanged(){
    const next=clean(options?.getUserId?.());
    if(next!==sessionId){
      sessionId=next;
      ++requestSeq;
      byStore=new Map();uniqueByName=new Map();
      lastFetch=0;loading=null;version++;
      options?.onChanged?.();
    }
    if(canRead())void refresh();
  }
  async function refresh(force=false){
    if(!canRead())return false;
    const uid=clean(options.getUserId());
    if(uid!==sessionId){
      const hadAliases=byStore.size>0;
      sessionId=uid;
      ++requestSeq;byStore=new Map();uniqueByName=new Map();
      lastFetch=0;loading=null;version++;
      // A session may be swapped directly by the Supabase SDK between tabs.
      // Repaint so former aliases and their target addresses cannot linger.
      if(hadAliases)options?.onChanged?.();
    }
    // Signed-out map and discovery views may read only this public alias list.
    if(loading){
      if(force){await loading;return refresh(true);}
      return loading;
    }
    if(!force&&lastFetch&&Date.now()-lastFetch<CACHE_MS)return true;
    const seq=++requestSeq;
    const task=(async()=>{
      try{
        const {data,error}=await options.getClient().rpc(RPC);
        if(error)throw error;
        if(seq!==requestSeq||uid!==clean(options.getUserId()))return false;
        if(!Array.isArray(data)||data.length>5000)
          throw Error('店舗統合情報の形式が不正です');
        const fresh=new Map(),collisions=new Set(),byName=new Map(),nameCollisions=new Set();
        for(const row of data){
          const source=clean(row?.source_name),srcPref=clean(row?.source_prefecture);
          const target=clean(row?.name),targetPref=clean(row?.prefecture);
          const storeAddress=clean(row?.address);
          if(!source||!srcPref||!target||!targetPref||srcPref!==targetPref||
             source.length>200||target.length>200||
             (storeAddress&&!storeAddress.startsWith(targetPref)))continue;
          const entry={name:target,prefecture:targetPref,address:storeAddress};
          const k=key(srcPref,source),nk=norm(source);
          if(fresh.has(k)&&fresh.get(k).name!==target)collisions.add(k);
          fresh.set(k,entry);
          if(byName.has(nk)&&
             (byName.get(nk).name!==target||byName.get(nk).prefecture!==targetPref))
             nameCollisions.add(nk);
          byName.set(nk,entry);
        }
        for(const k of collisions)fresh.delete(k);
        for(const k of nameCollisions)byName.delete(k);
        const signature=rowsSignature(fresh);
        const old=rowsSignature(byStore);
        byStore=fresh;uniqueByName=byName;lastFetch=Date.now();
        if(signature!==old){version++;options?.onChanged?.();}
        return true;
      }catch(error){
        if(seq===requestSeq&&uid===clean(options.getUserId())){
          console.warn('店舗マスターの統合情報を取得できませんでした:',error?.message||error);
          lastFetch=0;
          // Do not continue using a possibly revoked/deleted merge.
          if(byStore.size){
            byStore=new Map();uniqueByName=new Map();
            version++;options?.onChanged?.();
          }
        }
        return false;
      }finally{
        if(loading===task)loading=null;
      }
    })();
    loading=task;
    return task;
  }
  function rowsSignature(map){
    return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([k,v])=>[k,v.name,v.prefecture,v.address].join('\t')).join('\n');
  }
  function onTabChanged(tab){
    if(['lottery','lotteryManage','lotteryResults','appLottery',
        'infoPlaza','dev','map','add'].includes(tab))void refresh();
  }
  function init(config){
    if(options)return;
    options=config;
    onAuthChanged();
  }
  window.TorecaStoreAliases={
    init,onAuthChanged,onTabChanged,refresh,resolve,canonicalizeStores,
    name,address,get version(){return version},get count(){return byStore.size}
  };
})();
