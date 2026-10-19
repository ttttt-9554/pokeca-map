
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
    if (isDeveloper()) { renderCloudAdminLists(); loadLotteryDevResults(); }
    refreshWishlistForAccount();
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
    target.innerHTML = own.length ? own.map(card).join('') :
      '<p class="hint">共有した投稿はありません。</p>';
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
    supabaseClient.channel('pokeca-cloud-catalog-updates')
      .on('postgres_changes',{event:'*',schema:'public',table:'catalog_products'},()=>loadCloudData())
      .on('postgres_changes',{event:'*',schema:'public',table:'catalog_stores'},()=>loadCloudData())
      .subscribe();
    window.addEventListener('focus',()=>{ loadCloudData(); refreshWishlistForAccount(); });
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

    if (tab === 'map') refreshMap();
    if (tab === 'lottery') loadLotteryEvents();
    if (tab === 'dev' && isDeveloper()) loadLotteryDevResults();
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
    function toggle(show) { panel.hidden = !show; backdrop.hidden = !show; if (show) select.focus(); else open.focus(); }
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
  let lotteryItems = [];
  let lotteryLastFetch = 0;
  let lotteryLoading = null;
  let lotteryVisibleLimit = LP_PAGE_SIZE;
  let lotteryTimer = null;
  let lotteryCountdownTimer = null;

  function safeLotteryUrl(value) {
    return typeof value === 'string' &&
      /^https:\/\/livepocket\.jp\/e\/[a-zA-Z0-9_-]+\/?$/.test(value);
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
    const root = $('lpPrefecture');
    root.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = '全国';root.append(all);
    const unknown = document.createElement('option');
    unknown.value = 'unknown'; unknown.textContent = '都道府県未確認';root.append(unknown);
    for (const name of LP_PREFECTURES) {
      if (!actual.has(name)) continue;
      const option = document.createElement('option');
      option.value = name; option.textContent = name; root.append(option);
    }
    root.value = [...root.options].some(x => x.value === selected) ? selected : 'all';
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
        // URLが確認できたLivePocketイベントだけ受け入れ、同一URLは1件にまとめる。
        const seen = new Set();
        const clean = [];
        for (const item of data.items) {
          if (!item || !safeLotteryUrl(item.url) || seen.has(item.url)) continue;
          seen.add(item.url);
          clean.push(item);
        }
        lotteryItems = clean;
        lotteryLastFetch = Date.now();
        renderLotteryPrefectures();
        const update = data.updated_at || data.collected_at;
        const info = lotteryJapaneseDate(update);
        // JSON update time is not a proof that Actions has run recently.
        const viewedAt = new Intl.DateTimeFormat('ja-JP', {
          timeZone:'Asia/Tokyo', hour:'2-digit',minute:'2-digit',hour12:false
        }).format(new Date());
        status.textContent = `取得済み ${clean.length}イベント` +
          (info ? ` ／ データ最終変更 ${info}（日本時間）` : '') +
          ` ／ 画面で最新データを取得 ${viewedAt}`;
        renderLottery();
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
    return ({open:'受付中',upcoming:'開始前',closed:'受付終了'})[state] || '応募状況未確認';
  }

  function lotteryCategoryText(value) {
    return ({pokemon:'ポケカ',onepiece:'ワンピース',yugioh:'遊戯王',unknown:'未分類'})[value] || value;
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
    const label = reliableName || '商品名・イベント名を確認中';
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
      </details>` : `<p class="lp-store-muted">対象店舗：未確認</p>`;
    return `<article class="lp-card ${state === 'closed' ? 'lp-closed' : ''}">
      <div class="lp-badges"><span class="lp-status lp-${state}">${lotteryStatusText(state,item)}</span>
        ${lotteryIsNew(item) ? '<span class="lp-new-badge" aria-label="新着：初回登録から24時間以内">NEW</span>' : ''}
        <span class="lp-tag">${escape(lotteryCategoryText(genre))}</span>
        ${kind ? `<span class="lp-tag">${kind}</span>` : ''}
      </div>
      <h3 class="lp-full-title">${escape(label)}</h3>
      ${!officialName && item.product_name && trustedTitle && item.product_name !== trustedTitle ? `<p class="lp-sub">${escape(trustedTitle)}</p>` : ''}
      ${item.pokemon_map_match ? `<p class="lp-match">発見マップ商品マスタ一致：${escape(item.pokemon_map_match)}</p>` : ''}
      <p class="lp-deadline">${escape(when)}${escape(countdown)}${start ? `<small>応募開始：${escape(start)}</small>` : ''}</p>
      ${list}
      <a class="lp-official" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">公式ページで確認 ↗</a>
    </article>`;
  }

  function renderLottery() {
    if (!$('lpCards')) return;
    const now = Date.now();
    const query = productNorm($('lpQuery').value);
    const genre = $('lpGenre').value;
    const prefecture = $('lpPrefecture').value;
    const status = $('lpStatus').value;
    const type = $('lpType').value;
    const wishlistOnly = $('lpWishlistOnly').checked;
    const visible = lotteryItems.filter(item => {
      if (genre !== 'all' && lotteryGenre(item) !== genre) return false;
      if (prefecture === 'unknown' && lotteryPrefectures(item).length) return false;
      if (prefecture !== 'all' && prefecture !== 'unknown' && !lotteryPrefectures(item).includes(prefecture)) return false;
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
    const priority = {open:0,upcoming:1,unknown:2,closed:3};
    visible.sort((a,b) => {
      const sa = lotteryState(a,now), sb = lotteryState(b,now);
      if (sa !== sb) return priority[sa] - priority[sb];
      if (sa === 'open' || sa === 'upcoming') {
        const ea = lotteryDate(a.application_end_at), eb = lotteryDate(b.application_end_at);
        if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) return ea - eb;
      }
      return (lotteryDate(b.discord_posted_at) || 0) - (lotteryDate(a.discord_posted_at) || 0);
    });
    const pokemonCount = lotteryItems.filter(x => lotteryGenre(x) === 'pokemon').length;
    const knownCount = lotteryItems.filter(x => Number.isFinite(lotteryDate(x.application_end_at))).length;
    const openCount = lotteryItems.filter(x => lotteryState(x,now) === 'open').length;
    $('lpSummary').innerHTML = `<span>全イベント <strong>${lotteryItems.length}</strong>件</span>
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
  }

  function initLottery() {
    ensureLotteryNewBadgeStyle();
    // 初期表示はジャンル全件・日時確認済みの受付中のみ。
    $('lpGenre').value = 'all';
    $('lpStatus').value = 'open';
    for (const id of ['lpQuery','lpGenre','lpPrefecture','lpStatus','lpType','lpWishlistOnly']) {
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
      if (document.visibilityState === 'visible' && $('lotteryView').classList.contains('active')) renderLottery();
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && $('lotteryView').classList.contains('active')) loadLotteryEvents();
    });
  }

  // ========================================
  // 開発者専用：LivePocketの登録済みイベントを手動再確認
  // サーバーでもSupabase JWTを検証する。ブラウザにGitHub PATは置かない。
  // ========================================
  const LP_DEV_RECHECK_API = 'https://livepocket-backup-trigger.takahiro9455.workers.dev/admin/recheck';
  let lpDevRecheckBusy = false;
  const LP_DEV_RESULTS_URL = './livepocket_check_summary.json';
  let lpDevReportLoading = false;
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

  function lpDevReportMarkup(lastManual, lastRun) {
    if (!lastManual || !lastManual.completed_process_at) {
      return `<p class="hint">開発者ボタンによる再確認結果はまだありません。ボタンから実行し、GitHub Actionsの処理完了後に表示されます。</p>
      ${lastRun?.completed_process_at ? `<p class="hint">最新の自動処理：${escape(lpDevReportDate(lastRun.completed_process_at))}</p>` : ''}`;
    }
    const stats = lastManual.stats || {};
    const updates = lastManual.updates || {};
    const fields = [
      ['手動再確認の対象',lpDevNumeric(stats,'manual_selected')],
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
      <p class="hint">※「公式イベント名を検出」は更新件数とは異なります。取得できても既存名と同じ場合があります。</p>
      <p class="hint">※ 「イベントページと確認できず」は通信失敗と同義ではありません。HTTP応答があっても、イベント本文を確認できないページは正式名の自動反映に使いません。</p>
      <p class="hint">※ メタ情報の整形や見出し候補があっても、正式イベント名の検出・更新が成功したとは限りません。省略表示は採用せず、CSVには判定コードと件数だけを記録します。</p>
      <p class="hint">※手動で選んだイベントのみの集計です。ページ取得に成功した対象の差分を数えています。通常収集での全体データ整形は含めません。取得制限中は確認を停止します。</p>
      ${runLink}`;
  }

  async function loadLotteryDevResults() {
    if (!isDeveloper() || lpDevReportLoading) return;
    const output = $('lpDevResultsContent');
    const state = $('lpDevResultsState');
    if (!output || !state) return;
    lpDevReportLoading = true;
    try {
      const response = await fetch(LP_DEV_RESULTS_URL + '?t=' + Date.now(), {cache:'no-store'});
      if (response.status === 404) {
        state.textContent = '結果ファイルはまだありません。GitHub側のv21.11を反映後、最初の実行で作成されます。';
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
      state.textContent = '結果を取得しました。';
      output.innerHTML = lpDevReportMarkup(lastManual, result.last_run);
      if (lpDevReportSince && lastManual?.completed_process_at) {
        const checkedAt = Date.parse(lastManual.completed_process_at);
        // Old reports must not be treated as this button press's result.
        const isNewRun = String(lastManual.run_id || '') !== lpDevWaitingPreviousRun;
        if (isNewRun && Number.isFinite(checkedAt) && checkedAt >= lpDevReportSince - 10000) {
          clearInterval(lpDevReportTimer);
          lpDevReportTimer = null;
          lpDevReportSince = 0;
          state.textContent = '✅ 今回の手動再確認の結果が反映されました。';
          loadLotteryEvents(true);
        }
      }
    } catch (error) {
      renderLpDevDailyGrowth(null);
      state.textContent = '結果を取得できませんでした：' + (error?.message || '通信エラー');
    } finally {
      lpDevReportLoading = false;
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
    if (!automatic && !window.confirm('登録済みの抽選イベントを最大12件、GitHub Actionsで再確認しますか？\n通常の自動収集は停止しません。')) return;
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
      button.textContent = '登録済み抽選を12件再確認';
    }
  }

  function initLotteryDevRecheck() {
    const button = $('lpDevRecheckButton');
    const status = $('lpDevRecheckStatus');
    if (!button || !status) return;
    $('lpDevResultsRefresh')?.addEventListener('click', loadLotteryDevResults);
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
      switchTab('map');

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
