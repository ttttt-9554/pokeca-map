
(() => {
  'use strict';

  // ==========================================
  // 基本設定
  // ==========================================

  const KEY = 'pokeca-reports-v1';
  const STORE_KEY = 'pokeca-tochigi-stores-v05';
  const $ = id => document.getElementById(id);

  let reports = [];
  let stores = [];
  let packs = [];
  let decks = [];
  let editId = null;

  let map = null;
  let markers = null;

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

  const get = id => {
    const element = $(id);
    if (!element) {
      throw new Error(`HTML要素がありません: #${id}`);
    }
    return element;
  };

  function nowLocal() {
    const d = new Date();
    return new Date(
      d.getTime() - d.getTimezoneOffset() * 60000
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

  function saveReports() {
    localStorage.setItem(KEY, JSON.stringify(reports));
  }

  function loadReports() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(KEY) || '[]'
      );

      if (Array.isArray(saved)) {
        reports = saved.filter(validReport).map(r => ({
          ...r,
          category: r.category === 'deck' ? 'deck' : 'pack'
        }));
      }
    } catch (error) {
      console.error('履歴の読み込みエラー:', error);
    }
  }

  // ==========================================
  // 地図
  // ==========================================

  function initMap() {
    if (typeof L === 'undefined') {
      console.error('Leafletが読み込まれていません。');

      const mapElement = get('map');
      mapElement.textContent =
        '地図を読み込めませんでした。通信状態を確認して再読み込みしてください。';

      return false;
    }

    try {
      map = L.map('map').setView(
        [36.5551, 139.8828],
        12
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

      function openAtPoint(point) {
        formFor(null);
        get('lat').value = point.lat.toFixed(6);
        get('lng').value = point.lng.toFixed(6);
      }

      map.on('mousedown touchstart', event => {
        clearTimeout(pressTimer);

        const point = event.latlng;

        pressTimer = setTimeout(() => {
          openAtPoint(point);
        }, 650);
      });

      map.on('mouseup touchend dragstart move', () => {
        clearTimeout(pressTimer);
      });

      map.on('contextmenu', event => {
        clearTimeout(pressTimer);
        openAtPoint(event.latlng);
      });

      setTimeout(() => {
        map.invalidateSize();
      }, 300);

      return true;

    } catch (error) {
      console.error('地図の初期化エラー:', error);

      get('map').textContent =
        '地図の初期化に失敗しました。';

      map = null;
      markers = null;

      return false;
    }
  }

  function refreshMap() {
    if (!map) return;

    setTimeout(() => {
      try {
        map.invalidateSize();
      } catch (error) {
        console.error(error);
      }
    }, 100);
  }

  // ==========================================
  // 画面切り替え
  // ==========================================

  function switchTab(tab) {
    document.querySelectorAll('.view').forEach(view => {
      view.classList.toggle(
        'active',
        view.id === tab + 'View'
      );
    });

    document.querySelectorAll('nav button').forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.tab === tab
      );
    });

    if (tab === 'map') {
      refreshMap();
    }

    render();
  }

  // ==========================================
  // 履歴表示
  // ==========================================

  function inPeriod(report) {
    const period = get('period').value;

    if (period === 'all') return true;

    const time = new Date(report.foundAt).getTime();
    const now = Date.now();

    if (!Number.isFinite(time)) return false;

    if (period === 'week') {
      return time >= now - 7 * 86400000 &&
        time <= now;
    }

    return new Date(report.foundAt).toDateString() ===
      new Date().toDateString();
  }

  function card(report) {
    const category =
      report.category === 'deck'
        ? '構築デッキ'
        : '拡張パック';

    return `
      <article class="entry">
        <h3>${escape(report.shop)}</h3>

        <p>
          <strong>${escape(report.product)}</strong>
          · ${escape(report.status)}
          · ${category}
        </p>

        <p>${escape(report.foundAt.replace('T', ' '))}</p>

        ${
          report.memo
            ? `<p>${escape(report.memo)}</p>`
            : ''
        }

        <div class="actions">
          <button data-action="view"
                  data-id="${escape(report.id)}">
            地図で見る
          </button>

          <button data-action="edit"
                  data-id="${escape(report.id)}">
            編集
          </button>

          <button data-action="delete"
                  data-id="${escape(report.id)}">
            削除
          </button>
        </div>
      </article>
    `;
  }

  function render() {
    const sorted = [...reports].sort(
      (a, b) => b.foundAt.localeCompare(a.foundAt)
    );

    const historyList = get('historyList');
    const mapList = get('mapList');

    historyList.innerHTML = sorted.length
      ? sorted.map(card).join('')
      : '<p class="hint">まだ発見記録がありません。</p>';

    const visible = sorted.filter(inPeriod);

    mapList.innerHTML = visible.length
      ? visible.map(card).join('')
      : '<p class="hint">この期間の発見記録はありません。</p>';

    // 地図が未初期化でも履歴画面は動作させる
    if (!markers || typeof L === 'undefined') {
      return;
    }

    markers.clearLayers();

    visible.forEach(report => {
      const lat = Number(report.lat);
      const lng = Number(report.lng);

      const marker = L.marker([lat, lng]).addTo(markers);

      marker.bindPopup(`
        <strong>${escape(report.shop)}</strong>
        <p>${escape(report.product)}</p>
        <small>
          ${escape(report.foundAt.replace('T', ' '))}
          · ${escape(report.status)}
        </small>
      `);
    });
  }

  function handleCard(event) {
    const button = event.target.closest(
      'button[data-action]'
    );

    if (!button) return;

    const report = reports.find(
      r => r.id === button.dataset.id
    );

    if (!report) return;

    const action = button.dataset.action;

    if (action === 'delete') {
      if (!confirm('この発見記録を削除しますか？')) {
        return;
      }

      reports = reports.filter(
        r => r.id !== report.id
      );

      saveReports();
      render();
      return;
    }

    if (action === 'edit') {
      formFor(report);
      return;
    }

    if (action === 'view') {
      get('period').value = 'all';
      switchTab('map');

      if (map) {
        map.setView(
          [Number(report.lat), Number(report.lng)],
          16
        );

        markers.eachLayer(marker => {
          const position = marker.getLatLng();

          if (
            position.lat === Number(report.lat) &&
            position.lng === Number(report.lng)
          ) {
            marker.openPopup();
          }
        });
      }
    }
  }

  // ==========================================
  // 登録フォーム
  // ==========================================

  function formFor(report) {
    editId = report?.id || null;

    get('formTitle').textContent = editId
      ? '発見情報を編集'
      : '発見情報を登録';

    get('shop').value = report?.shop || '';
    get('product').value = report?.product || '';

    get('productCategory').value =
      report?.category === 'deck' ? 'deck' : 'pack';

    get('foundAt').value =
      report?.foundAt || nowLocal();

    get('status').value =
      report?.status || '販売を確認';

    get('memo').value = report?.memo || '';

    get('lat').value = report?.lat ?? '';
    get('lng').value = report?.lng ?? '';

    get('cancelEdit').hidden = !editId;

    closeProductDropdown();
    switchTab('add');
  }

  function saveForm(event) {
    event.preventDefault();

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

    if (!product) {
      alert('商品名を入力してください。');
      return;
    }

    if (
      latText === '' ||
      lngText === '' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      alert('店舗の位置情報を確認してください。');
      return;
    }

    if (!foundAt) {
      alert('発見日時を入力してください。');
      return;
    }

    const report = {
      id: editId || (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
      ),
      shop,
      product,
      category: get('productCategory').value,
      foundAt,
      status: get('status').value,
      memo: get('memo').value.trim(),
      lat,
      lng
    };

    const previous = reports;

    if (editId) {
      reports = reports.map(
        r => r.id === editId ? report : r
      );
    } else {
      reports = [...reports, report];
    }

    try {
      saveReports();
    } catch (error) {
      reports = previous;
      alert('保存できませんでした。ブラウザの容量を確認してください。');
      return;
    }

    editId = null;

    get('reportForm').reset();
    get('shop').value = '';
    get('lat').value = '';
    get('lng').value = '';
    get('foundAt').value = nowLocal();
    get('cancelEdit').hidden = true;

    get('period').value = 'all';

    switchTab('map');

    if (map) {
      map.setView([lat, lng], 16);
    }
  }

  // ==========================================
  // CSV共通解析
  // ==========================================

  function parseCSVRows(source) {
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
        (char === '\r' || char === '\n') &&
        !quoted
      ) {
        if (char === '\r' && text[i + 1] === '\n') {
          i++;
        }

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

    if (row.some(value => value.trim())) {
      rows.push(row);
    }

    return rows;
  }

  function parseCSV(source) {
    const rows = parseCSVRows(source);

    if (!rows.length) return [];

    const headers = rows.shift().map(
      header => header.trim()
    );

    return rows.map(row =>
      Object.fromEntries(
        headers.map((header, index) => [
          header,
          row[index] || ''
        ])
      )
    );
  }

  // ==========================================
  // 店舗データ
  // ==========================================

  function isStore(store) {
    return store &&
      typeof store.name === 'string' &&
      store.name.trim() &&
      Number.isFinite(Number(store.lat)) &&
      Number.isFinite(Number(store.lng)) &&
      Number(store.lat) > 35 &&
      Number(store.lat) < 38 &&
      Number(store.lng) > 138 &&
      Number(store.lng) < 141;
  }

  function norm(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\u3000・ー－-]/g, '');
  }

  function storeKey(store) {
    return norm(store.name) + '|' +
      Number(store.lat).toFixed(6) + '|' +
      Number(store.lng).toFixed(6);
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

  function updateStoreCount() {
    get('storeCount').textContent =
      `保存済み店舗 ${stores.length}件（この端末のみ）`;
  }

  function saveStores() {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify(stores)
    );

    updateStoreCount();
  }

  function addStores(items) {
    const existing = new Set(
      stores.map(storeKey)
    );

    let added = 0;

    items.filter(isStore).forEach(store => {
      const item = {
        name: String(store.name).trim(),
        city: String(store.city || '').trim(),
        lat: Number(store.lat),
        lng: Number(store.lng)
      };

      const key = storeKey(item);

      if (!existing.has(key)) {
        stores.push(item);
        existing.add(key);
        added++;
      }
    });

    try {
      saveStores();
    } catch (error) {
      console.error('店舗保存エラー:', error);
      updateStoreCount();
    }

    return added;
  }

  function loadSavedStores() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORE_KEY) || '[]'
      );

      if (Array.isArray(saved)) {
        stores = saved.filter(isStore).map(store => ({
          name: store.name,
          city: String(store.city || ''),
          lat: Number(store.lat),
          lng: Number(store.lng)
        }));
      }
    } catch (error) {
      console.error('店舗データ読込エラー:', error);
    }

    updateStoreCount();
  }

  async function loadStoreCSV() {
    try {
      const response = await fetch(
        './tochigi-convenience-stores.csv'
      );

      if (!response.ok) {
        throw new Error('店舗CSVが見つかりません');
      }

      const text = await response.text();
      const data = parseCSV(text);

      const items = data.filter(isStore);

      // 既存のローカル店舗を消さずに追加
      addStores(items);

      console.log(
        '店舗CSV読み込み成功:',
        items.length,
        '件'
      );

    } catch (error) {
      console.error('店舗CSV読み込みエラー:', error);
    }
  }

  function searchStores() {
    const area = norm(get('searchArea').value);
    const query = brandNorm(
      get('storeQuery').value
    );

    const results = get('storeResults');
    results.replaceChildren();

    if (!query) {
      results.textContent =
        '店舗名・チェーン名を入力してください。';
      return;
    }

    const matches = stores.filter(store => {
      const name = norm(store.name);
      const brand = brandNorm(store.name);
      const city = norm(store.city);

      const nameMatches =
        brand.includes(query) ||
        name.includes(query);

      const areaMatches =
        !area ||
        city.includes(area) ||
        name.includes(area);

      return nameMatches && areaMatches;
    });

    const count = document.createElement('p');
    count.className = 'hint';
    count.textContent =
      `${matches.length}件の店舗が見つかりました`;

    results.append(count);

    if (!matches.length) {
      const message = document.createElement('p');
      message.textContent =
        '該当店舗がありません。';
      results.append(message);
      return;
    }

    matches.forEach(store => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'store-result';

      const title = document.createElement('strong');
      title.textContent = store.name;

      const detail = document.createElement('small');
      detail.textContent = [
        store.city,
        `緯度 ${store.lat.toFixed(5)}`,
        `経度 ${store.lng.toFixed(5)}`
      ].filter(Boolean).join(' · ');

      button.append(title, detail);

      button.addEventListener('click', () => {
        get('shop').value = store.name;
        get('lat').value = store.lat.toFixed(6);
        get('lng').value = store.lng.toFixed(6);

        results.textContent =
          `選択済み：${store.name}`;

        if (map) {
          map.setView(
            [store.lat, store.lng],
            17
          );
        }
      });

      results.append(button);
    });
  }

  // ==========================================
  // チェーン名の候補表示
  // ==========================================

  const chainNames = [
    'セブンイレブン',
    'ファミリーマート',
    'ローソン',
    'ミニストップ'
  ];

  let chainDropdown = null;

  function closeChainDropdown() {
    if (chainDropdown) {
      chainDropdown.hidden = true;
    }
  }

  function showChainDropdown() {
    if (!chainDropdown) return;

    const input = get('storeQuery');
    const query = norm(input.value);

    chainDropdown.replaceChildren();

    const options = chainNames.filter(name => {
      if (!query) return true;

      return norm(name).includes(query) ||
        (
          name === 'ファミリーマート' &&
          norm('ファミマ').includes(query)
        ) ||
        (
          name === 'セブンイレブン' &&
          'seveneleven'.includes(query)
        );
    });

    options.forEach(name => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;

      button.style.cssText =
        'display:block;width:100%;padding:12px;' +
        'text-align:left;background:#fff;color:#111827;' +
        'border:0;border-bottom:1px solid #e5e7eb;';

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
    chainDropdown.hidden = true;

    chainDropdown.style.cssText =
      'position:absolute;top:100%;left:0;right:0;' +
      'z-index:1000;background:#fff;' +
      'border:1px solid #cbd5e1;border-radius:10px;' +
      'box-shadow:0 8px 20px rgba(0,0,0,.15);' +
      'max-height:240px;overflow-y:auto;';

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

  // ==========================================
  // 商品データ
  // ==========================================

  function productDateValue(value) {
    const match = String(value || '').match(
      /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/
    );

    if (!match) return 0;

    return (
      Number(match[1]) * 10000 +
      Number(match[2]) * 100 +
      Number(match[3])
    );
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
      .filter(product => product.name)
      .sort(
        (a, b) =>
          productDateValue(b.date) -
          productDateValue(a.date)
      );
  }

  async function loadProducts() {
    const sources = [
      {
        category: 'pack',
        file: './pokemon_packs.csv'
      },
      {
        category: 'deck',
        file: './pokemon_decks.csv'
      }
    ];

    await Promise.all(
      sources.map(async source => {
        try {
          const response = await fetch(source.file);

          if (!response.ok) {
            throw new Error(
              `${source.file}: HTTP ${response.status}`
            );
          }

          const text = await response.text();
          const products = parseProducts(text);

          if (source.category === 'pack') {
            packs = products;
          } else {
            decks = products;
          }

          console.log(
            `${source.category} 読み込み成功:`,
            products.length,
            '件'
          );

          if (
            document.activeElement === get('product')
          ) {
            showProductDropdown();
          }

        } catch (error) {
          console.error(
            '商品CSV読み込みエラー:',
            error
          );
        }
      })
    );
  }

  // ==========================================
  // 商品検索
  // ==========================================

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

  function currentProducts() {
    return get('productCategory').value === 'deck'
      ? decks
      : packs;
  }

  let productDropdown = null;

  function closeProductDropdown() {
    if (productDropdown) {
      productDropdown.hidden = true;
      get('product').setAttribute(
        'aria-expanded',
        'false'
      );
    }
  }

  function showProductDropdown() {
    if (!productDropdown) return;

    const input = get('product');
    const query = productNorm(input.value);
    const products = currentProducts();

    productDropdown.replaceChildren();

    if (!products.length) {
      const message = document.createElement('p');
      message.className = 'hint';
      message.style.padding = '12px';
      message.textContent =
        '商品データを読み込み中、またはCSVを取得できません。';

      productDropdown.append(message);
      productDropdown.hidden = false;
      return;
    }

    const matches = products.filter(product => {
      if (!query) return true;

      if (productNorm(product.name).includes(query)) {
        return true;
      }

      if (productNorm(product.reading).includes(query)) {
        return true;
      }

      return Object.entries(productAliases).some(
        ([name, aliases]) =>
          productNorm(product.name).includes(
            productNorm(name)
          ) &&
          aliases.some(alias =>
            productNorm(alias).includes(query)
          )
      );
    });

    if (!matches.length) {
      const message = document.createElement('p');
      message.className = 'hint';
      message.style.padding = '12px';
      message.textContent =
        '該当する商品がありません。手入力も可能です。';

      productDropdown.append(message);
    }

    matches.forEach(product => {
      const button = document.createElement('button');
      button.type = 'button';

      button.style.cssText =
        'display:block;width:100%;padding:10px 12px;' +
        'text-align:left;background:#fff;color:#111827;' +
        'border:0;border-bottom:1px solid #e5e7eb;';

      const name = document.createElement('strong');
      name.textContent = product.name;

      const detail = document.createElement('small');
      detail.style.cssText =
        'display:block;color:#64748b;margin-top:3px;';

      detail.textContent = [
        product.date,
        product.price
          ? `${product.price}円`
          : '',
        product.tax
      ].filter(Boolean).join(' · ');

      button.append(name, detail);

      button.addEventListener('click', () => {
        input.value = product.name;
        closeProductDropdown();
      });

      productDropdown.append(button);
    });

    productDropdown.hidden = false;

    input.setAttribute(
      'aria-expanded',
      'true'
    );
  }

  function initProductDropdown() {
    const input = get('product');

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'position:relative;width:100%;';

    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(input);

    input.style.width = '100%';
    input.setAttribute('autocomplete', 'off');

    productDropdown = document.createElement('div');
    productDropdown.id = 'packDropdown';
    productDropdown.hidden = true;

    productDropdown.style.cssText =
      'position:absolute;top:100%;left:0;right:0;' +
      'z-index:1100;background:#fff;' +
      'border:1px solid #cbd5e1;border-radius:10px;' +
      'box-shadow:0 8px 20px rgba(0,0,0,.15);' +
      'max-height:280px;overflow-y:auto;';

    wrapper.append(productDropdown);

    input.addEventListener('focus', showProductDropdown);
    input.addEventListener('click', showProductDropdown);
    input.addEventListener('input', showProductDropdown);

    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeProductDropdown();
      }
    });

    get('productCategory').addEventListener(
      'change',
      () => {
        input.value = '';
        closeProductDropdown();
      }
    );

    document.addEventListener('pointerdown', event => {
      if (!wrapper.contains(event.target)) {
        closeProductDropdown();
      }
    });
  }

  // ==========================================
  // 発見履歴のJSON入出力
  // ==========================================

  function exportReports() {
    const blob = new Blob(
      [JSON.stringify(reports, null, 2)],
      { type: 'application/json' }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'pokeca-reports.json';
    link.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
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
        throw new Error('JSON形式が正しくありません');
      }

      if (
        confirm(
          `${data.length}件の記録で現在のデータを置き換えますか？`
        )
      ) {
        reports = data.map(report => ({
          ...report,
          category:
            report.category === 'deck'
              ? 'deck'
              : 'pack'
        }));

        saveReports();
        render();
      }

    } catch (error) {
      alert('読み込めないJSONファイルです。');
    }

    event.target.value = '';
  }

  // ==========================================
  // 店舗CSV入出力
  // ==========================================

  function csvEscape(value) {
    const text = String(value ?? '');

    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }

    return text;
  }

  function exportStores() {
    const lines = [
      'name,city,lat,lng',
      ...stores.map(store =>
        [
          store.name,
          store.city,
          store.lat,
          store.lng
        ].map(csvEscape).join(',')
      )
    ];

    const blob = new Blob(
      ['\uFEFF' + lines.join('\r\n')],
      { type: 'text/csv;charset=utf-8' }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'pokeca-tochigi-stores.csv';
    link.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  async function importStores(event) {
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      if (file.size > 2000000) {
        throw new Error('CSVは2MB以下にしてください');
      }

      const rows = parseCSV(await file.text());

      if (rows.length > 10000) {
        throw new Error('一度に取り込めるのは1万件までです');
      }

      const items = rows.filter(isStore);

      if (!items.length) {
        throw new Error('有効な店舗データがありません');
      }

      if (
        confirm(
          `${items.length}件の店舗データを取り込みますか？`
        )
      ) {
        const added = addStores(items);
        alert(`${added}件の店舗を追加しました。`);
      }

    } catch (error) {
      alert(`CSV取込エラー：${error.message}`);
    }

    event.target.value = '';
  }

  function rememberStore() {
    const name = get('shop').value.trim();
    const latText = get('lat').value;
    const lngText = get('lng').value;

    const store = {
      name,
      city: get('searchArea').value.trim(),
      lat: Number(latText),
      lng: Number(lngText)
    };

    if (
      !name ||
      latText === '' ||
      lngText === '' ||
      !isStore(store)
    ) {
      alert('正確な店舗名・緯度・経度を入力してください。');
      return;
    }

    const added = addStores([store]);

    alert(
      added
        ? '店舗一覧に保存しました。'
        : 'すでに登録されている店舗です。'
    );
  }

  // ==========================================
  // 現在地
  // ==========================================

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
        map.setView(
          [
            position.coords.latitude,
            position.coords.longitude
          ],
          15
        );
      },
      () => {
        alert(
          '位置情報を取得できませんでした。ブラウザの設定を確認してください。'
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10000
      }
    );
  }

  // ==========================================
  // イベント登録
  // ==========================================

  function bindEvents() {
    document.querySelectorAll('nav button').forEach(
      button => {
        button.addEventListener('click', () => {
          switchTab(button.dataset.tab);
        });
      }
    );

    get('period').addEventListener(
      'change',
      render
    );

    get('historyList').addEventListener(
      'click',
      handleCard
    );

    get('mapList').addEventListener(
      'click',
      handleCard
    );

    get('reportForm').addEventListener(
      'submit',
      saveForm
    );

    get('cancelEdit').addEventListener(
      'click',
      () => formFor(null)
    );

    get('storeSearch').addEventListener(
      'click',
      () => {
        closeChainDropdown();
        searchStores();
      }
    );

    get('searchArea').addEventListener(
      'keydown',
      event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          searchStores();
        }
      }
    );

    get('storeRemember').addEventListener(
      'click',
      rememberStore
    );

    get('storeExport').addEventListener(
      'click',
      exportStores
    );

    get('storeImport').addEventListener(
      'change',
      importStores
    );

    get('export').addEventListener(
      'click',
      exportReports
    );

    get('import').addEventListener(
      'change',
      importReports
    );

    get('locate').addEventListener(
      'click',
      locate
    );
  }

  // ==========================================
  // アプリ起動
  // ==========================================

  function init() {
    try {
      console.log('ポケカ発見マップ：起動開始');

      loadReports();
      loadSavedStores();

      initProductDropdown();
      initChainDropdown();

      bindEvents();

      get('foundAt').value = nowLocal();
      get('cancelEdit').hidden = true;

      // 先に地図を初期化
      initMap();

      // 地図の有無に関係なく画面を表示
      switchTab('map');

      // CSVは非同期で読み込む
      loadStoreCSV();
      loadProducts();

      console.log('ポケカ発見マップ：起動完了');

    } catch (error) {
      console.error('アプリ起動エラー:', error);

      alert(
        'アプリの起動中にエラーが発生しました。\n' +
        error.message
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      init
    );
  } else {
    init();
  }

})();
