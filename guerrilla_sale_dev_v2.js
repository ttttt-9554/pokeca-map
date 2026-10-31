/* Developer-only sale controls. Database RLS remains the authorization boundary. */
(() => {
  'use strict';
  const BASE='https://aypcmtlaaygmiexboypk.supabase.co';
  const KEY='sb_publishable_C0YESv-nDjR7PvAoMPscQg_uznt6foN';
  const SESSION='sb-aypcmtlaaygmiexboypk-auth-token';
  const DEVELOPER='0ba965da-445b-4055-8d8d-ead585fa0d09';
  const SITES={
    pokemon:{name:'ポケモンセンターオンライン',host:'www.pokemoncenter-online.com',id:'pokemon-center-online'},
    amenity:{name:'アメニティードリーム',host:'www.amenitydream.com',id:'amenity-dream-online'}
  };
  SITES.pokemon.catalog='https://www.pokemoncenter-online.com/pokemon-card-game/';
  SITES.amenity.catalog='https://www.amenitydream.com/product-list';
  const $=id=>document.getElementById(id);
  let root,targets=[],snapshot={},events=[],products=[],counts={},fastHealth={},fastHealthError='',busy=false,editing=null,epoch=0;
  const shown=()=>!!$('devView')&&!$('devView').hidden;
  function token(){try{const value=JSON.parse(localStorage.getItem(SESSION)||'null');return value?.access_token||value?.currentSession?.access_token||'';}catch(_){return '';}}
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,action){const b=node('button',text);b.type='button';b.addEventListener('click',action);return b;}
  function status(text){if($('saleBetaStatus'))$('saleBetaStatus').textContent=text;if($('saleBetaAuthStatus')){$('saleBetaAuthStatus').textContent=text;$('saleBetaAuthStatus').hidden=!!root&&!root.hidden;}}
  function date(value){const n=Date.parse(value||'');return Number.isFinite(n)?new Date(n).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'未実行';}
  function canonical(value,site){
    const u=new URL(value.trim());
    const pattern=site==='pokemon'?/^\/[0-9]{6,20}(?:-[A-Za-z0-9_-]+)?\.html$/:/^\/product\/[0-9]+$/;
    if(!SITES[site]||u.protocol!=='https:'||u.hostname!==SITES[site].host||u.port||u.username||u.password||!pattern.test(u.pathname.replace(/\/$/,'')))throw new Error('選択した店舗の具体的な商品ページURLを入力してください。');
    if([...u.searchParams.keys()].some(k=>k.startsWith('dwvar_')))throw new Error('サイズ・色指定のURLは未対応です。商品固有のURLを確認してください。');
    return 'https://'+u.hostname+u.pathname.replace(/\/$/,'');
  }
  function link(url){const a=node('a','公式ページ ↗');try{const u=new URL(url);if(u.protocol!=='https:'||!Object.values(SITES).some(s=>s.host===u.hostname))return node('span','URL未確認');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';}catch(_){return node('span','URL未確認');}return a;}
  async function api(path,t,options={}){
    const response=await fetch(BASE+path,{method:options.method||'GET',cache:'no-store',headers:{apikey:KEY,Authorization:'Bearer '+t,'Content-Type':'application/json',Prefer:options.prefer||'return=representation'},body:options.body===undefined?undefined:JSON.stringify(options.body)});
    const text=await response.text();let data;try{data=text?JSON.parse(text):null;}catch(_){throw new Error('取得データの形式を確認できません。');}
    if(!response.ok)throw new Error(response.status===401||response.status===403?'開発者アカウントでログインし直してください。':'保存・取得に失敗しました（HTTP '+response.status+'）。');
    if(!shown()||t!==token())throw new Error('ログイン状態が変わりました。');
    return {data,count:Number((response.headers.get('content-range')||'').split('/')[1])};
  }
  async function authorize(){
    const t=token();if(!shown()||!t)throw new Error('開発者ログインが必要です。');
    const {data}=await api('/auth/v1/user',t);
    if(data?.id!==DEVELOPER)throw new Error('開発者専用です。');
    return t;
  }
  async function readTargets(t){
    const result=[];
    for(let offset=0;;offset+=500){
      const {data}=await api('/rest/v1/guerrilla_sale_monitor_targets?select=*&order=created_at,id&limit=500&offset='+offset,t);
      result.push(...(data||[]));if(!data||data.length<500)return result;
    }
  }
  function clear(){epoch++;targets=[];events=[];products=[];snapshot={};counts={};fastHealth={};fastHealthError='';editing=null;if(root){root.hidden=true;$('saleBetaSites')?.replaceChildren();$('saleBetaTargets')?.replaceChildren();$('saleBetaEvents')?.replaceChildren();$('saleBetaProducts')?.replaceChildren();$('saleBetaForm')?.reset();}}
  async function refresh(){
    if(busy||!shown())return;
    busy=true;const generation=epoch;
    try{
      const t=await authorize();
      const data=await Promise.all([
        readTargets(t),
        api('/rest/v1/guerrilla_sale_monitor_snapshot?select=payload,updated_at&id=eq.current',t),
        api('/rest/v1/guerrilla_sale_events?select=*&order=detected_at.desc&limit=20',t),
        api('/rest/v1/guerrilla_sale_products?select=*&order=checked_at.desc.nullslast&limit=20',t),
        ...Object.keys(SITES).map(site=>api('/rest/v1/guerrilla_sale_products?select=id&site_key=eq.'+site+'&limit=1',t,{prefer:'count=exact'})),
        api('/rest/v1/rpc/guerrilla_fast_admin_health_v1',t,{method:'POST',body:{}})
          .catch(e=>({data:null,healthError:String(e.message||e)}))
      ]);
      if(generation!==epoch||!shown()||token()!==t)return;
      targets=data[0];snapshot=data[1].data?.[0]?.payload||{};events=data[2].data||[];products=data[3].data||[];
      Object.keys(SITES).forEach((site,i)=>{counts[site]=Number.isFinite(data[4+i].count)?data[4+i].count:0;});
      const healthData=data[4+Object.keys(SITES).length];
      fastHealthError=healthData.healthError||'';
      fastHealth=Object.fromEntries((Array.isArray(healthData.data)?healthData.data:[])
        .filter(row=>row&&SITES[row.site_key]).map(row=>[row.site_key,row]));
      root.hidden=false;render();
      status(data[1].data?.length?'設定と保存済み結果を読み込みました。最終実行：'+date(data[1].data[0].updated_at):'設定は保存できますが、監視処理はまだ実行確認できていません。ONは実行成功を意味しません。');
    }catch(e){status(e.message);}finally{busy=false;}
  }
  async function mutate(path,method,body){
    if(busy)throw new Error('処理中です。完了後にもう一度操作してください。');
    busy=true;
    try{const t=await authorize();await api('/rest/v1/'+path,t,{method,body});status('設定を保存しました。次回の監視処理から適用されます。');}
    catch(e){status(e.message);throw e;}
    finally{busy=false;}
    await refresh();
  }
  function toggle(label,checked,action){
    const wrap=node('label',undefined,'sale-beta-toggle');const input=document.createElement('input');input.type='checkbox';input.checked=checked;
    input.addEventListener('change',async()=>{input.disabled=true;try{await action(input.checked);}catch(_){input.checked=!input.checked;}finally{input.disabled=false;}});
    wrap.append(input,node('span',label));return wrap;
  }
  function render(){
    const sites=$('saleBetaSites');sites.replaceChildren();
    for(const [key,site] of Object.entries(SITES)){
      const card=node('section',undefined,'sale-beta-card');card.append(node('h3',site.name));
      const all=targets.find(x=>x.site_key===key&&x.mode==='all');
      const selected=targets.filter(x=>x.site_key===key&&x.mode==='selected');
      const fast=fastHealth[key];
      const successAgo=Date.now()-Date.parse(fast?.last_success_at||'');
      const successful=fast?.baseline_ready===true&&fast?.last_status==='ok'&&
        Number.isFinite(successAgo)&&successAgo>=0&&successAgo<=20*60000;
      const waiting=fast?.last_status==='waiting';
      const blocked=fast?.last_status==='blocked'||
        fast?.last_status==='error'||String(fast?.last_status||'').startsWith('http_');
      const autoMessage=!all?.enabled?'⏸ 自動監視停止中':
        fastHealthError||!fast?'⚠ 監視の実行状態を確認できません':
        waiting?'⚠ 公式待合室のため取得待ち':
        fast?.last_status==='catalog_only'?'⌛ 商品一覧は取得済み・購入可能は未確認':
        blocked?'⚠ サイトの取得に失敗・再試行待ち':
        !fast.baseline_ready?'⌛ 高速監視の初回基準を取得待ち':
        successful?'✅ 高速監視で取得成功を確認':
        '⚠ 高速監視の取得成功が最近ありません';
      card.append(node('p',autoMessage,
        all?.enabled&&successful&&!waiting&&!blocked?'sale-beta-monitor-state':'sale-beta-warning'));
      if(selected.length){
        const selectToggle=toggle('指定商品監視をまとめて切替（'+selected.filter(x=>x.enabled).length+'/'+selected.length+'件ON）',selected.every(x=>x.enabled),value=>mutate('guerrilla_sale_monitor_targets?site_key=eq.'+key+'&mode=eq.selected','PATCH',{enabled:value,updated_at:new Date().toISOString()}));
        selectToggle.querySelector('input').indeterminate=selected.some(x=>x.enabled)&&!selected.every(x=>x.enabled);
        card.append(selectToggle);
      }
      const s=snapshot.sites?.[key]||{};
      const scopeText=key==='pokemon'?'通知対象：ポケモンカードの未開封パック／BOX／スターター・構築済みデッキのみ':'通知対象：未開封TCGのパック／BOX／スターター・構築済みデッキのみ';
      card.append(node('p',scopeText,'hint'));
      if(fast){
        card.append(node('p','⚡ 高速監視：最終試行 '+date(fast.last_run_at)+
          ' ／ 最終取得成功 '+(fast.last_success_at?date(fast.last_success_at):'未取得')+
          ' ／ 基準データ '+(fast.baseline_ready?'取得済み':'未取得'),'hint'));
        if(fast.cooldown_until&&Date.parse(fast.cooldown_until)>Date.now())
          card.append(node('p','次の取得再試行：'+date(fast.cooldown_until)+' 以降','sale-beta-warning'));
        if(waiting)card.append(node('p','公式サイトの待合室が解除されるまで新規販売は検出できません。自動再試行します。','sale-beta-warning'));
        else if(blocked)card.append(node('p','取得エラー：'+(ERRORS[fast.last_error]||ERRORS[fast.last_status]||fast.last_status||'詳細不明'),'sale-beta-warning'));
        if(fast.last_product_count>0)card.append(node('p','高速監視の直近確認商品：'+fast.last_product_count+'件','hint'));
        if(key==='pokemon'&&Array.isArray(fast.response_diagnostics)&&fast.response_diagnostics.length){
          const latest=fast.response_diagnostics[fast.response_diagnostics.length-1];
          const where=latest.phase==='catalog'?'公式商品一覧':
            latest.phase==='detail'?'公式商品詳細':
            latest.phase==='robots'?'巡回ルール':'接続前';
          const redirect=latest.redirect_to==='official_waiting_room'?'公式待合室':
            latest.redirect_to==='store_same_host'?'サイト内の別ページ':
            latest.redirect_to==='third_party'?'外部ドメイン':
            latest.redirect_to==='none'?'転送なし':'その他・未確認';
          card.append(node('p','🔎 最新のHTTP診断：'+date(latest.at)+
            ' ／ 取得先 '+where+
            ' ／ HTTP '+(latest.http_status??'未取得')+
            ' ／ 転送 '+redirect,'hint'));
          if(latest.redirect_to==='official_waiting_room'){
            card.append(node('p','BOTが公式待合室に転送されたことを確認。Cookie送信：なし'+
              ' ／ Set-Cookieヘッダー：'+(latest.set_cookie_seen?'検出':'未検出')+
              '。IPによる制限か、混雑・セッション条件かはこの結果だけでは断定できません。','sale-beta-warning'));
          }
        }
      }
      card.append(node('p','📄 補助巡回：発見済み '+(counts[key]||0)+'件 / 最終全商品処理 '+date(s.last_run_at),'hint'));
      // GitHub's scheduled sweep can be delayed or stopped independently of
      // the Supabase fast scan. Never present its stale data as current.
      const sweepAt=Date.parse(s.last_run_at||'');
      const sweepAge=Date.now()-sweepAt;
      if(all?.enabled && (!Number.isFinite(sweepAge) || sweepAge>30*60000)){
        const reason=s.status==='paused'?'以前の最終記録は「停止」でした。':
          '最終処理の記録が30分以上更新されていません。';
        card.append(node('p','⚠ 補助巡回：'+reason+
          '高速監視とは別の処理です。GitHub Actionsの実行状況を確認してください。','sale-beta-warning'));
      }
      card.append(node('p','補助巡回の基準：'+(s.front_baseline_ready?'取得済み':'取得待ち')+' / 補助巡回の次ページ '+(s.next_page||1),'hint'));
      if(s.catalog_total)card.append(node('p','一覧表示の総件数 '+s.catalog_total+'件（未確認商品も含みます）','hint'));
      if(s.errors?.length)card.append(node('p','確認上の問題：'+s.errors.map(x=>ERRORS[x]||x).join(' / '),'sale-beta-warning'));
      if(s.retry_after)card.append(node('p','次の再試行は '+date(s.retry_after)+' 以降','hint'));
      sites.append(card);
    }
    const list=$('saleBetaTargets');list.replaceChildren();
    const selected=targets.filter(x=>x.mode==='selected');
    if(!selected.length)list.append(node('p','指定商品はまだありません。下のフォームから追加できます。','hint'));
    for(const item of selected){
      const card=node('article',undefined,'sale-beta-card');card.append(node('strong',item.product),node('small',(SITES[item.site_key]?.name||item.shop)+' / 設定：'+(item.enabled?'ON':'OFF')),link(item.url));
      const actions=node('div',undefined,'sale-beta-actions');
      actions.append(button(item.enabled?'停止':'開始',()=>mutate('guerrilla_sale_monitor_targets?id=eq.'+encodeURIComponent(item.id),'PATCH',{enabled:!item.enabled,updated_at:new Date().toISOString()}).catch(()=>{})));
      actions.append(button('編集',()=>edit(item)));
      actions.append(button('削除',()=>{if(confirm('この指定商品を監視設定から削除しますか？過去の検知記録は残ります。'))mutate('guerrilla_sale_monitor_targets?id=eq.'+encodeURIComponent(item.id),'DELETE').catch(()=>{});}));
      card.append(actions);list.append(card);
    }
    const es=$('saleBetaEvents');es.replaceChildren();
    if(!events.length)es.append(node('p','検知記録はまだありません。初回の在庫確認では通知しません。','hint'));
    for(const e of events){
      const c=node('article',undefined,'sale-beta-card');
      const unconfirmed=e.kind==='reported_unconfirmed';
      const heading=unconfirmed?'⚠️ 販売報告（未確認）':
        e.kind==='new_product'?'✅ 公式販売確認・新規掲載':'✅ 公式販売確認・再開';
      c.append(node('strong',heading+'：'+e.product),
        node('small',(SITES[e.site_key]?.name||'')+' / '+date(e.detected_at)),link(e.url));
      if(unconfirmed)c.append(node('small','複数の独立した販売報告を照合しました。公式サイトの在庫は未確認です。'));
      es.append(c);
    }
    const ps=$('saleBetaProducts');ps.replaceChildren();
    if(!products.length)ps.append(node('p','まだ商品を確認していません。','hint'));
    for(const p of products){const c=node('article',undefined,'sale-beta-card');c.append(node('strong',p.product||'商品名未確認'),node('small',(LABELS[p.status]||p.status)+' / '+date(p.checked_at)),link(p.url));if(p.reason)c.append(node('small',ERRORS[p.reason]||p.reason));ps.append(c);}
  }
  const LABELS={available:'販売表示あり',unavailable:'在庫なし',unobserved:'発見済み・未確認',unknown:'判定不能',waiting:'待合室',blocked:'取得制限',lottery:'抽選販売'};
  const ERRORS={robots_denied:'サイトの巡回ルールで取得停止',robots_unavailable:'巡回ルールを取得できず停止',robots_unverified:'巡回ルールを確認できず停止',http_403:'アクセス制限',http_429:'アクセス頻度制限',http_500:'サイト側エラー（500）',http_502:'サイト側エラー（502）',http_503:'サイト側メンテナンス・混雑（503）',http_504:'サイト側タイムアウト（504）',waiting:'公式仮想待合室のため停止',redirect_blocked:'転送先を確認できず停止',catalog_markup_unverified:'商品一覧の構造を確認できません',catalog_no_verified_products:'商品一覧を取得しましたが、在庫を判定できる商品が見つかりません。監視対象URL・商品一覧構造を確認してください',product_markup_unverified:'商品ページの構造を確認できません',pagination_not_advancing:'ページ送りを確認できず停止',pagination_unverified:'一覧の続き・終端を確認できません',network_error:'通信エラー',dns_failed:'接続先を確認できません',run_budget_exceeded:'今回の実行上限。次回に継続'};
  function edit(item){editing=item.id;$('saleBetaSite').value=item.site_key;$('saleBetaName').value=item.product;$('saleBetaUrl').value=item.url;$('saleBetaEnabled').checked=item.enabled;$('saleBetaEditor').open=true;$('saleBetaName').focus();}
  function reset(){editing=null;$('saleBetaForm').reset();}
  function mount(){
    const panel=$('guerrillaSalePanel');if(!panel||$('saleBetaV2'))return;
    // Keep legacy nodes in the DOM for app.js listeners, but replace the visible
    // preview with the independently versioned, authenticated controls.
    const legacy=panel.querySelector('.guerrilla-sale-body');if(legacy)legacy.hidden=true;
    root=node('div',undefined,'sale-beta-body');root.id='saleBetaV2';root.hidden=true;
    root.innerHTML=`<p class="hint">開発者限定のテスト機能です。通知対象はカードゲームの未開封パック／BOX／構築済み・スターター系デッキのみです。シングルカード・サプライ・予約商品は除外します。通知はこの画面内だけに記録し、Discordには送信しません。</p>
      <p id="saleBetaStatus" role="status" aria-live="polite"></p><button type="button" id="saleBetaRefresh">設定・保存済み結果を再読込</button>
      <div id="saleBetaSites"></div><p class="hint">全商品は一覧を少しずつ巡回します。全商品を毎回確認する方式ではありません。指定商品は優先枠で順番に確認します。</p>
      <details open><summary>指定商品の登録一覧</summary><div id="saleBetaTargets"></div></details>
      <details id="saleBetaEditor"><summary>指定商品を追加・編集</summary><form id="saleBetaForm">
      <label>店舗<select id="saleBetaSite"><option value="pokemon">ポケモンセンターオンライン</option><option value="amenity">アメニティードリーム</option></select></label>
      <label>商品名<input id="saleBetaName" required maxlength="120" autocomplete="off"></label>
      <label>商品ページURL<input id="saleBetaUrl" type="url" required maxlength="1500" placeholder="https://..." autocomplete="off"></label>
      <label class="sale-beta-toggle"><input id="saleBetaEnabled" type="checkbox"><span>保存後に監視する（未選択なら設定だけ保存）</span></label>
      <div class="sale-beta-actions"><button type="submit">保存</button><button type="button" id="saleBetaCancel">入力をクリア</button></div></form></details>
      <details><summary>検知履歴（最新20件）</summary><div id="saleBetaEvents"></div></details>
      <details><summary>商品ごとの確認結果（最新20件）</summary><div id="saleBetaProducts"></div></details>
      <p class="hint">ポケセンの拡張パック・構築デッキの公式在庫あり一覧を交互に確認し、商品の購入ボタンを公式商品ページで確認できた場合だけ販売通知します。「在庫あり」一覧に予約・抽選が含まれるため、一覧への掲載だけでは通知しません。投稿依存の未確認速報は停止しています。公式待合室中は販売開始を確認できません。</p>
      <p class="hint">初回は先頭ページを基準として記録し、それ以降に先頭へ新しく現れた販売中商品を新規販売として記録します。既存商品の再販は指定商品を優先確認します。待合室・抽選・エラーは販売開始と区別します。</p>`;
    const authStatus=node('p','開発者権限を確認しています…','hint');authStatus.id='saleBetaAuthStatus';authStatus.setAttribute('role','status');panel.append(authStatus,root);
    const style=node('style');style.textContent=`
      #saleBetaV2{padding:0 14px 14px;color:var(--app-text)}#saleBetaV2[hidden]{display:none!important}
      #saleBetaV2 .sale-beta-card{border:1px solid var(--app-border);border-radius:11px;padding:12px;margin:10px 0;background:var(--app-surface2);display:grid;gap:8px;overflow-wrap:anywhere}
      #saleBetaV2 h3{font-size:15px;margin:0 0 6px}#saleBetaV2 small,#saleBetaV2 .hint{font-size:12px;color:var(--app-muted)}
      #saleBetaV2 .sale-beta-toggle{display:flex;align-items:center;gap:10px;font-size:14px;min-height:40px}
      #saleBetaV2 input[type=checkbox]{width:20px;height:20px;flex:0 0 20px;margin:0}
      #saleBetaV2 details{margin:12px 0;border:1px solid var(--app-border);border-radius:10px;padding:10px}#saleBetaV2 summary{cursor:pointer;font-weight:700}
      #saleBetaV2 form{background:transparent!important;padding:0;display:grid;gap:12px;margin-top:12px;border:0}
      #saleBetaV2 form label{display:grid;gap:7px;font-size:14px}#saleBetaV2 form .sale-beta-toggle{display:flex}
      #saleBetaV2 input,#saleBetaV2 select{box-sizing:border-box;max-width:100%;font-size:16px;background:var(--app-surface2);color:var(--app-text);border:1px solid var(--app-border)}
      #saleBetaV2 .sale-beta-card p{margin:2px 0}#saleBetaV2 a{color:var(--app-accent,currentColor);font-weight:700}#saleBetaV2 button{min-height:42px;border:1px solid var(--app-border);border-radius:9px;background:var(--app-surface);color:var(--app-text)}#saleBetaV2 .sale-beta-actions{display:flex;gap:8px;flex-wrap:wrap}#saleBetaStatus{font-size:13px;line-height:1.6}
      #saleBetaV2 .sale-beta-warning{font-size:12px;font-weight:700;color:var(--app-text)}#saleBetaV2 .sale-beta-monitor-state{margin:2px 0;font-size:14px;font-weight:800;color:var(--app-text)}
    `;document.head.append(style);
    $('saleBetaRefresh').addEventListener('click',refresh);$('saleBetaCancel').addEventListener('click',reset);
    $('saleBetaForm').addEventListener('submit',async e=>{
      e.preventDefault();if(busy)return;
      const site=$('saleBetaSite').value;
      try{
        const url=canonical($('saleBetaUrl').value,site);
        const other=targets.find(x=>x.mode==='selected'&&x.url===url&&x.id!==editing);
        if(other)throw new Error('この商品は登録済みです。一覧の「編集」を使ってください。');
        const body={site_key:site,mode:'selected',shop:SITES[site].name,product:$('saleBetaName').value.trim(),url,enabled:$('saleBetaEnabled').checked,updated_at:new Date().toISOString()};
        if(!body.product)throw new Error('商品名を入力してください。');
        if(editing)await mutate('guerrilla_sale_monitor_targets?id=eq.'+encodeURIComponent(editing),'PATCH',body);
        else await mutate('guerrilla_sale_monitor_targets','POST',{...body,id:crypto.randomUUID(),available_text:[],unavailable_text:[],required_text:[]});
        reset();
      }catch(error){status(error.message);}
    });
    new MutationObserver(()=>{if(!shown())clear();else if($('devView').classList.contains('active'))refresh();}).observe($('devView'),{attributes:true,attributeFilter:['hidden','class']});
    window.addEventListener('storage',e=>{if(e.key===SESSION){clear();if(shown())refresh();}});
    window.addEventListener('focus',()=>{if(shown()&&$('devView').classList.contains('active'))refresh();});
    setInterval(()=>{if(shown()&&$('devView').classList.contains('active')&&panel.open&&document.visibilityState==='visible')refresh();},60000);
    panel.addEventListener('toggle',()=>{if(panel.open&&shown())refresh();});
    refresh();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
