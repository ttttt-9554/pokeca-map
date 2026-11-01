/* Toreca Radar: developer-only Supabase usage metrics */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const RPC='toreca_developer_usage_v1';
  let options=null,lastLoaded=0,lastUser='',generation=0,busy=null;
  const allow=()=>!!options?.isDev?.()&&!!options?.getClient?.()&&!!options?.getUserId?.();
  const safeN=value=>{
    const n=Number(value);
    return Number.isFinite(n)&&n>=0?n:0;
  };
  const integer=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;
  const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
  function bytes(value){
    const n=safeN(value);
    if(n===0)return '0 MB';
    if(n<1000000)return (n/1000).toFixed(0)+' KB';
    if(n<1000000000)return (n/1000000).toFixed(1)+' MB';
    return (n/1000000000).toFixed(2)+' GB';
  }
  function capacity(label,used,limit,note){
    const rate=safeN(limit)>0?Math.min(100,safeN(used)*100/safeN(limit)):0;
    const p=rate.toFixed(1),tone=rate>=90?' sb-usage-danger':rate>=75?' sb-usage-warning':'';
    return '<section class="sb-usage-size-card'+tone+'">'+
      '<div class="sb-usage-row"><strong>'+safe(label)+'</strong><span>'+
      bytes(used)+' / '+bytes(limit)+'</span></div>'+
      '<div class="sb-usage-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+p+'" aria-label="'+safe(label)+' 使用率">'+
      '<span style="width:'+p+'%"></span></div>'+
      '<p class="hint">'+p+'%・'+safe(note)+'</p></section>';
  }
  function stat(label,value,info){
    return '<article class="sb-usage-stat"><span>'+safe(label)+'</span>'+
      '<strong>'+safe(value)+'</strong><small>'+safe(info)+'</small></article>';
  }
  function render(data){
    const panel=$('sbUsageContent');
    if(!panel)return;
    $('sbUsageCapacity').innerHTML=
      capacity('Postgres データベース',data.database_bytes,data.database_free_reference_bytes,
        'Freeの参考上限（WAL等は別）')+
      capacity('ファイル Storage',data.storage_bytes,data.storage_free_reference_bytes,
        'Freeの参考枠（組織合計）');
    $('sbUsageStats').innerHTML=
      stat('登録ユーザー',integer(data.auth_users)+'人',
        '過去30日ログイン '+integer(data.auth_signed_in_30d)+'人（課金MAUとは別）')+
      stat('DB接続数',integer(data.connections)+' / '+integer(data.max_connections),
        '内部サービスを含む現在の接続数')+
      stat('Storageファイル',integer(data.storage_objects)+'件',
        'バケット '+integer(data.storage_buckets)+'個')+
      stat('定期ジョブ',integer(data.cron_active)+' / '+integer(data.cron_jobs),
        '有効 / 登録済み')+
      stat('Cron実行／24時間',integer(data.cron_runs_24h)+'回',
        'Cronの実行記録')+
      stat('Cron失敗／24時間',integer(data.cron_failed_24h)+'回',
        'Cronの失敗記録（外部API成功とは別）');
    const rows=Array.isArray(data.top_tables)?data.top_tables.slice(0,8):[];
    const top=Math.max(1,...rows.map(r=>safeN(r.bytes)));
    $('sbUsageTables').innerHTML=rows.length?rows.map(r=>{
      const width=Math.min(100,safeN(r.bytes)*100/top).toFixed(1);
      const approx=Number.isSafeInteger(r.approx_rows)&&r.approx_rows>=0
        ?'・約'+r.approx_rows+'行':'';
      return '<div class="sb-usage-table-row"><div class="sb-usage-table-title">'+
        '<span>'+safe(r.name)+'</span><strong>'+bytes(r.bytes)+safe(approx)+'</strong></div>'+
        '<div class="sb-usage-table-bar"><span style="width:'+width+'%"></span></div></div>';
    }).join(''):'<p class="hint">テーブル情報がありません。</p>';
    panel.hidden=false;
    const date=Date.parse(data.observed_at);
    $('sbUsageStatus').textContent='✅ 最終取得：'+(Number.isFinite(date)
      ?new Date(date).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',
        year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
      :'時刻未確認')+'（日本時間）';
  }
  function clear(){
    ++generation;lastLoaded=0;busy=null;
    const box=$('sbUsageContent');if(box)box.hidden=true;
    const status=$('sbUsageStatus');if(status)status.textContent='開くと使用状況を読み込みます。';
  }
  function onAuthChanged(){
    const uid=allow()?String(options.getUserId()):'';
    if(uid!==lastUser){lastUser=uid;clear();}
  }
  function refresh(force=false){
    onAuthChanged();
    if(!allow())return Promise.resolve(false);
    if(busy)return busy;
    if(!force&&lastLoaded&&Date.now()-lastLoaded<60000)return Promise.resolve(true);
    const uid=String(options.getUserId()),seq=++generation;
    const button=$('sbUsageReload'),status=$('sbUsageStatus');
    if(button)button.disabled=true;
    if(status)status.textContent='🔄 使用量を取得しています…';
    const task=(async()=>{
      try{
        const {data,error}=await options.getClient().rpc(RPC);
        if(error)throw error;
        if(!allow()||uid!==String(options.getUserId())||seq!==generation)return false;
        if(data?.schema_version!==1||!Array.isArray(data.top_tables)||
           !Number.isFinite(Number(data.database_bytes)))throw Error('Invalid usage response');
        render(data);lastLoaded=Date.now();return true;
      }catch(e){
        if(allow()&&seq===generation&&status)
          status.textContent='⚠ 使用量を取得できません。ログイン状態かRPCの権限を確認してください。';
        return false;
      }finally{
        if(button)button.disabled=false;
        if(busy===task)busy=null;
      }
    })();
    busy=task;return task;
  }
  function init(config){
    if(options)return;
    options=config;
    const panel=$('sbUsagePanel');if(!panel)return;
    const parent=panel.closest('details.dev-accordion');
    $('sbUsageReload')?.addEventListener('click',()=>{void refresh(true);});
    parent?.addEventListener('toggle',()=>{if(parent.open&&allow())void refresh();});
    onAuthChanged();
    if(parent?.open&&allow())void refresh();
  }
  window.TorecaSupabaseUsage={init,onAuthChanged,refresh};
})();