/* Toreca Radar: official Pokémon card catalog and personal quantities. */
(function(){
  'use strict';

  const $ = id => document.getElementById(id);
  const TAB = 'pokemonCards';
  const PAGE_SIZE = 40;
  const READ_SIZE = 250;
  const MAX_QUANTITY = 9999;
  const OFFICIAL_ORIGIN = 'https://www.pokemon-card.com';
  const OFFICIAL_DETAIL = 'https://www.pokemon-card.com/card-search/details.php/card/';
  const failedImages = new Set();

  let options, active = false, owner = '', ownerVersion = 0;
  let sets = null, setsRequest = null, selectedGroup = null;
  let cards = null, readVersion = 0, loading = false, saving = false;
  let limit = PAGE_SIZE, backTab = 'infoPlaza', message = '';

  function searchKey(value){
    return String(value ?? '').normalize('NFKC').toLowerCase()
      .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 96));
  }

  function filterCards(){
    const terms = searchKey($('pokemonCardSearch').value).trim()
      .replace(/\s*\/\s*/g, '/').split(/\s+/).filter(Boolean);
    const filter = $('pokemonCardOwnedFilter').value;
    return (cards || []).filter(card => {
      if (filter === 'owned' && !card.quantity) return false;
      if (filter === 'missing' && card.quantity) return false;
      const text = searchKey([card.name, card.set_code, card.card_number].join(' '));
      const number = card.card_number?.split('/')[0];
      return terms.every(term => /^\d+$/.test(term)
        ? !!number && Number(term) === Number(number)
        : text.includes(term));
    });
  }

  function cardThumbnail(card, detailUrl){
    const link = document.createElement('a');
    link.className = 'pokemon-card-thumbnail';
    link.href = detailUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${card.name} ${card.card_number || ''}の画像・詳細を公式サイトで見る`);
    const path = card.official_image_path;
    // Only the exact official image for this printing may be loaded.
    const match = typeof path === 'string' && path.match(/^\/assets\/images\/card_images\/(?:large|legend)\/[A-Za-z0-9_-]+\/([0-9]{1,10})_[A-Za-z0-9_-]+\.jpg$/);
    if (!match || Number(match[1]) !== card.card_id || failedImages.has(path)) {
      link.textContent = '画像なし';
      return link;
    }
    const image = document.createElement('img');
    image.alt = '';
    image.width = 72;
    image.height = 100;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      failedImages.add(path);
      link.replaceChildren(document.createTextNode('画像なし'));
    }, {once:true});
    image.src = OFFICIAL_ORIGIN + path;
    link.append(image);
    return link;
  }

  function cardRow(card){
    const row = document.createElement('li');
    row.className = 'pokemon-card-row';
    row.dataset.cardId = card.card_id;
    const info = document.createElement('div');
    info.className = 'pokemon-card-info';
    const name = document.createElement('strong');
    name.textContent = card.name;
    const meta = document.createElement('small');
    meta.textContent = [card.set_code, card.card_number || '番号表記なし'].filter(Boolean).join(' ');
    const official = document.createElement('a');
    official.href = OFFICIAL_DETAIL + card.card_id + '/regu/all';
    official.target = '_blank';
    official.rel = 'noopener noreferrer';
    official.textContent = '公式詳細 ↗';
    info.append(name, meta, official);

    const actions = document.createElement('div');
    actions.className = 'pokemon-card-quantity';
    const label = document.createElement('span');
    label.textContent = card.quantity + '枚';
    for (const delta of [-1, 1]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.cardDelta = String(delta);
      button.disabled = saving || loading || (delta < 0 ? card.quantity === 0 : card.quantity >= MAX_QUANTITY);
      button.textContent = delta < 0 ? '−' : '＋';
      button.setAttribute('aria-label', `${card.name} ${card.card_number || ''}を1枚${delta < 0 ? '減らす' : '増やす'}`);
      actions.append(button);
      if (delta < 0) actions.append(label);
    }
    row.append(cardThumbnail(card, official.href), info, actions);
    return row;
  }

  function render(){
    const filtered = filterCards();
    const owned = (cards || []).filter(card => card.quantity > 0).length;
    const copies = (cards || []).reduce((total, card) => total + card.quantity, 0);
    const progress = $('pokemonCardProgressBar');
    $('pokemonCardProgress').hidden = !cards?.length;
    progress.max = cards?.length || 1;
    progress.value = owned;
    $('pokemonCardSummary').textContent = cards
      ? `${owned} / ${cards.length}種類 所持 · 計${copies}枚 · 未所持${cards.length - owned}種類` : '';
    $('pokemonCardStatus').textContent = message || (loading ? '収録カードを読み込んでいます…'
      : sets?.length === 0 ? '収録カードはまだ登録されていません。'
      : cards && !filtered.length ? '条件に合うカードはありません。'
      : cards ? `${filtered.length}件中 ${Math.min(limit, filtered.length)}件を表示` : '');
    $('pokemonCardSet').disabled = loading || saving || !sets?.length;
    $('pokemonCardsRefresh').disabled = loading || saving;
    $('pokemonCardsMore').hidden = filtered.length <= limit;
    $('pokemonCardList').replaceChildren(...filtered.slice(0, limit).map(cardRow));
  }

  async function loadSets(){
    if (sets) return sets;
    if (setsRequest) return setsRequest;
    const version = ownerVersion;
    const request = (async () => {
      const {data, error} = await options.getClient().from('pokemon_card_sets_v1')
        .select('official_group_id,product_id,title').order('title').order('official_group_id');
      if (version !== ownerVersion) return null;
      if (error) throw error;
      sets = data || [];
      const select = $('pokemonCardSet');
      select.replaceChildren(...sets.map(set => new Option(set.title, set.official_group_id)));
      options.onCatalogLoaded?.();
      return sets;
    })();
    setsRequest = request;
    try { return await request; }
    finally { if (setsRequest === request) setsRequest = null; }
  }

  async function loadCards(){
    if (!owner || saving) return false;
    const version = ++readVersion;
    loading = true;
    message = '';
    render();
    try {
      const available = await loadSets();
      if (version !== readVersion || !available) return false;
      if (!available.some(set => set.official_group_id === selectedGroup)) {
        selectedGroup = available[0]?.official_group_id ?? null;
      }
      $('pokemonCardSet').value = selectedGroup == null ? '' : String(selectedGroup);
      if (selectedGroup == null) {
        cards = [];
        return true;
      }
      const next = [];
      for (let offset = 0; ; offset += READ_SIZE) {
        const {data, error} = await options.getClient().rpc('pokemon_card_set_search_v1', {p_group_id: selectedGroup})
          .order('sort_order').order('card_id').range(offset, offset + READ_SIZE - 1);
        if (version !== readVersion) return false;
        if (error) throw error;
        next.push(...data);
        if (data.length < READ_SIZE) break;
      }
      cards = next;
      return true;
    } catch {
      if (version === readVersion) {
        cards = null;
        message = 'カードを読み込めませんでした。「再取得」をお試しください。';
      }
      return false;
    } finally {
      if (version === readVersion) {
        loading = false;
        render();
      }
    }
  }

  async function adjust(cardId, delta){
    if (!active || !owner || loading || saving || !options.getUserId()) return;
    const card = cards?.find(row => row.card_id === cardId);
    if (!card || card.quantity + delta < 0 || card.quantity + delta > MAX_QUANTITY) return;
    const version = ownerVersion;
    const restoreFocus = document.activeElement?.dataset.cardDelta === String(delta);
    saving = true;
    message = '所持枚数を保存しています…';
    render();
    try {
      const {data, error} = await options.getClient().rpc('pokemon_card_quantity_adjust_v1', {
        p_card_id: cardId, p_delta: delta
      });
      if (version !== ownerVersion) return;
      if (error || !Number.isInteger(data) || data < 0 || data > MAX_QUANTITY) throw error || new Error('Invalid quantity');
      card.quantity = data;
      message = card.name + 'の所持枚数を' + data + '枚に更新しました。';
    } catch {
      if (version !== ownerVersion) return;
      // A lost response may follow a successful save. Read the saved value
      // before enabling adjustments again instead of retrying the increment.
      saving = false;
      if (await loadCards() && version === ownerVersion) {
        message = '保存結果を再取得しました。表示中の枚数を確認してください。';
      }
    } finally {
      if (version === ownerVersion) {
        saving = false;
        render();
        if (active && restoreFocus && document.activeElement === document.body) {
          const row = $('pokemonCardList').querySelector(`[data-card-id="${cardId}"]`);
          const button = row?.querySelector(`button[data-card-delta="${delta}"]:enabled`);
          if (button) button.focus({preventScroll:true});
          else if (row) row.querySelector('button:enabled')?.focus({preventScroll:true});
          else $('pokemonCardOwnedFilter').focus({preventScroll:true});
        }
      }
    }
  }

  function onAuthChanged(){
    const user = options?.getUserId() || '';
    $('openPokemonCards').hidden = !user;
    if (user === owner) return;
    owner = user;
    failedImages.clear();
    ++ownerVersion;
    ++readVersion;
    sets = setsRequest = selectedGroup = cards = null;
    loading = saving = false;
    message = '';
    limit = PAGE_SIZE;
    $('pokemonCardSet').replaceChildren();
    $('pokemonCardSearch').value = '';
    $('pokemonCardOwnedFilter').value = 'all';
    render();
    if (active && owner) void loadCards();
    else if (owner) void loadSets().catch(() => {});
  }

  function onTabChanged(tab){
    const entered = !active && tab === TAB;
    active = tab === TAB;
    if (entered && owner) void loadCards();
  }

  function open(productId){
    if (!owner || saving) return;
    const set = sets?.find(row => productId && row.product_id === productId);
    backTab = set ? 'dev' : 'infoPlaza';
    $('pokemonCardsBack').textContent = set ? '← 商品マスター' : '← 情報広場';
    if (set && selectedGroup !== set.official_group_id) {
      selectedGroup = set.official_group_id;
      cards = null;
      message = '';
      limit = PAGE_SIZE;
      $('pokemonCardSearch').value = '';
      $('pokemonCardOwnedFilter').value = 'all';
      render();
    }
    options.navigate(TAB);
    $('pokemonCardsTitle').focus({preventScroll:true});
  }

  function init(config){
    if (options || !$('pokemonCardsView')) return;
    options = config;
    $('openPokemonCards').addEventListener('click', () => open());
    $('pokemonCardsBack').addEventListener('click', () => options.navigate(backTab));
    $('pokemonCardsRefresh').addEventListener('click', () => void loadCards());
    $('pokemonCardSet').addEventListener('change', event => {
      selectedGroup = Number(event.target.value);
      cards = null;
      limit = PAGE_SIZE;
      void loadCards();
    });
    const filtersChanged = () => { limit = PAGE_SIZE; message = ''; render(); };
    $('pokemonCardSearch').addEventListener('input', filtersChanged);
    $('pokemonCardOwnedFilter').addEventListener('change', filtersChanged);
    $('pokemonCardsMore').addEventListener('click', () => { limit += PAGE_SIZE; render(); });
    $('pokemonCardList').addEventListener('click', event => {
      const button = event.target.closest('button[data-card-delta]');
      if (!button || button.disabled) return;
      const delta = Number(button.dataset.cardDelta);
      if (delta !== -1 && delta !== 1) return;
      void adjust(Number(button.closest('[data-card-id]').dataset.cardId), delta);
    });
    onAuthChanged();
  }

  window.TorecaPokemonCards = {
    init, open, onAuthChanged, onTabChanged,
    hasProduct: productId => !!sets?.some(set => set.product_id === productId)
  };
})();
