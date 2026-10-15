
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

  function displayAuth() {
    const account = $('discordAccount');
    const status = $('shareAuthStatus');
    if (!supabaseClient) {
      const msg = '共有機能の読み込みに失敗しました。通信環境を確認してください。';
      account.textContent = msg; status.textContent = msg;
    } else if (authUser) {
      const profile = authUser.user_metadata || {};
      const name = profile.full_name || profile.name || profile.user_name || authUser.email || 'Discordユーザー';
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
    if (isDeveloper()) renderCloudAdminLists();
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
    window.addEventListener('focus',()=>loadCloudData());
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
    mergeCloudProducts(); updateStoreCount(); renderCloudAdminLists();
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
      initMapFilterDrawer();
      initChainDropdown();
      initCloudAdmin();
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
