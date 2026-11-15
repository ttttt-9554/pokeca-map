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
  const rowParts = new WeakMap();
  const pendingWrites = new Map();
  const uncertainCards = new Set();

  let options, active = false, owner = '', ownerVersion = 0;
  let sets = null, setsRequest = null, selectedGroup = null;
  let cards = null, readVersion = 0, loading = false, reloadAfterSave = false;
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
      if (filter === 'wanted' && !card.wanted) return false;
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
    image.width = 110;
    image.height = 154;
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

  function cardContentKey(card){
    return JSON.stringify([card.name, card.set_code, card.card_number, card.official_image_path]);
  }

  function cardRow(card){
    const row = document.createElement('li');
    row.className = 'pokemon-card-row';
    row.dataset.cardId = card.card_id;
    const name = document.createElement('strong');
    name.className = 'pokemon-card-name';
    name.textContent = card.name;
    const meta = document.createElement('small');
    meta.className = 'pokemon-card-number';
    meta.textContent = [card.set_code, card.card_number || '番号表記なし'].filter(Boolean).join(' ');
    const detailUrl = OFFICIAL_DETAIL + card.card_id + '/regu/all';

    const actions = document.createElement('div');
    actions.className = 'pokemon-card-quantity';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', `${card.name} ${card.card_number || ''}の所持枚数`);
    const label = document.createElement('span');
    label.textContent = card.quantity + '枚';
    const buttons = [];
    for (const delta of [-1, 1]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.cardDelta = String(delta);
      button.textContent = delta < 0 ? '−' : '＋';
      button.setAttribute('aria-label', `${card.name} ${card.card_number || ''}を1枚${delta < 0 ? '減らす' : '増やす'}`);
      actions.append(button);
      buttons.push({element:button, delta});
      if (delta < 0) actions.append(label);
    }
    const wanted = document.createElement('label');
    wanted.className = 'pokemon-card-wanted';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.cardWanted = '';
    checkbox.setAttribute('aria-label', `${card.name} ${card.card_number || ''}が欲しい`);
    const wantedText = document.createElement('span');
    wantedText.textContent = '欲しい';
    wanted.append(checkbox, wantedText);
    row.append(cardThumbnail(card, detailUrl), name, meta, actions, wanted);
    rowParts.set(row, {key:cardContentKey(card), imagePath:card.official_image_path, label, buttons, checkbox});
    syncCardControls(row, card);
    return row;
  }

  function setText(element, value){
    if (element.textContent !== value) element.textContent = value;
  }

  function syncCardControls(row, card){
    const parts = rowParts.get(row);
    const busy = loading || uncertainCards.has(card.card_id) || !!pendingWrites.get(card.card_id)?.recovering;
    setText(parts.label, card.quantity + '枚');
    for (const {element, delta} of parts.buttons) {
      const disabled = busy || (delta < 0 ? card.quantity === 0 : card.quantity >= MAX_QUANTITY);
      if (element.disabled !== disabled) element.disabled = disabled;
    }
    if (parts.checkbox.checked !== !!card.wanted) parts.checkbox.checked = !!card.wanted;
    if (parts.checkbox.disabled !== busy) parts.checkbox.disabled = busy;
  }

  function syncCardRows(visible){
    const list = $('pokemonCardList');
    const visibleIds = new Set(visible.map(card => String(card.card_id)));
    // Remove filtered-out rows first so surviving images do not need to move.
    for (const row of Array.from(list.children)) {
      if (!visibleIds.has(row.dataset.cardId)) row.remove();
    }
    const existing = new Map(Array.from(list.children, row => [row.dataset.cardId, row]));
    let cursor = list.firstElementChild;
    for (const card of visible) {
      let row = existing.get(String(card.card_id));
      if (row && rowParts.get(row)?.key !== cardContentKey(card)) {
        const replacement = cardRow(card);
        if (cursor === row) cursor = replacement;
        row.replaceWith(replacement);
        row = replacement;
      }
      if (!row) row = cardRow(card);
      syncCardControls(row, card);
      // An unchanged row stays attached, retaining its decoded image and focus.
      if (row === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(row, cursor);
    }
  }

  function render(changedCard){
    const filtered = filterCards();
    const owned = (cards || []).filter(card => card.quantity > 0).length;
    const copies = (cards || []).reduce((total, card) => total + card.quantity, 0);
    const progress = $('pokemonCardProgressBar');
    $('pokemonCardProgress').hidden = !cards?.length;
    if (progress.max !== (cards?.length || 1)) progress.max = cards?.length || 1;
    if (progress.value !== owned) progress.value = owned;
    setText($('pokemonCardSummary'), cards
      ? `${owned} / ${cards.length}種類 所持 · 計${copies}枚 · 未所持${cards.length - owned}種類` : '');
    setText($('pokemonCardStatus'), message || (pendingWrites.size ? '保存中…'
      : loading ? '収録カードを読み込んでいます…'
      : sets?.length === 0 ? '収録カードはまだ登録されていません。'
      : cards && !filtered.length ? '条件に合うカードはありません。'
      : cards ? `${filtered.length}件中 ${Math.min(limit, filtered.length)}件を表示` : ''));
    // A normal save only changes the tapped card and the collection totals.
    // In particular, never disable/recolor the whole grid while awaiting RPCs.
    if (changedCard && $('pokemonCardOwnedFilter').value === 'all') {
      const row = $('pokemonCardList').querySelector(`[data-card-id="${changedCard.card_id}"]`);
      if (row) syncCardControls(row, changedCard);
    } else {
      $('pokemonCardSet').disabled = loading || !sets?.length;
      $('pokemonCardsRefresh').disabled = loading;
      $('pokemonCardsMore').hidden = filtered.length <= limit;
      syncCardRows(filtered.slice(0, limit));
    }
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
    if (!owner) return false;
    // An explicit refresh or set change waits for pending writes so a stale
    // read cannot overwrite a newer optimistic quantity.
    if (pendingWrites.size) {
      reloadAfterSave = true;
      render();
      return false;
    }
    reloadAfterSave = false;
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
        const {data, error} = await options.getClient().rpc('pokemon_card_set_search_v2', {p_group_id: selectedGroup})
          .order('sort_order').order('card_id').range(offset, offset + READ_SIZE - 1);
        if (version !== readVersion) return false;
        if (error) throw error;
        next.push(...data);
        if (data.length < READ_SIZE) break;
      }
      cards = next;
      for (const card of cards) uncertainCards.delete(card.card_id);
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

  function syncPendingCard(state){
    const card = cards?.find(row => row.card_id === state.cardId);
    if (!card) { render(); return; }
    // Keep all queued taps visible even when an older response arrives.
    card.quantity = state.quantity;
    card.wanted = state.wanted;
    for (const operation of state.operations) {
      if (operation.type === 'quantity') {
        card.quantity = Math.min(MAX_QUANTITY, Math.max(0, card.quantity + operation.value));
      } else card.wanted = operation.value;
    }
    const focused = document.activeElement;
    const wasFocused = focused?.closest('[data-card-id]')?.dataset.cardId === String(state.cardId);
    render(card);
    if (active && wasFocused && (!focused.isConnected || focused.disabled)
        && (document.activeElement === focused || document.activeElement === document.body)) {
      const row = $('pokemonCardList').querySelector(`[data-card-id="${state.cardId}"]`);
      (row?.querySelector('button:enabled, input:enabled') || $('pokemonCardOwnedFilter')).focus({preventScroll:true});
    }
  }

  async function flushCardWrites(state){
    state.running = true;
    const current = () => state.version === ownerVersion && owner === options.getUserId();
    try {
      while (current() && state.operations.length) {
        const operation = state.operations[0];
        try {
          const quantity = operation.type === 'quantity';
          const {data, error} = await options.getClient().rpc(
            quantity ? 'pokemon_card_quantity_adjust_v1' : 'pokemon_card_wanted_set_v1',
            quantity ? {p_card_id:state.cardId, p_delta:operation.value}
              : {p_card_id:state.cardId, p_wanted:operation.value}
          );
          if (!current()) return;
          if (error || (quantity ? !Number.isInteger(data) || data < 0 || data > MAX_QUANTITY : typeof data !== 'boolean')) {
            throw error || new Error('Invalid saved value');
          }
          state.operations.shift();
          if (quantity) state.quantity = data;
          else state.wanted = data;
        } catch {
          if (!current()) return;
          // Never retry an increment after an uncertain response. Re-read only
          // this card, then continue the taps that have not yet been sent.
          state.recovering = true;
          syncPendingCard(state);
          const {data, error} = await options.getClient().rpc('pokemon_card_set_search_v2', {p_group_id:state.groupId})
            .eq('card_id', state.cardId).range(0, 0);
          if (!current()) return;
          const saved = data?.[0];
          if (error || !saved || !Number.isInteger(saved.quantity) || saved.quantity < 0 || saved.quantity > MAX_QUANTITY
              || typeof saved.wanted !== 'boolean') throw error || new Error('Unconfirmed save');
          state.operations.shift();
          state.quantity = saved.quantity;
          state.wanted = saved.wanted;
          state.recovering = false;
          message = '保存結果を再取得しました。枚数・チェックを確認してください。';
        }
        syncPendingCard(state);
      }
    } catch {
      if (current()) {
        // Only this card is blocked until an explicit refresh confirms it.
        uncertainCards.add(state.cardId);
        message = '保存結果を確認できませんでした。「再取得」を押してください。';
      }
    } finally {
      if (state.version === ownerVersion) {
        pendingWrites.delete(state.cardId);
        state.recovering = false;
        if (!pendingWrites.size && !message) message = '保存しました。';
        if (!uncertainCards.has(state.cardId)) syncPendingCard(state);
        else render(cards?.find(row => row.card_id === state.cardId));
        if (!pendingWrites.size && reloadAfterSave) void loadCards();
      }
    }
  }

  function queueChange(cardId, type, value){
    if (!active || !owner || loading || options.getUserId() !== owner || uncertainCards.has(cardId)) return;
    const card = cards?.find(row => row.card_id === cardId);
    if (!card || pendingWrites.get(cardId)?.recovering) return;
    if (type === 'quantity' ? card.quantity + value < 0 || card.quantity + value > MAX_QUANTITY : !!card.wanted === value) return;
    let state = pendingWrites.get(cardId);
    if (!state) {
      state = {cardId, groupId:selectedGroup, version:ownerVersion, quantity:card.quantity,
        wanted:!!card.wanted, operations:[], running:false, recovering:false};
      pendingWrites.set(cardId, state);
    }
    state.operations.push({type, value});
    if (!uncertainCards.size) message = '';
    syncPendingCard(state);
    if (!state.running) void flushCardWrites(state);
  }

  function onAuthChanged(){
    const user = options?.getUserId() || '';
    $('openPokemonCards').hidden = !user;
    if (user === owner) return;
    owner = user;
    failedImages.clear();
    pendingWrites.clear();
    uncertainCards.clear();
    ++ownerVersion;
    ++readVersion;
    sets = setsRequest = selectedGroup = cards = null;
    loading = reloadAfterSave = false;
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
    if (!owner) return;
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
    $('pokemonCardsRefresh').addEventListener('click', () => {
      // Only failed thumbnails need a fresh image element on an explicit retry.
      for (const row of $('pokemonCardList').children) {
        const parts = rowParts.get(row);
        if (parts && failedImages.has(parts.imagePath)) parts.key = null;
      }
      failedImages.clear();
      void loadCards();
    });
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
      queueChange(Number(button.closest('[data-card-id]').dataset.cardId), 'quantity', delta);
    });
    $('pokemonCardList').addEventListener('change', event => {
      const checkbox = event.target.closest('input[data-card-wanted]');
      if (!checkbox || checkbox.disabled) return;
      queueChange(Number(checkbox.closest('[data-card-id]').dataset.cardId), 'wanted', checkbox.checked);
    });
    onAuthChanged();
  }

  window.TorecaPokemonCards = {
    init, open, onAuthChanged, onTabChanged,
    hasProduct: productId => !!sets?.some(set => set.product_id === productId)
  };
})();
