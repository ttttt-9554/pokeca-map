
(() => {
  'use strict';

  const KEY = 'pokeca-reports-v1';
  const STORE_KEY = 'pokeca-tochigi-stores-v05'; // 既存データを保持
  const $ = id => document.getElementById(id);

  const SUPABASE_URL = 'https://aypcmtlaaygmiexboypk.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_C0YESv-nDjR7PvAoMPscQg_uznt6foN';
  const SHARED_TABLE = 'shared_reports';
  let supabaseClient = null;
  let authUser = null;
  // Manual app refresh can restore any ordinary tab immediately.
  // The developer tab must wait until Discord authentication confirms access.
  let restoreDeveloperTabPending = false;

  // Supabase > Authentication > Users に表示される自分の User UID を設定
  // 指定したUIDでログインしたときだけ開発タブを表示します。
  const DEVELOPER_USER_ID = '0ba965da-445b-4055-8d8d-ead585fa0d09';

  function isDeveloper() {
    return !!authUser && authUser.id === DEVELOPER_USER_ID;
  }

  function updateDeveloperTab() {
    const button = document.querySelector('nav button[data-tab="dev"]');
    const view = $('devView');
    const allowed = isDeveloper();
    if (button) button.hidden = !allowed;
    if (view) view.hidden = !allowed;
    if (!allowed && view?.classList.contains('active')) switchTab('map');
  }

  let sharedReports = [];
  let sharedChannel = null;
  let sharedEditId = null;
  let reports = [];
  let stores = [];
  let packs = [];
  let decks = [];
  let csvPacks = [];
  let csvDecks = [];
  let cloudProducts = [];
  let cloudStores = [];
  let mapSelectedProducts = []; // {name, category}
  let editId = null;
  let map = null;
  let markers = null;

  // 候補から選んだ商品の情報
  let selectedProduct = null;
  let selectedRegistrationProducts = [];
  let savingForm = false;

  const escape = value => String(value ?? '').replace(
    /[&<>"']/g,
    char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char])
  );

  function get(id) {
    const element = $(id);
    if (!element) {
      throw new Error(`HTML要素がありません: #${id}`);
    }
    return element;
  }

  function nowLocal() {
    const date = new Date();
    return new Date(
      date.getTime() - date.getTimezoneOffset() * 60000
    ).toISOString().slice(0, 16);
  }

  function validReport(r) {
    return r &&
      typeof r.id === 'string' &&
      typeof r.shop === 'string' &&
      typeof r.product === 'string' &&
      typeof r.foundAt === 'string' &&
      Number.isFinite(Number(r.lat)) &&
      Math.abs(Number(r.lat)) <= 90 &&
      Number.isFinite(Number(r.lng)) &&
      Math.abs(Number(r.lng)) <= 180;
  }

  function loadReports() {
    try {
      const data = JSON.parse(
        localStorage.getItem(KEY) || '[]'
      );
      if (Array.isArray(data)) {
        reports = data.filter(validReport).map(r => ({
          ...r,
          category: r.category === 'deck' ? 'deck' : 'pack'
        }));
      }
    } catch (error) {
      console.error('履歴読み込みエラー:', error);
    }
  }

  function saveReports() {
    localStorage.setItem(KEY, JSON.stringify(reports));
  }

  function allReports() { return [...reports, ...sharedReports]; }

  function fromShared(row) {
    return { id: String(row.id), ownerId: row.user_id, shared: true,
      shop: row.shop, product: row.product, category: row.category,
      foundAt: row.found_at ? new Date(new Date(row.found_at).getTime() - new Date(row.found_at).getTimezoneOffset()*60000).toISOString().slice(0,16) : '',
      status: row.status, memo: row.memo || '', lat: Number(row.lat), lng: Number(row.lng) };
  }


  // 友達限定のアプリ利用状況。Supabase RPC側で友達関係と公開許可を検証する。
  let friendPresenceTimer = null;
  let friendPresenceUserId = null;
  let friendPresencePublic = false;
  let friendPresenceBusy = false;
  function friendStatus(message) {
    const node = $('friendPresenceStatus');
    if (node) node.textContent = message;
  }
  function friendDisplayName() {
    const meta = authUser?.user_metadata || {};
    return String(meta.global_name || meta.globalName || meta.custom_claims?.global_name
      || meta.full_name || meta.name || meta.user_name || 'Discordユーザー').slice(0,80);
  }
  async function friendRpc(name, args = {}) {
    if (!supabaseClient || !authUser) throw new Error('Discordログインが必要です。');
    const {data,error} = await supabaseClient.rpc(name,args);
    if (error) throw error;
    return data;
  }
  async function friendPresenceHeartbeat() {
    if (!authUser || !friendPresencePublic || document.visibilityState === 'hidden') return;
    try { await friendRpc('friend_presence_heartbeat',{p_name:friendDisplayName()}); }
    catch (e) { friendStatus('オンライン更新に失敗しました: ' + e.message); }
  }
  function renderFriendList(rows) {
    const root = $('friendPresenceList');
    root.replaceChildren();
    if (!rows?.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'まだ友達がいません。招待コードを共有して追加してください。';
      root.append(empty);
      return;
    }
    rows.forEach(friend => {
      const item = document.createElement('div');
      item.className = 'friend-member';
      const name = document.createElement('strong');
      name.className = 'friend-member-name';
      name.textContent = friend.display_name || '友達';
      const state = document.createElement('span');
      state.className = 'friend-member-state';
      if (!friend.is_visible) {
        state.classList.add('private');
        state.textContent = '非公開';
      } else if (friend.is_online) {
        state.classList.add('online');
        state.textContent = '● オンライン';
      } else {
        state.classList.add('offline');
        state.textContent = '○ オフライン';
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '解除';
      remove.setAttribute('aria-label',(friend.display_name || '友達')+'との友達登録を解除');
      remove.addEventListener('click',async () => {
        if (!confirm('この友達との接続を解除しますか？')) return;
        try {
          await friendRpc('friend_remove',{p_friend_id:friend.friend_id});
          await friendRefresh();
        } catch(e) { friendStatus('解除できませんでした: '+e.message); }
      });
      item.append(name,state,remove);
      root.append(item);
    });
  }
  async function friendRefresh() {
    if (!authUser || friendPresenceBusy) return;
    friendPresenceBusy = true;
    try {
      const data = await friendRpc('friend_list_status');
      renderFriendList(data || []);
      friendStatus('友達の状態を更新しました。オンライン判定は約3分以内の利用です。');
    } catch(e) { friendStatus('友達の情報を取得できません: '+e.message); }
    finally { friendPresenceBusy = false; }
  }
  async function friendPresenceAuthChanged() {
    const loggedIn = !!authUser && !!supabaseClient;
    $('friendPresenceSignedOut').hidden = loggedIn;
    $('friendPresenceSignedIn').hidden = !loggedIn;
    if (friendPresenceTimer) { clearInterval(friendPresenceTimer); friendPresenceTimer = null; }
    if (!loggedIn) {
      friendPresenceUserId = null;
      friendPresencePublic = false;
      $('friendPresenceList').replaceChildren();
      $('friendPresenceOptin').checked = false;
      return;
    }
    const uid = authUser.id;
    friendPresenceUserId = uid;
    try {
      const settings = await friendRpc('friend_my_presence_settings');
      if (authUser?.id !== uid) return;
      friendPresencePublic = !!settings?.enabled;
      $('friendPresenceOptin').checked = friendPresencePublic;
      if (friendPresencePublic) await friendPresenceHeartbeat();
      await friendRefresh();
    } catch(e) { friendStatus('設定を読み込めません: '+e.message); }
    if (authUser?.id === uid) {
      friendPresenceTimer = setInterval(() => {
        if (authUser?.id !== uid) return;
        friendPresenceHeartbeat();
        if (document.visibilityState !== 'hidden') friendRefresh();
      },60000);
    }
  }
  function initFriendPresence() {
    $('friendPresenceOptin').addEventListener('change',async e => {
      const enabled = e.target.checked;
      try {
        await friendRpc('friend_set_presence',{p_enabled:enabled,p_name:friendDisplayName()});
        friendPresencePublic = enabled;
        friendStatus(enabled ? '公開を許可しました。友達にアプリ利用状況が表示されます。' : '非公開にしました。友達には状態が表示されません。');
        if (enabled) await friendPresenceHeartbeat();
      } catch(error) {
        e.target.checked = !enabled;
        friendStatus('設定の変更に失敗しました: '+error.message);
      }
    });
    $('friendCreateInvite').addEventListener('click',async () => {
      try {
        const code = await friendRpc('friend_create_invite');
        const output = $('friendInviteOutput');
        output.replaceChildren();
        const label = document.createElement('span');
        label.textContent = '招待コード（7日間有効・1回限り）：';
        const value = document.createElement('code');
        value.className = 'friend-invite-code';
        value.textContent = String(code);
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'コードをコピー';
        copy.addEventListener('click',async () => {
          try { await navigator.clipboard.writeText(String(code)); friendStatus('招待コードをコピーしました。'); }
          catch(_) { friendStatus('コードを長押ししてコピーしてください。'); }
        });
        output.append(label,value,copy);
      } catch(e) { friendStatus('招待コードを発行できません: '+e.message); }
    });
    $('friendAcceptInvite').addEventListener('click',async () => {
      const code = $('friendInviteInput').value.trim();
      if (!code) return friendStatus('招待コードを入力してください。');
      try {
        await friendRpc('friend_accept_invite',{p_code:code});
        $('friendInviteInput').value = '';
        friendStatus('友達を追加しました。');
        await friendRefresh();
      } catch(e) { friendStatus('友達を追加できません: '+e.message); }
    });
    $('friendRefresh').addEventListener('click',friendRefresh);
    document.addEventListener('visibilitychange',() => {
      if (document.visibilityState === 'visible' && authUser) {
        friendPresenceHeartbeat();
        friendRefresh();
      }
    });
  }

  function displayAuth() {
    const account = $('discordAccount');
    const status = $('shareAuthStatus');
    if (!supabaseClient) {
      const msg = '共有機能の読み込みに失敗しました。通信環境を確認してください。';
      account.textContent = msg; status.textContent = msg;
    } else if (authUser) {
      const profile = authUser.user_metadata || {};
      // Discordの表示名（global_name）を優先。未取得なら従来のユーザー名にフォールバック。
      const name = profile.global_name || profile.globalName || profile.custom_claims?.global_name
        || profile.full_name || profile.name || profile.user_name || authUser.email || 'Discordユーザー';
      account.replaceChildren();
      const line = document.createElement('div'); line.className = 'share-user';
      if (profile.avatar_url && /^https:\/\//.test(profile.avatar_url)) {
        const avatar = document.createElement('img'); avatar.src = profile.avatar_url; avatar.alt = '';
        avatar.referrerPolicy = 'no-referrer'; line.append(avatar);
      }
      const text = document.createElement('strong'); text.textContent = name + '（ログイン中）';
      line.append(text); account.append(line);
      status.textContent = 'Discordログイン中：登録時に「みんなに共有する」を選べます。';
    } else {
      account.textContent = '未ログイン：Discordでログインすると共有投稿できます。';
      status.textContent = '未ログイン：端末内への保存は引き続き利用できます。';
    }
    $('discordLogin').hidden = !supabaseClient || !!authUser;
    $('discordLogout').hidden = !authUser;
    $('publishReport').disabled = !authUser;
    if (!authUser) $('publishReport').checked = false;
    $('publishHint').textContent = authUser
      ? 'チェックを入れると共有データベースに投稿します。外すと端末内にだけ保存します。'
      : '共有するには「共有」タブからDiscordでログインしてください。';
    renderMyShared();
    updateDeveloperTab();
    if (restoreDeveloperTabPending && isDeveloper()) {
      restoreDeveloperTabPending = false;
      switchTab('dev');
    }
    if (isDeveloper()) { renderCloudAdminLists(); loadLotteryDevResults(); }
    lpExtRenderAdmin();
    refreshWishlistForAccount();
    refreshLotteryTrackerForAccount();
    refreshLotteryOnsiteReports(true);
    refreshLotteryOnsiteArchive(true);
    queueMicrotask(() => friendPresenceAuthChanged());
  }

  async function loadSharedReports() {
    if (!supabaseClient) return;
    const {data,error} = await supabaseClient.from(SHARED_TABLE)
      .select('id,user_id,shop,product,category,found_at,status,memo,lat,lng')
      .order('found_at', {ascending:false}).limit(1000);
    if (error) { $('sharedStatus').textContent = '共有情報の取得に失敗: ' + error.message; return; }
    sharedReports = (data || []).map(fromShared).filter(validReport);
    $('sharedStatus').textContent = `共有情報：${sharedReports.length}件（最大1000件を取得）`;
    renderAndFitMap();
    renderMyShared();
  }

  function renderMyShared() {
    const target = $('mySharedList'); if (!target) return;
    const own = authUser ? sharedReports.filter(r => r.ownerId === authUser.id) : [];
    target.innerHTML = own.length ? [...own]
      .sort((a,b)=>b.foundAt.localeCompare(a.foundAt)).map(card).join('') :
      '<p class="hint">'+(authUser?'共有した投稿はありません。':'Discordでログインすると自分の共有投稿が表示されます。')+'</p>';
  }

  async function initShared() {
    if (!window.supabase?.createClient) { displayAuth(); return; }
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {detectSessionInUrl:true, persistSession:true, autoRefreshToken:true}
    });
    supabaseClient.auth.onAuthStateChange((_event,session) => {
      authUser = session?.user || null;
      displayAuth();
    });
    const {data,error} = await supabaseClient.auth.getSession();
    if (error) $('sharedStatus').textContent = 'ログイン状態の確認に失敗: ' + error.message;
    authUser = data?.session?.user || null;
    displayAuth();
    await loadSharedReports();
    await loadCloudData();
    await lpCloudRefresh(true);
    await lpLocationRefresh(true);
    await lpExtRefresh(true);
    refreshLotteryOnsiteReports(true);
    refreshLotteryOnsiteArchive(true);
    supabaseClient.channel('pokeca-cloud-catalog-updates')
      .on('postgres_changes',{event:'*',schema:'public',table:'catalog_products'},()=>loadCloudData())
      .on('postgres_changes',{event:'*',schema:'public',table:'catalog_stores'},()=>loadCloudData())
      .subscribe();
    window.addEventListener('focus',()=>{ loadCloudData(); lpCloudRefresh(true); lpLocationRefresh(true); lpExtRefresh(true); refreshWishlistForAccount(); refreshLotteryTrackerForAccount(true); refreshLotteryOnsiteReports(true); refreshLotteryOnsiteArchive(true); });
    supabaseClient.channel('pokeca-wishlist-updates')
      .on('postgres_changes',{event:'*',schema:'public',table:WISHLIST_TABLE},
        payload => { if (payload.new?.user_id === authUser?.id) refreshWishlistForAccount(); })
      .subscribe();
    sharedChannel = supabaseClient.channel('pokeca-shared-report-updates')
      .on('postgres_changes',{event:'*',schema:'public',table:SHARED_TABLE},() => loadSharedReports())
      .subscribe();
  }

  async function discordLogin() {
    if (!supabaseClient) return alert('共有機能を読み込めませんでした。');
    const {error} = await supabaseClient.auth.signInWithOAuth({provider:'discord',options:{
      redirectTo: window.location.origin + window.location.pathname,
      scopes:'identify email'
    }});
    if (error) alert('Discordログインに失敗しました: ' + error.message);
  }

  async function discordLogout() {
    if (!supabaseClient) return;
    const {error} = await supabaseClient.auth.signOut();
    if (error) return alert('ログアウトに失敗しました: ' + error.message);
    authUser = null; displayAuth(); render();
  }

  function toSharedPayload(report) {
    return {shop:report.shop, product:report.product, category:report.category,
      found_at:new Date(report.foundAt).toISOString(),status:report.status,
      memo:report.memo,lat:report.lat,lng:report.lng};
  }

  async function saveSharedReport(report) {
    if (!supabaseClient || !authUser) throw new Error('Discordログインが必要です。');
    const payload = {...toSharedPayload(report),user_id:authUser.id};
    const query = sharedEditId
      ? supabaseClient.from(SHARED_TABLE).update(payload).eq('id',sharedEditId).eq('user_id',authUser.id)
      : supabaseClient.from(SHARED_TABLE).insert(payload);
    const {data,error} = await query.select('id');
    if (error) throw error;
    if (!data?.length) throw new Error('更新できませんでした。投稿者本人か確認してください。');
    await loadSharedReports();
  }

  async function deleteSharedReport(report) {
    if (!authUser || report.ownerId !== authUser.id) return alert('自分の共有投稿のみ削除できます。');
    if (!confirm('この共有投稿を削除しますか？ ほかの利用者の地図からも消えます。')) return;
    const {data,error} = await supabaseClient.from(SHARED_TABLE)
      .delete().eq('id',report.id).eq('user_id',authUser.id).select('id');
    if (error || !data?.length) return alert('削除できませんでした: ' + (error?.message || '権限を確認してください。'));
    await loadSharedReports();
  }

  // ========================================
  // 地図
  // ========================================

  function initMap() {
    if (typeof L === 'undefined') {
      get('map').textContent =
        '地図ライブラリを読み込めませんでした。';
      console.error('Leafletが読み込まれていません');
      return;
    }

    try {
      map = L.map('map').setView(
        [36.5551, 139.8828], 12
      );

      L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }
      ).addTo(map);

      markers = L.layerGroup().addTo(map);

      let pressTimer = null;

      function registerPoint(point) {
        formFor(null);
        get('lat').value = point.lat.toFixed(6);
        get('lng').value = point.lng.toFixed(6);
      }

      map.on('mousedown touchstart', event => {
        clearTimeout(pressTimer);
        const point = event.latlng;
        pressTimer = setTimeout(
          () => registerPoint(point), 650
        );
      });

      map.on('mouseup touchend dragstart move', () => {
        clearTimeout(pressTimer);
      });

      map.on('contextmenu', event => {
        clearTimeout(pressTimer);
        registerPoint(event.latlng);
      });

    } catch (error) {
      console.error('地図初期化エラー:', error);
      map = null;
      markers = null;
      get('map').textContent =
        '地図の初期化に失敗しました。';
    }
  }

  function refreshMap() {
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 100);
  }

  function switchTab(tab) {
    if ($('mapFilterDrawer') && !$('mapFilterDrawer').hidden && tab !== 'map') setMapFilterOpen(false);
    if (tab === 'dev' && !isDeveloper()) tab = 'map';
    const changedTab = !document.getElementById(tab+'View')?.classList.contains('active');
    document.querySelectorAll('.view').forEach(view => {
      view.classList.toggle(
        'active', view.id === `${tab}View`
      );
    });

    document.querySelectorAll('nav button').forEach(button => {
      button.classList.toggle(
        'active', button.dataset.tab === tab
      );
    });

    // The content shares one scroll container across tabs. Retaining the prior
    // tab's scroll position can make short views such as History appear blank.
    if (changedTab) {
      const area=$('appScrollArea');
      if(area)area.scrollTop=0;
    }
    if (tab === 'history') {
      renderMyShared();
      if (supabaseClient) loadSharedReports();
    }
    if (tab === 'map') refreshMap();
    if (tab === 'lottery') { loadLotteryEvents(); lpCloudRefresh(); lpLocationRefresh(); lpExtRefresh(); refreshLotteryTrackerForAccount(); refreshLotteryOnsiteReports(); refreshLotteryOnsiteArchive(); }
    if (tab === 'lotteryManage') { loadLotteryEvents(); lpCloudRefresh(); lpLocationRefresh(); refreshLotteryTrackerForAccount(); refreshLotteryOnsiteReports(); renderLotteryTrackerSummary(); }
    if (tab === 'dev' && isDeveloper()) { loadLotteryDevResults(); lpCloudRefresh(); lpLocationRefresh(); lpExtRefresh(); }
    render();
  }


  // マップ検索サイドバー
  function setMapFilterOpen(open) {
    const drawer = $('mapFilterDrawer');
    const overlay = $('mapFilterOverlay');
    if (!drawer || !overlay) return;
    drawer.hidden = !open;
    overlay.hidden = !open;
    drawer.setAttribute('aria-hidden', String(!open));
    $('openMapFilters').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('map-filter-locked', open);
    if (open) {
      $('closeMapFilters').focus();
    } else {
      closeMapProductDropdown();
      $('openMapFilters').focus();
      refreshMap();
    }
  }

  function initMapFilterDrawer() {
    $('openMapFilters').addEventListener('click', () => setMapFilterOpen(true));
    $('closeMapFilters').addEventListener('click', () => setMapFilterOpen(false));
    $('applyMapFilters').addEventListener('click', () => setMapFilterOpen(false));
    $('mapFilterOverlay').addEventListener('click', () => setMapFilterOpen(false));
    document.addEventListener('keydown', event => {
      if ($('mapFilterDrawer').hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMapFilterOpen(false);
      }
      if (event.key === 'Tab') {
        const focusable = [...$('mapFilterDrawer').querySelectorAll('button:not([disabled]):not([hidden]),input:not([disabled]),select:not([disabled])')]
          .filter(element => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
      }
    });
  }

  // ========================================
  // 履歴表示
  // ========================================

  function inPeriod(r) {
    const period = get('period').value;
    if (period === 'all') return true;

    const time = new Date(r.foundAt).getTime();
    const now = Date.now();

    if (!Number.isFinite(time)) return false;

    if (period === 'week') {
      return time >= now - 7 * 86400000 && time <= now;
    }

    return new Date(r.foundAt).toDateString() ===
      new Date().toDateString();
  }

  function card(r) {
    const category = r.category === 'deck'
      ? '構築デッキ'
      : '拡張パック';

    const mine = !r.shared || (authUser && r.ownerId === authUser.id);
    return `
      <article class="entry">
        <h3>${escape(r.shop)} ${r.shared ? '<span class="share-tag">共有</span>' : '<span class="share-tag">端末内</span>'}</h3>
        <p>
          <strong>${escape(r.product)}</strong>
          · ${escape(r.status || '')}
          · ${category}
        </p>
        <p>${escape(r.foundAt.replace('T', ' '))}</p>
        ${r.memo ? `<p>${escape(r.memo)}</p>` : ''}
        <div class="actions">
          <button data-action="view"
                  data-id="${escape(r.id)}">地図で見る</button>
          <button data-action="edit"
                  data-id="${escape(r.id)}">編集</button>
          <button data-action="delete"
                  data-id="${escape(r.id)}">削除</button>
        </div>
      </article>
    `;
  }

  function render() {
    const sorted = [...reports].sort(
      (a, b) => b.foundAt.localeCompare(a.foundAt)
    );

    get('historyList').innerHTML = sorted.length
      ? sorted.map(card).join('')
      : '<p class="hint">まだ発見記録がありません。</p>';

    const visible = allReports().sort((a,b) => b.foundAt.localeCompare(a.foundAt)).filter(r => inPeriod(r) && mapReportMatches(r));
    get('mapFilterCount').textContent = `該当する発見情報：${visible.length}件`; 

    get('mapList').innerHTML = visible.length
      ? visible.map(card).join('')
      : '<p class="hint">この期間の発見記録はありません。</p>';

    if (!markers || typeof L === 'undefined') return;

    markers.clearLayers();

    visible.forEach(r => {
      L.marker([Number(r.lat), Number(r.lng)])
        .addTo(markers)
        .bindPopup(`
          <strong>${escape(r.shop)}</strong>
          <p>${escape(r.product)}</p>
          <small>
            ${escape(r.foundAt.replace('T', ' '))}
          </small>
        `);
    });
  }

  // 絞り込み後、該当する発見ポイントがすべて見える範囲へ移動する。
  // 通常の再描画では呼ばず、商品・カテゴリ・期間の変更時だけ実行する。
  function fitMapToFilteredReports() {
    if (!map || !markers || typeof L === 'undefined') return;

    const points = allReports()
      .filter(r => inPeriod(r) && mapReportMatches(r))
      .map(r => [Number(r.lat), Number(r.lng)])
      .filter(([lat, lng]) =>
        Number.isFinite(lat) && Number.isFinite(lng) &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      );

    if (!points.length) return; // 0件なら現在の表示範囲を維持

    // スマホで地図が表示された後のサイズを使用する。
    requestAnimationFrame(() => {
      if (!document.getElementById('mapView')?.classList.contains('active')) return;
      map.invalidateSize();
      if (points.length === 1) {
        map.setView(points[0], 16, { animate: true });
      } else {
        map.fitBounds(L.latLngBounds(points), {
          padding: [36, 36],
          maxZoom: 16,
          animate: true
        });
      }
    });
  }

  function renderAndFitMap() {
    render();
    fitMapToFilteredReports();
  }

  async function handleCard(event) {
    const button = event.target.closest(
      'button[data-action]'
    );
    if (!button) return;

    const r = allReports().find(item => item.id === button.dataset.id);
    if (!r) return;

    if (r.shared && (!authUser || r.ownerId !== authUser.id) && button.dataset.action !== 'view') return;
    if (r.shared && button.dataset.action === 'delete') { await deleteSharedReport(r); return; }
    if (button.dataset.action === 'delete') {
      if (!confirm('この端末内の発見記録を削除しますか？')) return;

      reports = reports.filter(item => item.id !== r.id);
      saveReports();
      render();
      return;
    }

    if (button.dataset.action === 'edit') {
      formFor(r);
      return;
    }

    if (button.dataset.action === 'view') {
      get('period').value = 'all';
      // 履歴の「地図で見る」は商品フィルターを解除して確実に表示
      mapSelectedProducts = [];
      get('mapCategoryPack').checked = true;
      get('mapCategoryDeck').checked = true;
      updateMapFilterUI();
      switchTab('map');

      if (map) {
        map.setView([Number(r.lat), Number(r.lng)], 16);
        markers.eachLayer(marker => {
          const pos = marker.getLatLng();
          if (
            pos.lat === Number(r.lat) &&
            pos.lng === Number(r.lng)
          ) {
            marker.openPopup();
          }
        });
      }
    }
  }

  // ========================================
  // カテゴリ選択
  // ========================================

  function selectedCategories() {
    const selected = [];

    if (get('categoryPack').checked) {
      selected.push('pack');
    }
    if (get('categoryDeck').checked) {
      selected.push('deck');
    }

    return selected;
  }

  function updateCategoryHint() {
    const selected = selectedCategories();
    let message = '';

    if (selected.length === 0) {
      message = '商品カテゴリを1つ以上選択してください。';
    } else if (selected.length === 2) {
      message = '拡張パックと構築デッキの両方を検索します。';
    } else if (selected[0] === 'pack') {
      message = '拡張パックの商品を検索します。';
    } else {
      message = '構築デッキ・スターターセットを検索します。';
    }

    get('categoryHint').textContent = message;
  }

  function currentProducts() {
    const selected = selectedCategories();
    const result = [];

    if (selected.includes('pack')) {
      result.push(
        ...packs.map(p => ({ ...p, category: 'pack' }))
      );
    }

    if (selected.includes('deck')) {
      result.push(
        ...decks.map(p => ({ ...p, category: 'deck' }))
      );
    }

    return result.sort(
      (a, b) => productDateValue(b.date) -
        productDateValue(a.date)
    );
  }

  function categoryChanged() {
    // 以前選んだ商品がカテゴリ変更後も
    // 誤って保存されないよう選択を解除
    selectedProduct = null;
    selectedRegistrationProducts = selectedRegistrationProducts.filter(p => selectedCategories().includes(p.category));
    updateRegistrationProducts();
    get('product').value = '';
    updateCategoryHint();
    closeProductDropdown();
  }

  // ========================================
  // 登録フォーム
  // ========================================

  function formFor(r) {
    editId = r && !r.shared ? r.id : null;
    sharedEditId = r?.shared ? r.id : null;
    selectedProduct = null;
    selectedRegistrationProducts = [];
    updateRegistrationProducts();
    $('publishReport').checked = !!r?.shared;
    $('publishReport').disabled = !!r?.shared || !authUser;

    get('formTitle').textContent = (editId || sharedEditId)
      ? '発見情報を編集'
      : '発見情報を登録';

    get('shop').value = r?.shop || '';
    get('product').value = r?.product || '';

    get('categoryPack').checked =
      r?.category !== 'deck';
    get('categoryDeck').checked =
      r?.category === 'deck';

    get('foundAt').value = r?.foundAt || nowLocal();
    get('status').value = r?.status || '販売を確認';
    get('memo').value = r?.memo || '';
    get('lat').value = r?.lat ?? '';
    get('lng').value = r?.lng ?? '';
    get('cancelEdit').hidden = !(editId || sharedEditId);

    updateCategoryHint();
    closeProductDropdown();
    switchTab('add');
  }

  async function saveForm(event) {
    event.preventDefault();
    if (savingForm) return;

    const shop = get('shop').value.trim();
    const product = get('product').value.trim();
    const foundAt = get('foundAt').value;

    const latText = get('lat').value;
    const lngText = get('lng').value;
    const lat = Number(latText);
    const lng = Number(lngText);

    if (!shop) {
      alert('店舗を選択してください。');
      return;
    }

    if (!product && !selectedRegistrationProducts.length) {
      alert('商品名を1つ以上選択または入力してください。');
      return;
    }

    if (
      latText === '' ||
      lngText === '' ||
      !Number.isFinite(lat)) {
      alert('店舗の位置情報を確認してください。');
      return;
    }

    if (
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      alert('緯度・経度が正しくありません。');
      return;
    }

    if (!foundAt) {
      alert('発見日時を入力してください。');
      return;
    }

    const selected = selectedCategories();

    if (selected.length === 0) {
      alert('商品カテゴリを選択してください。');
      return;
    }

    const editing = !!(editId || sharedEditId);
    const selectedItems = editing ? [] : [...selectedRegistrationProducts];
    // 候補から追加していない手入力の商品も1件として登録できる
    if (product && !selectedItems.some(p => p.name === product)) {
      let category = null;
      if (selectedProduct && selectedProduct.name === product && selected.includes(selectedProduct.category)) {
        category = selectedProduct.category;
      } else if (selected.length === 1) {
        category = selected[0];
      } else {
        alert('手入力の商品を登録する場合はカテゴリを1つだけ選択してください。');
        return;
      }
      selectedItems.push({name: product, category});
    }
    if (editing) {
      selectedItems.length = 0;
      const category = selectedProduct && selectedProduct.name === product && selected.includes(selectedProduct.category)
        ? selectedProduct.category : selected.length === 1 ? selected[0] : null;
      if (!product || !category) {
        alert('編集時は商品を1種類選び、カテゴリを確定してください。');
        return;
      }
      selectedItems.push({name: product, category});
    }
    if (!selectedItems.length) {
      alert('登録する商品を選択してください。');
      return;
    }
    if (selectedItems.length > 20) {
      alert('一度に登録できる商品は20種類までです。');
      return;
    }

    const makeReport = item => ({
      id: editId || (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
      shop, product: item.name, category: item.category, foundAt,
      status: get('status').value, memo: get('memo').value.trim(), lat, lng
    });
    const batch = selectedItems.map(makeReport);
    const shared = $('publishReport').checked || !!sharedEditId;
    const submitButton = get('reportForm').querySelector('button[type="submit"]');
    savingForm = true;
    if (submitButton) submitButton.disabled = true;
    try {
      if (shared) {
        if (!supabaseClient || !authUser) throw new Error('Discordログインが必要です。');
        if (sharedEditId) {
          await saveSharedReport(batch[0]);
        } else {
          // 1商品につき1行のINSERT。DB Webhookから商品別にDiscord通知される
          const payloads = batch.map(r => ({...toSharedPayload(r), user_id: authUser.id}));
          const {data, error} = await supabaseClient.from(SHARED_TABLE).insert(payloads).select('id');
          if (error) throw error;
          if (!data || data.length !== payloads.length) throw new Error('登録件数を確認できませんでした。共有一覧を確認してください。');
          await loadSharedReports();
        }
      } else {
        const previous = reports;
        reports = editId ? reports.map(r => r.id === editId ? batch[0] : r) : [...reports, ...batch];
        try { saveReports(); } catch (error) { reports = previous; throw error; }
      }
    } catch (error) {
      alert('登録に失敗しました。\n' + error.message + '\n共有投稿の場合、再送信前に共有一覧を確認してください。');
      return;
    } finally {
      savingForm = false;
      if (submitButton) submitButton.disabled = false;
    }
    editId = null;
    sharedEditId = null;
    selectedProduct = null;
    selectedRegistrationProducts = [];
    updateRegistrationProducts();

    get('reportForm').reset();
    $('publishReport').disabled = !authUser;
    get('shop').value = '';
    get('lat').value = '';
    get('lng').value = '';
    get('foundAt').value = nowLocal();
    get('cancelEdit').hidden = true;

    updateCategoryHint();
    get('period').value = 'all';
    switchTab('map');

    if (map) {
      map.setView([lat, lng], 16);
    }
  }

  // ========================================
  // CSV読み込み
  // ========================================

  function parseCSV(source) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    const text = source.replace(/^\uFEFF/, '');

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '"') {
        if (quoted && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        row.push(field);
        field = '';
      } else if (
        (char === '\n' || char === '\r') && !quoted
      ) {
        if (char === '\r' && text[i + 1] === '\n') i++;

        row.push(field);
        if (row.some(value => value.trim())) {
          rows.push([...row]);
        }
        row = [];
        field = '';
      } else {
        field += char;
      }
    }

    row.push(field);
    if (row.some(value => value.trim())) rows.push(row);

    if (!rows.length) return [];

    const headers = rows.shift().map(
      header => header.trim()
    );

    return rows.map(values =>
      Object.fromEntries(
        headers.map((header, index) => [
          header,
          values[index] || ''
        ])
      )
    );
  }

  function productDateValue(value) {
    const match = String(value || '').match(
      /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/
    );
    if (!match) return 0;

    return Number(match[1]) * 10000 +
      Number(match[2]) * 100 +
      Number(match[3]);
  }

  function parseProducts(text) {
    return parseCSV(text)
      .map(row => ({
        name: String(row['パック名'] || '').trim(),
        date: String(row['発売日'] || '').trim(),
        price: String(
          row['希望小売価格（円）'] || ''
        ).trim(),
        tax: String(row['価格表記'] || '').trim(),
        reading: String(row['よみがな'] || '').trim()
      }))
      .filter(p => p.name)
      .sort(
        (a, b) =>
          productDateValue(b.date) -
          productDateValue(a.date)
      );
  }

  async function loadProducts() {
    const sources = [
      ['pack', './pokemon_packs.csv'],
      ['deck', './pokemon_decks.csv']
    ];

    await Promise.all(
      sources.map(async ([category, file]) => {
        try {
          const response = await fetch(file);
          if (!response.ok) {
            throw new Error(`${file}: HTTP ${response.status}`);
          }

          const products = parseProducts(
            await response.text()
          );

          if (category === 'pack') {
            csvPacks = products;
          } else {
            csvDecks = products;
          }

          mergeCloudProducts();
          fillLotteryProductSuggestions();
          console.log(
            category, '商品数:', products.length
          );

          if (document.activeElement === get('product')) {
            showProductDropdown();
          }
          if (document.activeElement === get('mapProductSearch')) {
            showMapProductDropdown();
          }
        } catch (error) {
          console.error('商品CSV読み込みエラー:', error);
        }
      })
    );
  }

  // ========================================
  // 商品検索
  // ========================================

  const productAliases = {
    'MEGAドリームex': ['メガドリ'],
    'VSTARユニバース': ['vユニ', 'ブイユニ'],
    'シャイニートレジャーex': ['シャイトレ'],
    'シャイニースターV': ['シャイスタ'],
    'ポケモンカード151': ['151', 'イチゴーイチ'],
    '黒炎の支配者': ['黒炎'],
    'ロケット団の栄光': ['ロケ団'],
    'テラスタルフェスex': ['テラフェス'],
    '30th CELEBRATION': ['30周年'],
    '25th ANNIVERSARY COLLECTION': ['25周年'],
    'バトルパートナーズ': ['バトパ'],
    '超電ブレイカー': ['超電'],
    '楽園ドラゴーナ': ['楽ドラ'],
    '熱風のアリーナ': ['熱風'],
    'インフェルノX': ['インフェ'],
    'メガブレイブ': ['メガブレ'],
    'メガシンフォニア': ['メガシン'],
    'ホワイトフレア': ['ホワフレ'],
    'ブラックボルト': ['ブラボル']
  };

  function productNorm(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(
        /[\u30A1-\u30F6]/g,
        char => String.fromCharCode(
          char.charCodeAt(0) - 0x60
        )
      )
      .replace(
        /[\s\u3000・ー－‐-‒–—―_()（）「」『』]/g,
        ''
      );
  }

  // ========================================
  // マップ用 商品カテゴリ・商品名フィルター
  // ========================================
  function mapCategories() {
    const result = [];
    if (get('mapCategoryPack').checked) result.push('pack');
    if (get('mapCategoryDeck').checked) result.push('deck');
    return result;
  }

  function mapReportMatches(report) {
    const categories = mapCategories();
    const category = report.category === 'deck' ? 'deck' : 'pack';
    if (!categories.includes(category)) return false;
    const chosen = mapSelectedProducts.filter(p => categories.includes(p.category));
    if (!chosen.length) return true;
    return chosen.some(p => p.category === category &&
      productNorm(p.name) === productNorm(report.product));
  }

  function mapProductMatches(product, query) {
    if (!query) return true;
    if (productNorm(product.name).includes(query) || productNorm(product.reading).includes(query)) return true;
    return Object.entries(productAliases).some(([name, aliases]) =>
      productNorm(product.name).includes(productNorm(name)) &&
      aliases.some(alias => productNorm(alias).includes(query)));
  }

  function closeMapProductDropdown() {
    get('mapProductDropdown').hidden = true;
    get('mapProductSearch').setAttribute('aria-expanded', 'false');
  }

  function showMapProductDropdown() {
    const dropdown = get('mapProductDropdown');
    const query = productNorm(get('mapProductSearch').value);
    dropdown.replaceChildren();
    const categories = mapCategories();
    const products = [
      ...(categories.includes('pack') ? packs.map(p => ({...p, category:'pack'})) : []),
      ...(categories.includes('deck') ? decks.map(p => ({...p, category:'deck'})) : [])
    ].sort((a,b) => productDateValue(b.date) - productDateValue(a.date));
    if (!categories.length) {
      dropdown.textContent = '商品カテゴリを1つ以上選択してください。';
    } else if (!products.length) {
      dropdown.textContent = '商品データを読み込み中です。';
    } else {
      const matches = products.filter(p => mapProductMatches(p, query));
      if (!matches.length) dropdown.textContent = '該当する商品がありません。';
      matches.slice(0, 120).forEach(p => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'map-product-choice';
        const strong = document.createElement('strong');
        strong.textContent = p.name;
        const small = document.createElement('small');
        small.textContent = `${p.category === 'pack' ? '拡張パック' : '構築デッキ'}${p.date ? ' · '+p.date : ''}`;
        button.append(strong, small);
        button.addEventListener('click', () => {
          if (!mapSelectedProducts.some(x => x.category === p.category && x.name === p.name)) {
            mapSelectedProducts.push({name:p.name, category:p.category});
          }
          get('mapProductSearch').value = '';
          closeMapProductDropdown();
          updateMapFilterUI();
          renderAndFitMap();
        });
        dropdown.append(button);
      });
    }
    dropdown.hidden = false;
    get('mapProductSearch').setAttribute('aria-expanded', 'true');
  }

  function updateMapFilterUI() {
    const categories = mapCategories();
    get('mapCategoryHint').textContent = categories.length === 2
      ? '拡張パックと構築デッキの両方を検索します。'
      : categories.length === 1
        ? (categories[0] === 'pack' ? '拡張パックの商品を検索します。' : '構築デッキの商品を検索します。')
        : '商品カテゴリを1つ以上選択してください。';
    const box = get('mapSelectedProducts');
    box.replaceChildren();
    mapSelectedProducts.forEach((p, index) => {
      const chip = document.createElement('span');
      chip.className = 'map-product-chip';
      chip.append(document.createTextNode(p.name));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `${p.name}を解除`);
      remove.addEventListener('click', () => {
        mapSelectedProducts.splice(index, 1);
        updateMapFilterUI();
        renderAndFitMap();
      });
      chip.append(remove);
      box.append(chip);
    });
    get('mapClearProducts').hidden = mapSelectedProducts.length === 0;
  }


  // 探している商品: 未ログイン時は端末保存、ログイン時はユーザー専用クラウド保存。
  const WISHLIST_KEY = 'pokeca-wishlist-v1';
  const WISHLIST_TABLE = 'user_wishlists';
  let wishlist = [];
  let wishlistReady = false;
  let wishlistSyncSequence = 0;
  let wishlistSaveQueue = Promise.resolve();

  function normalizeWishlist(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter(p => {
      if (!p || typeof p.name !== 'string' || !['pack','deck'].includes(p.category)) return false;
      const name = p.name.trim();
      const key = p.category + ':' + productNorm(name);
      if (!name || name.length > 200 || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0,100).map(p => ({name:p.name.trim(), category:p.category}));
  }
  function readLocalWishlist() {
    try { return normalizeWishlist(JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]')); }
    catch (_) { return []; }
  }
  function writeLocalWishlist() {
    try { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)); }
    catch (_) { console.warn('探している商品の端末保存に失敗しました'); }
  }
  function wishlistStatus(message) {
    const node = get('wishlistSyncStatus');
    if (node) node.textContent = message;
  }
  function loadWishlist() {
    wishlist = readLocalWishlist();
    wishlistReady = true;
  }
  async function refreshWishlistForAccount() {
    const sequence = ++wishlistSyncSequence;
    if (!wishlistReady) return;
    if (!supabaseClient || !authUser) {
      wishlist = readLocalWishlist();
      renderWishlist();
      wishlistStatus('端末内に保存中。Discordログインで他の端末と同期できます。');
      return;
    }
    const userId = authUser.id;
    wishlistStatus('クラウドから同期中…');
    try {
      await wishlistSaveQueue;
      const {data,error} = await supabaseClient.from(WISHLIST_TABLE)
        .select('items').eq('user_id',userId).maybeSingle();
      if (error) throw error;
      if (sequence !== wishlistSyncSequence || authUser?.id !== userId) return;
      const remote = normalizeWishlist(data?.items || []);
      const migrationKey = WISHLIST_KEY + '-migrated-' + userId;
      const shouldMigrate = localStorage.getItem(migrationKey) !== '1';
      // 初回のみ既存の端末設定をクラウドに統合。以降はクラウドを正として削除も反映する。
      const merged = shouldMigrate ? normalizeWishlist([...remote,...readLocalWishlist()]) : remote;
      if (shouldMigrate) {
        const {error:saveError} = await supabaseClient.from(WISHLIST_TABLE)
          .upsert({user_id:userId,items:merged},{onConflict:'user_id'});
        if (saveError) throw saveError;
        if (sequence !== wishlistSyncSequence || authUser?.id !== userId) return;
        localStorage.setItem(migrationKey,'1');
      }
      wishlist = merged;
      writeLocalWishlist();
      renderWishlist();
      wishlistStatus('☁ 同じDiscordアカウントの端末と同期しています。');
    } catch (error) {
      if (sequence !== wishlistSyncSequence) return;
      wishlistStatus('同期できませんでした。通信とSupabase設定を確認してください：' + error.message);
    }
  }
  function saveWishlist() {
    wishlist = normalizeWishlist(wishlist);
    writeLocalWishlist();
    renderWishlist();
    if ($('lotteryView')?.classList.contains('active')) renderLottery();
    if (!supabaseClient || !authUser) {
      wishlistStatus('端末内に保存しました。Discordログインで同期できます。');
      return;
    }
    const userId = authUser.id;
    const snapshot = wishlist.map(p => ({...p}));
    wishlistStatus('クラウドに保存中…');
    wishlistSaveQueue = wishlistSaveQueue.catch(()=>{}).then(async () => {
      const {error} = await supabaseClient.from(WISHLIST_TABLE)
        .upsert({user_id:userId,items:snapshot},{onConflict:'user_id'});
      if (error) throw error;
      if (authUser?.id === userId) wishlistStatus('☁ クラウドに保存しました。');
    }).catch(error => {
      if (authUser?.id === userId) wishlistStatus('クラウド保存に失敗しました：' + error.message);
    });
  }
  function renderWishlist() {
    const list = get('wishlistSelected');
    list.replaceChildren();
    wishlist.forEach((p, index) => {
      const chip = document.createElement('span');
      chip.className = 'map-product-chip';
      chip.append(document.createTextNode(p.name));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', p.name + 'を探している商品から削除');
      remove.addEventListener('click', () => { wishlist.splice(index, 1); saveWishlist(); });
      chip.append(remove);
      list.append(chip);
    });
    get('wishlistEmpty').hidden = wishlist.length > 0;
    get('wishlistSelectedHeading').textContent = `② 登録済みの探している商品（${wishlist.length}件）`;
    get('wishlistApply').disabled = wishlist.length === 0;
    updateLotteryWishlistControl();
  }
  function showWishlistChoices() {
    const input = get('wishlistSearch');
    const dropdown = get('wishlistChoices');
    const info = get('wishlistSearchInfo');
    const query = productNorm(input.value);
    dropdown.replaceChildren();
    if (!query) {
      dropdown.hidden = true;
      info.textContent = '商品名を入力すると、ここに候補が表示されます。';
      input.setAttribute('aria-expanded','false');
      return;
    }
    const allProducts = [
      ...packs.map(p => ({...p, category:'pack'})),
      ...decks.map(p => ({...p, category:'deck'}))
    ];
    if (!allProducts.length) {
      info.textContent = '商品一覧を読み込み中です。少し待ってから検索してください。';
      dropdown.hidden = true;
      input.setAttribute('aria-expanded','false');
      return;
    }
    const matches = allProducts
      .filter(p => mapProductMatches(p, query))
      .filter(p => !wishlist.some(x => x.category === p.category && productNorm(x.name) === productNorm(p.name)))
      .sort((a,b) => productDateValue(b.date) - productDateValue(a.date));
    info.textContent = matches.length ? `検索結果：${matches.length}件（候補をタップして追加）` : '該当する未登録の商品はありません。別の名前でも検索できます。';
    matches.slice(0, 40).forEach(p => {
      const button = document.createElement('button');
      button.type = 'button';
      const main = document.createElement('span');
      main.className = 'wishlist-choice-main';
      const name = document.createElement('strong');
      name.textContent = p.name;
      const details = document.createElement('small');
      details.textContent = (p.category === 'deck' ? '構築デッキ・スターターセット' : '拡張パック') + (p.date ? ' · ' + p.date : '');
      main.append(name, details);
      const add = document.createElement('span');
      add.className = 'wishlist-choice-add';
      add.textContent = '＋ 追加';
      button.append(main, add);
      button.addEventListener('click', () => {
        wishlist.push({name:p.name, category:p.category});
        input.value = '';
        dropdown.hidden = true;
        input.setAttribute('aria-expanded','false');
        info.textContent = `「${p.name}」を登録しました。続けて別の商品も検索できます。`;
        saveWishlist();
      });
      dropdown.append(button);
    });
    dropdown.hidden = matches.length === 0;
    input.setAttribute('aria-expanded',String(matches.length > 0));
  }
  function initWishlist() {
    loadWishlist();
    renderWishlist();
    get('wishlistSearchInfo').textContent = '商品名を入力すると、ここに候補が表示されます。';
    const input = get('wishlistSearch');
    input.addEventListener('input', showWishlistChoices);
    input.addEventListener('focus', showWishlistChoices);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { get('wishlistChoices').hidden = true; input.setAttribute('aria-expanded','false'); }
    });
    document.addEventListener('pointerdown', e => {
      if (!e.target.closest('.wishlist-panel')) {
        get('wishlistChoices').hidden = true;
        input.setAttribute('aria-expanded','false');
      }
    });
    get('wishlistApply').addEventListener('click', () => {
      if (!wishlist.length) return;
      get('mapCategoryPack').checked = wishlist.some(p => p.category === 'pack');
      get('mapCategoryDeck').checked = wishlist.some(p => p.category === 'deck');
      mapSelectedProducts = wishlist.map(p => ({...p}));
      closeMapProductDropdown();
      updateMapFilterUI();
      renderAndFitMap();
      setMapFilterOpen(false);
    });
    get('wishlistResetFilter').addEventListener('click', () => {
      mapSelectedProducts = [];
      get('mapCategoryPack').checked = true;
      get('mapCategoryDeck').checked = true;
      updateMapFilterUI();
      renderAndFitMap();
    });
  }

  function initMapProductFilter() {
    ['mapCategoryPack','mapCategoryDeck'].forEach(id => {
      get(id).addEventListener('change', () => {
        // 選択されていないカテゴリの商品は選択リストからも外す
        mapSelectedProducts = mapSelectedProducts.filter(p => mapCategories().includes(p.category));
        closeMapProductDropdown();
        updateMapFilterUI();
        renderAndFitMap();
      });
    });
    const input = get('mapProductSearch');
    input.addEventListener('focus', showMapProductDropdown);
    input.addEventListener('input', showMapProductDropdown);
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeMapProductDropdown();
      if (e.key === 'Enter') e.preventDefault();
    });
    get('mapClearProducts').addEventListener('click', () => {
      mapSelectedProducts = [];
      input.value = '';
      closeMapProductDropdown();
      updateMapFilterUI();
      renderAndFitMap();
    });
    document.addEventListener('pointerdown', e => {
      if (!e.target.closest('.map-product-input-wrap')) closeMapProductDropdown();
    });
    updateMapFilterUI();
  }

  function updateRegistrationProducts() {
    const box = $('registrationSelectedProducts');
    if (!box) return;
    box.replaceChildren();
    selectedRegistrationProducts.forEach((item, index) => {
      const chip = document.createElement('span');
      chip.className = 'map-product-chip';
      chip.append(document.createTextNode(item.name));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', item.name + 'を解除');
      remove.addEventListener('click', () => {
        selectedRegistrationProducts.splice(index, 1);
        updateRegistrationProducts();
      });
      chip.append(remove);
      box.append(chip);
    });
    const hint = $('registrationSelectionHint');
    if (hint) hint.textContent = selectedRegistrationProducts.length
      ? `${selectedRegistrationProducts.length}種類を選択中。保存すると商品ごとに別々の発見情報になります。`
      : '候補をタップすると複数の商品を追加できます。';
    const input = $('product');
    if (input) input.required = selectedRegistrationProducts.length === 0;
  }

  let productDropdown = null;

  function closeProductDropdown() {
    if (!productDropdown) return;
    productDropdown.hidden = true;
    get('product').setAttribute('aria-expanded', 'false');
  }

  function showProductDropdown() {
    if (!productDropdown) return;

    const input = get('product');
    const query = productNorm(input.value);
    const products = currentProducts();

    productDropdown.replaceChildren();

    if (selectedCategories().length === 0) {
      productDropdown.textContent =
        '商品カテゴリを選択してください。';
      productDropdown.hidden = false;
      return;
    }

    if (!products.length) {
      productDropdown.textContent =
        '商品データを読み込み中、または取得できません。';
      productDropdown.hidden = false;
      return;
    }

    const matches = products.filter(p => {
      if (!query) return true;

      if (productNorm(p.name).includes(query)) {
        return true;
      }
      if (productNorm(p.reading).includes(query)) {
        return true;
      }

      return Object.entries(productAliases).some(
        ([name, aliases]) =>
          productNorm(p.name).includes(productNorm(name)) &&
          aliases.some(alias =>
            productNorm(alias).includes(query)
          )
      );
    });

    if (!matches.length) {
      const message = document.createElement('p');
      message.className = 'hint';
      message.textContent =
        '該当する商品がありません。手入力も可能です。';
      message.style.padding = '12px';
      productDropdown.append(message);
    }

    matches.slice(0, 150).forEach(p => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'product-result';

      const name = document.createElement('strong');
      name.textContent = p.name;

      const detail = document.createElement('small');
      detail.style.display = 'block';
      detail.style.color = '#64748b';
      detail.style.marginTop = '4px';

      const category = p.category === 'deck'
        ? '構築デッキ'
        : '拡張パック';

      detail.textContent = [
        category,
        p.date,
        p.price ? `${p.price}円` : '',
        p.tax
      ].filter(Boolean).join(' · ');

      button.append(name, detail);

      button.addEventListener('click', () => {
        if (editId || sharedEditId) {
          input.value = p.name;
          selectedProduct = {name:p.name, category:p.category};
        } else {
          if (!selectedRegistrationProducts.some(x => x.name === p.name && x.category === p.category)) {
            if (selectedRegistrationProducts.length >= 20) return alert('一度に20種類まで選択できます。');
            selectedRegistrationProducts.push({name:p.name, category:p.category});
          }
          input.value = '';
          selectedProduct = null;
          updateRegistrationProducts();
        }
        closeProductDropdown();
      });

      productDropdown.append(button);
    });

    productDropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function initProductDropdown() {
    const input = get('product');

    const wrapper = document.createElement('div');
    wrapper.className = 'product-input-wrap';

    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);

    productDropdown = document.createElement('div');
    productDropdown.id = 'packDropdown';
    productDropdown.className = 'product-dropdown';
    productDropdown.hidden = true;
    wrapper.append(productDropdown);

    input.setAttribute('autocomplete', 'off');

    input.addEventListener('focus', showProductDropdown);
    input.addEventListener('click', showProductDropdown);

    input.addEventListener('input', () => {
      selectedProduct = null;
      showProductDropdown();
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'Escape') {
        closeProductDropdown();
      }
    });

    ['categoryPack', 'categoryDeck'].forEach(id => {
      get(id).addEventListener('change', categoryChanged);
    });

    document.addEventListener('pointerdown', event => {
      if (!wrapper.contains(event.target)) {
        closeProductDropdown();
      }
    });
  }

  // ========================================
  // 店舗データ
  // ========================================

  const STORE_CATEGORIES = [
    'コンビニ', 'TSUTAYA', 'GEO', 'ヨドバシカメラ',
    'コジマ', 'ヤマダデンキ', 'カードショップ'
  ];

  function inferStoreCategory(p) {
    if (STORE_CATEGORIES.includes(p.category)) return p.category;
    const name = String(p.name || '').normalize('NFKC').toLowerCase();
    if (/tsutaya|ツタヤ/.test(name)) return 'TSUTAYA';
    if (/ゲオ|\bgeo\b/.test(name)) return 'GEO';
    if (/ヨドバシ/.test(name)) return 'ヨドバシカメラ';
    if (/コジマ/.test(name)) return 'コジマ';
    if (/ヤマダ|テックランド|yamada/i.test(name)) return 'ヤマダデンキ';
    if (/カードラボ|トレカ|バトロコ|駿河屋|ganryu|wondergoo|bookoff|ホビーオフ|イエローサブマリン|きんこん館|ポケットトレジャー|tiny frontier|コーギーアール|quest/i.test(name)) return 'カードショップ';
    return 'コンビニ';
  }

  function isStore(p) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) return false;
    if (p.lat === '' || p.lng === '' || p.lat == null || p.lng == null) return false;
    return Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
      Number(p.lat) > 35 && Number(p.lat) < 38 &&
      Number(p.lng) > 138 && Number(p.lng) < 141;
  }

  function norm(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\u3000・ー－-]/g, '');
  }

  function brandNorm(value) {
    const text = norm(value);

    if (/^(セブン|seven|7eleven)/.test(text)) {
      return 'seven';
    }
    if (/^(ファミマ|ファミリマト|ファミリーマート|familymart)/.test(text)) {
      return 'familymart';
    }
    if (/^(ローソン|ロソン|lawson)/.test(text)) {
      return 'lawson';
    }
    if (/^(ミニストップ|ministop)/.test(text)) {
      return 'ministop';
    }
    return text;
  }

  function storeKey(p) {
    return norm(p.name) + '|' +
      Number(p.lat).toFixed(6) + '|' +
      Number(p.lng).toFixed(6);
  }

  function updateStoreCount() {
    const count = stores.length + cloudStores.filter(s=>!stores.some(p=>storeKey(p)===storeKey(s))).length;
    get('storeCount').textContent = `登録店舗 ${count}件（端末保存＋CSV）`;
    const status = $('storeDataStatus');
    if (status) status.textContent = `${count}店舗を検索できます。`;
  }

  function addStores(items) {
    const existing = new Map(stores.map((p, i) => [storeKey(p), i]));
    let added = 0;
    items.filter(isStore).forEach(p => {
      const item = {
        id: String(p.id || '').trim(),
        name: String(p.name).trim(),
        city: String(p.city || '').trim(),
        address: String(p.address || '').trim(),
        category: inferStoreCategory(p),
        lat: Number(p.lat), lng: Number(p.lng)
      };
      const key = storeKey(item);
      if (existing.has(key)) {
        const index = existing.get(key);
        const old = stores[index];
        // CSV側の分類・住所で既存の古いデータを補完する。
        stores[index] = { ...old, ...item,
          id: item.id || old.id || '',
          address: item.address || old.address || '',
          city: item.city || old.city || '' };
      } else {
        existing.set(key, stores.length);
        stores.push(item);
        added++;
      }
    });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(stores));
    } catch (error) {
      console.error('店舗データ保存エラー:', error);
    }
    updateStoreCount();
    return added;
  }

  function loadSavedStores() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(saved)) {
        stores = saved.filter(isStore).map(p => ({
          id: String(p.id || ''), name: String(p.name).trim(),
          city: String(p.city || ''), address: String(p.address || ''),
          category: inferStoreCategory(p),
          lat: Number(p.lat), lng: Number(p.lng)
        }));
      }
    } catch (error) {
      console.error('店舗データ読み込みエラー:', error);
    }
    updateStoreCount();
  }

  async function loadStoreCSV() {
    const sources = [
      ['./tochigi-convenience-stores.csv', 'コンビニ'],
      ['./tochigi_pokeca_stores_89_app_ready.csv', null]
    ];
    await Promise.all(sources.map(async ([file, fallbackCategory]) => {
      try {
        const response = await fetch(file, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
        const items = parseCSV(await response.text()).map(p => ({
          ...p, category: p.category || fallbackCategory || ''
        })).filter(isStore);
        const added = addStores(items);
        console.log(file, '読込:', items.length, '追加:', added);
      } catch (error) {
        console.error('店舗CSV読み込みエラー:', error);
        const status = $('storeDataStatus');
        if (status) status.textContent =
          '一部の店舗CSVを読み込めませんでした。開発者ツールで確認してください。';
      }
    }));
  }

  function selectedStoreCategories() {
    return [...document.querySelectorAll('input[name="storeCategory"]:checked')]
      .map(input => input.value);
  }

  function searchStores() {
    const area = norm(get('searchArea').value);
    const query = brandNorm(get('storeQuery').value);
    const output = get('storeResults');
    const selected = selectedStoreCategories();
    output.replaceChildren();

    if (!selected.length) {
      output.textContent = '店舗カテゴリを1つ以上選択してください。';
      return;
    }
    if (!query && !area) {
      output.textContent = '地域または店舗名を入力してください。';
      return;
    }
    const matches = [...stores.filter(p=>!cloudStores.some(c=>storeKey(c)===storeKey(p))),...cloudStores].filter(p => {
      if (!selected.includes(inferStoreCategory(p))) return false;
      const name = norm(p.name);
      const brand = brandNorm(p.name);
      const city = norm(p.city);
      const address = norm(p.address);
      return (!query || brand.includes(query) || name.includes(query) || norm(inferStoreCategory(p)).includes(query)) &&
        (!area || city.includes(area) || address.includes(area) || name.includes(area));
    });
    const count = document.createElement('p');
    count.className = 'hint';
    count.textContent = `${matches.length}件の店舗が見つかりました。` +
      (matches.length > 150 ? ' 最初の150件を表示します。' : '');
    output.append(count);
    if (!matches.length) {
      const message = document.createElement('p');
      message.textContent = '該当店舗がありません。';
      output.append(message);
      return;
    }
    matches.slice(0, 150).forEach(p => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'store-result';
      const name = document.createElement('strong');
      name.textContent = p.name;
      const detail = document.createElement('small');
      detail.textContent = [inferStoreCategory(p), p.city, p.address]
        .filter(Boolean).join(' · ');
      button.append(name, detail);
      button.addEventListener('click', () => {
        get('shop').value = p.name;
        get('lat').value = p.lat.toFixed(6);
        get('lng').value = p.lng.toFixed(6);
        output.textContent = `選択済み：${p.name}（${inferStoreCategory(p)}）`;
        if (map) map.setView([p.lat, p.lng], 17);
      });
      output.append(button);
    });
  }

  // ========================================
  // 店舗チェーン候補
  // ========================================

  const chainNames = [
    'セブンイレブン',
    'ファミリーマート',
    'ローソン',
    'ミニストップ',
    'TSUTAYA', 'GEO', 'ヨドバシカメラ', 'コジマ',
    'ヤマダデンキ', 'カードショップ'
  ];

  let chainDropdown = null;

  function closeChainDropdown() {
    if (chainDropdown) chainDropdown.hidden = true;
  }

  function showChainDropdown() {
    if (!chainDropdown) return;

    const input = get('storeQuery');
    const query = norm(input.value);
    chainDropdown.replaceChildren();

    const options = chainNames.filter(name =>
      !query ||
      norm(name).includes(query) ||
      (name === 'ファミリーマート' &&
       norm('ファミマ').includes(query)) ||
      (name === 'セブンイレブン' &&
       'seveneleven'.includes(query))
    );

    options.forEach(name => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.className = 'product-result';

      button.addEventListener('click', () => {
        input.value = name;
        closeChainDropdown();
        searchStores();
      });

      chainDropdown.append(button);
    });

    chainDropdown.hidden = options.length === 0;
  }

  function initChainDropdown() {
    const input = get('storeQuery');
    const row = input.closest('.searchrow');
    if (!row) return;

    row.style.position = 'relative';

    chainDropdown = document.createElement('div');
    chainDropdown.id = 'chainDropdown';
    chainDropdown.className = 'product-dropdown';
    chainDropdown.hidden = true;
    row.append(chainDropdown);

    input.addEventListener('focus', showChainDropdown);
    input.addEventListener('click', showChainDropdown);
    input.addEventListener('input', showChainDropdown);

    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeChainDropdown();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        closeChainDropdown();
        searchStores();
      }
    });

    document.addEventListener('pointerdown', event => {
      if (!row.contains(event.target)) {
        closeChainDropdown();
      }
    });
  }

  // ========================================
  // 店舗CSV入出力
  // ========================================

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text)
      ? '"' + text.replace(/"/g, '""') + '"'
      : text;
  }

  function exportStores() {
    if (!isDeveloper()) return;
    const lines = [
      'name,city,address,category,lat,lng',
      ...stores.map(p =>
        [p.name, p.city, p.address || '', inferStoreCategory(p), p.lat, p.lng]
          .map(csvEscape).join(',')
      )
    ];

    const blob = new Blob(
      ['\uFEFF' + lines.join('\r\n')],
      { type: 'text/csv;charset=utf-8' }
    );

    downloadBlob(blob, 'pokeca-tochigi-stores.csv');
  }

  async function importStores(event) {
    if (!isDeveloper()) return;
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      if (file.size > 2000000) {
        throw new Error('CSVは2MB以下にしてください。');
      }

      const items = parseCSV(
        await file.text()
      ).filter(isStore);

      if (!items.length) {
        throw new Error('有効な店舗データがありません。');
      }

      if (confirm(`${items.length}件の店舗を取り込みますか？`)) {
        const added = addStores(items);
        alert(`${added}件を追加しました。`);
      }
    } catch (error) {
      alert(`CSV取込エラー：${error.message}`);
    }

    event.target.value = '';
  }

  function rememberStore() {
    if (!isDeveloper()) return;
    const latText = get('lat').value;
    const lngText = get('lng').value;

    const item = {
      name: get('shop').value.trim(),
      city: get('searchArea').value.trim(),
      category: 'コンビニ',
      lat: Number(latText),
      lng: Number(lngText)
    };

    if (
      !item.name ||
      latText === '' ||
      lngText === '' ||
      !isStore(item)
    ) {
      alert('正しい店舗名と位置情報を入力してください。');
      return;
    }

    const added = addStores([item]);

    alert(added
      ? '店舗一覧に保存しました。'
      : 'すでに登録されている店舗です。'
    );
  }

  // ========================================
  // JSON入出力
  // ========================================

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportReports() {
    downloadBlob(
      new Blob(
        [JSON.stringify(reports, null, 2)],
        { type: 'application/json' }
      ),
      'pokeca-reports.json'
    );
  }

  async function importReports(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const data = JSON.parse(await file.text());

      if (
        !Array.isArray(data) ||
        data.length > 10000 ||
        !data.every(validReport)
      ) {
        throw new Error('JSON形式が正しくありません。');
      }

      if (confirm(
        `${data.length}件の記録で現在のデータを置き換えますか？`
      )) {
        const previous = reports;
        reports = data.map(r => ({
          ...r,
          category: r.category === 'deck' ? 'deck' : 'pack'
        }));

        try {
          saveReports();
          render();
        } catch (error) {
          reports = previous;
          throw error;
        }
      }
    } catch (error) {
      alert('JSONファイルを読み込めませんでした。');
    }

    event.target.value = '';
  }

  // ========================================
  // 現在地
  // ========================================

  function locate() {
    if (!map) {
      alert('地図が読み込まれていません。');
      return;
    }

    if (!navigator.geolocation) {
      alert('位置情報に対応していません。');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        map.setView([
          position.coords.latitude,
          position.coords.longitude
        ], 15);
      },
      () => {
        alert('位置情報を取得できませんでした。');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // ========================================
  // イベント登録
  // ========================================

  function bindEvents() {
    document.querySelectorAll('nav button').forEach(button => {
      button.addEventListener('click', () => {
        switchTab(button.dataset.tab);
        // v21.24: Open the developer tab to dispatch an on-demand recheck.
        // The normal scheduled collector cadence is not modified.
        if (button.dataset.tab === 'dev' && isDeveloper()) {
          requestLotteryDevRecheck({automatic: true});
        }
      });
    });

    get('period').addEventListener('change', renderAndFitMap);

    get('historyList').addEventListener('click', handleCard);
    get('mapList').addEventListener('click', handleCard);

    get('reportForm').addEventListener('submit', saveForm);

    get('cancelEdit').addEventListener('click', () => {
      formFor(null);
    });

    get('storeSelectAll').addEventListener('click', () => {
      document.querySelectorAll('input[name="storeCategory"]').forEach(input => { input.checked = true; });
    });
    get('storeClearAll').addEventListener('click', () => {
      document.querySelectorAll('input[name="storeCategory"]').forEach(input => { input.checked = false; });
    });
    get('storeSearch').addEventListener('click', () => {
      closeChainDropdown();
      searchStores();
    });

    get('searchArea').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchStores();
      }
    });

    get('storeRemember').addEventListener(
      'click', rememberStore
    );
    get('storeExport').addEventListener(
      'click', exportStores
    );
    get('storeImport').addEventListener(
      'change', importStores
    );

    get('export').addEventListener(
      'click', exportReports
    );
    get('import').addEventListener(
      'change', importReports
    );
    get('discordLogin').addEventListener('click',discordLogin);
    get('discordLogout').addEventListener('click',discordLogout);
    get('sharedRefresh').addEventListener('click',loadSharedReports);
    get('historySharedRefresh').addEventListener('click',loadSharedReports);
    get('mySharedList').addEventListener('click',handleCard);

    get('locate').addEventListener('click', locate);
  }


  // クラウドデータは端末のlocalStorageに混ぜない（削除後に復活させないため）。
  function mergeCloudProducts() {
    const merge = (base, category) => {
      const items = base.map(p=>({...p}));
      for (const row of cloudProducts.filter(p=>p.category===category)) {
        const p = {name:row.name,reading:row.reading||'',date:row.release_date||'',price:row.price==null?'':String(row.price),tax:''};
        const i=items.findIndex(x=>x.name===p.name);
        if(i>=0) items[i]={...items[i],...p}; else items.push(p);
      }
      return items.sort((a,b)=>productDateValue(b.date)-productDateValue(a.date));
    };
    packs=merge(csvPacks,'pack'); decks=merge(csvDecks,'deck');
  }

  async function loadCloudData() {
    if (!supabaseClient) return;
    const [p,s] = await Promise.all([
      supabaseClient.from('catalog_products').select('id,category,name,reading,release_date,price').order('created_at',{ascending:false}).limit(2000),
      supabaseClient.from('catalog_stores').select('id,name,category,city,address,lat,lng').order('created_at',{ascending:false}).limit(2000)
    ]);
    if (p.error || s.error) {
      const target=$('cloudAdminStatus');
      if(target && isDeveloper()) target.textContent='クラウド取得エラー：'+(p.error||s.error).message+'（SQL設定を確認）';
      return;
    }
    cloudProducts=p.data||[];
    cloudStores=(s.data||[]).filter(isStore).map(x=>({...x,lat:Number(x.lat),lng:Number(x.lng)}));
    mergeCloudProducts(); updateStoreCount(); renderCloudAdminLists(); fillLotteryProductSuggestions();
    if (document.activeElement===$('product')) showProductDropdown();
    if (document.activeElement===$('mapProductSearch')) showMapProductDropdown();
    if ($('cloudAdminStatus')) $('cloudAdminStatus').textContent=`共有商品 ${cloudProducts.length}件・共有店舗 ${cloudStores.length}件`;
  }

  function renderCloudAdminLists() {
    if(!isDeveloper()) return;
    for(const [kind,rows] of [['Product',cloudProducts],['Store',cloudStores]]) {
      const target=$('cloud'+kind+'List'); if(!target)continue;
      target.replaceChildren();
      for(const item of rows) {
        const div=document.createElement('div');div.className='cloud-admin-item';
        const label=document.createElement('span');label.textContent=kind==='Product'?`${item.category==='pack'?'パック':'デッキ'}：${item.name}`:`${item.name}（${item.city||'地域未設定'}）`;
        const edit=document.createElement('button');edit.type='button';edit.textContent='編集';edit.addEventListener('click',()=>{
          if(kind==='Product') {
            for(const [field,value] of Object.entries({Id:item.id,Category:item.category,Name:item.name,Reading:item.reading||'',Date:item.release_date||'',Price:item.price??''})) $('cloudProduct'+field).value=value;
          } else {
            for(const [field,value] of Object.entries({Id:item.id,Name:item.name,Category:item.category,City:item.city||'',Address:item.address||'',Lat:item.lat,Lng:item.lng})) $('cloudStore'+field).value=value;
          }
          $('cloud'+kind+'Form').scrollIntoView({behavior:'smooth',block:'start'});
        });
        const del=document.createElement('button');del.type='button';del.textContent='削除';del.addEventListener('click',()=>deleteCloudItem(kind,item));
        div.append(label,edit,del);target.append(div);
      }
    }
  }

  async function deleteCloudItem(kind,item) {
    if(!isDeveloper()||!supabaseClient)return;
    if(!confirm(`「${item.name}」を共有データから削除しますか？`))return;
    const table=kind==='Product'?'catalog_products':'catalog_stores';
    const {error}=await supabaseClient.from(table).delete().eq('id',item.id);
    if(error) return alert('削除失敗：'+error.message);
    await loadCloudData();
  }

  async function saveCloudItem(kind,event) {
    event.preventDefault();
    if(!isDeveloper()||!supabaseClient) return alert('開発者としてDiscordログインしてください。');
    const product=kind==='Product';
    const id=$('cloud'+kind+'Id').value;
    const value=field=>$('cloud'+kind+field).value.trim();
    let payload;
    if(product) {
      payload={category:value('Category'),name:value('Name'),reading:value('Reading'),release_date:value('Date')||null,price:value('Price')===''?null:Number(value('Price'))};
    } else {
      payload={name:value('Name'),category:value('Category'),city:value('City'),address:value('Address'),lat:Number(value('Lat')),lng:Number(value('Lng'))};
      if(!isStore(payload))return alert('緯度・経度を確認してください（現在は栃木周辺の範囲に対応）。');
    }
    const table=product?'catalog_products':'catalog_stores';
    const query=id?supabaseClient.from(table).update(payload).eq('id',id):supabaseClient.from(table).insert(payload);
    const {error}=await query;
    if(error)return alert('保存失敗：'+error.message);
    $('cloud'+kind+'Form').reset();$('cloud'+kind+'Id').value='';
    await loadCloudData();
    alert('全ユーザー共通データに保存しました。');
  }

  function initCloudAdmin() {
    for(const kind of ['Product','Store']) {
      $('cloud'+kind+'Form').addEventListener('submit',e=>saveCloudItem(kind,e));
      $('cloud'+kind+'Cancel').addEventListener('click',()=>{$('cloud'+kind+'Form').reset();$('cloud'+kind+'Id').value='';});
    }
    $('cloudUseSelectedStore').addEventListener('click',()=>{
      const lat=Number($('lat')?.value),lng=Number($('lng')?.value);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)||!lat||!lng) return alert('登録画面で店舗を選択してからお試しください。');
      $('cloudStoreLat').value=lat;$('cloudStoreLng').value=lng;
      if($('shop')?.value) $('cloudStoreName').value=$('shop').value;
    });
  }


  // アプリ設定（全ユーザー共通の端末内テーマ設定）
  function initAppTheme() {
    const key = 'pokeca-app-theme-v1';
    const root = document.documentElement;
    const select = document.getElementById('appThemeChoice');
    const panel = document.getElementById('appSettingsPanel');
    const backdrop = document.getElementById('appSettingsBackdrop');
    const open = document.getElementById('appSettingsOpen');
    const close = document.getElementById('appSettingsClose');
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let choice = 'system';
    try { choice = localStorage.getItem(key) || 'system'; } catch (_) {}
    if (!['system','light','dark'].includes(choice)) choice = 'system';
    select.value = choice;
    const apply = () => {
      const dark = choice === 'dark' || (choice === 'system' && media.matches);
      root.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d1524' : '#2563eb');
    };
    select.addEventListener('change', () => { choice = select.value; try { localStorage.setItem(key, choice); } catch (_) {} apply(); });
    if (media.addEventListener) media.addEventListener('change', apply);
    else if (media.addListener) media.addListener(apply);
    // Avoid programmatic focus of native select: it may pop up on iPhone.
    function toggle(show) {
      panel.hidden = !show;
      backdrop.hidden = !show;
      const target = show ? close : open;
      try { target.focus({preventScroll:true}); }
      catch (_) { target.focus(); }
    }
    open.addEventListener('click', () => toggle(true));
    close.addEventListener('click', () => toggle(false));
    backdrop.addEventListener('click', () => toggle(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) toggle(false); });
    apply();
  }


  // ========================================
  // LivePocket 抽選一覧（既存の地図とは独立）
  // ========================================
  const LP_JSON_URL = './livepocket_public.json';
  const LP_OTHER_JSON_URL = './other_lottery_public.json';
  const LP_EXT_OVERRIDE_TABLE = 'lottery_external_event_overrides';
  let lpExtOverrides = new Map();
  let lpExtReady = false,lpExtError='',lpExtLastFetch=0,lpExtLoading=null;
  let lpExtEditing='',lpExtBusy=false,lpExtListLimit=80;
  const LP_PAGE_SIZE = 50;
  const LP_REFRESH_MS = 5 * 60 * 1000;
  const LP_PREFECTURES = [
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県',
    '茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県',
    '新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県',
    '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
    '鳥取県','島根県','岡山県','広島県','山口県',
    '徳島県','香川県','愛媛県','高知県',
    '福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'
  ];
  // 「全国」は47県の別名ではなく、任意の都道府県の抽選に一致する範囲。
  const LP_NATIONWIDE = '全国';
  const LP_MANUAL_AREAS = [...LP_PREFECTURES,LP_NATIONWIDE];
  let lotteryItems = [];
  let lotteryBaseItems = [];
  const LP_CLOUD_TABLE = 'livepocket_event_overrides';
  let lpCloudOverrides = new Map();
  const LP_LOCATION_TABLE = 'livepocket_location_overrides';
  let lpLocationOverrides = new Map();
  let lpLocationReady = false, lpLocationLoading = null;
  let lpLocationLastFetch = 0, lpLocationError = '';
  let lpLocationBusy = false, lpLocationEditing = '';
  let lpLocationFilter = 'all', lpLocationSearch = '', lpLocationLimit = 60;
  let lpCloudReady = false;
  let lpCloudLastFetch = 0;
  let lpCloudLoading = null;
  let lpCloudError = '';
  let lotteryLastFetch = 0;
  let lotteryLoading = null;
  let lotteryVisibleLimit = LP_PAGE_SIZE;
  let lotteryTimer = null;
  let lotteryCountdownTimer = null;

  // External event references may use any ordinary website except X/Twitter.
  // Do not permit unsafe schemes, X redirect hosts, embedded credentials, etc.
  function safeLotteryUrl(value) {
    if(typeof value!=='string'||value.length<12||value.length>2000||
       /[\\\s\u0000-\u001f]/.test(value))return false;
    try{
      const link=new URL(value);
      const host=link.hostname.toLowerCase().replace(/\.$/,'');
      if(!['https:','http:'].includes(link.protocol) || link.username ||
         link.password || !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(host) ||
         !['','80','443'].includes(link.port) ||
         host.endsWith('.local')||host.endsWith('.internal')||
         host.endsWith('.localhost'))return false;
      return !['x.com','twitter.com','t.co','fxtwitter.com',
        'vxtwitter.com','fixupx.com'].some(x=>host===x||host.endsWith('.'+x));
    }catch(_){return false;}
  }

  function isLivePocketEventUrl(url) {
    return typeof url==='string' &&
      /^https:\/\/livepocket\.jp\/e\/[a-zA-Z0-9_-]{4,64}\/?$/.test(url);
  }

  function lotterySite(item) {
    if(isLivePocketEventUrl(item?.url))return 'LivePocket';
    const site=String(item?.source_site||'').trim();
    if(site)return site;
    try{return new URL(item.url).hostname;}catch(_){return '外部サイト';}
  }

  function lotteryStoreEntries(item) {
    const raw = Array.isArray(item.stores) ? item.stores : [];
    const entries = raw.filter(x => x && typeof x.name === 'string' && x.name.trim())
      .map(x => ({name:x.name.trim(),prefecture:String(x.prefecture||'').trim()}));
    if (entries.length) return entries;
    if (item.store_name) return [{name:String(item.store_name),prefecture:String(item.prefecture||'')}];
    return [];
  }

  function lotteryPrefectures(item) {
    const names = new Set(lotteryStoreEntries(item).map(s => s.prefecture).filter(Boolean));
    if (!names.size && item.prefecture) names.add(item.prefecture);
    return [...names];
  }

  function lotteryDate(value) {
    if (!value) return NaN;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : NaN;
  }

  // v21.50: An application that already ended is historical, not a
  // manual-error/recheck task. Prefer the latest public deadline, falling
  // back to the diagnostic CSV for older events. Unknown dates stay eligible.
  function lpApplicationExpired(url, diagnosticEnd='', now=Date.now()) {
    const publicItem=lotteryBaseItems.find(item=>item.url===url);
    const publishedEnd=lotteryDate(publicItem?.application_end_at);
    const end=Number.isFinite(publishedEnd)?publishedEnd:lotteryDate(diagnosticEnd);
    return Number.isFinite(end)&&end<=now;
  }

  // v21.20: NEW lasts 24 hours after this URL was first registered.
  // Never infer newness from Discord message time: old URLs may be reposted.
  const LP_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
  function lotteryIsNew(item, now = Date.now()) {
    if (!item || typeof item.first_detected_at !== 'string') return false;
    const detectedAt = lotteryDate(item.first_detected_at);
    return Number.isFinite(detectedAt) && detectedAt <= now &&
      now - detectedAt < LP_NEW_WINDOW_MS;
  }

  function ensureLotteryNewBadgeStyle() {
    if (document.getElementById('lpNewBadgeStyle')) return;
    const sheet = document.createElement('style');
    sheet.id = 'lpNewBadgeStyle';
    sheet.textContent = '.lp-new-badge{display:inline-flex;align-items:center;' +
      'padding:3px 9px;border-radius:999px;background:#ffe58f;color:#523600;' +
      'font-size:12px;font-weight:900;letter-spacing:.07em;' +
      'border:1px solid #edb94c;line-height:1.5;white-space:nowrap}';
    document.head.appendChild(sheet);
  }

  function lotteryState(item, now = Date.now()) {
    // Manual-confirmed unavailable pages are never labelled "受付中".
    // Keep them in the "すべて" list and preserve saved lottery history.
    if (item.manual_page_unavailable === true) return 'unavailable';
    const end = lotteryDate(item.application_end_at);
    const start = lotteryDate(item.application_start_at);
    if (Number.isFinite(end) && now > end) return 'closed';
    if (Number.isFinite(start) && now < start) return 'upcoming';
    if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end) return 'open';
    // 終了日時のみが判明していても、開始を確認できなければ受付中と断定しない。
    return 'unknown';
  }

  function lotteryJapaneseDate(value) {
    const time = lotteryDate(value);
    if (!Number.isFinite(time)) return '';
    return new Intl.DateTimeFormat('ja-JP',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',hour12:false
    }).format(new Date(time));
  }

  function lotteryGenre(item) {
    const explicit = String(item.review_category || '').toLowerCase();
    if (explicit === 'pokemon' || (item.pokemon_map_match && explicit !== 'onepiece' && explicit !== 'yugioh')) return 'pokemon';
    return explicit || 'unknown';
  }

  function lotteryProductType(item) {
    const kind = String(item.pokemon_map_type || '').toLowerCase();
    return ['pack','deck','pack/deck'].includes(kind) ? kind : 'unknown';
  }

  function lotteryMatchedWishlist(item) {
    const matched = productNorm(item.pokemon_map_match || '');
    const observed = productNorm(item.product_name || '');
    const title = productNorm(item.event_title_provisional ? '' : item.event_title || '');
    return wishlist.some(p => {
      const target = productNorm(p.name);
      const knownType = lotteryProductType(item);
      if (knownType !== 'unknown' && !knownType.split('/').includes(p.category)) return false;
      if (!target || target.length < 5) return false;
      if (matched && target === matched) return true;
      if (observed && observed.includes(target)) return true;
      if (title && title.includes(target)) return true;
      return false;
    });
  }

  function updateLotteryWishlistControl() {
    const checkbox = $('lpWishlistOnly');
    const label = $('lpWishlistLabel');
    if (!checkbox || !label) return;
    label.textContent = `⭐ 「探している商品」のみ（${wishlist.length}種類）`;
    checkbox.disabled = wishlist.length === 0;
    if (!wishlist.length) checkbox.checked = false;
  }

  function fillLotteryProductSuggestions() {
    const root = $('lpProductSuggestions');
    if (!root) return;
    root.replaceChildren();
    const seen = new Set();
    for (const p of [...packs,...decks]) {
      if (!p?.name || seen.has(p.name)) continue;
      seen.add(p.name);
      const option = document.createElement('option');
      option.value = p.name;
      root.append(option);
      if (seen.size >= 500) break;
    }
  }

  function renderLotteryPrefectures() {
    const selected = $('lpPrefecture').value;
    const actual = new Set(lotteryItems.flatMap(lotteryPrefectures));
    // Nationwide events must be reachable even if that prefecture has
    // no local-only events yet (otherwise its filter option disappears).
    const hasNationwide = actual.has(LP_NATIONWIDE);
    const root = $('lpPrefecture');
    root.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = '全国';root.append(all);
    const unknown = document.createElement('option');
    unknown.value = 'unknown'; unknown.textContent = '都道府県未確認';root.append(unknown);
    for (const name of LP_PREFECTURES) {
      if (!hasNationwide && !actual.has(name)) continue;
      const option = document.createElement('option');
      option.value = name; option.textContent = name; root.append(option);
    }
    root.value = [...root.options].some(x => x.value === selected) ? selected : 'all';
  }


  // v21.45: Supabase overrides are a separate authoritative display layer.
  // The GitHub-collected base JSON and a user's private lottery history remain
  // untouched. A backend RLS policy limits writes to the developer UID.
  function lpCloudApply() {
    lotteryItems = lotteryBaseItems.map(base=>{
      if(!isLivePocketEventUrl(base.url)){
        // Never display an excluded URL simply because the Discord collector
        // discovers it again. Until the moderation table is loaded, hold all
        // external cards rather than risk revealing excluded entries.
        if(!lpExtReady)return null;
        const row=lpExtOverrides.get(base.url);
        if(row?.state==='excluded')return null;
        if(!row)return base;
        const item={...base};
        if(row.event_title){
          item.event_title=row.event_title;
          item.official_event_title=row.event_title;
          item.event_title_provisional=false;
        }
        item.store_name=row.store_name||'';
        item.prefecture=row.prefecture||'';
        delete item.stores;
        item.review_category=row.review_category||'unknown';
        item.pokemon_map_type=row.product_type||'unknown';
        item.application_start_at=row.application_start_at||null;
        item.application_end_at=row.application_end_at||null;
        item.manual_external_edit=true;
        return item;
      }
      const override=lpCloudOverrides.get(base.url);
      const location=lpLocationOverrides.get(base.url);
      if(!override&&!location)return base;
      const item={...base};
      if(override?.resolution==='title' && lpManualValidTitle(override.event_title)){
        // A validated title also supersedes a historical unavailable CSV flag.
        item.manual_page_unavailable=false;
        delete item.manual_page_unavailable_reason;
        item.event_title=override.event_title;
        item.official_event_title=override.event_title;
        item.event_title_provisional=false;
        // A title verified from this exact URL also supersedes older CSV
        // page-unavailable reports. Otherwise a corrected event could remain
        // incorrectly marked as deleted for other users.
        item.manual_page_unavailable=false;
        delete item.manual_page_unavailable_reason;
        // The genre helper is deliberately narrow: don't guess based on snippets.
        if(/ワンピース|ONE\s*PIECE/i.test(override.event_title))item.review_category='onepiece';
        else if(/遊戯王|YU-GI-OH/i.test(override.event_title))item.review_category='yugioh';
        else if(/ポケモン|ポケカ|POKEMON/i.test(override.event_title))item.review_category='pokemon';
      }
      if(override?.resolution==='unavailable') {
        item.manual_page_unavailable=true;
        item.manual_page_unavailable_reason=override.reason;
      }else if(override?.resolution==='active'){
        item.manual_page_unavailable=false;
        delete item.manual_page_unavailable_reason;
      }
      // Preserve multi-store events: never collapse several branches to one.
      if(location && (!Array.isArray(base.stores)||base.stores.length<=1)){
        const name=typeof location.store_name==='string'?location.store_name.trim():'';
        const area=LP_MANUAL_AREAS.includes(location.prefecture)?location.prefecture:'';
        if(name)item.store_name=name;
        if(area)item.prefecture=area;
        if(Array.isArray(base.stores)&&base.stores.length===1){
          const entry={...base.stores[0]};
          if(name)entry.name=name;
          if(area)entry.prefecture=area;
          item.stores=[entry];
        }
      }
      return item;
    }).filter(Boolean);
    if($('lpPrefecture'))renderLotteryPrefectures();
    if($('lotteryView')?.classList.contains('active'))renderLottery();
    lpExtRenderAdmin();
  }

  async function lpCloudRefresh(force=false){
    if(!supabaseClient){
      lpCloudError='Supabase接続待ち';
      return false;
    }
    if(!force && lpCloudReady && Date.now()-lpCloudLastFetch<30000)return true;
    if(lpCloudLoading)return lpCloudLoading;
    lpCloudLoading=(async()=>{
      try{
        const {data,error}=await supabaseClient.from(LP_CLOUD_TABLE)
          .select('event_url,resolution,event_title,reason,evidence,updated_at')
          .limit(2000);
        if(error)throw error;
        lpCloudOverrides=new Map((data||[]).filter(x=>safeLotteryUrl(x.event_url))
          .map(x=>[x.event_url,x]));
        lpCloudReady=true;
        lpCloudError='';
        lpCloudLastFetch=Date.now();
        lpCloudApply();
        if(isDeveloper() && lpManualLoaded)lpManualRender();
        // Refresh the location management list when another device changes
        // the page status or the existing manual title correction.
        if(isDeveloper() && lpLocationListLoaded)lpLocationRender();
        return true;
      }catch(error){
        lpCloudReady=false;
        lpCloudError=error?.message||String(error);
        console.warn('抽選の手動修正情報を取得できません:',error);
        if(isDeveloper() && lpManualLoaded)lpManualRender();
        return false;
      }finally{lpCloudLoading=null;}
    })();
    return lpCloudLoading;
  }

  async function lpCloudSave(payload) {
    if(!isDeveloper()||!supabaseClient)throw Error('開発者のDiscordログインが必要です。');
    if(!lpCloudReady)throw Error('Supabaseの手動修正テーブルが利用できません。SQL設定を確認してください：'+lpCloudError);
    const {data,error}=await supabaseClient.from(LP_CLOUD_TABLE)
      .upsert(payload,{onConflict:'event_url'})
      .select('event_url,resolution,event_title,reason,evidence,updated_at')
      .single();
    if(error)throw Error(error.message);
    if(!data || data.event_url!==payload.event_url)throw Error('サーバーで保存が確認できませんでした');
    lpCloudOverrides.set(data.event_url,data);
    lpCloudLastFetch=0;
    lpCloudApply();
    if(isDeveloper() && lpManualLoaded)lpManualRender();
    return data;
  }

  async function lpCloudRemove(url) {
    if(!isDeveloper()||!supabaseClient||!lpCloudReady)throw Error('開発者権限・データベース接続を確認してください。');
    const {data,error}=await supabaseClient.from(LP_CLOUD_TABLE)
      .delete().eq('event_url',url).select('event_url');
    if(error)throw Error(error.message);
    if(!Array.isArray(data)||!data.some(row=>row.event_url===url))throw Error('対象の保存済み修正を削除できませんでした。');
    lpCloudOverrides.delete(url);
    lpCloudLastFetch=0;
    lpCloudApply();
    if(isDeveloper() && lpManualLoaded)lpManualRender();
  }

  // v21.48: Public location corrections; RLS protects developer-only writes.
  async function lpLocationRefresh(force=false){
    if(!supabaseClient){lpLocationError='Supabase接続待ち';return false;}
    if(!force&&lpLocationReady&&Date.now()-lpLocationLastFetch<30000)return true;
    if(lpLocationLoading)return lpLocationLoading;
    lpLocationLoading=(async()=>{
      try{
        const {data,error}=await supabaseClient.from(LP_LOCATION_TABLE)
          .select('event_url,store_name,prefecture,evidence,updated_at').limit(2000);
        if(error)throw error;
        lpLocationOverrides=new Map((data||[]).filter(x=>safeLotteryUrl(x.event_url))
          .map(x=>[x.event_url,x]));
        lpLocationReady=true;lpLocationError='';lpLocationLastFetch=Date.now();
        lpCloudApply();lpLocationRender();return true;
      }catch(error){
        lpLocationReady=false;lpLocationError=error?.message||String(error);
        console.warn('店舗・地域の修正データが取得できません:',error);
        lpLocationRender();return false;
      }finally{lpLocationLoading=null;}
    })();return lpLocationLoading;
  }
  async function lpLocationSave(row){
    if(!isDeveloper()||!supabaseClient||!lpLocationReady)
      throw Error('開発者ログインまたはクラウド接続を確認してください');
    const base=lotteryBaseItems.find(x=>x.url===row.event_url);
    if(!base||(Array.isArray(base.stores)&&base.stores.length>1))
      throw Error('複数店舗イベントは一括上書きできません');
    const {data,error}=await supabaseClient.from(LP_LOCATION_TABLE)
      .upsert(row,{onConflict:'event_url'})
      .select('event_url,store_name,prefecture,evidence,updated_at').single();
    if(error)throw Error(error.message);
    if(!data||data.event_url!==row.event_url)throw Error('保存を確認できませんでした');
    lpLocationOverrides.set(data.event_url,data);lpLocationLastFetch=0;
    lpCloudApply();lpLocationRender();
  }
  async function lpLocationRemove(url){
    if(!isDeveloper()||!supabaseClient||!lpLocationReady)
      throw Error('開発者ログインまたはクラウド接続を確認してください');
    const {data,error}=await supabaseClient.from(LP_LOCATION_TABLE)
      .delete().eq('event_url',url).select('event_url');
    if(error)throw Error(error.message);
    if(!Array.isArray(data)||!data.some(row=>row.event_url===url))
      throw Error('修正の解除を確認できませんでした');
    lpLocationOverrides.delete(url);lpLocationLastFetch=0;
    lpCloudApply();lpLocationRender();
  }

  async function loadLotteryEvents(force = false) {
    if (!force && lotteryItems.length && Date.now() - lotteryLastFetch < LP_REFRESH_MS) {
      renderLottery(); return;
    }
    if (lotteryLoading) return lotteryLoading;
    const button = $('lpRefresh');
    const status = $('lpLoadStatus');
    button.disabled = true;
    status.textContent = '抽選情報を取得しています…';
    lotteryLoading = (async () => {
      try {
        // Cache-busting query avoids older Pages/CDN/browser copies after a new commit.
        const response = await fetch(LP_JSON_URL + '?refresh=' + Date.now(), {cache:'no-store'});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (!data || !Array.isArray(data.items)) throw new Error('公開JSONの形式が正しくありません');
        // The LivePocket source remains authoritative for its own event URLs.
        // External links are metadata-only. Never crawl untrusted third-party URLs.
        let external=[],externalError='';
        try{
          const other=await fetch(LP_OTHER_JSON_URL+'?refresh='+Date.now(),{cache:'no-store'});
          if(!other.ok)throw Error('HTTP '+other.status);
          const more=await other.json();
          if(!more||!Array.isArray(more.items))throw Error('外部URLデータ形式不正');
          external=more.items.filter(x=>x&&safeLotteryUrl(x.url)&&
            !isLivePocketEventUrl(x.url));
        }catch(err){externalError=String(err?.message||err);}
        const seen=new Set(),clean=[];
        for(const item of [...data.items,...external]){
          if(!item||!safeLotteryUrl(item.url)||seen.has(item.url))continue;
          seen.add(item.url);
          clean.push(item);
        }
        lotteryBaseItems=clean;
        if(supabaseClient)await lpExtRefresh();
        lpCloudApply();
        lotteryLastFetch = Date.now();
        renderLotteryPrefectures();
        const update = data.updated_at || data.collected_at;
        const info = lotteryJapaneseDate(update);
        // JSON update time is not a proof that Actions has run recently.
        const viewedAt = new Intl.DateTimeFormat('ja-JP', {
          timeZone:'Asia/Tokyo', hour:'2-digit',minute:'2-digit',hour12:false
        }).format(new Date());
        const otherCount=clean.filter(x=>!isLivePocketEventUrl(x.url)).length;
        status.textContent = `取得済み ${clean.length}件（外部URL ${otherCount}件）`+
          (externalError?' ／ 外部URL取得失敗：'+externalError:'')+
          (info ? ` ／ LivePocket最終変更 ${info}（日本時間）` : '') +
          ` ／ 画面で最新データを取得 ${viewedAt}`;
        renderLottery();
        refreshLotteryOnsiteReports();
      } catch(error) {
        console.error('LivePocket取得エラー:',error);
        status.textContent = '抽選情報を読み込めませんでした。更新をお試しください：' + error.message +
          (lotteryItems.length ? '（最後に取得した一覧を表示中）' : '');
        renderLottery();
      } finally {
        button.disabled = false;
        lotteryLoading = null;
      }
    })();
    return lotteryLoading;
  }

  function lotteryStatusText(state, item) {
    if (state === 'unknown') return Number.isFinite(lotteryDate(item.application_end_at)) ? '受付状況未確認' : '応募期限未確認';
    return ({open:'受付中',upcoming:'開始前',closed:'受付終了',unavailable:'ページなし（手動確認）'})[state] || '応募状況未確認';
  }

  function lotteryCategoryText(value) {
    return ({pokemon:'ポケカ',onepiece:'ワンピース',yugioh:'遊戯王',unknown:'未分類'})[value] || value;
  }


  // v21.59: Human review for external sites with incompatible page structures.
  // These overlays do not mutate the GitHub-collected URLs or user histories.
  async function lpExtRefresh(force=false){
    if(!supabaseClient){lpExtError='Supabase接続待ち';lpExtRenderAdmin();return false;}
    if(!force&&lpExtReady&&Date.now()-lpExtLastFetch<30000)return true;
    if(lpExtLoading)return lpExtLoading;
    lpExtLoading=(async()=>{
      try{
        const {data,error}=await supabaseClient.from(LP_EXT_OVERRIDE_TABLE)
          .select('event_url,state,event_title,store_name,prefecture,review_category,product_type,application_start_at,application_end_at,exclusion_reason,updated_at')
          .limit(5000);
        if(error)throw error;
        lpExtOverrides=new Map((data||[]).filter(x=>safeLotteryUrl(x.event_url)&&
          !isLivePocketEventUrl(x.event_url)).map(x=>[x.event_url,x]));
        lpExtReady=true;lpExtError='';lpExtLastFetch=Date.now();
        lpCloudApply();
        return true;
      }catch(error){
        lpExtError=String(error?.message||error);
        console.warn('外部抽選の手動修正情報を取得できません:',error);
        lpExtRenderAdmin();
        return false;
      }finally{lpExtLoading=null;}
    })();
    return lpExtLoading;
  }

  // Developer refresh: fetch the currently published Discord URL catalog AND
  // the Supabase moderation state. Collection itself runs in GitHub Actions.
  let lpExtPublishedRefreshBusy=false;
  async function lpExtRefreshPublished(){
    const button=$('lpExtRefresh'),feedback=$('lpExtRefreshFeedback');
    if(!button||!feedback||!isDeveloper()||lpExtPublishedRefreshBusy)return false;
    lpExtPublishedRefreshBusy=true;
    const buttonLabel=button.textContent;
    button.disabled=true;
    button.textContent='取得中…';
    feedback.textContent='🔄 公開済みの外部URLと手動編集情報を取得しています…';
    try{
      // Wait for a concurrently running lottery feed load before replacing
      // its cache. Force a fresh network fetch rather than trusting the timer.
      if(lotteryLoading)await lotteryLoading;
      const response=await fetch(LP_OTHER_JSON_URL+'?refresh='+Date.now(),{cache:'no-store'});
      if(!response.ok)throw Error('外部URL一覧 HTTP '+response.status);
      const data=await response.json();
      if(!data||!Array.isArray(data.items))
        throw Error('外部URL一覧のデータ形式が不正です');
      const fresh=new Map();
      for(const item of data.items){
        if(!item||!safeLotteryUrl(item.url)||isLivePocketEventUrl(item.url))continue;
        if(!fresh.has(item.url))fresh.set(item.url,item);
      }
      const old=new Set(lotteryBaseItems.filter(item=>
        item&&!isLivePocketEventUrl(item.url)).map(item=>item.url));
      const updated=await lpExtRefresh(true);
      if(!updated)throw Error(lpExtError||'Supabaseの編集情報を取得できません');
      // Preserve all existing LivePocket entries and their separate overlays.
      lotteryBaseItems=[
        ...lotteryBaseItems.filter(item=>item&&isLivePocketEventUrl(item.url)),
        ...fresh.values()
      ];
      lpCloudApply();
      const additions=[...fresh.keys()].filter(url=>!old.has(url)).length;
      const removed=[...old].filter(url=>!fresh.has(url)).length;
      const stamp=new Intl.DateTimeFormat('ja-JP',{
        timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit',
        hour12:false
      }).format(new Date());
      const publishedAt=lotteryJapaneseDate(data.collected_at);
      feedback.textContent='✅ '+stamp+' に取得完了：外部URL '+fresh.size+
        '件 ／ 新規 '+additions+'件 ／ 公開一覧から消えたURL '+removed+'件'+
        (publishedAt?' ／ Discord最終収集 '+publishedAt+'（日本時間）':'')+
        '。データが変わっていなくても再取得済みです。';
      return true;
    }catch(error){
      feedback.textContent='⚠ 取得失敗：'+String(error?.message||error)+
        '。現在の一覧は変更していません。';
      console.warn('外部抽選の最新情報を取得できません:',error);
      return false;
    }finally{
      lpExtPublishedRefreshBusy=false;
      button.disabled=false;
      button.textContent=buttonLabel;
    }
  }

  function lpExtDateInput(iso){
    const ms=Date.parse(iso||'');
    if(!Number.isFinite(ms))return '';
    return new Intl.DateTimeFormat('sv-SE',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',hour12:false
    }).format(new Date(ms)).replace(' ','T');
  }

  function lpExtDateSave(value){
    if(!value)return null;
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
      throw Error('応募日時の入力形式を確認してください。');
    const date=new Date(value+':00+09:00');
    if(!Number.isFinite(date.getTime()))throw Error('応募日時が正しくありません。');
    if(lpExtDateInput(date.toISOString())!==value)
      throw Error('存在しない日時が入力されています。');
    return date.toISOString();
  }

  function lpExtFormRow(){
    const form=$('lpExtForm'),url=lpExtEditing;
    if(!form||!url||!safeLotteryUrl(url)||isLivePocketEventUrl(url))
      throw Error('外部抽選URLが不正です。');
    const val=name=>String(form.elements.namedItem(name)?.value||'').trim();
    const title=val('event_title'),store=val('store_name'),area=val('prefecture'),
      category=val('review_category'),type=val('product_type'),reason=val('exclusion_reason');
    if(title.length>200||store.length>200||reason.length>300)
      throw Error('入力した文字数が上限を超えています。');
    if(area&&!LP_MANUAL_AREAS.includes(area))throw Error('都道府県を確認してください。');
    if(!['pokemon','onepiece','yugioh','unknown'].includes(category)||
       !['unknown','pack','deck'].includes(type))throw Error('ジャンル・商品区分が不正です。');
    const start=lpExtDateSave(val('application_start_at')),
      end=lpExtDateSave(val('application_end_at'));
    if(start&&end&&Date.parse(start)>Date.parse(end))
      throw Error('応募開始日時は締切日時より前にしてください。');
    return {event_url:url,event_title:title||null,store_name:store||null,
      prefecture:area||null,review_category:category,product_type:type,
      application_start_at:start,application_end_at:end,exclusion_reason:reason||null};
  }

  function lpExtRenderAdmin(){
    const root=$('lpExtManage'),list=$('lpExtManageList'),status=$('lpExtManageStatus');
    if(!root||!list||!status)return;
    root.hidden=!isDeveloper();
    if(!isDeveloper())return;
    // Keep sections the user expanded open across saves and background refreshes.
    const editedOpen=$('lpExtEdited')?.open===true;
    const excludedOpen=$('lpExtExcluded')?.open===true;
    const input=String($('lpExtSearch')?.value||'').trim().toLocaleLowerCase('ja-JP');
    const candidates=new Map(lotteryBaseItems.filter(x=>x&&!isLivePocketEventUrl(x.url))
      .map(x=>[x.url,x]));
    for(const [url,row] of lpExtOverrides)
      if(!candidates.has(url))candidates.set(url,{
        url,source_site:'以前の収集URL',event_title:row.event_title||'',store_name:row.store_name||''
      });
    const all=[...candidates.values()];
    const matched=all.filter(item=>{
      if(!input)return true;
      const row=lpExtOverrides.get(item.url);
      return [item.url,item.event_title,item.store_name,item.source_site,
        row?.event_title,row?.store_name,row?.prefecture,row?.exclusion_reason]
        .filter(Boolean).join(' ').toLocaleLowerCase('ja-JP').includes(input);
    }).sort((a,b)=>(lotteryFirstSeenTime(b)||0)-(lotteryFirstSeenTime(a)||0));
    const pending=matched.filter(item=>!lpExtOverrides.has(item.url));
    const edited=matched.filter(item=>{
      const row=lpExtOverrides.get(item.url);
      return row&&row.state!=='excluded';
    });
    const excluded=matched.filter(item=>lpExtOverrides.get(item.url)?.state==='excluded');
    const totalExcluded=all.filter(item=>lpExtOverrides.get(item.url)?.state==='excluded').length;
    const totalEdited=all.filter(item=>{
      const row=lpExtOverrides.get(item.url);
      return row&&row.state!=='excluded';
    }).length;
    status.textContent=(lpExtError?'⚠ 保存先：'+lpExtError+' ／ ':'')+
      '未編集 '+(all.length-totalEdited-totalExcluded)+'件 ／ 編集済み '+totalEdited+
      '件 ／ 除外済み '+totalExcluded+'件'+
      (input?' ／ 検索結果 '+matched.length+'件':'');
    function card(item){
      const row=lpExtOverrides.get(item.url);
      const hidden=row?.state==='excluded';
      const title=row?.event_title||item.event_title||item.source_site||'イベント名未確認';
      return '<div class="lp-ext-admin-row">'+
        '<div><strong>'+escape(title)+'</strong>'+
          '<p>'+escape(item.url)+'</p>'+
          (hidden?'<strong class="lp-ext-excluded">🚫 一覧から除外中</strong>':
            row?'<small>✏ 手動修正あり</small>':'<small>未確認</small>')+
          (row?.exclusion_reason?'<p>理由：'+escape(row.exclusion_reason)+'</p>':'')+
        '</div><button type="button" data-lp-ext-edit="'+escape(item.url)+'">'+
          (hidden?'編集・復元':'編集・除外')+'</button></div>';
    }
    list.innerHTML=
      '<section class="lp-ext-unchecked" aria-label="未編集の外部URL">'+
        '<h4>📝 未編集 <span>'+pending.length+'件</span></h4>'+
        (pending.length?pending.slice(0,lpExtListLimit).map(card).join(''):
          '<p class="hint">未編集の外部URLはありません。</p>')+
      '</section>'+
      '<details id="lpExtEdited" class="lp-ext-fold"'+
        ((editedOpen||!!input)&&edited.length?' open':'')+'>'+
        '<summary>✅ 編集済み <span>'+edited.length+'件</span></summary>'+
        '<div class="lp-ext-fold-content">'+
          (edited.length?edited.slice(0,lpExtListLimit).map(card).join(''):
            '<p class="hint">編集済みの外部URLはありません。</p>')+
        '</div>'+
      '</details>'+
      '<details id="lpExtExcluded" class="lp-ext-fold"'+
        ((excludedOpen||!!input)&&excluded.length?' open':'')+'>'+
        '<summary>🚫 除外済み <span>'+excluded.length+'件</span></summary>'+
        '<div class="lp-ext-fold-content">'+
          (excluded.length?excluded.slice(0,lpExtListLimit).map(card).join(''):
            '<p class="hint">除外済みの外部URLはありません。</p>')+
        '</div>'+
      '</details>';
    const more=$('lpExtMore');
    if(more)more.hidden=[pending,edited,excluded].every(items=>items.length<=lpExtListLimit);
  }

  function lpExtOpen(url){
    if(!isDeveloper()||!safeLotteryUrl(url)||isLivePocketEventUrl(url))return;
    const base=lotteryBaseItems.find(x=>x.url===url);
    const row=lpExtOverrides.get(url);
    if(!base&&!row)return;
    if(!lpExtReady){
      alert('手動修正の保存先を取得できていません。再読み込みしてください。'+lpExtError);
      return;
    }
    lpExtEditing=url;
    const form=$('lpExtForm'),dialog=$('lpExtDialog');
    if(!form||!dialog)return;
    form.reset();
    const sourceLink=$('lpExtEditingUrl');
    sourceLink.href=url;
    sourceLink.textContent='🔗 元の抽選ページを開く ↗\n'+url;
    const set=(name,value)=>{form.elements.namedItem(name).value=value||'';};
    set('event_title',row?row.event_title:(base?.event_title_provisional?'':base?.event_title));
    set('store_name',row?row.store_name:base?.store_name);
    set('prefecture',row?row.prefecture:base?.prefecture);
    set('review_category',row?.review_category||base?.review_category||'unknown');
    set('product_type',row?.product_type||base?.pokemon_map_type||'unknown');
    set('application_start_at',lpExtDateInput(row?row.application_start_at:base?.application_start_at));
    set('application_end_at',lpExtDateInput(row?row.application_end_at:base?.application_end_at));
    set('exclusion_reason',row?.exclusion_reason);
    $('lpExtDelete').hidden=row?.state==='excluded';
    $('lpExtRestore').hidden=row?.state!=='excluded';
    $('lpExtReset').hidden=!row;
    $('lpExtEditorStatus').textContent=row?.state==='excluded'
      ? '🚫 除外済みです。編集して保存しても「復元」を押すまで非表示のままです。'
      : '確認できた情報だけを入力してください。未確認の項目は空欄にできます。';
    dialog.showModal();
    // Focus a non-editable heading: iOS must not open its keyboard automatically.
    $('lpExtDialogTitle')?.focus({preventScroll:true});
  }

  async function lpExtWrite(mode){
    if(!isDeveloper()||lpExtBusy||!supabaseClient||!lpExtReady)return;
    const message=$('lpExtEditorStatus');
    let payload;
    try{payload=lpExtFormRow();}
    catch(error){message.textContent='⚠ '+(error.message||error);return;}
    const old=lpExtOverrides.get(payload.event_url);
    if(mode==='exclude'){
      if(!confirm('このURLを全ユーザーの抽選一覧から除外しますか？ 再収集されても復活せず、あとで復元できます。'))return;
    }else if(mode==='reset'){
      if(!old)return;
      if(!confirm('このURLの手動修正と除外状態を解除しますか？ 再収集データの表示に戻ります。'))return;
    }
    lpExtBusy=true;
    const buttons=[...$('lpExtForm').querySelectorAll('button')];
    buttons.forEach(x=>x.disabled=true);
    message.textContent='🔄 Supabaseに保存しています…';
    try{
      const url=payload.event_url;
      if(mode==='reset'){
        const {data,error}=await supabaseClient.from(LP_EXT_OVERRIDE_TABLE)
          .delete().eq('event_url',url).select('event_url');
        if(error)throw error;
        if(!Array.isArray(data)||!data.some(x=>x.event_url===url))
          throw Error('手動修正の解除が確認できませんでした');
        lpExtOverrides.delete(url);
      }else{
        payload.state=mode==='exclude'?'excluded':
          mode==='restore'?'active':old?.state||'active';
        payload.exclusion_reason=payload.state==='excluded'
          ?payload.exclusion_reason||old?.exclusion_reason||null:null;
        const {data,error}=await supabaseClient.from(LP_EXT_OVERRIDE_TABLE)
          .upsert(payload,{onConflict:'event_url'})
          .select('event_url,state,event_title,store_name,prefecture,review_category,product_type,application_start_at,application_end_at,exclusion_reason,updated_at').single();
        if(error)throw error;
        if(!data||data.event_url!==url||data.state!==payload.state)
          throw Error('保存結果が確認できませんでした');
        lpExtOverrides.set(url,data);
      }
      lpExtLastFetch=Date.now();
      $('lpExtDialog').close();
      lpCloudApply();
      $('lpExtManageStatus').textContent='✅ 保存しました。ほかの利用者にも反映されます。';
    }catch(error){
      message.textContent='⚠ 保存に失敗しました：'+(error?.message||error);
    }finally{
      lpExtBusy=false;
      buttons.forEach(x=>x.disabled=false);
    }
  }

  function lpExtInitUI(){
    const root=$('lpExtManage'),dialog=$('lpExtDialog');
    if(!root||!dialog)return;
    $('lpExtPrefecture').innerHTML='<option value="">未確認</option>'+
      LP_MANUAL_AREAS.map(x=>'<option value="'+escape(x)+'">'+escape(x)+'</option>').join('');
    $('lpExtSearch').addEventListener('input',()=>{lpExtListLimit=80;lpExtRenderAdmin();});
    $('lpExtMore').addEventListener('click',()=>{lpExtListLimit+=80;lpExtRenderAdmin();});
    $('lpExtRefresh').addEventListener('click',lpExtRefreshPublished);
    $('lpExtManageList').addEventListener('click',event=>{
      const target=event.target.closest('button[data-lp-ext-edit]');
      if(target)lpExtOpen(target.dataset.lpExtEdit);
    });
    $('lotteryView').addEventListener('click',event=>{
      const target=event.target.closest('button[data-lp-ext-edit]');
      if(target)lpExtOpen(target.dataset.lpExtEdit);
    });
    $('lpExtForm').addEventListener('submit',event=>{
      event.preventDefault();lpExtWrite('save');
    });
    $('lpExtDelete').addEventListener('click',()=>lpExtWrite('exclude'));
    $('lpExtRestore').addEventListener('click',()=>lpExtWrite('restore'));
    $('lpExtReset').addEventListener('click',()=>lpExtWrite('reset'));
    $('lpExtCancel').addEventListener('click',()=>dialog.close());
    lpExtRenderAdmin();
  }

  function lotteryCard(item, state) {
    const stores = lotteryStoreEntries(item);
    const places = lotteryPrefectures(item);
    // Once the exact-URL official title is verified, show it as the primary
    // heading even if an older Discord snippet remains in product_name.
    const officialName = item.official_event_title && item.official_event_title === item.event_title
      ? String(item.event_title).trim() : '';
    const trustedTitle = item.event_title_provisional ? '' : item.event_title;
    const reliableName = (officialName || item.product_name || trustedTitle || '').trim();
    // Discord excerpt is a discovery hint only, not an authoritative heading.
    const external=!isLivePocketEventUrl(item.url);
    const label = reliableName || (external?'外部サイト・抽選内容未確認':'商品名・イベント名を確認中');
    const typ = lotteryProductType(item);
    const kind = typ === 'pack' ? '拡張パック' : typ === 'deck' ? '構築デッキ' : typ === 'pack/deck' ? '商品区分が複数候補' : '';
    const when = item.application_end_at && Number.isFinite(lotteryDate(item.application_end_at))
      ? lotteryJapaneseDate(item.application_end_at) + ' 締切' : '応募締切：未確認';
    const start = Number.isFinite(lotteryDate(item.application_start_at)) ? lotteryJapaneseDate(item.application_start_at) : '';
    let countdown = '';
    if (state === 'open') {
      const minutes = Math.max(0, Math.floor((lotteryDate(item.application_end_at) - Date.now()) / 60000));
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      countdown = days ? ` ／ 残り${days}日${hours}時間` : ` ／ 残り${hours}時間${minutes % 60}分`;
    }
    const placeText = places.length ? places.join('・') : '都道府県未確認';
    const genre = lotteryGenre(item);
    const list = stores.length ? `
      <details class="lp-store-details">
        <summary>対象店舗 ${stores.length}件（${escape(placeText)}）</summary>
        <ul>${stores.map(x => `<li>${escape(x.name)} <small>（${escape(x.prefecture || '都道府県未確認')}）</small></li>`).join('')}</ul>
      </details>` : `<p class="lp-store-muted">対象店舗：未確認${places.length ? `（地域：${escape(placeText)}）` : ""}</p>`;
    return `<article class="lp-card ${state === 'closed' || state === 'unavailable' ? 'lp-closed' : ''}">
      <div class="lp-badges"><span class="lp-status lp-${state}">${lotteryStatusText(state,item)}</span>
        ${lotteryIsNew(item) ? '<span class="lp-new-badge" aria-label="新着：初回登録から24時間以内">NEW</span>' : ''}
        <span class="lp-tag">${escape(lotteryCategoryText(genre))}</span>
        <span class="lp-tag">${escape(lotterySite(item))}</span>
        ${kind ? `<span class="lp-tag">${kind}</span>` : ''}
      </div>
      <h3 class="lp-full-title">${escape(label)}</h3>
      ${external?'<p class="lp-store-muted">Discord共有URLです。抽選ページかどうか、応募期間や店舗・当落条件を確認してください。未確認の項目は推測しません。</p>':''}
      ${state === 'unavailable' ? '<p class="lp-missing-notice">⚠ 公式ページが見つからない・削除済みとの手動確認記録があります。現在の公開状態は再確認してください。イベント履歴は保持しています。</p>' : ''}
      ${!officialName && item.product_name && trustedTitle && item.product_name !== trustedTitle ? `<p class="lp-sub">${escape(trustedTitle)}</p>` : ''}
      ${item.pokemon_map_match ? `<p class="lp-match">発見マップ商品マスタ一致：${escape(item.pokemon_map_match)}</p>` : ''}
      <p class="lp-deadline">${escape(when)}${escape(countdown)}${start ? `<small>応募開始：${escape(start)}</small>` : ''}</p>
      ${list}
      ${lotteryOnsiteSharedHtml(item.url)}
      <a class="lp-official" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${external?'抽選URLを開いて確認 ↗':'公式ページで確認 ↗'}</a>
      ${lotteryTrackerActionsHtml(item)}
      ${external&&isDeveloper()? `<div class="lp-external-dev-actions"><button type="button" data-lp-ext-edit="${escape(item.url)}">🛠 外部抽選を編集・除外</button></div>`:''}
    </article>`;
  }

  // v21.54: Newest means the first URL registration time (not a repost).
  // Historical URLs without first_detected_at fall back to Discord post time.
  function lotteryFirstSeenTime(item) {
    const first = lotteryDate(item.first_detected_at);
    if (Number.isFinite(first)) return first;
    const posted = lotteryDate(item.discord_posted_at);
    return Number.isFinite(posted) ? posted : 0;
  }

  function lotterySortCards(cards, order = 'newest', now = Date.now()) {
    const priority = {open:0,upcoming:1,unknown:2,closed:3,unavailable:4};
    cards.sort((a,b) => {
      if (order === 'status') {
        // Keep the original status/deadline sort as an optional view.
        const sa=lotteryState(a,now), sb=lotteryState(b,now);
        if(sa!==sb) return priority[sa]-priority[sb];
        if(sa==='open'||sa==='upcoming'){
          const ea=lotteryDate(a.application_end_at), eb=lotteryDate(b.application_end_at);
          if(Number.isFinite(ea)&&Number.isFinite(eb)&&ea!==eb)return ea-eb;
        }
      }
      const newest=lotteryFirstSeenTime(b)-lotteryFirstSeenTime(a);
      if(newest)return newest;
      return String(a.url||'').localeCompare(String(b.url||''));
    });
    return cards;
  }

  function renderLottery() {
    if (!$('lpCards')) return;
    const now = Date.now();
    const query = productNorm($('lpQuery').value);
    const genre = $('lpGenre').value;
    const prefecture = $('lpPrefecture').value;
    const status = $('lpStatus').value;
    const type = $('lpType').value;
    const site = $('lpSite').value;
    const wishlistOnly = $('lpWishlistOnly').checked;
    const visible = lotteryItems.filter(item => {
      if(site==='external'&&isLivePocketEventUrl(item.url))return false;
      if(site==='livepocket'&&!isLivePocketEventUrl(item.url))return false;
      if (genre !== 'all' && lotteryGenre(item) !== genre) return false;
      if (prefecture === 'unknown' && lotteryPrefectures(item).length) return false;
      if (prefecture !== 'all' && prefecture !== 'unknown') {
        const areas=lotteryPrefectures(item);
        if(!areas.includes(prefecture)&&!areas.includes(LP_NATIONWIDE))return false;
      }
      if (status !== 'all' && lotteryState(item, now) !== status) return false;
      if (type !== 'all' && !(type === 'unknown' ? lotteryProductType(item) === 'unknown' : lotteryProductType(item).split('/').includes(type))) return false;
      if (wishlistOnly && !lotteryMatchedWishlist(item)) return false;
      if (query) {
        const text = [item.product_name,item.event_title_provisional ? '' : item.event_title,item.source_preview,item.store_name,
          item.pokemon_map_match,...lotteryStoreEntries(item).map(s => s.name)]
          .filter(Boolean).join(' ');
        if (!productNorm(text).includes(query)) return false;
      }
      return true;
    });
    lotterySortCards(visible, $('lpSort').value, now);
    const pokemonCount = lotteryItems.filter(x => lotteryGenre(x) === 'pokemon').length;
    const knownCount = lotteryItems.filter(x => Number.isFinite(lotteryDate(x.application_end_at))).length;
    const openCount = lotteryItems.filter(x => lotteryState(x,now) === 'open').length;
    const externalCount=lotteryItems.filter(x=>!isLivePocketEventUrl(x.url)).length;
    $('lpSummary').innerHTML = `<span>全イベント <strong>${lotteryItems.length}</strong>件</span>
      <span>外部URL <strong>${externalCount}</strong>件</span>
      <span>ポケカ <strong>${pokemonCount}</strong>件</span>
      <span>締切確認済み <strong>${knownCount}</strong>件</span>
      <span>受付中（確認済み） <strong>${openCount}</strong>件</span>`;
    $('lpResultCount').textContent = `検索結果：${visible.length}件` +
      (visible.length > lotteryVisibleLimit ? `（${lotteryVisibleLimit}件まで表示中）` : '');
    $('lpCards').innerHTML = visible.length ? visible.slice(0,lotteryVisibleLimit)
      .map(x => lotteryCard(x, lotteryState(x,now))).join('') :
      '<p class="lp-empty">該当する抽選イベントがありません。ジャンルや応募状況を変更してみてください。</p>';
    const more = $('lpMore');
    more.hidden = visible.length <= lotteryVisibleLimit;
    more.textContent = `さらに${Math.min(LP_PAGE_SIZE,visible.length-lotteryVisibleLimit)}件表示`;
    renderLotteryTrackerSummary();
  }

  function initLottery() {
    ensureLotteryNewBadgeStyle();
    ensureLotteryTrackerUI();
    lpExtInitUI();
    $('lpOnsiteArchiveSearch')?.addEventListener('input',()=>{
      lotteryOnsiteArchiveLimit=40;renderLotteryOnsiteArchive();
    });
    $('lpOnsiteArchiveMore')?.addEventListener('click',()=>{
      lotteryOnsiteArchiveLimit+=40;renderLotteryOnsiteArchive();
    });
    $('lpOnsiteArchiveRefresh')?.addEventListener('click',()=>refreshLotteryOnsiteArchive(true));
    renderLotteryOnsiteArchive();
    $('lotteryView').addEventListener('click', lotteryTrackerHandleClick);
    // v21.29: The personal-management list lives in a separate view now.
    // Its '管理' buttons need their own delegated click listener.
    $('lotteryManageView').addEventListener('click', lotteryTrackerHandleClick);
    $('lotteryView').addEventListener('click', lotteryOnsiteHandleClick);
    // 初期表示はジャンル全件・日時確認済みの受付中のみ。
    $('lpGenre').value = 'all';
    $('lpStatus').value = 'open';
    $('lpSort').value = 'newest';
    $('lpSite').value = 'all';
    for (const id of ['lpQuery','lpGenre','lpPrefecture','lpStatus','lpType','lpSort','lpSite','lpWishlistOnly']) {
      $(id).addEventListener(id === 'lpQuery' ? 'input' : 'change', () => {
        lotteryVisibleLimit = LP_PAGE_SIZE;
        renderLottery();
      });
    }
    $('lpRefresh').addEventListener('click',() => loadLotteryEvents(true));
    $('lpMore').addEventListener('click',() => {lotteryVisibleLimit += LP_PAGE_SIZE;renderLottery();});
    $('lpClearFilters').addEventListener('click',() => {
      $('lpQuery').value = '';
      $('lpGenre').value = 'all';
      $('lpPrefecture').value = 'all';
      $('lpStatus').value = 'open';
      $('lpType').value = 'all';
      $('lpSort').value = 'newest';
      $('lpSite').value = 'all';
      $('lpWishlistOnly').checked = false;
      lotteryVisibleLimit = LP_PAGE_SIZE;
      renderLottery();
    });
    fillLotteryProductSuggestions();
    updateLotteryWishlistControl();
    lotteryTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && $('lotteryView').classList.contains('active')) {
        loadLotteryEvents();
      }
    }, LP_REFRESH_MS);
    lotteryCountdownTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if ($('lotteryView').classList.contains('active')) renderLottery();
      if ($('lotteryManageView').classList.contains('active')) renderLotteryTrackerSummary();
      if ($('lotteryView').classList.contains('active') ||
          $('lotteryManageView').classList.contains('active')) {
        lpCloudRefresh();
      }
      if ($('lotteryView').classList.contains('active') ||
          $('lotteryManageView').classList.contains('active') ||
          (isDeveloper() && $('devView').classList.contains('active'))) {
        // Other users pick up saved event corrections without reloading the app.
        lpCloudRefresh();
        lpLocationRefresh();
        lpExtRefresh();
      }
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if ($('lotteryView').classList.contains('active')) {loadLotteryEvents();lpLocationRefresh(true);}
      if ($('lotteryManageView').classList.contains('active')) renderLotteryTrackerSummary();
      if ($('lotteryView').classList.contains('active')) refreshLotteryOnsiteArchive(true);
    });
  }


  // ========================================
  // v21.27: Each Discord account privately manages its own lottery progress.
  // This data is NEVER added to public LivePocket JSON, reports or Discord.
  // Supabase RLS enforces user_id=auth.uid() for every operation.
  // ========================================
  const LP_TRACK_TABLE = 'lottery_user_entries';
  const LP_EXT_TRACK_TABLE = 'lottery_external_user_entries';
  function lotteryTrackTableFor(url){
    return isLivePocketEventUrl(url)?LP_TRACK_TABLE:LP_EXT_TRACK_TABLE;
  }
  const LP_TRACK_STATUSES = ['not_applied','applied','won','lost','received'];
  const LP_TRACK_LABELS = {
    not_applied:'未応募', applied:'応募済み', won:'当選・受取待ち',
    lost:'落選', received:'受取済み'
  };
  // v21.37: Group the private management list by current application status.
  const LP_TRACK_GROUPS = [
    ['applied','✉️'], ['won','🎉'], ['lost','📪'],
    ['received','✅'], ['not_applied','◻️']
  ];
  let lotteryTrackRecords = new Map();
  let lotteryTrackUserId = '';
  let lotteryTrackSequence = 0;
  let lotteryTrackLastLoad = 0;
  let lotteryTrackFetching = null;
  let lotteryTrackSaving = false;
  let lotteryTrackFilter = 'all';
  // v21.47: lost entries start folded; preserve the visitor's choice.
  let lotteryLostGroupExpanded = false;
  let lotteryTrackError = '';

  function lotteryTrackCss() {
    if ($('lpTrackerStyle')) return;
    const sheet = document.createElement('style');
    sheet.id = 'lpTrackerStyle';
    sheet.textContent = `
      /* v21.28: 6 tabs for regular users, 7 for developers. */
      nav:has(button[data-tab="lotteryManage"]){grid-template-columns:repeat(6,minmax(0,1fr))}
      nav:has(button[data-tab="lotteryManage"]):has(button[data-tab="dev"]:not([hidden])){grid-template-columns:repeat(7,minmax(0,1fr))}
      nav button[data-tab="lotteryManage"]{font-size:20px}
      nav button[data-tab="lotteryManage"] span{font-size:10px}
      #lotteryManageView{padding-bottom:25px;color:var(--app-text,#172033)}
      #lotteryManageView>h2{margin:3px 0 10px}
      #lotteryManageView>.hint{color:var(--app-muted,#64748b)}
      #lpTrackerPanel{padding:14px;margin:14px 0;border:1px solid var(--app-border,#cbd5e1);border-radius:16px;background:var(--app-surface,#fff);color:var(--app-text,#172033)}
      #lpTrackerPanel h3{margin:0 0 8px;font-size:16px}
      #lpTrackerPanel .lp-tracker-intro{font-size:12px;line-height:1.65;color:var(--app-muted,#64748b);margin:5px 0 10px}
      .lp-track-counts{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}
      .lp-track-counts span{padding:5px 8px;border-radius:9px;border:1px solid var(--app-border,#cbd5e1);font-size:12px;background:var(--app-surface2,#f8fafc)}
      .lp-track-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}

      /* v21.39: Local in-app alerts for approaching pickup dates (not push). */
      .lp-pickup-alerts{display:grid;gap:10px;margin:14px 0 17px;padding:13px;
        border:2px solid #eab308;border-radius:14px;background:#fffbeb;color:#713f12}
      .lp-pickup-alerts[hidden]{display:none!important}
      .lp-pickup-alert-head{display:flex;align-items:center;justify-content:space-between;
        gap:8px;flex-wrap:wrap}
      .lp-pickup-alert-head h4{margin:0;font-size:15px;font-weight:800;color:inherit}
      .lp-pickup-alert-count{border:1px solid #ca8a04;border-radius:999px;
        padding:3px 10px;font-weight:800;font-size:12px}
      .lp-pickup-alert-row{display:flex;align-items:flex-start;justify-content:space-between;
        gap:10px;padding:10px;border:1px solid #facc15;border-radius:10px;
        background:#fffef5}
      .lp-pickup-alert-row>div{flex:1;min-width:0}
      .lp-pickup-alert-row strong{display:block;font-size:13px;line-height:1.5;
        overflow-wrap:anywhere;color:#422006}
      .lp-pickup-alert-row p{margin:5px 0 0;font-size:12px;font-weight:800;color:#854d0e}
      .lp-pickup-alert-row.urgent{border-color:#fca5a5;background:#fff1f2}
      .lp-pickup-alert-row.urgent p{color:#9f1239}
      .lp-pickup-alert-row button{flex-shrink:0;min-height:39px;
        padding:7px 10px;border:1px solid #d97706;border-radius:9px;
        background:#fff;color:#78350f;font-size:12px;font-weight:800}
      .lp-pickup-alerts .lp-pickup-alert-help{font-size:11px;line-height:1.55;
        margin:0;color:#713f12}
      html[data-theme="dark"] .lp-pickup-alerts{
        background:#332715!important;color:#fde68a!important;border-color:#b58927!important}
      html[data-theme="dark"] .lp-pickup-alert-row{
        background:#3b2d1a!important;border-color:#a16207!important}
      html[data-theme="dark"] .lp-pickup-alert-row.urgent{
        background:#44212c!important;border-color:#e87979!important}
      html[data-theme="dark"] .lp-pickup-alert-row strong{
        color:#fff5dd!important}
      html[data-theme="dark"] .lp-pickup-alert-row p,
      html[data-theme="dark"] .lp-pickup-alerts .lp-pickup-alert-help{
        color:#fde68a!important}
      html[data-theme="dark"] .lp-pickup-alert-row.urgent p{color:#fecdd3!important}
      html[data-theme="dark"] .lp-pickup-alert-row button{
        background:#4c3821!important;color:#fff3d6!important;border-color:#b58927!important}

      .lp-track-toolbar label{font-size:12px;font-weight:700}
      #lpTrackFilter{font-size:13px;min-height:38px;max-width:200px;color:var(--app-text,#172033);background:var(--app-surface2,#fff);border:1px solid var(--app-border,#cbd5e1)}
      #lpTrackReload{min-height:38px;font-size:12px}
      /* Clear, separated sections for each application status. */
      .lp-track-group{--lp-group-accent:#94a3b8;margin:17px 0 0;padding:0 12px 9px;
        border:1px solid var(--app-border,#cbd5e1);border-top:3px solid var(--lp-group-accent);
        border-radius:12px;background:var(--app-surface2,#f8fafc);color:var(--app-text,#172033)}
      .lp-track-group[data-status="applied"]{--lp-group-accent:#60a5fa}
      .lp-track-group[data-status="won"]{--lp-group-accent:#34d399}
      .lp-track-group[data-status="lost"]{--lp-group-accent:#fb923c}
      .lp-track-group[data-status="received"]{--lp-group-accent:#a78bfa}
      .lp-track-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
        margin:0!important;padding:12px 0 9px;font-size:15px!important;font-weight:800;
        color:var(--app-text,#172033)!important;line-height:1.45}
      .lp-track-group-count{flex-shrink:0;padding:3px 9px;border-radius:999px;font-size:12px;
        background:var(--app-surface,#fff);border:1px solid var(--app-border,#cbd5e1)}
      /* v21.47: Only the lost group is collapsible; count stays visible. */
      .lp-track-lost-fold>summary{list-style:none;cursor:pointer;touch-action:manipulation;
        -webkit-tap-highlight-color:transparent}
      .lp-track-lost-fold>summary::-webkit-details-marker{display:none}
      .lp-track-lost-fold>summary::marker{content:""}
      .lp-track-lost-meta{display:flex;align-items:center;gap:12px;flex-shrink:0}
      .lp-track-lost-chevron{display:block;width:9px;height:9px;flex-shrink:0;
        border-right:2px solid currentColor;border-bottom:2px solid currentColor;
        transform:rotate(45deg);transition:transform .2s ease;margin:0 6px 4px 2px}
      .lp-track-lost-fold[open] .lp-track-lost-chevron{
        transform:rotate(225deg);margin:5px 6px 0 2px}
      .lp-track-lost-fold>summary:focus-visible{
        outline:2px solid var(--app-accent,#2563eb);outline-offset:2px;border-radius:5px}
      .lp-track-row{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--app-border,#dbe3ed)}
      .lp-track-row>div{min-width:0;flex:1}
      .lp-track-row strong{display:block;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
      .lp-track-row p{margin:4px 0;font-size:12px;color:var(--app-muted,#64748b);line-height:1.5}
      .lp-track-row button{flex-shrink:0;min-height:38px;font-size:12px}
      /* v21.38: Pickup date and deadline countdown in the won section. */
      .lp-pickup-details{display:grid;gap:6px;margin:10px 0 11px;padding:10px;
        border:1px solid var(--app-border,#cbd5e1);border-radius:10px;
        background:var(--app-surface,#fff);color:var(--app-text,#172033)}
      .lp-pickup-date-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 10px;
        font-size:12px;line-height:1.55}
      .lp-pickup-date-line>span{min-width:64px;font-weight:700;color:var(--app-muted,#64748b)}
      .lp-pickup-date-line>strong{display:inline;font-size:13px;font-weight:800;
        color:var(--app-text,#172033)}
      .lp-pickup-remaining{margin:3px 0 0!important;padding:8px 10px;
        border:1px solid #93c5fd;border-radius:9px;background:#eff6ff;
        color:#1d4ed8!important;font-size:14px!important;font-weight:800;
        line-height:1.5!important}
      .lp-pickup-remaining.soon,.lp-pickup-remaining.today,
      .lp-pickup-remaining.overdue{background:#fff1e6;border-color:#fbbf24;
        color:#9a3412!important}
      .lp-pickup-remaining.unregistered{background:var(--app-surface2,#f1f5f9);
        border-color:var(--app-border,#cbd5e1);color:var(--app-text,#172033)!important}
      .lp-pickup-help{margin:1px 0 0!important;font-size:10px!important;
        font-weight:500;line-height:1.5!important;color:var(--app-muted,#64748b)!important}
      html[data-theme="dark"] .lp-pickup-details{background:#172337!important}
      html[data-theme="dark"] .lp-pickup-remaining{background:#17375d;
        color:#dbeafe!important;border-color:#4c82ca}
      html[data-theme="dark"] .lp-pickup-remaining.soon,
      html[data-theme="dark"] .lp-pickup-remaining.today,
      html[data-theme="dark"] .lp-pickup-remaining.overdue{
        background:#49301c;color:#fde68a!important;border-color:#a16207}
      html[data-theme="dark"] .lp-pickup-remaining.unregistered{
        background:#263a55;color:#f1f5f9!important;border-color:#59718d}
      .lp-track-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:11px 0 0}
      .lp-track-actions button{min-height:40px;font-size:12px;padding:8px 10px}
      .lp-track-pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:750;border:1px solid var(--app-border,#cbd5e1);background:var(--app-surface2,#eef2ff)}
      .lp-track-note{font-size:12px;line-height:1.5;color:var(--app-muted,#64748b);margin:7px 0}
      .lp-track-overdue{font-weight:800;color:#c2410c!important}
      .lp-track-today{font-weight:800;color:#be123c!important}
      #lpTrackStatus{font-size:12px;line-height:1.55;color:var(--app-muted,#64748b)}
      #lpTrackerEditor{width:min(95vw,560px);max-height:90dvh;overflow:auto;border-radius:17px;border:1px solid var(--app-border,#cbd5e1);background:var(--app-surface,#fff);color:var(--app-text,#172033);padding:18px}
      #lpTrackerEditor::backdrop{background:#0009}
      #lpTrackerForm{display:grid;gap:13px;padding:0}
      /* v21.28: Suppress global form background (#fff) inside both dialogs. */
      #lpTrackerEditor form#lpTrackerForm,#lpOnsiteEditor form#lpOnsiteForm{
        background:transparent!important;color:inherit!important;box-shadow:none!important;
        padding:0!important;margin:0!important;border:0!important;border-radius:0!important;
      }
      #lpTrackerEditor form label,#lpOnsiteEditor form label{color:var(--app-text,#172033)}
      #lpTrackerEditor input[type=checkbox]{appearance:checkbox;-webkit-appearance:checkbox;
        accent-color:#3b82f6;background:transparent;min-width:20px;flex-shrink:0}
      #lpTrackerForm label:not(.lp-check-line){display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:700}
      #lpTrackerForm select,#lpTrackerForm input[type=date],#lpTrackerForm textarea{width:100%;min-width:0;min-height:40px;border-radius:8px;padding:7px;border:1px solid var(--app-border,#cbd5e1);background:var(--app-surface2,#fff);color:var(--app-text,#172033)}
      #lpTrackerForm textarea{min-height:74px;resize:vertical}
      #lpTrackerForm .lp-check-line{display:flex;align-items:center;gap:9px;font-size:13px}
      #lpTrackerForm .lp-check-line input{width:20px;height:20px}
      .lp-track-modal-actions{display:flex;gap:8px;flex-wrap:wrap}
      .lp-track-modal-actions button{min-height:42px}
      #lpOnsiteArchive{margin:10px 0 16px;border:1px solid var(--app-border,#cbd5e1);border-radius:12px;background:var(--app-surface,#fff);color:var(--app-text,#172033)}
      #lpOnsiteArchive>summary{cursor:pointer;font-weight:800;padding:13px 14px}
      .lp-onsite-archive-body{padding:0 14px 14px}
      .lp-onsite-archive-body>p{color:var(--app-muted,#64748b);font-size:12px}
      .lp-onsite-archive-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
      .lp-onsite-archive-controls input{flex:1 1 170px;min-width:0;padding:10px;border:1px solid var(--app-border,#cbd5e1);background:var(--app-surface2,#f8fafc);color:var(--app-text,#172033);border-radius:9px}
      .lp-onsite-archive-controls button,#lpOnsiteArchiveMore{min-height:40px}
      .lp-onsite-archive-card{background:var(--app-surface2,#f8fafc);border:1px solid var(--app-border,#cbd5e1);border-radius:10px;padding:12px;margin:10px 0}
      .lp-onsite-archive-card h4{margin:0 0 7px;color:var(--app-text,#172033);font-size:15px;overflow-wrap:anywhere}
      .lp-onsite-archive-card p{margin:5px 0;color:var(--app-muted,#64748b)}
      .lp-onsite-archive-card ul{padding-left:20px;overflow-wrap:anywhere}
      .lp-onsite-archive-card li{margin:5px 0}
      .lp-onsite-archive-card a{display:inline-block;margin-top:5px}
      #lpOnsiteArchiveStatus{font-size:12px;color:var(--app-muted,#64748b);overflow-wrap:anywhere}
      .lp-onsite-shared{border:1px solid var(--app-border,#cbd5e1);border-radius:11px;padding:10px;margin:12px 0;background:var(--app-surface2,#f8fafc);font-size:12px;line-height:1.6}
      .lp-onsite-shared strong{font-size:13px;color:var(--app-text,#172033)}
      .lp-onsite-shared p{margin:4px 0;color:var(--app-muted,#64748b)}
      .lp-onsite-shared details{margin:6px 0}
      .lp-onsite-shared ul{padding-left:18px;margin:6px 0;overflow-wrap:anywhere}
      .lp-onsite-shared li{margin-bottom:5px}
      .lp-onsite-shared button{min-height:38px;margin-top:5px;font-size:12px}
      #lpOnsiteEditor{width:min(95vw,560px);max-height:90dvh;overflow:auto;border-radius:17px;border:1px solid var(--app-border,#cbd5e1);background:var(--app-surface,#fff);color:var(--app-text,#172033);padding:18px}
      #lpOnsiteEditor::backdrop{background:#0009}
      #lpOnsiteForm{display:grid;gap:12px;padding:0}
      #lpOnsiteForm label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:700}
      #lpOnsiteForm select,#lpOnsiteForm textarea{width:100%;min-width:0;border-radius:8px;padding:8px;border:1px solid var(--app-border,#cbd5e1);background:var(--app-surface2,#fff);color:var(--app-text,#172033)}
      #lpOnsiteForm textarea{min-height:100px;resize:vertical}
      #lpOnsiteMessage{font-size:12px;overflow-wrap:anywhere}
      html[data-theme=dark] .lp-onsite-shared{background:var(--app-surface2,#1d293c)!important}
      html[data-theme=dark] #lpOnsiteEditor{background:var(--app-surface,#172337)!important;color:var(--app-text,#eaf1ff)!important}
      html[data-theme=dark] #lpTrackerEditor{background:var(--app-surface,#172337)!important;color:var(--app-text,#eaf1ff)!important}
      html[data-theme=dark] #lpTrackerEditor form#lpTrackerForm,html[data-theme=dark] #lpOnsiteEditor form#lpOnsiteForm{
        background:transparent!important;color:var(--app-text,#eaf1ff)!important;
      }
      html[data-theme=dark] #lpTrackerEditor form label,html[data-theme=dark] #lpOnsiteEditor form label{
        color:var(--app-text,#eaf1ff)!important;
      }
      html[data-theme=dark] #lpTrackerEditor .lp-tracker-intro,html[data-theme=dark] #lpOnsiteEditor .lp-tracker-intro{
        color:var(--app-muted,#c5d4e9)!important;
      }
      html[data-theme=dark] #lpTrackerForm select,
      html[data-theme=dark] #lpTrackerForm input[type=date],
      html[data-theme=dark] #lpTrackerForm textarea,
      html[data-theme=dark] #lpOnsiteForm select,
      html[data-theme=dark] #lpOnsiteForm textarea{
        background:var(--app-surface2,#263c54)!important;
        color:var(--app-text,#f1f6ff)!important;
        border:1px solid var(--app-border,#59718d)!important;
        color-scheme:dark;
      }
      html[data-theme=dark] #lpTrackerForm textarea::placeholder,
      html[data-theme=dark] #lpOnsiteForm textarea::placeholder{color:#b9cce4!important;opacity:1}
      html[data-theme=dark] #lpTrackerEditor button:not(.primary),
      html[data-theme=dark] #lpOnsiteEditor button:not(.primary){
        background:var(--app-surface2,#263c54)!important;
        color:var(--app-text,#f1f6ff)!important;
        border-color:var(--app-border,#59718d)!important;
      }
      #lpTrackEditorMessage{font-size:12px;min-height:16px;line-height:1.5}
      html[data-theme=dark] #lpTrackerPanel,html[data-theme=dark] #lpTrackerEditor{background:var(--app-surface)!important;color:var(--app-text)!important}
      html[data-theme=dark] .lp-track-overdue{color:#fdba74!important}
      html[data-theme=dark] .lp-track-today{color:#fda4af!important}
    `;
    document.head.append(sheet);
  }

  // v21.28: Personal application management has its own navigation tab.
  // The cards in the lottery tab still provide quick registration shortcuts.
  function ensureLotteryTrackingTab() {
    if (!$('lotteryManageView')) {
      const view = document.createElement('section');
      view.id = 'lotteryManageView';
      view.className = 'view';
      view.setAttribute('aria-label', '自分の抽選管理');
      view.innerHTML = '<h2>✅ 抽選管理</h2>' +
        '<p class="hint">応募済み・当選・落選・受け取り期限を管理します。各抽選カードから記録を追加できます。</p>';
      $('lotteryView').after(view);
    }
    const lotteryButton = document.querySelector('nav button[data-tab="lottery"]');
    const historyButton = document.querySelector('nav button[data-tab="history"]');
    let managementButton = document.querySelector('nav button[data-tab="lotteryManage"]');
    if (!managementButton && lotteryButton) {
      managementButton = document.createElement('button');
      managementButton.type = 'button';
      managementButton.dataset.tab = 'lotteryManage';
      managementButton.setAttribute('aria-label', '自分の抽選管理を開く');
      managementButton.innerHTML = '✅<span>抽選管理</span>';
      lotteryButton.after(managementButton);
    }
    // v21.29: Map → Register → History → Lottery → Lottery Management → Share → Dev.
    // Move existing buttons, preserving their event handlers and data-tab values.
    if (historyButton && lotteryButton && managementButton) {
      historyButton.after(lotteryButton, managementButton);
    }
  }

  function ensureLotteryTrackerUI() {
    if ($('lpTrackerPanel')) return;
    lotteryTrackCss();
    ensureLotteryTrackingTab();
    const container = document.createElement('section');
    container.id = 'lpTrackerPanel';
    container.setAttribute('aria-label','自分の抽選管理');
    container.innerHTML = `<h3>✅ 自分の抽選管理</h3>
      <p class="lp-tracker-intro">応募、当選、受け取り期間と「自分の現地対応完了」を非公開で管理します。現地対応が必要かどうか・対応内容は別枠で全ユーザーに共有します。</p>
      <section id="lpPickupAlerts" class="lp-pickup-alerts" aria-label="当選商品の受取期限のお知らせ" hidden></section>
      <p id="lpTrackStatus" role="status" aria-live="polite"></p>
      <div id="lpTrackCounts" class="lp-track-counts"></div>
      <div class="lp-track-toolbar"><label for="lpTrackFilter">自分の記録を表示</label>
        <select id="lpTrackFilter"><option value="all">すべて</option><option value="applied">応募済み</option><option value="won">当選・受取待ち</option><option value="lost">落選</option><option value="received">受取済み</option><option value="not_applied">未応募</option><option value="onsite">現地対応待ち</option></select>
        <button type="button" id="lpTrackReload">記録を更新</button></div>
      <div id="lpTrackList"></div>`;
    $('lotteryManageView').append(container);
    $('lpTrackFilter').addEventListener('change', e => {
      lotteryTrackFilter = e.target.value;
      // Explicitly filtering to "落選" reveals the matching entries.
      if (lotteryTrackFilter === 'lost') lotteryLostGroupExpanded = true;
      renderLotteryTrackerSummary();
    });
    // Preserve the fold state when Supabase refreshes or a record is edited.
    $('lpTrackList').addEventListener('toggle', event => {
      if (event.target?.matches?.('details.lp-track-lost-fold')) {
        lotteryLostGroupExpanded = event.target.open;
      }
    }, true);
    $('lpTrackReload').addEventListener('click',()=>refreshLotteryTrackerForAccount(true));
    const dialog = document.createElement('dialog');
    dialog.id = 'lpTrackerEditor';
    dialog.setAttribute('aria-label','抽選の個別管理');
    dialog.innerHTML = '<div id="lpTrackerEditorBody"></div>';
    document.body.append(dialog);
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });
    renderLotteryTrackerSummary();
  }

  function lotteryTrackRecord(url) {
    return lotteryTrackRecords.get(url) || null;
  }

  function lotteryTrackClean(row) {
    if (!row || !safeLotteryUrl(row.event_url)) return null;
    return {
      event_url:row.event_url,
      status:LP_TRACK_STATUSES.includes(row.status) ? row.status : 'not_applied',
      onsite_required:row.onsite_required === true,
      onsite_done:row.onsite_done === true,
      pickup_start:/^\d{4}-\d{2}-\d{2}$/.test(row.pickup_start||'')?row.pickup_start:'',
      pickup_end:/^\d{4}-\d{2}-\d{2}$/.test(row.pickup_end||'')?row.pickup_end:'',
      note:typeof row.note==='string'?row.note.slice(0,500):'',
      updated_at:row.updated_at||''
    };
  }

  async function refreshLotteryTrackerForAccount(force = false) {
    const user = authUser?.id || '';
    if (!user || !supabaseClient) {
      ++lotteryTrackSequence;
      lotteryTrackUserId = '';
      lotteryTrackRecords.clear();
      lotteryTrackError = '';
      lotteryTrackLastLoad = 0;
      renderLotteryTrackerSummary();
      if ($('lpCards')) renderLottery();
      return;
    }
    if (!force && user === lotteryTrackUserId && Date.now()-lotteryTrackLastLoad < 45000) return;
    if (lotteryTrackFetching && user === lotteryTrackUserId) return lotteryTrackFetching;
    const seq = ++lotteryTrackSequence;
    if (lotteryTrackUserId !== user) {
      lotteryTrackRecords.clear();
      lotteryTrackLastLoad = 0;
    }
    lotteryTrackUserId = user;
    const run = (async() => {
      try {
        const fetched=await Promise.all([LP_TRACK_TABLE,LP_EXT_TRACK_TABLE].map(table=>
          supabaseClient.from(table)
            .select('event_url,status,onsite_required,onsite_done,pickup_start,pickup_end,note,updated_at')
            .eq('user_id',user).order('updated_at',{ascending:false}).limit(3000)));
        for(const response of fetched)if(response.error)throw response.error;
        if (seq !== lotteryTrackSequence || authUser?.id !== user) return;
        lotteryTrackRecords = new Map(fetched.flatMap(x=>x.data||[])
          .map(lotteryTrackClean).filter(Boolean).map(x=>[x.event_url,x]));
        lotteryTrackError='';
        lotteryTrackLastLoad=Date.now();
      } catch(e) {
        if (seq !== lotteryTrackSequence || authUser?.id !== user) return;
        lotteryTrackError='クラウド同期に失敗しました。SQLの設定と通信をご確認ください：'+String(e.message||e);
      } finally {
        if (seq === lotteryTrackSequence) {
          renderLotteryTrackerSummary();
          if ($('lpCards')) renderLottery();
        }
      }
    })();
    lotteryTrackFetching=run;
    try {await run;} finally {if (lotteryTrackFetching===run) lotteryTrackFetching=null;}
  }

  function lotteryTrackPickupMessage(record) {
    if (!record || record.status!=='won') return '';
    // Japan date-only deadline, never reinterpret as a UTC instant.
    const tokyo = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const start = record.pickup_start || '';
    const end = record.pickup_end || '';
    if (end && tokyo > end) return '⚠ 受取期限を過ぎています：'+end;
    if (end && tokyo === end) return '⚠ 今日が受取期限：'+end;
    if (start && tokyo < start) return '受取開始：'+start+(end?' ／ 期限：'+end:'');
    if (start && end) return '受取期間：'+start+' ～ '+end;
    if (end) return '受取期限：'+end;
    if (start) return '受取開始：'+start;
    return '受取期間：未登録';
  }

  // v21.38: Pickup dates contain no end-of-day cutoff time. Count down to
  // the START (00:00 JST) of the deadline date, never a made-up closing time.
  function lotteryPickupDateText(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '未登録';
    const parts=value.split('-').map(Number);
    const day=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
    const weekday='日月火水木金土'[day.getUTCDay()];
    return parts[0]+'/'+String(parts[1]).padStart(2,'0')+'/'+
      String(parts[2]).padStart(2,'0')+'（'+weekday+'）';
  }

  function lotteryPickupRemaining(end, now=Date.now()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
      return {text:'⚠ 受取期限未登録',style:'unregistered'};
    }
    const today=new Intl.DateTimeFormat('sv-SE',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).format(new Date(now));
    if (today>end) return {text:'⚠ 受取期限日を過ぎています',style:'overdue'};
    if (today===end) return {text:'⚠ 今日が受取期限日',style:'today'};
    const deadlineDateStart=Date.parse(end+'T00:00:00+09:00');
    if (!Number.isFinite(deadlineDateStart)) return {text:'⚠ 期限日を確認してください',style:'unregistered'};
    const remaining=Math.max(0,deadlineDateStart-now);
    const days=Math.floor(remaining/86400000);
    const hours=Math.floor((remaining%86400000)/3600000);
    return {text:'⏳ 期限日まで あと'+(days?days+'日':'')+hours+'時間',
      style:days<3?'soon':'normal'};
  }

  function lotteryPickupDetailsHtml(record) {
    if (!record || record.status!=='won') return '';
    const remaining=lotteryPickupRemaining(record.pickup_end);
    const help=record.pickup_end
      ? '※残り時間は期限日の午前0時までの目安です。実際の受取終了時刻は未登録のため、必ず公式案内で確認してください。'
      : '管理ボタンから受取期限を登録できます。実際の終了時刻は公式案内で確認してください。';
    return '<div class="lp-pickup-details" aria-label="受け取り期間と期限日の案内">'+
      '<div class="lp-pickup-date-line"><span>受取開始</span><strong>'+
        escape(lotteryPickupDateText(record.pickup_start))+'</strong></div>'+
      '<div class="lp-pickup-date-line"><span>受取期限</span><strong>'+
        escape(lotteryPickupDateText(record.pickup_end))+'</strong></div>'+
      '<p class="lp-pickup-remaining '+remaining.style+'">'+escape(remaining.text)+'</p>'+
      '<p class="lp-pickup-help">'+escape(help)+'</p></div>';
  }

  function lotteryTrackItemName(url) {
    const item=lotteryItems.find(x=>x.url===url);
    if (!item) return url;
    return String(item.official_event_title || item.product_name || (item.event_title_provisional?'':item.event_title) || item.store_name || url).trim().slice(0,160);
  }

  function lotteryTrackSort(a,b) {
    const priority = r => r.status==='won' ? 0 : lotteryOnsiteSummary(r.event_url).state==='required' && !r.onsite_done ? 1 : r.status==='applied' ? 2 : r.status==='not_applied' ? 3 : r.status==='received' ? 4 : 5;
    if(priority(a)!==priority(b))return priority(a)-priority(b);
    // For won items: the closest dated deadline first, unknown dates last.
    if(a.status==='won'&&b.status==='won'){
      const aEnd=a.pickup_end || '9999-12-31';
      const bEnd=b.pickup_end || '9999-12-31';
      if(aEnd!==bEnd)return aEnd.localeCompare(bEnd);
      const aStart=a.pickup_start || '9999-12-31';
      const bStart=b.pickup_start || '9999-12-31';
      if(aStart!==bStart)return aStart.localeCompare(bStart);
    }
    return String(b.updated_at).localeCompare(String(a.updated_at));
  }

  // v21.39: Show reminders ONLY inside the private management tab.
  // No system push permission or background worker is needed.
  const LP_PICKUP_ALERT_DAYS = 3;
  function lotteryPickupAlertItems(records, now = Date.now()) {
    const today = new Intl.DateTimeFormat('sv-SE',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).format(new Date(now));
    const dayAsUtc = iso => Date.UTC(
      Number(iso.slice(0,4)),Number(iso.slice(5,7))-1,Number(iso.slice(8,10))
    );
    return records.filter(r => r.status==='won' &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.pickup_end || '')).map(record => {
      const days = Math.round((dayAsUtc(record.pickup_end)-dayAsUtc(today))/86400000);
      const level = days<0?'overdue':days===0?'today':'soon';
      return {record,days,level};
    }).filter(x => x.days<=LP_PICKUP_ALERT_DAYS)
      .sort((a,b) => a.record.pickup_end.localeCompare(b.record.pickup_end));
  }

  function renderLotteryPickupAlerts(records) {
    const root=$('lpPickupAlerts');
    if(!root)return;
    if(!authUser || !supabaseClient) {
      root.hidden=true;
      root.replaceChildren();
      return;
    }
    const alerts=lotteryPickupAlertItems(records);
    if(!alerts.length) {
      root.hidden=true;
      root.replaceChildren();
      return;
    }
    const visible=alerts.slice(0,15);
    root.innerHTML='<div class="lp-pickup-alert-head">'+
      '<h4>🔔 受取期限のお知らせ</h4><span class="lp-pickup-alert-count">'+
      alerts.length+'件</span></div>'+
      visible.map(({record,days,level}) => {
        const label=level==='overdue'?'⚠ 期限日を過ぎています':
          level==='today'?'⚠ 今日が受取期限日':'あと'+days+'日で受取期限日';
        return '<div class="lp-pickup-alert-row '+
          (level==='soon'?'':'urgent')+'"><div>'+
          '<strong>'+escape(lotteryTrackItemName(record.event_url))+'</strong>'+
          '<p>'+escape(label+'：'+lotteryPickupDateText(record.pickup_end))+'</p>'+
          '</div><button type="button" data-lp-track="edit" data-url="'+
          escape(record.event_url)+'">管理</button></div>';
      }).join('')+
      (alerts.length>15?'<p class="lp-pickup-alert-help">ほか'+
        (alerts.length-15)+'件も受取期限の確認が必要です。</p>':'')+
      '<p class="lp-pickup-alert-help">※終了時刻は登録されていません。実際の受取条件・締切時刻は公式案内で確認してください。</p>';
    root.hidden=false;
  }

  function renderLotteryTrackerSummary() {
    const host=$('lpTrackerPanel');
    if(!host)return;
    const status=$('lpTrackStatus');
    if(!supabaseClient || !authUser){
      status.textContent='Discordログインすると、自分専用の応募・当選記録を保存できます。「共有」タブからログインしてください。';
      $('lpTrackCounts').replaceChildren();
      $('lpTrackList').innerHTML='';
      renderLotteryPickupAlerts([]);
      return;
    }
    status.textContent=lotteryTrackError || '🔒 自分のDiscordアカウントに非公開で保存します。';
    const records=[...lotteryTrackRecords.values()];
    renderLotteryPickupAlerts(records);
    const counts=[
      ['応募済み',records.filter(x=>x.status==='applied').length],
      ['当選・受取待ち',records.filter(x=>x.status==='won').length],
      ['落選',records.filter(x=>x.status==='lost').length],
      ['受取済み',records.filter(x=>x.status==='received').length],
      ['自分の現地対応未完了',records.filter(x=>lotteryOnsiteSummary(x.event_url).state==='required'&&!x.onsite_done).length]
    ];
    $('lpTrackCounts').innerHTML=counts.map(([label,n])=>`<span>${escape(label)} <strong>${n}</strong>件</span>`).join('');
    const filtered=records.filter(x=>lotteryTrackFilter==='all' ||
      (lotteryTrackFilter==='onsite'?lotteryOnsiteSummary(x.event_url).state==='required'&&!x.onsite_done:x.status===lotteryTrackFilter))
      .sort(lotteryTrackSort);
    // Keep the existing 100-entry display cap and sorting within each status.
    const displayed=filtered.slice(0,100);
    const sections=LP_TRACK_GROUPS.map(([key,icon])=>{
      const group=displayed.filter(x=>x.status===key);
      if(!group.length)return '';
      const total=filtered.filter(x=>x.status===key).length;
      const rows=group.map(x=>{
        const msg=x.status==='won' ? '' : lotteryTrackPickupMessage(x);
        const warn=msg.startsWith('⚠') ? (msg.includes('今日')?'lp-track-today':'lp-track-overdue'):'';
        const onsite=lotteryOnsiteSummary(x.event_url).state==='required'
          ? `<p>自分の現地対応：${x.onsite_done?'完了':'未完了'}</p>`:'';
        return `<div class="lp-track-row"><div>
          <strong>${escape(lotteryTrackItemName(x.event_url))}</strong>
          ${onsite}
          ${x.status==='won'?lotteryPickupDetailsHtml(x):''}
          ${msg?`<p class="${warn}">${escape(msg)}</p>`:''}
          <a href="${escape(x.event_url)}" target="_blank" rel="noopener noreferrer" style="font-size:12px">公式ページ ↗</a>
        </div><button type="button" data-lp-track="edit" data-url="${escape(x.event_url)}">管理</button></div>`;
      }).join('');
      if(key==='lost'){
        return `<details class="lp-track-group lp-track-lost-fold" data-status="lost" aria-label="落選" ${lotteryLostGroupExpanded?'open':''}>
          <summary class="lp-track-group-head"><span>${icon} ${escape(LP_TRACK_LABELS[key])}</span>
            <span class="lp-track-lost-meta"><span class="lp-track-group-count">${total}件</span>
            <span class="lp-track-lost-chevron" aria-hidden="true"></span></span>
          </summary>${rows}</details>`;
      }
      return `<section class="lp-track-group" data-status="${key}" aria-label="${escape(LP_TRACK_LABELS[key])}">
        <h4 class="lp-track-group-head"><span>${icon} ${escape(LP_TRACK_LABELS[key])}</span>
        <span class="lp-track-group-count">${total}件</span></h4>${rows}</section>`;
    }).join('');
    $('lpTrackList').innerHTML=filtered.length
      ? sections+(filtered.length>100?'<p class="lp-tracker-intro">最初の100件を表示しています。絞り込みでほかの記録を表示できます。</p>':'')
      : `<p class="lp-tracker-intro">${records.length?'該当する管理記録はありません。':'まだ記録はありません。各抽選の「応募済みにする」から登録できます。'}</p>`;
  }

  function lotteryTrackerActionsHtml(item) {
    const record=lotteryTrackRecord(item.url);
    const applied=record && record.status!=='not_applied';
    const show=record?LP_TRACK_LABELS[record.status]:'未応募';
    const onsite=lotteryOnsiteSummary(item.url).state==='required' ? (record?.onsite_done?'現地対応済み':'現地対応待ち') : '';
    const warning=lotteryTrackPickupMessage(record);
    const css=warning.startsWith('⚠')?'lp-track-overdue':'';
    return `<div class="lp-track-actions" aria-label="自分の応募管理">
      ${record?`<span class="lp-track-pill">${escape(show)}${onsite?' ／ '+escape(onsite):''}</span>`:''}
      <button type="button" data-lp-track="apply" data-url="${escape(item.url)}">${applied?'✅ 応募状況を確認':'☐ 応募済みにする'}</button>
      <button type="button" data-lp-track="edit" data-url="${escape(item.url)}">⚙ 個別管理</button>
    </div>${warning?`<p class="lp-track-note ${css}">${escape(warning)}</p>`:''}`;
  }

  function lotteryTrackerHandleClick(event) {
    const button=event.target.closest('button[data-lp-track]');
    if(!button || !event.currentTarget.contains(button))return;
    const url=button.dataset.url;
    if(!safeLotteryUrl(url))return;
    if(!authUser||!supabaseClient){
      alert('抽選の個人管理にはDiscordログインが必要です。「共有」タブでログインしてください。');
      switchTab('group');return;
    }
    if(button.dataset.lpTrack==='apply'){
      const old=lotteryTrackRecord(url);
      if(old?.status && old.status!=='not_applied'){
        lotteryTrackerOpenEditor(url);return;
      }
      lotteryTrackerSave(url,{...lotteryTrackerDefaults(url),status:'applied'});
    }else if(button.dataset.lpTrack==='edit') lotteryTrackerOpenEditor(url);
  }

  function lotteryTrackerDefaults(url) {
    return lotteryTrackRecord(url) || {
      event_url:url,status:'not_applied',onsite_required:false,onsite_done:false,
      pickup_start:'',pickup_end:'',note:'',updated_at:''
    };
  }

  // v21.36: Open dialogs with their headings focused, never their first select.
  function showLotteryEditorDialog(dialog) {
    if (typeof dialog.showModal !== 'function') return false;
    dialog.showModal();
    const heading = dialog.querySelector('[data-dialog-title-focus]');
    if (heading) {
      try { heading.focus({preventScroll:true}); }
      catch (_) { heading.focus(); }
    }
    return true;
  }

  function lotteryTrackerOpenEditor(url) {
    if(!authUser || !safeLotteryUrl(url))return;
    const data=lotteryTrackerDefaults(url);
    const dlg=$('lpTrackerEditor');
    if(!dlg)return;
    $('lpTrackerEditorBody').innerHTML=`<h3 tabindex="-1" autofocus data-dialog-title-focus>抽選の個別管理</h3>
      <p class="lp-tracker-intro">${escape(lotteryTrackItemName(url))}</p>
      <form id="lpTrackerForm">
      <label>応募・当選状況
        <select name="status">${LP_TRACK_STATUSES.map(k=>`<option value="${k}" ${data.status===k?'selected':''}>${escape(LP_TRACK_LABELS[k])}</option>`).join('')}</select>
      </label>
      <p class="lp-tracker-intro">現地対応の必要性・内容は各イベントの「みんなの現地対応情報」から共有できます。この画面で記録するのは自分の完了状況だけです。</p>
      <label class="lp-check-line"><input type="checkbox" name="onsite_done" ${data.onsite_done?'checked':''}>自分の現地対応を完了した</label>
      <label>受け取り開始日（わかる場合）<input type="date" name="pickup_start" value="${escape(data.pickup_start)}"></label>
      <label>受け取り期限日（わかる場合）<input type="date" name="pickup_end" value="${escape(data.pickup_end)}"></label>
      <p class="lp-tracker-intro">当選したら「当選・受取待ち」を選び、公式案内の受取期間を入力してください。アプリ内で期限が確認できます。公式条件は自動確定しません。</p>
      <label>自分用メモ（500文字まで）<textarea name="note" maxlength="500" rows="3" placeholder="例：店頭で本人確認が必要／受取時に身分証を持参">${escape(data.note)}</textarea></label>
      <div class="lp-track-modal-actions"><button type="submit" class="primary">保存</button><button type="button" id="lpTrackEditorClose">閉じる</button>
      ${lotteryTrackRecord(url)?'<button type="button" id="lpTrackEditorDelete">記録を削除</button>':''}</div>
      <p id="lpTrackEditorMessage" role="status" aria-live="polite"></p>
      </form>`;
    $('lpTrackEditorClose').addEventListener('click',()=>dlg.close());
    $('lpTrackEditorDelete')?.addEventListener('click',async()=>{
      if(!confirm('この抽選の個人管理記録を削除しますか？'))return;
      await lotteryTrackerDelete(url);
    });
    $('lpTrackerForm').addEventListener('submit',async e=>{
      e.preventDefault();
      const form=e.currentTarget,fd=new FormData(form);
      const status=String(fd.get('status')||'not_applied');
      const completed=fd.get('onsite_done')==='on';
      const data={status,onsite_required:completed,onsite_done:completed,
        pickup_start:String(fd.get('pickup_start')||''),pickup_end:String(fd.get('pickup_end')||''),
        note:String(fd.get('note')||'').trim().slice(0,500)};
      if(data.pickup_start&&data.pickup_end&&data.pickup_start>data.pickup_end){
        $('lpTrackEditorMessage').textContent='受取開始日は受取期限日より前にしてください。';return;
      }
      await lotteryTrackerSave(url,data,true);
    });
    if (!showLotteryEditorDialog(dlg)) {
      alert('このブラウザでは管理画面を開けません。');
    }
  }

  async function lotteryTrackerSave(url,values,closeOnSuccess=false) {
    if(lotteryTrackSaving || !authUser || !supabaseClient)return;
    if(!safeLotteryUrl(url))return;
    const uid=authUser.id;
    const status=String(values.status||'not_applied');
    if(!LP_TRACK_STATUSES.includes(status))return;
    const completed=values.onsite_done===true;
    // Legacy private column exists only for the v21.27 SQL compatibility constraint.
    const payload={user_id:uid,event_url:url,status,onsite_required:completed,
      onsite_done:completed,
      pickup_start:values.pickup_start||null,pickup_end:values.pickup_end||null,
      note:String(values.note||'').slice(0,500)};
    if(payload.pickup_start&&payload.pickup_end&&payload.pickup_start>payload.pickup_end)return;
    lotteryTrackSaving=true;
    const message=$('lpTrackEditorMessage');
    if(message)message.textContent='保存中…';
    try{
      const {data,error}=await supabaseClient.from(lotteryTrackTableFor(url)).upsert(payload,{onConflict:'user_id,event_url'})
        .select('event_url,status,onsite_required,onsite_done,pickup_start,pickup_end,note,updated_at').single();
      if(error)throw error;
      if(authUser?.id!==uid)return;
      const parsed=lotteryTrackClean(data);
      if(parsed)lotteryTrackRecords.set(url,parsed);
      lotteryTrackError='';
      renderLotteryTrackerSummary();renderLottery();
      if(closeOnSuccess&&$('lpTrackerEditor')?.open)$('lpTrackerEditor').close();
    }catch(error){
      if(authUser?.id===uid){
        const msg='保存できませんでした。SupabaseのSQL設定をご確認ください：'+(error.message||error);
        if(message)message.textContent=msg;
        else alert(msg);
      }
    }finally{lotteryTrackSaving=false;}
  }

  async function lotteryTrackerDelete(url) {
    if(lotteryTrackSaving || !authUser || !supabaseClient)return;
    const uid=authUser.id;
    lotteryTrackSaving=true;
    try{
      const {error}=await supabaseClient.from(lotteryTrackTableFor(url)).delete().eq('user_id',uid).eq('event_url',url);
      if(error)throw error;
      if(authUser?.id!==uid)return;
      lotteryTrackRecords.delete(url);
      $('lpTrackerEditor')?.close();
      renderLotteryTrackerSummary();renderLottery();
    }catch(error){
      const msg=$('lpTrackEditorMessage');
      if(msg)msg.textContent='削除できませんでした：'+(error.message||error);
    }finally{lotteryTrackSaving=false;}
  }


  // =====================================================
  // v21.27 shared onsite REQUIREMENT reports vs private completion.
  // Reports are always user-submitted and NOT an official confirmation.
  // Each user can edit ONLY their own report (RLS); conflicts stay visible.
  // =====================================================
  const LP_ONSITE_TABLE = 'lottery_onsite_reports';
  const LP_EXT_ONSITE_TABLE = 'lottery_external_onsite_reports';
  const LP_ONSITE_ARCHIVE_TABLE = 'lottery_onsite_archive';
  const LP_EXT_ONSITE_ARCHIVE_TABLE = 'lottery_external_onsite_archive';
  function lotteryOnsiteTableFor(url){
    return isLivePocketEventUrl(url)?LP_ONSITE_TABLE:LP_EXT_ONSITE_TABLE;
  }
  let lotteryOnsiteArchiveRows=[],lotteryOnsiteArchiveLastFetch=0;
  let lotteryOnsiteArchiveFetching=null,lotteryOnsiteArchiveError='';
  let lotteryOnsiteArchiveLimit=40;
  let lotteryOnsiteReports = new Map();
  let lotteryOnsiteFetching = null;
  let lotteryOnsiteSequence = 0;
  let lotteryOnsiteLastFetch = 0;
  let lotteryOnsiteError = '';
  let lotteryOnsiteSaving = false;

  function lotteryOnsiteClean(row) {
    if (!row || !safeLotteryUrl(row.event_url) || typeof row.user_id !== 'string' ||
        !['required','not_required'].includes(row.requirement)) return null;
    return {event_url:row.event_url,user_id:row.user_id,requirement:row.requirement,
      details:typeof row.details==='string'?row.details.slice(0,500):'',
      updated_at:typeof row.updated_at==='string'?row.updated_at:'',
      application_end_at:typeof row.application_end_at==='string'?row.application_end_at:null,
      store_name:typeof row.store_name==='string'?row.store_name:'',
      prefecture:typeof row.prefecture==='string'?row.prefecture:'',
      event_title:typeof row.event_title==='string'?row.event_title:''};
  }

  function lotteryOnsiteSummary(url) {
    const reports=lotteryOnsiteReports.get(url) || [];
    const yes=reports.filter(x=>x.requirement==='required').length;
    const no=reports.filter(x=>x.requirement==='not_required').length;
    return {state:yes&&no?'conflict':yes?'required':no?'not_required':'unknown',
      yes,no,reports};
  }

  function lotteryOnsiteMyReport(url) {
    const uid=authUser?.id;
    return uid ? (lotteryOnsiteReports.get(url)||[]).find(x=>x.user_id===uid)||null : null;
  }

  function lotteryOnsiteSharedHtml(url) {
    const data=lotteryOnsiteSummary(url);
    const names={required:'現地対応が必要との報告あり',not_required:'現地対応は不要との報告あり',
      conflict:'⚠ 報告が分かれています',unknown:'現地対応：情報未登録'};
    // Report text is user provided, unverified and escaped against HTML injection.
    const details=data.reports.filter(x=>x.details).slice(0,3)
      .map(x=>`<li><strong>${x.requirement==='required'?'必要':'不要'}との報告：</strong> ${escape(x.details)}</li>`).join('');
    return `<section class="lp-onsite-shared" aria-label="みんなの現地対応情報">
      <strong>📍 ${lotteryOnsiteError?'⚠ 現地対応情報の取得に失敗':names[data.state]}</strong>
      ${lotteryOnsiteError?`<p>${escape(lotteryOnsiteError)}</p>`:''}
      ${data.reports.length?`<p>利用者からの報告：必要 ${data.yes}件 ／ 不要 ${data.no}件</p>`:''}
      ${details?`<details><summary>現地対応に関する報告内容</summary><ul>${details}</ul></details>`:''}
      <p class="lp-onsite-disclaimer">利用者の報告です。正確な応募条件は公式ページで確認してください。</p>
      <button type="button" data-lp-onsite="edit" data-url="${escape(url)}">${lotteryOnsiteMyReport(url)?'自分の報告を編集':'現地対応情報を共有'}</button>
    </section>`;
  }

  async function refreshLotteryOnsiteReports(force=false) {
    if (!supabaseClient) return;
    if (!force && lotteryOnsiteLastFetch && Date.now()-lotteryOnsiteLastFetch<60000) return;
    if (lotteryOnsiteFetching) return lotteryOnsiteFetching;
    const seq=++lotteryOnsiteSequence;
    const run=(async()=>{
      try {
        const all=[];
        // Supabase projects often cap a query at 1,000 rows. Paginate so
        // growing community reports do not silently omit older events.
        for(const table of [LP_ONSITE_TABLE,LP_EXT_ONSITE_TABLE]){
          for(let offset=0;offset<10000;offset+=500){
            const {data,error}=await supabaseClient.from(table)
              .select('user_id,event_url,requirement,details,updated_at,application_end_at,store_name,prefecture,event_title')
              .order('updated_at',{ascending:false}).range(offset,offset+499);
            if(error)throw error;
            if(seq!==lotteryOnsiteSequence)return;
            all.push(...(data||[]));
            if(!data||data.length<500)break;
          }
        }
        const next=new Map();
        for(const row of all){
          const record=lotteryOnsiteClean(row);
          if (!record) continue;
          const group=next.get(record.event_url)||[];
          if (!group.some(x=>x.user_id===record.user_id)) group.push(record);
          next.set(record.event_url,group);
        }
        lotteryOnsiteReports=next;
        lotteryOnsiteLastFetch=Date.now();
        lotteryOnsiteError='';
      } catch(e) {
        if(seq!==lotteryOnsiteSequence) return;
        lotteryOnsiteError='共有の現地対応情報を取得できませんでした：'+String(e.message||e);
        console.warn(lotteryOnsiteError);
      } finally {
        if(seq===lotteryOnsiteSequence && $('lpCards')) renderLottery();
      }
    })();
    lotteryOnsiteFetching=run;
    try {await run;} finally {if(lotteryOnsiteFetching===run)lotteryOnsiteFetching=null;}
  }


  // The Postgres cron snapshots finished community reports independently
  // of any client. This browser only reads immutable archived results.
  async function refreshLotteryOnsiteArchive(force=false){
    if(!supabaseClient)return;
    if(!force && lotteryOnsiteArchiveLastFetch &&
      Date.now()-lotteryOnsiteArchiveLastFetch<60000)return;
    if(lotteryOnsiteArchiveFetching)return lotteryOnsiteArchiveFetching;
    lotteryOnsiteArchiveFetching=(async()=>{
      try{
        const rows=[];
        for(const table of [LP_ONSITE_ARCHIVE_TABLE,LP_EXT_ONSITE_ARCHIVE_TABLE]){
          for(let offset=0;offset<10000;offset+=500){
            const {data,error}=await supabaseClient.from(table)
              .select('event_url,store_name,prefecture,event_title,application_end_at,required_count,not_required_count,required_details,archived_at')
              .order('application_end_at',{ascending:false}).range(offset,offset+499);
            if(error)throw error;
            rows.push(...(data||[]));
            if(!data||data.length<500)break;
          }
        }
        lotteryOnsiteArchiveRows=rows.filter(x=>safeLotteryUrl(x.event_url))
          .sort((a,b)=>Date.parse(b.application_end_at)-Date.parse(a.application_end_at));
        lotteryOnsiteArchiveLastFetch=Date.now();
        lotteryOnsiteArchiveError='';
      }catch(error){
        lotteryOnsiteArchiveError='アーカイブ取得失敗：'+String(error?.message||error);
        console.warn(lotteryOnsiteArchiveError);
      }finally{
        lotteryOnsiteArchiveFetching=null;
        renderLotteryOnsiteArchive();
      }
    })();
    return lotteryOnsiteArchiveFetching;
  }

  function renderLotteryOnsiteArchive(){
    const root=$('lpOnsiteArchive'),list=$('lpOnsiteArchiveList'),
      status=$('lpOnsiteArchiveStatus');
    if(!root||!list||!status)return;
    $('lpOnsiteArchiveCount').textContent=lotteryOnsiteArchiveRows.length+'件';
    const search=String($('lpOnsiteArchiveSearch')?.value||'')
      .trim().toLocaleLowerCase('ja-JP');
    const matching=lotteryOnsiteArchiveRows.filter(row=>{
      if(!search)return true;
      return [row.store_name,row.prefecture,row.event_title,row.event_url,
        ...(Array.isArray(row.required_details)?row.required_details:[])]
        .filter(v=>typeof v==='string').join(' ')
        .toLocaleLowerCase('ja-JP').includes(search);
    });
    status.textContent=lotteryOnsiteArchiveError||
      ('保存済み '+lotteryOnsiteArchiveRows.length+'件 ／ 表示 '+
      Math.min(lotteryOnsiteArchiveLimit,matching.length)+'件'+
      (search?'（検索結果 '+matching.length+'件）':''));
    list.innerHTML=matching.length?matching.slice(0,lotteryOnsiteArchiveLimit).map(row=>{
      const notes=Array.isArray(row.required_details)?row.required_details
        .filter(x=>typeof x==='string'&&x.trim()).slice(0,40):[];
      return '<article class="lp-onsite-archive-card">'+
        '<h4>'+escape(row.store_name||'店舗名未確認')+'</h4>'+
        '<p>地域：'+escape(row.prefecture||'未確認')+'</p>'+
        '<p>抽選：'+escape(row.event_title||'イベント名未確認')+'</p>'+
        '<p>応募終了：'+escape(lotteryJapaneseDate(row.application_end_at)||'未確認')+'</p>'+
        '<p>現地対応が必要 '+Number(row.required_count||0)+'件'+
          (Number(row.not_required_count)>0?' ／ 不要 '+Number(row.not_required_count)+'件':'')+'</p>'+
        (notes.length?'<strong>当時報告された対応内容</strong><ul>'+
          notes.map(note=>'<li>'+escape(note)+'</li>').join('')+'</ul>':
          '<p>具体的な対応内容の記載はありません。</p>')+
        '<p>※過去の利用者報告です。現在の条件は公式情報を確認してください。</p>'+
        '<a href="'+escape(row.event_url)+
          '" target="_blank" rel="noopener noreferrer">当時の抽選URL ↗</a>'+
        '</article>';
    }).join(''):
      '<p class="hint">'+(search?'検索に一致する記録はありません。':
        'まだアーカイブはありません。締切日時が確認できた現地対応必須の報告が、応募終了後に自動保存されます。')+'</p>';
    const more=$('lpOnsiteArchiveMore');
    more.hidden=matching.length<=lotteryOnsiteArchiveLimit;
    more.textContent='さらに表示（残り'+
      Math.max(0,matching.length-lotteryOnsiteArchiveLimit)+'件）';
  }

  function lotteryOnsiteHandleClick(event) {
    const button=event.target.closest('button[data-lp-onsite]');
    if(!button || !event.currentTarget.contains(button))return;
    const url=button.dataset.url;
    if(!safeLotteryUrl(url))return;
    if(!authUser || !supabaseClient){
      alert('現地対応の情報を共有するにはDiscordログインが必要です。閲覧はログイン不要です。');
      switchTab('group');return;
    }
    lotteryOnsiteOpenEditor(url);
  }

  function lotteryOnsiteOpenEditor(url) {
    if (!authUser || !safeLotteryUrl(url)) return;
    const existing=lotteryOnsiteMyReport(url);
    let dlg=$('lpOnsiteEditor');
    if(!dlg){
      dlg=document.createElement('dialog');
      dlg.id='lpOnsiteEditor';
      document.body.append(dlg);
      dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close();});
    }
    dlg.innerHTML=`<h3 tabindex="-1" autofocus data-dialog-title-focus>📍 みんなに現地対応情報を共有</h3>
      <p class="lp-tracker-intro">${escape(lotteryTrackItemName(url))}</p>
      <p class="lp-tracker-intro">ここで報告した「現地対応の要否・内容」は全ユーザーに表示されます。応募・当選・自分の完了状況は共有されません。</p>
      <form id="lpOnsiteForm">
        <label>現地対応の要否
          <select name="requirement" required>
            <option value="" disabled ${existing?'':'selected'}>選択してください</option>
            <option value="required" ${existing?.requirement==='required'?'selected':''}>現地で追加対応が必要</option>
            <option value="not_required" ${existing?.requirement==='not_required'?'selected':''}>現地対応は不要</option>
          </select></label>
        <label>対応内容・条件（500文字まで）<textarea name="details" maxlength="500" rows="4" placeholder="例：抽選前に店頭で会員登録が必要。対象店舗・期限なども記入してください。">${escape(existing?.details||'')}</textarea></label>
        <p class="lp-tracker-intro">※利用者による情報提供です。ほかの利用者と内容が異なる場合は両方の報告を表示します。公式ページで条件をご確認ください。</p>
        <div class="lp-track-modal-actions"><button type="submit" class="primary">全ユーザーに共有する</button><button type="button" id="lpOnsiteClose">閉じる</button>
          ${existing?'<button type="button" id="lpOnsiteDelete">自分の報告を削除</button>':''}</div>
        <p id="lpOnsiteMessage" role="status" aria-live="polite"></p>
      </form>`;
    $('lpOnsiteClose').addEventListener('click',()=>dlg.close());
    $('lpOnsiteDelete')?.addEventListener('click',async()=>{
      if(confirm('自分が共有した現地対応情報を削除しますか？'))await lotteryOnsiteDelete(url);
    });
    $('lpOnsiteForm').addEventListener('submit',async e=>{
      e.preventDefault();
      const fd=new FormData(e.currentTarget);
      await lotteryOnsiteSave(url,{requirement:String(fd.get('requirement')),
        details:String(fd.get('details')||'').trim().slice(0,500)});
    });
    showLotteryEditorDialog(dlg);
  }

  async function lotteryOnsiteSave(url,values) {
    if(lotteryOnsiteSaving || !authUser || !supabaseClient || !safeLotteryUrl(url))return;
    if(!['required','not_required'].includes(values.requirement))return;
    const uid=authUser.id;
    // Save event identity while the live event is still in the public feed.
    const item=lotteryItems.find(x=>x.url===url)||lotteryBaseItems.find(x=>x.url===url);
    const previous=lotteryOnsiteMyReport(url);
    const names=item?[...new Set(lotteryStoreEntries(item).map(x=>x.name).filter(Boolean))]:[];
    const areas=item?lotteryPrefectures(item):[];
    const end=item?lotteryDate(item.application_end_at):NaN;
    const payload={user_id:uid,event_url:url,requirement:values.requirement,
      details:String(values.details||'').slice(0,500),
      application_end_at:Number.isFinite(end)?new Date(end).toISOString():(previous?.application_end_at||null),
      store_name:String(names.join('・')||item?.store_name||previous?.store_name||'').slice(0,1000),
      prefecture:String(areas.join('・')||previous?.prefecture||'').slice(0,600),
      event_title:String(item?.official_event_title||item?.product_name||
        (item?.event_title_provisional?'':item?.event_title)||previous?.event_title||'').slice(0,500)};
    lotteryOnsiteSaving=true;
    const status=$('lpOnsiteMessage');
    if(status)status.textContent='共有内容を保存中…';
    try{
      const {data,error}=await supabaseClient.from(lotteryOnsiteTableFor(url))
        .upsert(payload,{onConflict:'user_id,event_url'})
        .select('user_id,event_url,requirement,details,updated_at,application_end_at,store_name,prefecture,event_title').single();
      if(error)throw error;
      if(authUser?.id!==uid)return;
      const record=lotteryOnsiteClean(data);
      if(record){
        const group=(lotteryOnsiteReports.get(url)||[]).filter(x=>x.user_id!==uid);
        lotteryOnsiteReports.set(url,[record,...group]);
      }
      lotteryOnsiteLastFetch=0;
      $('lpOnsiteEditor')?.close();
      renderLottery();renderLotteryTrackerSummary();
      refreshLotteryOnsiteReports(true);
    } catch(e) {
      if(authUser?.id===uid && status)status.textContent='保存失敗：'+String(e.message||e);
    } finally {lotteryOnsiteSaving=false;}
  }

  async function lotteryOnsiteDelete(url) {
    if(lotteryOnsiteSaving || !authUser || !supabaseClient || !safeLotteryUrl(url))return;
    const uid=authUser.id;
    lotteryOnsiteSaving=true;
    try{
      const {error}=await supabaseClient.from(lotteryOnsiteTableFor(url))
        .delete().eq('user_id',uid).eq('event_url',url);
      if(error)throw error;
      if(authUser?.id!==uid)return;
      lotteryOnsiteReports.set(url,(lotteryOnsiteReports.get(url)||[]).filter(x=>x.user_id!==uid));
      lotteryOnsiteLastFetch=0;
      $('lpOnsiteEditor')?.close();
      renderLottery();renderLotteryTrackerSummary();
      refreshLotteryOnsiteReports(true);
    } catch(e) {
      const status=$('lpOnsiteMessage');if(status)status.textContent='削除失敗：'+String(e.message||e);
    } finally {lotteryOnsiteSaving=false;}
  }

  // ========================================
  // 開発者専用：LivePocketの登録済みイベントを手動再確認
  // サーバーでもSupabase JWTを検証する。ブラウザにGitHub PATは置かない。
  // ========================================
  const LP_DEV_RECHECK_API = 'https://livepocket-backup-trigger.takahiro9455.workers.dev/admin/recheck';
  let lpDevRecheckBusy = false;
  const LP_DEV_RESULTS_URL = './livepocket_check_summary.json';
  let lpDevReportLoading = false;
  // A tap made while an automatic poll is active is queued, never discarded.
  let lpDevManualRefreshQueued = false;
  let lpDevResultSignature = '';
  let lpDevReportTimer = null;
  let lpDevReportSince = 0;
  let lpDevLastSeenManualRun = '';
  let lpDevWaitingPreviousRun = '';
  const LP_DEV_REPORT_POLL_MS = 15000;
  const LP_DEV_REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  function lpDevReportDate(value) {
    const date = new Date(value || '');
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',hour12:false
    }).format(date) : '不明';
  }

  function lpDevNumeric(stats, key) {
    const value = stats?.[key];
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  // v21.18: server-aggregated Japanese-calendar daily new event counts.
  // Counts originate from first-seen URL checkpoints, not update timestamps
  // or user-local storage. Render ONLY within the developer-only view.
  function lpDevDailyPanel() {
    if (!isDeveloper()) return null;
    let host = $('lpDevDailyPanel');
    if (!host) {
      const before = $('lpDevRecheckPanel');
      if (!before) return null;
      host = document.createElement('div');
      host.id = 'lpDevDailyPanel';
      host.className = 'store-tools lp-dev-recheck';
      host.innerHTML = '<h3>📈 今日の抽選追加数</h3><div id="lpDevDailyContent" role="status" aria-live="polite"></div>';
      before.before(host);
    }
    return $('lpDevDailyContent');
  }

  function renderLpDevDailyGrowth(daily) {
    const host = lpDevDailyPanel();
    if (!host) return;
    const valid = Number.isSafeInteger(daily?.today) && daily.today >= 0 &&
      Number.isSafeInteger(daily?.yesterday) && daily.yesterday >= 0 &&
      Number.isSafeInteger(daily?.last_7_days) && daily.last_7_days >= 0 &&
      Number.isSafeInteger(daily?.registered_total) && daily.registered_total >= 0 &&
      daily.source === 'v14_first_detected_urls' &&
      /^\d{4}-\d{2}-\d{2}$/.test(daily.date_jst || '');
    if (!valid) {
      host.innerHTML = '<p class="hint">新規追加数は集計準備中です。次のGitHub Actions成功後に「結果を更新」を押してください。</p>';
      return;
    }
    const localDay = new Intl.DateTimeFormat('sv-SE', {
      timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit'
    }).format(new Date());
    if (daily.date_jst !== localDay) {
      // Do not display yesterday's value under the heading "today".
      host.innerHTML = `<p class="hint">本日分は次の自動収集後に表示されます。直近の集計日：${escape(daily.date_jst)}（日本時間）</p>`;
      return;
    }
    const fields = [
      ['今日の新規追加', daily.today],
      ['昨日の新規追加', daily.yesterday],
      ['直近7日間の新規追加', daily.last_7_days],
      ['登録イベント総数', daily.registered_total]
    ];
    const since = /^\d{4}-\d{2}-\d{2}$/.test(daily.tracked_since_jst || '') ?
      daily.tracked_since_jst : '';
    host.innerHTML = `
      <p class="hint">${escape(daily.date_jst)}（日本時間）／最終集計 ${escape(lpDevReportDate(daily.as_of))}</p>
      <div class="lp-dev-results-grid">${fields.map(([label,count]) =>
        `<div class="lp-dev-result-cell"><span>${escape(label)}</span><strong>${count.toLocaleString('ja-JP')}</strong></div>`).join('')}</div>
      <p class="hint">※抽選イベントURLの初登録数です。受付終了を含み、手動再確認・名称変更・同一URLの再投稿は増加に含めません。</p>
      <p class="hint">※記録開始${since ? `：${escape(since)}（日本時間）` : '以前の日別内訳なし'}。それ以前の登録分を推測して加算しません。更新はGitHub Actions成功後「結果を更新」で反映されます。</p>`;
  }

  // v21.41: Only safe aggregate counts are rendered. No event URLs or
  // browser page content are included in the published developer summary.
  function lpDevFailureReasonsMarkup(stats) {
    const keys = [
      ['manual_fail_timeout','時間切れ','ページの読み込み時間が上限を超えた'],
      ['manual_fail_no_response','HTTP応答なし','ブラウザーがHTTP応答を取得できなかった'],
      ['manual_fail_http_error','HTTPエラー','対象ページがエラーを返した（詳細コードはCSVで確認）'],
      ['manual_fail_redirected','別ページへ移動','元のLivePocketイベントURLとは異なるページになった'],
      ['manual_fail_page_unconfirmed','イベント本文を確認できず','通信できてもイベント固有の本文を検証できなかった'],
      ['manual_fail_access_blocked','アクセス制限・確認画面','アクセス制限や確認画面などで読み取れなかった'],
      ['manual_fail_browser_error','ブラウザー処理のエラー','ブラウザーの処理中に例外が発生した'],
      ['manual_fail_other','その他・分類対象外','上記には含まれない取得不成功']
    ];
    // Old summaries were generated before these fields existed.
    if (!Object.hasOwn(stats, 'manual_fail_other')) {
      return '<section class="lp-dev-failure-report"><h4>🔎 取得できなかった理由</h4>'+
        '<p class="hint">詳しい内訳は、次回の手動再確認が完了した後に表示されます。</p></section>';
    }
    const checked = lpDevNumeric(stats,'manual_attempted');
    const successful = lpDevNumeric(stats,'manual_success');
    const failed = Math.max(0,checked-successful);
    const rows = keys.map(([key,label,description]) => ({
      label,description,count:lpDevNumeric(stats,key)
    }));
    const sum = rows.reduce((n,row) => n+row.count,0);
    const problems = rows.filter(row => row.count>0);
    const details = problems.length
      ? problems.map(row => '<div class="lp-dev-failure-reason">'+
        '<strong>'+escape(row.label)+' <span>'+row.count+'件</span></strong>'+
        '<p>'+escape(row.description)+'</p></div>').join('')
      : '<p class="hint">今回の手動確認ではページ取得の失敗は記録されていません。</p>';
    return '<section class="lp-dev-failure-report" aria-label="再確認の失敗理由">'+
      '<h4>🔎 取得できなかった理由</h4>'+
      '<p><strong>確認 '+checked+'件 ／ ページ取得成功 '+successful+
      '件 ／ 取得不成功 '+failed+'件</strong></p>'+
      '<div class="lp-dev-failure-list">'+details+'</div>'+
      (sum!==failed?'<p class="hint">※診断件数に不一致があります。集計処理の確認が必要です。</p>':'')+
      '<p class="hint">※上記はページ取得不成功の内訳で、重複しない集計です。'+
      '「公式イベント名が更新されなかった件数」とは別です。'+
      'イベント名・URLなどは集計データに含めません。</p></section>';
  }

  function lpDevReportMarkup(lastManual, lastRun) {
    if (!lastManual || !lastManual.completed_process_at) {
      return `<p class="hint">開発者ボタンによる再確認結果はまだありません。ボタンから実行し、GitHub Actionsの処理完了後に表示されます。</p>
      ${lastRun?.completed_process_at ? `<p class="hint">最新の自動処理：${escape(lpDevReportDate(lastRun.completed_process_at))}</p>` : ''}`;
    }
    const stats = lastManual.stats || {};
    const updates = lastManual.updates || {};
    const fields = [
      ['前回実行で選択した対象',lpDevNumeric(stats,'manual_selected')],
      ['実際にページ確認',lpDevNumeric(stats,'manual_attempted')],
      ['イベントページ取得成功',lpDevNumeric(stats,'manual_success')],
      ...(Object.hasOwn(stats,'manual_page_unconfirmed') ? [
        ['イベント本文を確認',lpDevNumeric(stats,'manual_page_event_confirmed')],
        ['イベントページと確認できず',lpDevNumeric(stats,'manual_page_unconfirmed')]
      ] : []),
      ['公式イベント名を検出',lpDevNumeric(stats,'manual_title_detected')],
      ['タイトル候補なし',lpDevNumeric(stats,'manual_title_no_candidates')],
      ['タイトル候補を未採用',lpDevNumeric(stats,'manual_title_rejected')],
      ...(Object.hasOwn(stats,'manual_title_site_common') ? [
        ['うちサイト共通名のみ',lpDevNumeric(stats,'manual_title_site_common')],
        ['うち候補が品質チェックを通過せず',lpDevNumeric(stats,'manual_title_filtered_all')],
        ['うち複数候補が競合',lpDevNumeric(stats,'manual_title_multiple_unresolved')],
        ['うち有効候補を確定できず',lpDevNumeric(stats,'manual_title_valid_unselected')]
      ] : []),
      ...(Object.hasOwn(stats,'manual_title_meta_template_cleaned') ? [
        ['公式ページのメタ情報を整形',lpDevNumeric(stats,'manual_title_meta_template_cleaned')],
        ['見出し・埋め込みデータの候補あり',lpDevNumeric(stats,'manual_title_heading_seen')],
        ...(Object.hasOwn(stats,'manual_title_dom_candidates') ? [
          ['イベント名専用要素の候補あり',lpDevNumeric(stats,'manual_title_dom_candidates')],
          ['ページ埋め込みデータの候補あり',lpDevNumeric(stats,'manual_title_state_candidates')]
        ] : []),
        ['省略されたタイトルを除外',lpDevNumeric(stats,'manual_title_truncated')],
        ...(Object.hasOwn(stats,'manual_title_truncated_tail') ? [
          ['末尾が省略された候補',lpDevNumeric(stats,'manual_title_truncated_tail')],
          ['途中に省略記号のある候補',lpDevNumeric(stats,'manual_title_truncated_inner')],
          ['文字化け候補',lpDevNumeric(stats,'manual_title_replacement_char')]
        ] : [])
      ] : []),
      ['タイトル取得のアクセス制限',lpDevNumeric(stats,'manual_title_access_blocked')],
      ['イベント名の更新',lpDevNumeric(stats,'manual_title_updated')],
      ['確認済み名称の補完',lpDevNumeric(stats,'manual_verified_titles_updated')],
      ['商品名の更新',lpDevNumeric(stats,'manual_product_updated')],
      ['応募日時の更新',lpDevNumeric(stats,'manual_deadline_updated')],
      ['店舗情報の更新',lpDevNumeric(stats,'manual_store_updated')],
      ['取得制限の検出',lpDevNumeric(stats,'manual_blocked')],
    ];
    const safeId = /^\d+$/.test(String(lastManual.run_id || '')) ? String(lastManual.run_id) : '';
    const runLink = safeId ? `<a href="https://github.com/ttttt-9554/pokeca-map/actions/runs/${safeId}" target="_blank" rel="noopener noreferrer">この実行をGitHubで確認 ↗</a>` : '';
    return `<p class="lp-dev-results-date"><strong>最終手動確認：</strong>${escape(lpDevReportDate(lastManual.completed_process_at))}</p>
      <div class="lp-dev-results-grid">${fields.map(([name,count]) => `<div class="lp-dev-result-cell"><span>${escape(name)}</span><strong>${Number.isSafeInteger(count) && count >= 0 ? count : 0}</strong></div>`).join('')}</div>
      ${lpDevFailureReasonsMarkup(stats)}
      <p class="hint">※「公式イベント名を検出」は更新件数とは異なります。取得できても既存名と同じ場合があります。</p>
      <p class="hint">※ 「イベントページと確認できず」は通信失敗と同義ではありません。HTTP応答があっても、イベント本文を確認できないページは正式名の自動反映に使いません。</p>
      <p class="hint">※ メタ情報の整形や見出し候補があっても、正式イベント名の検出・更新が成功したとは限りません。省略表示は採用せず、CSVには判定コードと件数だけを記録します。</p>
      <p class="hint">※これは上記の最終手動実行時の履歴です。「選択した対象」は現在の未解決件数ではありません。自動確認済み・手動で解決済み・応募終了したイベントは次回の再確認候補から除外し、確認失敗は間隔を空けて再試行します。</p>
      <p class="hint">※手動で選んだイベントのみの集計です。ページ取得に成功した対象の差分を数えています。通常収集での全体データ整形は含めません。取得制限中は確認を停止します。</p>
      ${runLink}`;
  }

  // v21.40: Immediate feedback on manual result refresh, even when the
  // published JSON is unchanged or another request is already running.
  async function loadLotteryDevResults({manual = false} = {}) {
    const output = $('lpDevResultsContent');
    const state = $('lpDevResultsState');
    const button = $('lpDevResultsRefresh');
    if (!output || !state) return;

    if (!isDeveloper()) {
      if (manual) state.textContent = '⚠ 開発者としてログインしてください。';
      return;
    }
    if (lpDevReportLoading) {
      if (manual) {
        lpDevManualRefreshQueued = true;
        state.textContent = '⏳ 結果を取得中です。完了後に最新データを再確認します…';
        if (button) {
          button.disabled = true;
          button.textContent = '更新待ち…';
        }
      }
      return;
    }

    lpDevReportLoading = true;
    if (manual) {
      if (button) {
        button.disabled = true;
        button.textContent = '更新中…';
        button.setAttribute('aria-busy','true');
      }
      state.textContent = '🔄 最新の再確認結果を取得しています…';
    }
    const previousSignature = lpDevResultSignature;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let abortTimer = null;
    try {
      if (controller) abortTimer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(LP_DEV_RESULTS_URL + '?t=' + Date.now(), {
        cache:'no-store',
        signal: controller ? controller.signal : undefined
      });
      if (response.status === 404) {
        state.textContent = '結果ファイルはまだありません。GitHub Actionsの実行完了後に再度更新してください。';
        renderLpDevDailyGrowth(null);
        output.replaceChildren();
        return;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const result = await response.json();
      if (!result || result.schema_version !== 1) throw new Error('結果データの形式が異なります');
      renderLpDevDailyGrowth(result.daily_additions);
      const lastManual = result.last_manual;
      if (lastManual?.run_id) lpDevLastSeenManualRun = String(lastManual.run_id);
      const signature = [
        lastManual?.run_id || '',
        lastManual?.completed_process_at || '',
        result.last_run?.run_id || '',
        result.last_run?.completed_process_at || '',
        result.daily_additions?.as_of || ''
      ].join('|');
      lpDevResultSignature = signature;

      const viewedAt = new Intl.DateTimeFormat('ja-JP',{
        timeZone:'Asia/Tokyo', hour:'2-digit',minute:'2-digit',second:'2-digit',
        hour12:false
      }).format(new Date());
      const same = previousSignature && previousSignature === signature;
      state.textContent = manual
        ? '✅ '+viewedAt+' に確認しました。'+
          (same?'公開結果は前回と同じです。GitHub Actions完了後に更新されます。':
            '公開結果を読み込みました。')
        : '結果を取得しました。';
      output.innerHTML = lpDevReportMarkup(lastManual, result.last_run);
      if (lpDevReportSince && lastManual?.completed_process_at) {
        const checkedAt = Date.parse(lastManual.completed_process_at);
        // Old reports must not be treated as this button press's result.
        const isNewRun = String(lastManual.run_id || '') !== lpDevWaitingPreviousRun;
        if (isNewRun && Number.isFinite(checkedAt) && checkedAt >= lpDevReportSince - 10000) {
          clearInterval(lpDevReportTimer);
          lpDevReportTimer = null;
          lpDevReportSince = 0;
          state.textContent = '✅ 今回の手動再確認の結果が反映されました（確認 '+viewedAt+'）。';
          loadLotteryEvents(true);
        }
      }
    } catch (error) {
      // Keep previously fetched results visible when a network check fails.
      state.textContent = error?.name === 'AbortError'
        ? '⚠ 読み込みが15秒を超えました。通信を確認してもう一度「結果を更新」を押してください。'
        : '⚠ 結果を取得できませんでした：'+(error?.message || '通信エラー');
      console.warn('再確認の結果取得エラー:',error);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      lpDevReportLoading = false;
      if (button) {
        button.disabled = false;
        button.textContent = '結果を更新';
        button.removeAttribute('aria-busy');
      }
      if (lpDevManualRefreshQueued) {
        lpDevManualRefreshQueued = false;
        // Follow the user's explicit tap with a fresh no-cache request.
        queueMicrotask(() => loadLotteryDevResults({manual:true}));
      }
    }
  }

  function watchLotteryDevResults(startTime) {
    if (lpDevReportTimer) clearInterval(lpDevReportTimer);
    lpDevReportSince = startTime;
    lpDevWaitingPreviousRun = lpDevLastSeenManualRun;
    lpDevReportTimer = setInterval(() => {
      if (!isDeveloper() || Date.now() - lpDevReportSince > LP_DEV_REPORT_TIMEOUT_MS) {
        clearInterval(lpDevReportTimer);
        lpDevReportTimer = null;
        lpDevReportSince = 0;
        const state = $('lpDevResultsState');
        if (state && isDeveloper()) state.textContent = '反映待ちです。GitHub Actionsを確認するか、「結果を更新」を押してください。';
        return;
      }
      loadLotteryDevResults();
    }, LP_DEV_REPORT_POLL_MS);
  }


  // v21.24: The developer tab itself is an explicit on-demand refresh.
  // The previous dedicated button remains available for an explicit retry.
  // Both use the same JWT-protected Cloudflare Worker; never expose a PAT.
  async function requestLotteryDevRecheck({automatic = false} = {}) {
    const button = $('lpDevRecheckButton');
    const status = $('lpDevRecheckStatus');
    if (!button || !status || !isDeveloper()) return;
    // Do not dispatch a second workflow while the current request/run is pending.
    if (lpDevRecheckBusy || lpDevReportSince) {
      if (!automatic) status.textContent = 'すでに再確認中です。完了後にもう一度操作してください。';
      return;
    }
    if (!supabaseClient) {
      status.textContent = '開発者としてDiscordログインしてください。';
      return;
    }
    if (!automatic && !window.confirm('未解決の抽選イベントを最大12件、GitHub Actionsで再確認しますか？\n通常の自動収集は停止しません。')) return;
    lpDevRecheckBusy = true;
    button.disabled = true;
    button.textContent = 'GitHubに起動依頼中…';
    status.textContent = automatic
      ? '開発タブを開いたため、登録済み抽選の再確認を起動しています…'
      : 'ログインを検証し、確認処理を起動しています…';
    try {
      const {data, error} = await supabaseClient.auth.getSession();
      if (error || !data?.session?.access_token) throw new Error('ログイン情報が期限切れです。共有タブでログインし直してください。');
      if (data.session.user?.id !== DEVELOPER_USER_ID) throw new Error('開発者権限を確認できません。');
      const response = await fetch(LP_DEV_RECHECK_API, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + data.session.access_token
        },
        body: JSON.stringify({batch: 12})
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'サーバー応答 HTTP ' + response.status);
      status.textContent = '✅ 再確認を起動しました。GitHub Actions完了後に結果を自動反映します。';
      watchLotteryDevResults(Date.now());
      loadLotteryDevResults();
    } catch (error) {
      status.textContent = '⚠ ' + (error?.message || '起動できませんでした。');
    } finally {
      lpDevRecheckBusy = false;
      button.disabled = false;
      button.textContent = '未解決の抽選を最大12件再確認';
    }
  }


  // v21.42: Developer-assisted corrections for event names the parser could
  // not verify. GitHub credentials are NEVER placed in a browser bundle.
  // Drafts stay on this device; approval happens by committing the exported
  // allowlisted CSV to the existing GitHub repository.
  const LP_MANUAL_DRAFT_KEY = 'pokeca-livepocket-title-fixes-v1';
  const LP_MANUAL_GITHUB_EDITOR =
    'https://github.com/ttttt-9554/pokeca-map/edit/main/livepocket_verified_titles.csv';
  const LP_MANUAL_REASONS = {
    event_page_unconfirmed:'イベント本文を確認できず',
    fetch_failed:'ページ取得を確認できず',
    title_candidates_rejected:'イベント名候補を採用できず',
    no_title_candidates:'イベント名候補なし',
    access_blocked:'アクセス制限・認証画面',
    wrong_event_url:'別のイベントURL',
    invalid_fetch_result:'確認データを取得できず'
  };
  let lpManualRows = [];
  let lpManualOriginal = [];
  let lpManualDrafts = {};
  let lpManualLoaded = false;
  let lpManualBusy = false;
  let lpManualEditing = '';

  // A proper quote-aware CSV reader: Japanese titles may contain commas or
  // quoted text. Invalid/missing columns must never be silently overwritten.
  function lpManualParseCsv(text) {
    const lines=[], row=[];
    let field='', quoted=false;
    const input=String(text||'').replace(/^\uFEFF/,'');
    for(let i=0;i<input.length;i++) {
      const c=input[i];
      if(quoted) {
        if(c==='"' && input[i+1]==='"'){field+='"';i++;}
        else if(c==='"'){quoted=false;}
        else field+=c;
      }else if(c==='"'){quoted=true;}
      else if(c===','){row.push(field);field='';}
      else if(c==='\n'){row.push(field);if(row.some(v=>v!==''))lines.push(row.slice());row.length=0;field='';}
      else if(c!=='\r'){field+=c;}
    }
    if(quoted)throw Error('CSVに閉じられていない引用符があります');
    if(field || row.length){row.push(field);lines.push(row.slice());}
    if(!lines.length)throw Error('CSVが空です');
    const head=lines.shift();
    if(new Set(head).size!==head.length)throw Error('CSV列名が重複しています');
    return {header:head,rows:lines.map(parts=>{
      const data={};
      head.forEach((name,index)=>{data[name]=parts[index]??'';});
      return data;
    })};
  }

  function lpManualCsvLine(values) {
    return values.map(value=>{
      const s=String(value??'');
      return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
    }).join(',');
  }

  function lpManualValidTitle(value) {
    const title=String(value||'').replace(/\s+/g,' ').trim();
    if(title.length<5 || title.length>160 ||
       /(\.\.\.|…|https?:\/\/|[\uFFFD„<>]|\b(?:captcha|access denied|just a moment|403 forbidden|robot check)\b|アクセスが制限|チケット購入・予約・販売)/i.test(title) ||
       /[\x00-\x1F\x7F]/.test(title) ||
       /[-–—|｜]\s*(LivePocket(?:-Ticket-)?|ライヴポケット)\s*$/i.test(title) ||
       ['イベント','イベント情報','チケット','チケット情報','受付中'].includes(title)) return '';
    return title;
  }

  function lpManualValidUrl(url) {
    return /^https:\/\/livepocket\.jp\/e\/[a-zA-Z0-9_-]{4,64}$/.test(url||'');
  }

  function lpManualSaveDrafts() {
    try { localStorage.setItem(LP_MANUAL_DRAFT_KEY,JSON.stringify(lpManualDrafts)); }
    catch(error) { throw Error('端末に下書きを保存できません：'+(error?.message||error)); }
  }

  function lpManualInitUI() {
    if($('lpManualPanel'))return;
    const before=$('lpDevRecheckPanel');
    if(!before)return;
    const section=document.createElement('section');
    section.id='lpManualPanel';
    section.className='store-tools lp-dev-manual-panel';
    section.innerHTML='<h3>🛠️ 取得失敗イベントの手動修正</h3>'+
      '<p class="hint">自動取得できなかったイベントを一覧で確認し、公式ページ・公式画面のスクリーンショットから正式イベント名を入力できます。'+
      '開発者として「保存して反映」を押すとSupabaseへ保存され、全ユーザーの一覧へ反映されます。既存のCSVはバックアップ用に残します。</p>'+
      '<button type="button" id="lpManualLoad">失敗候補を読み込む</button>'+
      '<p id="lpManualStatus" class="hint" role="status" aria-live="polite">未読み込み</p>'+ 
      '<p id="lpManualFeedback" class="hint" role="status" aria-live="polite"></p>'+
      '<div id="lpManualList"></div>'+ 
      '<div id="lpManualResolved" class="lp-manual-resolved"></div>'+
      '<details id="lpManualExportLegacy" class="lp-manual-legacy">'+
      '<summary>旧方式：CSVバックアップ（通常は操作不要）</summary>'+
      '<div id="lpManualExport" hidden>'+
      '<p class="hint"><strong>修正CSVの確定</strong>：下書きに追加したものを、既存の承認済みイベント名を残して統合します。'+
      'GitHubへ反映するまでは公開データは変わりません。</p>'+
      '<div class="lp-manual-export-buttons">'+
      '<button type="button" id="lpManualCopy">GitHub用CSVをコピー</button>'+
      '<button type="button" id="lpManualDownload">CSVを保存</button></div>'+
      '<a href="'+LP_MANUAL_GITHUB_EDITOR+'" target="_blank" rel="noopener noreferrer">GitHubでCSVを編集 ↗</a>'+
      '<p class="hint">GitHubで <code>livepocket_verified_titles.csv</code> の内容を丸ごと置き換え、Commit changesを押してください。'+
      '次の収集処理で反映されます。GitHubの権限が必要です。</p></div></details>';
    before.after(section);
    const dialog=document.createElement('dialog');
    dialog.id='lpManualEditor';
    dialog.setAttribute('aria-label','失敗イベントの正式名称を手動修正');
    dialog.innerHTML='<h3 tabindex="-1" autofocus id="lpManualEditorTitle">正式イベント名の手動修正</h3>'+
      '<p id="lpManualEditorDescription" class="hint"></p>'+
      '<form id="lpManualForm">'+
      '<label>正式イベント名（5〜160文字）<textarea name="event_title" rows="4" maxlength="160" required placeholder="公式ページに実際に掲載されている正式名称"></textarea></label>'+
      '<label>確認できた証拠の種類<select name="evidence" required>'+
      '<option value="" selected disabled>選択してください</option>'+
      '<option value="official_page_viewed">同じURLの公式イベントページを確認</option>'+
      '<option value="official_screenshot_viewed">同じURLの公式画面スクリーンショットを確認</option></select></label>'+
      '<label class="lp-manual-consent"><input type="checkbox" name="confirmed" required>このイベントURLと正式名称が一致することを自分で確認しました</label>'+
      '<div class="lp-manual-export-buttons">'+
      '<button type="submit" class="primary">保存して全ユーザーに反映</button>'+
      '<button type="button" id="lpManualClose">閉じる</button>'+
      '<button type="button" id="lpManualRemoveDraft">下書きを削除</button></div>'+
      '<p id="lpManualEditorStatus" class="hint" role="status" aria-live="polite"></p></form>';
    document.body.append(dialog);
    try {
      const stored=JSON.parse(localStorage.getItem(LP_MANUAL_DRAFT_KEY)||'{}');
      if(stored && typeof stored==='object' && !Array.isArray(stored))lpManualDrafts=stored;
    }catch(ignore){}
    $('lpManualLoad').addEventListener('click',lpManualLoad);
    section.addEventListener('click',async event=>{
      const name=event.target.closest('button[data-manual-url]');
      if(name && section.contains(name)){lpManualOpen(name.dataset.manualUrl);return;}
      const button=event.target.closest('button[data-cloud-remove]');
      if(button && section.contains(button) && isDeveloper()) {
        const url=button.dataset.cloudRemove;
        if(!window.confirm('このイベントのクラウド修正を解除しますか？\n自動収集の元データが再び表示されます。'))return;
        button.disabled=true;
        try{
          await lpCloudRemove(url);
          lpManualRender();
          $('lpManualStatus').textContent='✅ クラウド修正を解除しました。';
        }catch(error){
          $('lpManualStatus').textContent='⚠ 解除できませんでした：'+(error?.message||error);
          button.disabled=false;
        }
      }
    });
    $('lpManualCopy').addEventListener('click',()=>lpManualExport('copy'));
    $('lpManualDownload').addEventListener('click',()=>lpManualExport('download'));
    $('lpManualClose').addEventListener('click',()=>dialog.close());
    $('lpManualRemoveDraft').addEventListener('click',()=>{
      if(!isDeveloper()||!lpManualEditing)return;
      delete lpManualDrafts[lpManualEditing];
      try{lpManualSaveDrafts();}catch(error){$('lpManualEditorStatus').textContent=error.message;return;}
      dialog.close();
      lpManualRender();
    });
    $('lpManualForm').addEventListener('submit',async event=>{
      event.preventDefault();
      if(!isDeveloper()||!lpManualValidUrl(lpManualEditing))return;
      const form=event.currentTarget,fd=new FormData(form);
      const title=lpManualValidTitle(fd.get('event_title'));
      const evidence=String(fd.get('evidence')||'');
      if(!title||!['official_page_viewed','official_screenshot_viewed'].includes(evidence)||
          fd.get('confirmed')!=='on'){
        $('lpManualEditorStatus').textContent='正式名称・証拠・確認チェックを見直してください。';
        return;
      }
      const url=lpManualEditing;
      const button=form.querySelector('button[type=submit]');
      button.disabled=true;button.textContent='クラウドに保存中…';
      $('lpManualEditorStatus').textContent='🔄 Supabaseへ保存しています…';
      try{
        await lpCloudSave({
          event_url:url,resolution:'title',event_title:title,
          reason:null,evidence
        });
        // Local drafts must not be exported again after successful publishing.
        delete lpManualDrafts[url];
        try{lpManualSaveDrafts();}catch(ignore){}
        $('lpManualEditor').close();
        lpManualRender();
        $('lpManualFeedback').textContent='✅ 正式イベント名を保存しました。エラー一覧から対応済みに移動しました。';
      }catch(error){
        $('lpManualEditorStatus').textContent='⚠ 保存できませんでした：'+(error?.message||error)+
          '。入力内容は残っています。Supabase設定を確認してください。';
      }finally{
        button.disabled=false;button.textContent='保存して全ユーザーに反映';
      }
    });
    dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  }

  async function lpManualLoad() {
    if(!isDeveloper())return;
    if(lpManualBusy)return;
    lpManualBusy=true;
    const btn=$('lpManualLoad'),status=$('lpManualStatus');
    btn.disabled=true;
    btn.textContent='読込中…';
    status.textContent='🔄 失敗候補と現在の承認済み修正を取得しています…';
    try {
      // Pull current public deadlines so a stale diagnostic row never forces
      // the developer to correct an already expired application.
      await loadLotteryEvents();
      const suffix='?v='+Date.now();
      const [failed,approved] = await Promise.all([
        fetch('./livepocket_content_checks.csv'+suffix,{cache:'no-store'}),
        fetch('./livepocket_verified_titles.csv'+suffix,{cache:'no-store'})
      ]);
      if(!failed.ok||!approved.ok)throw Error('CSV取得 HTTP '+failed.status+'/'+approved.status);
      const source=lpManualParseCsv(await failed.text());
      const verified=lpManualParseCsv(await approved.text());
      for(const column of ['url','title_diagnostic_reason','event_title','title_diagnostic_checked_at']) {
        if(!source.header.includes(column))throw Error('抽選チェックCSVに列がありません：'+column);
      }
      for(const column of ['url','event_title','evidence','approved']) {
        if(!verified.header.includes(column))throw Error('承認済みCSVに列がありません：'+column);
      }
      lpManualOriginal=verified.rows;
      const done=new Set(verified.rows.filter(x=>x.approved==='yes').map(x=>x.url));
      const now=Date.now();
      lpManualRows=source.rows.filter(row=>
        lpManualValidUrl(row.url) &&
        !lpApplicationExpired(row.url,row.application_end_at,now) &&
        Object.hasOwn(LP_MANUAL_REASONS,row.title_diagnostic_reason||'') &&
        !done.has(row.url) &&
        !['v21_9_official_exact_url_title','v21_13_verified_manual_exact_url'].includes(row.title_source||'')
      ).sort((a,b)=>String(b.title_diagnostic_checked_at).localeCompare(String(a.title_diagnostic_checked_at)));
      await lpCloudRefresh(true);
      const loadedUrls=new Set(lpManualRows.map(row=>row.url));
      for(const record of lpCloudOverrides.values()) {
        if(!loadedUrls.has(record.event_url)){
          lpManualRows.push({url:record.event_url,event_title:record.event_title||'',
            title_diagnostic_reason:'fetch_failed',title_diagnostic_checked_at:record.updated_at||''});
          loadedUrls.add(record.event_url);
        }
      }
      lpManualLoaded=true;
      lpManualRender();
      await lpMissingLoad();
    }catch(error) {
      status.textContent='⚠ 失敗候補を読み込めませんでした：'+(error?.message||error);
    }finally {
      btn.disabled=false;
      btn.textContent='失敗候補を再読み込み';
      lpManualBusy=false;
    }
  }

  // v21.45: keep an editable "対応済み" area separate from unresolved failures.
  // Do not interpret a local title draft as already published. A local
  // "pending" decision is handled separately from public corrections.
  function lpManualRender() {
    if(!isDeveloper())return;
    const list=$('lpManualList'),status=$('lpManualStatus');
    const resolved=$('lpManualResolved');
    if(!list||!status)return;
    const validDrafts=Object.entries(lpManualDrafts).filter(([url,data])=>
      lpManualValidUrl(url)&&lpManualValidTitle(data?.event_title)&&
      ['official_page_viewed','official_screenshot_viewed'].includes(data?.evidence));
    $('lpManualExport').hidden=validDrafts.length===0||!lpManualLoaded;
    // CSV export remains a legacy backup option, not the primary save flow.
    const missingExport=$('lpMissingExport');
    if(missingExport){
      const eligible=new Set(lpManualRows.map(x=>x.url));
      missingExport.hidden=!(lpMissingLoaded&&Object.entries(lpMissingDrafts)
        .some(([url,draft])=>eligible.has(url)&&
          (Object.hasOwn(LP_MISSING_EVIDENCE,draft?.reason)||
          (draft?.reason==='clear'&&lpMissingOriginal.some(x=>x.url===url&&x.approved==='yes')))));
    }
    if(!lpManualLoaded) {
      status.textContent='未読み込み（端末内の下書き '+validDrafts.length+'件）';
      return;
    }
    const byUrl=new Map();
    for(const row of lpManualRows)if(lpManualValidUrl(row.url))byUrl.set(row.url,row);
    // Old CSV registrations are considered resolved. Keep them accessible.
    for(const row of lpManualOriginal)if(row.approved==='yes'&&lpManualValidUrl(row.url)&&!byUrl.has(row.url)){
      const v={url:row.url,event_title:row.event_title||'',title_diagnostic_reason:'',title_diagnostic_checked_at:''};
      byUrl.set(row.url,v);lpManualRows.push(v);
    }
    for(const [url,draft] of Object.entries(lpMissingDrafts)){
      if(draft?.reason==='pending'&&lpManualValidUrl(url)&&!byUrl.has(url)){
        const v={url,event_title:'判断保留のイベント',title_diagnostic_reason:'fetch_failed'};
        byUrl.set(url,v);lpManualRows.push(v);
      }
    }
    const doneTitles=new Set(lpManualOriginal.filter(x=>x.approved==='yes').map(x=>x.url));
    const doneMissing=new Set(lpMissingOriginal.filter(x=>x.approved==='yes').map(x=>x.url));
    const finished=[],pending=[],unresolved=[];
    let excludedClosed=0;
    const now=Date.now();
    for(const row of byUrl.values()){
      const override=lpCloudOverrides.get(row.url);
      const onHold=lpMissingDrafts[row.url]?.reason==='pending';
      if(override||doneTitles.has(row.url)||doneMissing.has(row.url))finished.push(row);
      else if(lpApplicationExpired(row.url,row.application_end_at,now))excludedClosed++;
      else if(onHold)pending.push(row);
      else unresolved.push(row);
    }
    const cloudError=!lpCloudReady?' ⚠ クラウド未接続：'+(lpCloudError||'Supabase設定を確認'):''; 
    status.textContent='要確認 '+unresolved.length+'件 ／ 対応済み '+finished.length+
      '件 ／ 保留 '+pending.length+'件'+
      (excludedClosed?' ／ 応募終了で確認不要 '+excludedClosed+'件':'')+cloudError;
    list.innerHTML=unresolved.length?unresolved.slice(0,100).map(row=>{
      const draft=lpManualDrafts[row.url];
      const reason=LP_MANUAL_REASONS[row.title_diagnostic_reason]||'手動確認が必要';
      const title=(row.event_title||row.store_name||'イベント名未確認').slice(0,150);
      const checked=row.title_diagnostic_checked_at?lpDevReportDate(row.title_diagnostic_checked_at):'不明';
      return '<div class="lp-manual-row"><div><strong>'+escape(title)+'</strong>'+
        '<p>'+escape(reason)+' ／ 確認：'+escape(checked)+'</p>'+
        (draft?'<p class="lp-manual-ready">📝 入力中：'+escape(draft.event_title)+'</p>':'')+
        '<a href="'+escape(row.url)+'" target="_blank" rel="noopener noreferrer">公式ページを確認 ↗</a>'+
        '</div><div class="lp-manual-row-actions">'+
        '<button type="button" data-manual-url="'+escape(row.url)+'">名前を修正</button>'+
        '<button type="button" data-missing-url="'+escape(row.url)+'">ページなし・保留</button></div></div>';
    }).join('')+(unresolved.length>100?'<p class="hint">先頭100件を表示しています。</p>':'')
      :'<p class="hint">✅ 現在のエラーリストに未対応の候補はありません。</p>';
    if(resolved) {
      const renderResolved=(row,onHold)=>{
        const cloud=lpCloudOverrides.get(row.url);
        const savedTitle=cloud?.resolution==='title'?cloud.event_title:
          lpManualOriginal.find(x=>x.url===row.url&&x.approved==='yes')?.event_title;
        const originalReason=lpMissingOriginal.find(x=>x.url===row.url&&x.approved==='yes')?.reason;
        const state=onHold?'⏳ 判断保留（このiPhoneのみ）':
          cloud?.resolution==='unavailable'?'🚫 ページなし（公開済み）':
          cloud?.resolution==='active'?'✅ ページ復旧（公開済み）':
          cloud?.resolution==='title'?'✅ イベント名修正（公開済み）':
          doneMissing.has(row.url)?'🚫 ページなし（CSV登録済み）':
          '✅ イベント名修正（CSV登録済み）';
        return '<div class="lp-manual-row"><div>'+
          '<strong>'+escape(savedTitle||row.event_title||row.url)+'</strong>'+
          '<p>'+escape(state)+'</p>'+
          (originalReason&&!cloud?'<p>以前の記録：'+escape(LP_MISSING_LABELS[originalReason]||originalReason)+'</p>':'')+
          '<a href="'+escape(row.url)+'" target="_blank" rel="noopener noreferrer">公式ページ ↗</a>'+
          '</div><div class="lp-manual-row-actions">'+
          '<button type="button" data-manual-url="'+escape(row.url)+'">名称を編集</button>'+
          '<button type="button" data-missing-url="'+escape(row.url)+'">状態を編集</button>'+
          (cloud?'<button type="button" data-cloud-remove="'+escape(row.url)+'">修正を解除</button>':'')+
          '</div></div>';
      };
      const records=[...finished.map(row=>renderResolved(row,false)),
        ...pending.map(row=>renderResolved(row,true))];
      // v21.46: Fold resolved entries initially and preserve the opened state
      // whenever the list re-renders during a background refresh or save.
      const wasExpanded=resolved.querySelector('details.lp-manual-fold')?.open===true;
      resolved.innerHTML='<details class="lp-manual-fold">'+
        '<summary class="lp-manual-fold-summary">'+
          '<span class="lp-manual-fold-label">✅ 対応済み・判断保留</span>'+
          '<span class="lp-manual-fold-count">'+records.length+'件</span>'+
          '<span class="lp-manual-fold-chevron" aria-hidden="true"></span>'+
        '</summary>'+
        '<div class="lp-manual-fold-content">'+
          '<p class="hint">保存した項目は上のエラー一覧に出ません。ここから編集・解除できます。</p>'+
          (records.length?records.join(''):'<p class="hint">まだ対応済みの記録はありません。</p>')+
        '</div></details>';
      if(wasExpanded)resolved.querySelector('details.lp-manual-fold').open=true;
    }
  }

  function lpManualOpen(url) {
    if(!isDeveloper()||!lpManualLoaded||!lpManualRows.some(row=>row.url===url))return;
    const dialog=$('lpManualEditor');
    lpManualEditing=url;
    const row=lpManualRows.find(record=>record.url===url);
    const draft=lpManualDrafts[url];
    $('lpManualEditorDescription').textContent=
      '対象：'+url+' ／ 現在の候補：'+(row.event_title||'未確認')+
      '。公式ページを開き、表示される名称をそのまま入力してください。';
    const form=$('lpManualForm');
    form.reset();
    const cloud=lpCloudOverrides.get(url);
    form.elements.namedItem('event_title').value=draft?.event_title||
      (cloud?.resolution==='title'?cloud.event_title:'')||'';
    form.elements.namedItem('evidence').value=draft?.evidence||
      (cloud?.resolution==='title'?cloud.evidence:'')||'';
    form.elements.namedItem('confirmed').checked=false;
    $('lpManualEditorStatus').textContent='';
    $('lpManualRemoveDraft').hidden=!draft;
    dialog.showModal();
    $('lpManualEditorTitle').focus({preventScroll:true});
  }

  function lpManualBuildCsv() {
    if(!lpManualLoaded)throw Error('先に失敗候補を読み込んでください');
    const map=new Map();
    for(const row of lpManualOriginal) {
      if(lpManualValidUrl(row.url))map.set(row.url,{
        url:row.url,event_title:row.event_title,evidence:row.evidence,approved:row.approved
      });
    }
    const eligible=new Set(lpManualRows.map(row=>row.url));
    let additions=0;
    for(const [url,fix] of Object.entries(lpManualDrafts)) {
      if(!eligible.has(url) || !lpManualValidUrl(url))continue;
      const title=lpManualValidTitle(fix?.event_title);
      if(!title || !['official_page_viewed','official_screenshot_viewed'].includes(fix?.evidence))continue;
      // Do not override previously approved independent claims in the CSV.
      if(map.has(url)&&map.get(url).approved==='yes')continue;
      map.set(url,{url,event_title:title,evidence:fix.evidence,approved:'yes'});
      additions++;
    }
    if(additions===0)throw Error('出力する新しい修正下書きがありません');
    const header=['url','event_title','evidence','approved'];
    return {total:additions,text:[lpManualCsvLine(header),
      ...Array.from(map.values(), row=>lpManualCsvLine(header.map(key=>row[key]||'')))
    ].join('\r\n')+'\r\n'};
  }

  async function lpManualExport(mode) {
    if(!isDeveloper())return;
    const status=$('lpManualStatus');
    let csv;
    try{csv=lpManualBuildCsv();}
    catch(error){status.textContent='⚠ '+error.message;return;}
    if(mode==='copy') {
      try {
        if(navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(csv.text);
        }else{
          const area=document.createElement('textarea');
          area.value=csv.text;area.style.position='fixed';area.style.opacity='0';
          document.body.append(area);area.select();
          const ok=document.execCommand('copy');area.remove();
          if(!ok)throw Error('このiPhoneでコピーできません');
        }
        status.textContent='✅ '+csv.total+'件の修正を含むCSVをコピーしました。GitHubで貼り付けてCommitしてください。';
      }catch(error){status.textContent='⚠ コピーできませんでした。CSVを保存するボタンをお試しください。';}
    }else{
      const blob=new Blob(['\uFEFF'+csv.text],{type:'text/csv;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=url;link.download='livepocket_verified_titles.csv';
      document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),2000);
      status.textContent='✅ '+csv.total+'件の修正CSVを作成しました。GitHubへファイルを反映してください。';
    }
  }


  // v21.44: A page that is confirmed absent has a different meaning from
  // a title extraction failure or a transient browser/connection problem.
  // Nothing is deleted. The only published action is via a reviewed GitHub CSV.
  const LP_MISSING_DRAFT_KEY='pokeca-livepocket-page-status-v1';
  const LP_MISSING_CSV_EDITOR=
    'https://github.com/ttttt-9554/pokeca-map/edit/main/livepocket_verified_unavailable.csv';
  const LP_MISSING_EVIDENCE={
    not_found_404_410:'observed_404_410',
    official_removed_notice:'official_notice_viewed'
  };
  const LP_MISSING_LABELS={
    not_found_404_410:'404／410（ページが見つからない・削除済み）',
    official_removed_notice:'公式ページに削除・非公開の案内あり',
    pending:'判定保留（通信エラー・ログイン・確認画面など）',
    clear:'ページの復旧を確認・登録解除'
  };
  let lpMissingLoaded=false,lpMissingOriginal=[],lpMissingDrafts={};
  let lpMissingEditing='';

  function lpMissingInitUI() {
    if($('lpMissingPanel'))return;
    const manual=$('lpManualPanel');
    if(!manual)return;
    const pane=document.createElement('section');
    pane.id='lpMissingPanel';
    pane.innerHTML='<h4>🚫 ページなし・再確認待ちの管理</h4>'+
      '<p class="hint">ページが消えた場合は404／410や公式の削除案内を確認して記録します。'+
      '通信失敗・ログイン画面・アクセス制限だけの場合は「判断保留」にしてください。'+
      'ページが復旧した場合は登録解除できます。イベント・応募履歴は削除されません。</p>'+
      '<p id="lpMissingStatus" class="hint" role="status" aria-live="polite">候補一覧の読込後に使えます。</p>'+
      '<details class="lp-manual-legacy"><summary>旧方式：ページ状態CSVバックアップ</summary>'+
      '<div id="lpMissingExport" hidden>'+
      '<div class="lp-manual-export-buttons">'+
      '<button type="button" id="lpMissingCopy">ページ状態CSVをコピー</button>'+
      '<button type="button" id="lpMissingDownload">ページ状態CSVを保存</button></div>'+
      '<a href="'+LP_MISSING_CSV_EDITOR+'" target="_blank" rel="noopener noreferrer">GitHubでページ状態CSVを編集 ↗</a>'+
      '<p class="hint">ファイル名：livepocket_verified_unavailable.csv。'+
      '既存の確認記録を残して統合した内容です。GitHubに貼り付けてCommitすると、次の収集処理で反映されます。'+
      '誤って登録した場合も「ページの復旧を確認」を選んで再出力できます。</p></div></details>';
    manual.append(pane);
    const dialog=document.createElement('dialog');
    dialog.id='lpMissingDialog';
    dialog.setAttribute('aria-label','LivePocketのページ状態を手動確認');
    dialog.innerHTML='<h3 id="lpMissingHeading" tabindex="-1" autofocus>公式ページの状態を記録</h3>'+
      '<p id="lpMissingDescription" class="hint"></p>'+
      '<form id="lpMissingForm">'+
      '<label>公式ページを確認した結果<select name="reason" required>'+
      '<option value="" selected disabled>選択してください</option>'+
      '<option value="not_found_404_410">404／410 と確認した</option>'+
      '<option value="official_removed_notice">公式の削除・非公開案内を確認した</option>'+
      '<option value="pending">一時的に開けない・不明（判断保留）</option>'+
      '<option value="clear">ページが復旧した（登録解除）</option></select></label>'+
      '<p class="hint">※アクセス制限や通信エラーのみで「ページなし」と確定しないでください。'+
      '「判断保留」はiPhone内のメモだけで、公開一覧には反映しません。</p>'+
      '<label class="lp-manual-consent">'+
      '<input type="checkbox" name="checked" required>'+
      '<span>このイベントURLを実際に確認し、選択した結果であることを確認しました</span></label>'+
      '<div class="lp-manual-export-buttons">'+
      '<button type="submit" class="primary">保存して反映</button>'+
      '<button type="button" id="lpMissingClose">閉じる</button>'+
      '<button type="button" id="lpMissingRemoveDraft">下書きを削除</button></div>'+
      '<p id="lpMissingEditorStatus" class="hint" role="status" aria-live="polite"></p></form>';
    document.body.append(dialog);
    try {
      const saved=JSON.parse(localStorage.getItem(LP_MISSING_DRAFT_KEY)||'{}');
      if(saved && typeof saved==='object'&&!Array.isArray(saved))lpMissingDrafts=saved;
    }catch(ignore){}
    manual.addEventListener('click',e=>{
      const btn=e.target.closest('button[data-missing-url]');
      if(btn&&manual.contains(btn))lpMissingOpen(btn.dataset.missingUrl);
    });
    $('lpMissingClose').addEventListener('click',()=>dialog.close());
    $('lpMissingRemoveDraft').addEventListener('click',()=>{
      if(!isDeveloper()||!lpMissingEditing)return;
      const old=lpMissingDrafts[lpMissingEditing];
      delete lpMissingDrafts[lpMissingEditing];
      try{lpMissingSave();}catch(error){
        if(old)lpMissingDrafts[lpMissingEditing]=old;
        $('lpMissingEditorStatus').textContent=error.message;return;
      }
      dialog.close();lpManualRender();
    });
    $('lpMissingForm').addEventListener('submit',async event=>{
      event.preventDefault();
      if(!isDeveloper()||!lpManualValidUrl(lpMissingEditing))return;
      const form=event.currentTarget,fd=new FormData(form);
      const reason=String(fd.get('reason')||'');
      if(!Object.hasOwn(LP_MISSING_LABELS,reason)||fd.get('checked')!=='on'){
        $('lpMissingEditorStatus').textContent='ページの確認結果と確認チェックを選択してください。';
        return;
      }
      const url=lpMissingEditing,button=form.querySelector('button[type=submit]');
      button.disabled=true;button.textContent='保存中…';
      $('lpMissingEditorStatus').textContent='🔄 確認結果を保存しています…';
      try{
        if(reason==='pending') {
          // Transient failures remain private on this device, not public.
          const previous=lpMissingDrafts[url];
          lpMissingDrafts[url]={reason:'pending'};
          try{lpMissingSave();}catch(error){
            if(previous)lpMissingDrafts[url]=previous;
            else delete lpMissingDrafts[url];
            throw error;
          }
        }else{
          const isUnavailable=Object.hasOwn(LP_MISSING_EVIDENCE,reason);
          await lpCloudSave({
            event_url:url,
            resolution:isUnavailable?'unavailable':'active',
            event_title:null,
            reason:isUnavailable?reason:null,
            evidence:isUnavailable?LP_MISSING_EVIDENCE[reason]:'official_page_reopened'
          });
          // Cloud-confirmed rows must not linger as old local CSV drafts.
          delete lpMissingDrafts[url];
          try{lpMissingSave();}catch(ignore){}
        }
        $('lpMissingDialog').close();
        lpManualRender();
        $('lpMissingStatus').textContent=reason==='pending'
          ? '✅ 判断保留として端末内に保存しました。エラー一覧から移動しました（全ユーザーには非公開）。'
          : '✅ ページ状態をSupabaseに保存しました。全ユーザーの一覧に反映されます。';
      }catch(error){
        $('lpMissingEditorStatus').textContent='⚠ 保存できませんでした：'+
          (error?.message||error)+'。入力内容はそのまま残っています。';
      }finally{
        button.disabled=false;button.textContent='保存して反映';
      }
    });
    $('lpMissingCopy').addEventListener('click',()=>lpMissingExportCsv('copy'));
    $('lpMissingDownload').addEventListener('click',()=>lpMissingExportCsv('download'));
  }

  function lpMissingSave() {
    try{localStorage.setItem(LP_MISSING_DRAFT_KEY,JSON.stringify(lpMissingDrafts));}
    catch(e){throw Error('端末に保存できません：'+(e?.message||e));}
  }

  async function lpMissingLoad() {
    if(!isDeveloper())return;
    const status=$('lpMissingStatus');
    try{
      const response=await fetch('./livepocket_verified_unavailable.csv?v='+Date.now(),{cache:'no-store'});
      if(!response.ok)throw Error('HTTP '+response.status);
      const parsed=lpManualParseCsv(await response.text());
      for(const column of ['url','reason','evidence','approved'])
        if(!parsed.header.includes(column))throw Error('ページ状態CSVに列がありません：'+column);
      lpMissingOriginal=parsed.rows;
      // Keep previously marked URLs editable, even if their failure reason
      // disappeared after the last recheck. A developer can revoke a report.
      const known=new Set(lpManualRows.map(row=>row.url));
      for(const row of parsed.rows){
        if(row.approved==='yes' && lpManualValidUrl(row.url) && !known.has(row.url)){
          lpManualRows.push({url:row.url,event_title:'以前ページなしと確認したイベント',
            title_diagnostic_reason:'fetch_failed',title_diagnostic_checked_at:''});
          known.add(row.url);
        }
      }
      lpMissingLoaded=true;
      status.textContent='✅ ページなし確認記録 '+parsed.rows.filter(x=>x.approved==='yes').length+'件を取得';
      lpManualRender();
    }catch(e){
      lpMissingLoaded=false;
      status.textContent='⚠ ページ状態CSVの取得に失敗：'+(e?.message||e);
      lpManualRender();
    }
  }

  function lpMissingRowInfo(url) {
    const draft=lpMissingDrafts[url];
    const original=lpMissingOriginal.find(row=>row.url===url&&row.approved==='yes');
    if(draft && LP_MISSING_LABELS[draft.reason]){
      const published=draft.reason!=='pending';
      return '<p class="lp-manual-ready">'+
        (published?'📝 ページ状態の下書き：':'⏳ 端末内の保留：')+
        escape(LP_MISSING_LABELS[draft.reason])+'</p>';
    }
    return original ? '<p class="lp-manual-ready">🚫 公開済み：'+
      escape(LP_MISSING_LABELS[original.reason]||'ページなし')+'</p>':'';
  }

  function lpMissingOpen(url) {
    if(!isDeveloper()||!lpManualLoaded||!lpMissingLoaded||
       !lpManualRows.some(row=>row.url===url)) {
      const status=$('lpMissingStatus');
      if(status)status.textContent='⚠ 先に失敗候補を読み込み、ページ状態CSVの取得完了を待ってください。';
      return;
    }
    lpMissingEditing=url;
    const draft=lpMissingDrafts[url];
    const original=lpMissingOriginal.find(row=>row.url===url&&row.approved==='yes');
    $('lpMissingDescription').textContent=
      '対象：'+url+'。公式ページを開いてから状態を選択してください。'+
      (original?' 現在「'+(LP_MISSING_LABELS[original.reason]||'ページなし')+'」で登録されています。':'');
    const form=$('lpMissingForm');
    form.reset();
    const cloud=lpCloudOverrides.get(url);
    form.elements.namedItem('reason').value=draft?.reason||
      (cloud?.resolution==='unavailable'?cloud.reason:
       cloud?.resolution==='active'?'clear':'');
    form.elements.namedItem('checked').checked=false;
    $('lpMissingRemoveDraft').hidden=!draft;
    $('lpMissingEditorStatus').textContent='';
    $('lpMissingDialog').showModal();
    $('lpMissingHeading').focus({preventScroll:true});
  }

  function lpMissingBuildCsv() {
    if(!lpMissingLoaded||!lpManualLoaded)throw Error('先に失敗候補を読み込んでください');
    const entries=new Map();
    for(const row of lpMissingOriginal)if(lpManualValidUrl(row.url))
      entries.set(row.url,{url:row.url,reason:row.reason,evidence:row.evidence,approved:row.approved});
    const eligible=new Set(lpManualRows.map(row=>row.url));
    let changed=0;
    for(const [url,draft] of Object.entries(lpMissingDrafts)){
      if(!eligible.has(url)||!lpManualValidUrl(url))continue;
      const reason=draft?.reason;
      if(reason==='pending')continue; // local reminder only
      if(reason==='clear'){
        if(entries.has(url)){entries.delete(url);changed++;}
      }else if(Object.hasOwn(LP_MISSING_EVIDENCE,reason)){
        const entry={url,reason,evidence:LP_MISSING_EVIDENCE[reason],approved:'yes'};
        if(JSON.stringify(entries.get(url))!==JSON.stringify(entry)){
          entries.set(url,entry);changed++;
        }
      }
    }
    if(!changed)throw Error('公開用CSVに反映できる変更がありません（判断保留は端末のみ保存します）。');
    const fields=['url','reason','evidence','approved'];
    const body=[lpManualCsvLine(fields),...Array.from(entries.values(),row=>
      lpManualCsvLine(fields.map(key=>row[key]||'')))].join('\r\n')+'\r\n';
    return {text:body,total:changed};
  }

  async function lpMissingExportCsv(mode) {
    if(!isDeveloper())return;
    const status=$('lpMissingStatus');
    let result;
    try{result=lpMissingBuildCsv();}catch(e){status.textContent='⚠ '+e.message;return;}
    if(mode==='copy'){
      try{
        if(!navigator.clipboard?.writeText)throw Error('コピー非対応');
        await navigator.clipboard.writeText(result.text);
        status.textContent='✅ ページ状態の変更 '+result.total+
          '件を含むCSVをコピーしました。GitHubの該当CSVに貼り付けて保存してください。';
      }catch(e){status.textContent='⚠ コピーできません。CSVを保存してGitHubへ反映してください。';}
    }else{
      const blob=new Blob(['\uFEFF'+result.text],{type:'text/csv;charset=utf-8'});
      const target=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=target;link.download='livepocket_verified_unavailable.csv';
      document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(target),2000);
      status.textContent='✅ ページ状態CSVを保存しました。GitHubへ反映してください。';
    }
  }


  // v21.52: An official page confirmed removed is also a resolution for
  // an unknown region, recorded in the existing event status override table.
  let lpLocationListLoaded=false, lpLocationPageEditing='';

  function lpLocationBaseList(){
    return lotteryBaseItems.filter(item=>item&&isLivePocketEventUrl(item.url)&&
      (!Array.isArray(item.stores)||item.stores.length<=1));
  }

  function lpLocationPageMissing(base){
    const shown=lotteryItems.find(item=>item.url===base.url)||base;
    return shown.manual_page_unavailable===true;
  }

  function lpLocationInitUI(){
    if($('lpLocationPanel'))return;
    const previous=$('lpManualPanel');
    if(!previous)return;
    const panel=document.createElement('section');
    panel.id='lpLocationPanel';
    panel.className='store-tools lp-dev-location-panel';
    panel.innerHTML='<h3>📍 店舗・地域未確認の手動修正</h3>'+
      '<p class="hint">店舗名・都道府県は別々に確認・保存できます。'+
      '正式名称や地域は公式イベントページ・公式案内で確認してください。'+
      '地域不明のイベントの公式ページが削除された場合は「ページなしを記録」を利用できます。'+
      '「保存して反映」で全ユーザーの抽選一覧に適用し、自動取得では上書きされません。'+
      '複数店舗イベントは誤った一括上書きを防ぐため対象外です。</p>'+
      '<button type="button" id="lpLocationLoad">店舗・地域未確認を読み込む</button>'+
      '<p id="lpLocationStatus" class="hint" role="status" aria-live="polite">未読み込み</p>'+
      '<p id="lpLocationFeedback" class="hint" role="status" aria-live="polite"></p>'+
      '<div id="lpLocationFilters" class="lp-location-filter" hidden>'+
        '<label for="lpLocationQuery">イベント・店舗・URLで検索</label>'+
        '<input id="lpLocationQuery" type="search" placeholder="イベント名や店舗名を検索" autocomplete="off">'+
        '<label for="lpLocationKind">未確認の項目</label>'+
        '<select id="lpLocationKind">'+
          '<option value="all">店舗・地域のすべて</option>'+
          '<option value="store">店舗名が未確認</option>'+
          '<option value="area">都道府県が未確認</option>'+
        '</select>'+
      '</div>'+
      '<div id="lpLocationList"></div>'+
      '<div id="lpLocationResolved"></div>';
    previous.after(panel);
    const dialog=document.createElement('dialog');
    dialog.id='lpLocationDialog';
    dialog.setAttribute('aria-label','抽選イベントの店舗・地域を手動修正');
    dialog.innerHTML='<h3 tabindex="-1" id="lpLocationDialogTitle">店舗名・都道府県を確認</h3>'+
      '<p id="lpLocationDescription" class="hint"></p>'+
      '<form id="lpLocationForm">'+
      '<label>確認できた店舗名（省略可）'+
        '<input type="text" name="store_name" maxlength="160" placeholder="例：○○カードショップ △△店" autocomplete="off"></label>'+
      '<label>確認できた地域（都道府県・全国／省略可）'+
        '<select name="prefecture"><option value="">未確認・変更しない</option>'+
          '<option value="'+LP_NATIONWIDE+'">🌏 全国（すべての都道府県で表示）</option>'+
          LP_PREFECTURES.map(p=>'<option value="'+escape(p)+'">'+escape(p)+'</option>').join('')+
        '</select></label>'+
      '<p class="hint">※「全国」で保存すると、抽選一覧では47都道府県のどの絞り込みにも表示されます。'+
        'どちらか1項目以上入力してください。空欄の項目は自動収集の値を維持します。'+
        '既存の修正を消す場合は一覧から「修正を解除」を押してください。</p>'+
      '<label>公式情報を確認した方法'+
        '<select name="evidence" required>'+
        '<option value="" disabled selected>選択してください</option>'+
        '<option value="official_page_viewed">同じURLのLivePocketイベントページ</option>'+
        '<option value="official_screenshot_viewed">公式イベントページのスクリーンショット</option>'+
        '<option value="official_store_notice_viewed">店舗公式のお知らせ・案内</option>'+
        '</select></label>'+
      '<label class="lp-location-check"><input type="checkbox" name="confirmed" required>'+
        '<span>このイベントと店舗・都道府県が一致することを確認しました</span></label>'+
      '<div class="lp-manual-export-buttons">'+
        '<button type="submit" class="primary">保存して全ユーザーに反映</button>'+
        '<button type="button" id="lpLocationClose">閉じる</button>'+
      '</div><p id="lpLocationEditorStatus" role="status" aria-live="polite" class="hint"></p>'+
      '</form>';
    document.body.append(dialog);
    const pageDialog=document.createElement('dialog');
    pageDialog.id='lpLocationPageDialog';
    pageDialog.setAttribute('aria-label','地域未確認イベントのページ状態を記録');
    pageDialog.innerHTML='<h3 tabindex="-1" id="lpLocationPageTitle">地域未確認：ページ状態を確認</h3>'+
      '<p id="lpLocationPageDescription" class="hint"></p>'+
      '<form id="lpLocationPageForm">'+
      '<label>LivePocket公式ページの確認結果<select name="reason" required>'+
      '<option value="" disabled selected>確認結果を選択してください</option>'+
      '<option value="not_found_404_410">404／410（ページが存在しない）</option>'+
      '<option value="official_removed_notice">公式に削除・非公開の案内あり</option>'+
      '<option value="clear">ページが復旧した（ページなしの記録を解除）</option>'+
      '</select></label>'+
      '<p class="hint">通信エラー・ログイン画面・アクセス制限だけの場合は削除済みと確定しないでください。'+
      'ページなしを保存しても抽選データは削除されず、全ユーザーに状態だけ反映します。</p>'+
      '<label class="lp-location-check"><input type="checkbox" name="confirmed" required>'+
      '<span>対象の公式URLを確認し、選択した結果であることを確認しました</span></label>'+
      '<div class="lp-manual-export-buttons">'+
      '<button type="submit" class="primary">ページ状態を保存して反映</button>'+
      '<button type="button" id="lpLocationPageClose">閉じる</button></div>'+
      '<p id="lpLocationPageEditorStatus" class="hint" role="status" aria-live="polite"></p>'+
      '</form>';
    document.body.append(pageDialog);
    $('lpLocationPageClose').addEventListener('click',()=>pageDialog.close());
    $('lpLocationPageForm').addEventListener('submit',lpLocationPageSubmit);
    $('lpLocationLoad').addEventListener('click',lpLocationLoad);
    $('lpLocationQuery').addEventListener('input',e=>{
      lpLocationSearch=e.target.value.trim().toLocaleLowerCase('ja-JP');
      lpLocationLimit=60;lpLocationRender();
    });
    $('lpLocationKind').addEventListener('change',e=>{
      lpLocationFilter=e.target.value;lpLocationLimit=60;lpLocationRender();
    });
    panel.addEventListener('click',async e=>{
      const edit=e.target.closest('button[data-lp-location-edit]');
      if(edit&&panel.contains(edit)){lpLocationOpen(edit.dataset.lpLocationEdit);return;}
      const page=e.target.closest('button[data-lp-location-page]');
      if(page&&panel.contains(page)){lpLocationPageOpen(page.dataset.lpLocationPage);return;}
      const more=e.target.closest('button[data-lp-location-more]');
      if(more&&panel.contains(more)){lpLocationLimit+=60;lpLocationRender();return;}
      const remove=e.target.closest('button[data-lp-location-remove]');
      if(remove&&panel.contains(remove)){
        const url=remove.dataset.lpLocationRemove;
        if(!isDeveloper()||!lpLocationOverrides.has(url))return;
        if(!window.confirm('このイベントの店舗・地域の手動修正を解除しますか？\n自動収集の値に戻ります。'))return;
        remove.disabled=true;
        try{
          await lpLocationRemove(url);
          $('lpLocationFeedback').textContent='✅ 店舗・地域の手動修正を解除しました。';
        }catch(error){
          $('lpLocationFeedback').textContent='⚠ 解除できません：'+(error?.message||error);
          remove.disabled=false;
        }
      }
    });
    $('lpLocationClose').addEventListener('click',()=>dialog.close());
    $('lpLocationForm').addEventListener('submit',lpLocationSubmit);
  }

  async function lpLocationLoad(){
    if(!isDeveloper()||lpLocationBusy)return;
    lpLocationBusy=true;
    const button=$('lpLocationLoad'),status=$('lpLocationStatus');
    button.disabled=true;button.textContent='読込中…';
    status.textContent='🔄 抽選情報と店舗・地域の修正記録を取得しています…';
    try{
      await Promise.all([loadLotteryEvents(true),lpLocationRefresh(true),lpCloudRefresh(true)]);
      if(!lotteryBaseItems.length)throw Error('公開抽選一覧がまだ取得できていません');
      if(!lpLocationReady)throw Error(lpLocationError||'修正データの接続を確認できません');
      if(!lpCloudReady)throw Error(lpCloudError||'ページ状態の保存先に接続できません');
      lpLocationListLoaded=true;
      $('lpLocationFilters').hidden=false;
      lpLocationRender();
    }catch(error){
      status.textContent='⚠ 読み込みに失敗しました：'+(error?.message||error);
    }finally{
      lpLocationBusy=false;button.disabled=false;button.textContent='店舗・地域未確認を再読み込み';
    }
  }

  function lpLocationRender(){
    const panel=$('lpLocationPanel');
    if(!panel||!isDeveloper())return;
    const list=$('lpLocationList'),saved=$('lpLocationResolved');
    if(!lpLocationListLoaded){return;}
    if(!lpLocationReady){
      $('lpLocationStatus').textContent='⚠ 店舗・地域の修正サーバーに接続できません：'+lpLocationError;
      return;
    }
    const bases=lpLocationBaseList();
    const now=Date.now();
    const active=bases.filter(base=>!lpApplicationExpired(base.url,base.application_end_at,now));
    const incomplete=active.filter(base=>
      (!lotteryStoreEntries(base).length||!lotteryPrefectures(base).length) &&
      !lpLocationPageMissing(base));
    // A confirmed removed page resolves an unknown region; keep it accessible
    // in the folded handled list, including after the application deadline.
    const pageResolved=bases.filter(base=>
      !lotteryPrefectures(base).length&&lpLocationPageMissing(base));
    const byUrl=new Map([...incomplete,...pageResolved,
      ...bases.filter(x=>lpLocationOverrides.has(x.url))].map(x=>[x.url,x]));
    const all=[...byUrl.values()];
    const stored=all.filter(base=>lpLocationOverrides.has(base.url)||lpLocationPageMissing(base));
    const missing=all.filter(base=>!lpLocationOverrides.has(base.url)&&!lpLocationPageMissing(base));
    const search=base=>{
      if(!lpLocationSearch)return true;
      return [base.url,base.event_title,base.product_name,base.store_name,
        ...lotteryStoreEntries(base).map(s=>s.name)].filter(Boolean)
        .join(' ').toLocaleLowerCase('ja-JP').includes(lpLocationSearch);
    };
    const kind=base=>lpLocationFilter==='all'||
      (lpLocationFilter==='store'&&!lotteryStoreEntries(base).length)||
      (lpLocationFilter==='area'&&!lotteryPrefectures(base).length);
    const visible=missing.filter(base=>search(base)&&kind(base));
    const unsafe=lotteryBaseItems.filter(item=>
      !lpApplicationExpired(item.url,item.application_end_at,now) &&
      Array.isArray(item.stores)&&item.stores.length>1 &&
      (!lotteryStoreEntries(item).length||!lotteryPrefectures(item).length)).length;
    $('lpLocationStatus').textContent='未対応 '+missing.length+'件 ／ 店舗名未確認 '+
      missing.filter(x=>!lotteryStoreEntries(x).length).length+
      '件 ／ 都道府県未確認 '+missing.filter(x=>!lotteryPrefectures(x).length).length+
      '件 ／ 対応済み '+stored.length+'件（ページなし '+stored.filter(lpLocationPageMissing).length+'件）'+
      (unsafe?' ／ 複数店舗・地域未確認（編集対象外） '+unsafe+'件':'');
    function card(base,done){
      const saved=lpLocationOverrides.get(base.url);
      const pageMissing=lpLocationPageMissing(base);
      const item=lotteryItems.find(x=>x.url===base.url)||base;
      const oldStores=lotteryStoreEntries(base);
      const oldAreas=lotteryPrefectures(base);
      const title=(item.event_title||item.product_name||'イベント名未確認').slice(0,150);
      const name=lotteryStoreEntries(item).map(x=>x.name).join('・')||'店舗未確認';
      const areas=lotteryPrefectures(item).join('・')||'都道府県未確認';
      return '<div class="lp-location-row"><div class="lp-location-row-body">'+
        '<strong>'+escape(title)+'</strong>'+
        '<p>店舗：'+escape(name)+' ／ 地域：'+escape(areas)+'</p>'+
        '<p class="lp-location-original">元データ：'+
          escape(oldStores.map(x=>x.name).join('・')||'店舗未確認')+' ／ '+
          escape(oldAreas.join('・')||'都道府県未確認')+'</p>'+
        (saved?'<p class="lp-location-stored">✅ 手動修正済み'+
          (saved.store_name?'・店舗':'')+(saved.prefecture?'・地域':'')+'</p>':'')+
        (pageMissing?'<p class="lp-location-stored">🚫 ページなし（保存済み）</p>':'')+
        '<a href="'+escape(base.url)+'" target="_blank" rel="noopener noreferrer">公式ページ ↗</a>'+
        '</div><div class="lp-location-actions">'+
          '<button type="button" data-lp-location-edit="'+escape(base.url)+'">'+
            (done?'再編集':'店舗・地域を編集')+'</button>'+
          (!oldAreas.length?'<button type="button" data-lp-location-page="'+escape(base.url)+'">'+
            (pageMissing?'ページ状態を再編集':'ページなしを記録')+'</button>':'')+
          (done&&saved?'<button type="button" data-lp-location-remove="'+
            escape(base.url)+'">修正を解除</button>':'')+
        '</div></div>';
    }
    list.innerHTML='<h4 class="lp-manual-list-title">⚠ 店舗・地域 未対応 '+visible.length+'件'+
      (lpLocationSearch||lpLocationFilter!=='all'?'（検索結果）':'')+'</h4>'+
      (visible.length?visible.slice(0,lpLocationLimit).map(x=>card(x,false)).join('')+
        (visible.length>lpLocationLimit?
          '<button type="button" id="lpLocationMore" data-lp-location-more>さらに表示（残り'+
          (visible.length-lpLocationLimit)+'件）</button>':'')
        :'<p class="hint">該当する未確認イベントはありません。</p>');
    const expanded=saved.querySelector('details.lp-location-saved-fold')?.open===true;
    const matching=stored.filter(search);
    saved.innerHTML='<details class="lp-location-saved-fold">'+
      '<summary>✅ 店舗・地域 対応済み・ページなし <span>'+stored.length+'件</span></summary>'+
      '<div class="lp-location-saved-content">'+
      '<p class="hint">保存済みとページなしの記録を表示します。ページ復旧の確認や再編集もここからできます。</p>'+
      (matching.length?matching.map(x=>card(x,true)).join(''):
        '<p class="hint">表示する保存済みデータはありません。</p>')+
      '</div></details>';
    if(expanded)saved.querySelector('details.lp-location-saved-fold').open=true;
  }

  function lpLocationOpen(url){
    if(!isDeveloper()||!lpLocationListLoaded||!lpLocationReady||!safeLotteryUrl(url))return;
    const base=lotteryBaseItems.find(x=>x.url===url);
    if(!base||(Array.isArray(base.stores)&&base.stores.length>1)){
      $('lpLocationFeedback').textContent='⚠ 複数店舗のイベントは一括修正できません。';return;
    }
    lpLocationEditing=url;
    const previous=lpLocationOverrides.get(url);
    const oldStores=lotteryStoreEntries(base);
    const oldAreas=lotteryPrefectures(base);
    $('lpLocationDescription').textContent='対象：'+url+
      ' ／ 元データの店舗：'+(oldStores.map(x=>x.name).join('・')||'未確認')+
      ' ／ 地域：'+(oldAreas.join('・')||'未確認')+
      '。確認できた項目だけ入力してください。';
    const form=$('lpLocationForm');
    form.reset();
    form.elements.namedItem('store_name').value=previous?.store_name||'';
    form.elements.namedItem('prefecture').value=previous?.prefecture||'';
    form.elements.namedItem('evidence').value=previous?.evidence||'';
    form.elements.namedItem('confirmed').checked=false;
    $('lpLocationEditorStatus').textContent='';
    $('lpLocationDialog').showModal();
    $('lpLocationDialogTitle').focus({preventScroll:true});
  }

  function lpLocationPageOpen(url){
    if(!isDeveloper()||!lpLocationListLoaded||!safeLotteryUrl(url))return;
    const base=lpLocationBaseList().find(item=>item.url===url);
    if(!base||lotteryPrefectures(base).length){
      $('lpLocationFeedback').textContent='⚠ この操作は地域未確認イベントのみ利用できます。';return;
    }
    if(!lpCloudReady){
      $('lpLocationFeedback').textContent='⚠ ページ状態の保存先に接続できません：'+
        (lpCloudError||'再読み込みしてください');return;
    }
    lpLocationPageEditing=url;
    const cloud=lpCloudOverrides.get(url);
    const form=$('lpLocationPageForm');
    form.reset();
    const existingReason=cloud?.resolution==='unavailable'?cloud.reason:
      (base.manual_page_unavailable?base.manual_page_unavailable_reason:'');
    if(Object.hasOwn(LP_MISSING_EVIDENCE,existingReason))
      form.elements.namedItem('reason').value=existingReason;
    $('lpLocationPageDescription').textContent='対象：'+url+
      ' ／ 元の地域は未確認。ページなしを登録すると地域未対応の一覧から外れます。'+
      (lpLocationPageMissing(base)?' 現在ページなしと記録されています。':'');
    $('lpLocationPageEditorStatus').textContent='';
    $('lpLocationPageDialog').showModal();
    $('lpLocationPageTitle').focus({preventScroll:true});
  }

  async function lpLocationPageSubmit(event){
    event.preventDefault();
    if(!isDeveloper()||lpLocationBusy||!lpCloudReady)return;
    const form=event.currentTarget,values=new FormData(form);
    const reason=String(values.get('reason')||'');
    const checked=values.get('confirmed')==='on';
    const message=$('lpLocationPageEditorStatus');
    if((!Object.hasOwn(LP_MISSING_EVIDENCE,reason)&&reason!=='clear')||!checked){
      message.textContent='⚠ 公式ページの確認結果と確認チェックを選択してください。';return;
    }
    const url=lpLocationPageEditing;
    const base=lpLocationBaseList().find(item=>item.url===url);
    if(!base||lotteryPrefectures(base).length){
      message.textContent='⚠ 対象が地域未確認イベントではありません。';return;
    }
    if(reason==='clear'&&!lpLocationPageMissing(base)){
      message.textContent='⚠ ページなしの記録がありません。';return;
    }
    const existing=lpCloudOverrides.get(url);
    if(existing?.resolution==='title' &&
       !window.confirm('既存のイベント名の手動修正をページ状態の記録に置き換えます。続けますか？'))return;
    lpLocationBusy=true;
    const button=form.querySelector('button[type=submit]');
    button.disabled=true;button.textContent='保存中…';
    message.textContent='🔄 ページ状態をSupabaseへ保存しています…';
    try{
      const unavailable=reason!=='clear';
      await lpCloudSave({event_url:url,resolution:unavailable?'unavailable':'active',
        event_title:null,reason:unavailable?reason:null,
        evidence:unavailable?LP_MISSING_EVIDENCE[reason]:'official_page_reopened'});
      $('lpLocationPageDialog').close();
      lpLocationRender();
      $('lpLocationFeedback').textContent=unavailable
        ? '✅ ページなしを保存しました。地域未対応から対応済みに移動しました。'
        : '✅ ページ復旧を保存しました。地域が未確認なら未対応に戻ります。';
    }catch(error){
      message.textContent='⚠ 保存できませんでした：'+(error?.message||error)+
        '。入力内容は保持しています。';
    }finally{
      lpLocationBusy=false;button.disabled=false;button.textContent='ページ状態を保存して反映';
    }
  }

  async function lpLocationSubmit(event){
    event.preventDefault();
    if(!isDeveloper()||!lpLocationReady||lpLocationBusy)return;
    const form=event.currentTarget,values=new FormData(form);
    const name=String(values.get('store_name')||'').trim().replace(/\s+/g,' ');
    const area=String(values.get('prefecture')||'');
    const evidence=String(values.get('evidence')||'');
    const checked=values.get('confirmed')==='on';
    const message=$('lpLocationEditorStatus');
    if((!name&&!area)||(name&&(name.length<2||name.length>160||
        /[\x00-\x1f\x7f]/.test(name))) ||
      (area&&!LP_MANUAL_AREAS.includes(area)) ||
      !['official_page_viewed','official_screenshot_viewed','official_store_notice_viewed'].includes(evidence) ||
      !checked){
      message.textContent='⚠ 店舗名・都道府県を1項目以上入力し、確認方法と確認チェックを選択してください。';
      return;
    }
    const base=lotteryBaseItems.find(x=>x.url===lpLocationEditing);
    if(!base||(Array.isArray(base.stores)&&base.stores.length>1)){
      message.textContent='⚠ このイベントは複数店舗のため、上書きできません。';return;
    }
    const originalName=lotteryStoreEntries(base).map(x=>x.name).join('・');
    const originalArea=lotteryPrefectures(base).join('・');
    if(((name&&originalName&&name!==originalName)||(area&&originalArea&&area!==originalArea)) &&
      !window.confirm('元の店舗名・都道府県と異なる値で上書きします。\n公式情報と一致することを確認しましたか？'))return;
    lpLocationBusy=true;
    const button=form.querySelector('button[type=submit]');
    button.disabled=true;button.textContent='保存中…';
    message.textContent='🔄 Supabaseへ保存しています…';
    try{
      await lpLocationSave({event_url:lpLocationEditing,store_name:name||null,
        prefecture:area||null,evidence});
      $('lpLocationDialog').close();
      $('lpLocationFeedback').textContent='✅ 店舗・地域の修正を保存しました。全ユーザーの抽選一覧に反映されます。';
    }catch(error){
      message.textContent='⚠ 保存できませんでした：'+(error?.message||error)+
        '。入力内容は保持しています。';
    }finally{
      lpLocationBusy=false;button.disabled=false;button.textContent='保存して全ユーザーに反映';
    }
  }

  function initLotteryDevRecheck() {
    const button = $('lpDevRecheckButton');
    const status = $('lpDevRecheckStatus');
    if (!button || !status) return;
    lpManualInitUI();
    lpMissingInitUI();
    lpLocationInitUI();
    $('lpDevResultsRefresh')?.addEventListener('click', () => loadLotteryDevResults({manual:true}));
    button.addEventListener('click', () => requestLotteryDevRecheck({automatic: false}));
  }

  // ========================================
  // 起動
  // ========================================

  function init() {
    try {
      console.log('ポケカ発見マップ 地図自動調整版 起動開始');

      initAppTheme();
      loadReports();
      loadSavedStores();

      initProductDropdown();
      initMapProductFilter();
      initWishlist();
      initMapFilterDrawer();
      initChainDropdown();
      initCloudAdmin();
      initLotteryDevRecheck();
      initFriendPresence();
      initLottery();
      bindEvents();

      get('foundAt').value = nowLocal();
      get('cancelEdit').hidden = true;
      updateCategoryHint();

      initMap();
      // v21.35: Only manual app refresh restores the tab saved in the URL.
      // A regular app launch still opens the map as before.
      let initialTab = 'map';
      try {
        const currentUrl = new URL(window.location.href);
        const requestedTab = currentUrl.searchParams.has('app_refresh')
          ? currentUrl.searchParams.get('app_tab') : null;
        const allowedTabs = ['map','add','history','lottery','lotteryManage','group','dev'];
        if (allowedTabs.includes(requestedTab)) {
          if (requestedTab === 'dev') restoreDeveloperTabPending = true;
          else initialTab = requestedTab;
        }
        if (currentUrl.searchParams.has('app_tab')) {
          currentUrl.searchParams.delete('app_tab');
          window.history.replaceState(window.history.state, '', currentUrl.href);
        }
      } catch (error) {
        console.warn('更新時のタブ復元をスキップ:', error);
      }
      switchTab(initialTab);

      loadStoreCSV();
      loadProducts();
      initShared().catch(error => {
        console.error('共有機能初期化エラー',error);
        $('sharedStatus').textContent = '共有機能の初期化に失敗: ' + error.message;
      });

      console.log('ポケカ発見マップ 7カテゴリ版 起動完了');
    } catch (error) {
      console.error('アプリ起動エラー:', error);
      alert(
        'アプリの起動中にエラーが発生しました。\n' +
        error.message
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
