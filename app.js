
(() => {
  'use strict';

  const KEY = 'pokeca-reports-v1';
  const STORE_KEY = 'pokeca-tochigi-stores-v05'; // 既存データを保持
  const $ = id => document.getElementById(id);

  let reports = [];
  let stores = [];
  let packs = [];
  let decks = [];
  let mapSelectedProducts = []; // {name, category}
  let editId = null;
  let map = null;
  let markers = null;

  // 候補から選んだ商品の情報
  let selectedProduct = null;

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

    return `
      <article class="entry">
        <h3>${escape(r.shop)}</h3>
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

    const visible = sorted.filter(r => inPeriod(r) && mapReportMatches(r));
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

    const points = reports
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

  function handleCard(event) {
    const button = event.target.closest(
      'button[data-action]'
    );
    if (!button) return;

    const r = reports.find(
      item => item.id === button.dataset.id
    );
    if (!r) return;

    if (button.dataset.action === 'delete') {
      if (!confirm('この発見記録を削除しますか？')) return;

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
    get('product').value = '';
    updateCategoryHint();
    closeProductDropdown();
  }

  // ========================================
  // 登録フォーム
  // ========================================

  function formFor(r) {
    editId = r?.id || null;
    selectedProduct = null;

    get('formTitle').textContent = editId
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
    get('cancelEdit').hidden = !editId;

    updateCategoryHint();
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

    let category = null;

    // 候補から選択した商品ならカテゴリを自動判定
    if (
      selectedProduct &&
      selectedProduct.name === product &&
      selected.includes(selectedProduct.category)
    ) {
      category = selectedProduct.category;
    } else if (selected.length === 1) {
      category = selected[0];
    } else {
      // 両方チェック・手入力の場合は曖昧さを防ぐ
      alert(
        '手入力した商品を保存する場合は、' +
        'カテゴリを1つだけチェックしてください。'
      );
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
      category,
      foundAt,
      status: get('status').value,
      memo: get('memo').value.trim(),
      lat,
      lng
    };

    const previous = reports;

    if (editId) {
      reports = reports.map(
        item => item.id === editId ? report : item
      );
    } else {
      reports = [...reports, report];
    }

    try {
      saveReports();
    } catch (error) {
      reports = previous;
      alert('保存に失敗しました。');
      return;
    }

    editId = null;
    selectedProduct = null;

    get('reportForm').reset();
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
            packs = products;
          } else {
            decks = products;
          }

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

    matches.forEach(p => {
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
        input.value = p.name;
        selectedProduct = {
          name: p.name,
          category: p.category
        };
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
    const count = stores.length;
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
    const matches = stores.filter(p => {
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

    get('locate').addEventListener('click', locate);
  }

  // ========================================
  // 起動
  // ========================================

  function init() {
    try {
      console.log('ポケカ発見マップ 地図自動調整版 起動開始');

      loadReports();
      loadSavedStores();

      initProductDropdown();
      initMapProductFilter();
      initChainDropdown();
      bindEvents();

      get('foundAt').value = nowLocal();
      get('cancelEdit').hidden = true;
      updateCategoryHint();

      initMap();
      switchTab('map');

      loadStoreCSV();
      loadProducts();

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
