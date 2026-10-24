/* Toreca Radar: read-only guerrilla sale status feed.
 * Discord alerts are sent by the server-side collector.
 * This UI does not claim to provide background iPhone Web Push.
 */
(() => {
  'use strict';
  const URL = './guerrilla_sale_feed.json';
  const SEEN = 'toreca-guerrilla-alert-seen-v1';
  const $ = id => document.getElementById(id);
  let feed = {items: [], events: [], monitored_count: 0};
  let loading = false;

  function timeLabel(iso) {
    const value = Date.parse(iso || '');
    return Number.isFinite(value)
      ? new Date(value).toLocaleString('ja-JP', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})
      : '未確認';
  }
  function safeUrl(value) {
    try {
      const u = new URL(String(value));
      return u.protocol === 'https:' && u.hostname ? u.href : '';
    } catch (_) { return ''; }
  }
  function node(tag, value, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (value !== undefined) el.textContent = String(value);
    return el;
  }
  function link(url) {
    const href = safeUrl(url);
    if (!href) return node('span', 'リンクなし');
    const a = node('a', '公式販売ページ ↗', 'guerrilla-sale-link');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  function updateBadge() {
    let seen = 0;
    try { seen = Number(localStorage.getItem(SEEN)) || 0; } catch (_) {}
    const unread = (feed.events || []).filter(e => Date.parse(e.detected_at || '') > seen).length;
    const badge = $('guerrillaSaleBadge');
    if (badge) {
      badge.hidden = !unread;
      badge.textContent = unread ? unread + '件 NEW' : '';
    }
  }
  function updateShopOptions(items) {
    const select = $('guerrillaSaleShop');
    if (!select) return;
    const current = select.value;
    const shops = [...new Set(items.map(x => String(x.shop || '').trim()).filter(Boolean))].sort();
    select.replaceChildren(new Option('全店舗', 'all'), ...shops.map(s => new Option(s,s)));
    select.value = shops.includes(current) ? current : 'all';
  }
  function render() {
    const items = Array.isArray(feed.items) ? feed.items : [];
    const events = Array.isArray(feed.events) ? feed.events : [];
    const filter = $('guerrillaSaleShop')?.value || 'all';
    const visible = entry => filter === 'all' || String(entry.shop) === filter;
    const live = items.filter(x => x.status === 'available').length;
    $('guerrillaSaleCount').textContent = items.length + '件監視中 / 販売表示 ' + live + '件';
    const eventRoot = $('guerrillaSaleEvents');
    const currentRoot = $('guerrillaSaleCurrent');
    eventRoot.replaceChildren();
    currentRoot.replaceChildren();
    const recent = events.filter(visible).slice(0, 15);
    if (!recent.length) eventRoot.append(node('p','販売開始を確認した速報はまだありません。','hint'));
    for (const evt of recent) {
      const card = node('article',undefined,'guerrilla-sale-card');
      card.append(node('strong', '⚡ ' + (evt.shop || '店舗未設定') + ' / ' + (evt.product || '商品未設定')));
      card.append(node('small','検知：' + timeLabel(evt.detected_at)));
      card.append(link(evt.url));
      eventRoot.append(card);
    }
    const current = items.filter(visible);
    if (!current.length) {
      currentRoot.append(node('p',
        items.length ? 'この店舗の監視対象はありません。' :
          'まだ監視対象の販売URLが登録されていません。管理者による対象設定後に表示されます。','hint'));
    }
    const labels = {available:'販売表示を検知',unavailable:'売り切れ・受付前',unknown:'判定できません'};
    for (const item of current) {
      const card = node('article',undefined,'guerrilla-sale-card');
      const status = node('span',labels[item.status] || '不明','guerrilla-sale-status is-' + (item.status || 'unknown'));
      card.append(node('strong',(item.shop || '店舗未設定') + ' / ' + (item.product || '商品未設定')));
      card.append(status);
      card.append(node('small','確認：' + timeLabel(item.checked_at)));
      if (item.status === 'unknown' && item.reason) {
        card.append(node('small',String(item.reason)));
      }
      card.append(link(item.url));
      currentRoot.append(card);
    }
    updateBadge();
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    const message = $('guerrillaSaleStatus');
    try {
      const res = await fetch(URL + '?v=' + Date.now(), {cache:'no-store'});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.items) || !Array.isArray(data.events)) throw new Error('データ形式');
      feed = data;
      updateShopOptions(feed.items);
      render();
      message.textContent = '公式販売ページの自動確認結果です。更新時点の情報で、購入や在庫を保証しません。';
    } catch (err) {
      message.textContent = '速報を読み込めませんでした。通信状況を確認して更新してください。';
    } finally {
      loading = false;
    }
  }
  function init() {
    const panel = $('guerrillaSalePanel');
    if (!panel) return;
    panel.addEventListener('toggle', () => {
      if (!panel.open) return;
      try { localStorage.setItem(SEEN, String(Date.now())); } catch (_) {}
      updateBadge();
      refresh();
    });
    $('guerrillaSaleRefresh').addEventListener('click', refresh);
    $('guerrillaSaleShop').addEventListener('change', render);
    refresh();
    setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 90000);
    window.addEventListener('focus', refresh);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
