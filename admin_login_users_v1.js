/* Discord display names for the developer's valid signed-in accounts. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const RPC = 'toreca_admin_logged_in_users_v1';
  let options = null, lastUser = '', generation = 0, lastLoaded = 0, busy = null;

  function allowed() {
    return !!options?.isDev?.() && !!options?.getUserId?.() && !!options?.getClient?.();
  }

  function visible() {
    const panel = $('adminLoginUsersPanel');
    return !!panel?.closest('details.dev-accordion')?.open &&
      !!$('devView')?.classList.contains('active') && document.visibilityState !== 'hidden';
  }

  function clear() {
    ++generation;
    lastLoaded = 0;
    busy = null;
    $('adminLoginUsersList')?.replaceChildren();
    if ($('adminLoginUsersCount')) $('adminLoginUsersCount').textContent = '';
    if ($('adminLoginUsersStatus')) $('adminLoginUsersStatus').textContent = '開くとログイン中のユーザーを確認します。';
    if ($('adminLoginUsersReload')) $('adminLoginUsersReload').disabled = false;
  }

  function onAuthChanged() {
    const user = allowed() ? String(options.getUserId()) : '';
    if (lastUser !== user) {
      lastUser = user;
      clear();
    }
    if (user && visible()) void refresh();
  }

  async function refresh(force = false) {
    if (!allowed() || !visible()) return false;
    if (busy) return busy;
    if (!force && lastLoaded && Date.now() - lastLoaded < 60000) return true;
    const user = String(options.getUserId()), seq = ++generation;
    const button = $('adminLoginUsersReload'), status = $('adminLoginUsersStatus');
    if (button) button.disabled = true;
    if (status) status.textContent = '🔄 ログイン状態を確認しています…';
    const task = Promise.resolve().then(async () => {
      try {
        const { data, error } = await options.getClient().rpc(RPC);
        if (error) throw error;
        if (!allowed() || user !== String(options.getUserId()) || seq !== generation) return false;
        if (!Array.isArray(data)) throw Error('Invalid login list');
        const names = data.map(row => typeof row?.display_name === 'string' && row.display_name.trim()
          ? row.display_name.trim().slice(0, 80) : 'Discordユーザー');
        names.sort((a, b) => a.localeCompare(b, 'ja'));
        const list = $('adminLoginUsersList');
        const items = names.map(name => {
          const item = document.createElement('li');
          item.textContent = name;
          return item;
        });
        list?.replaceChildren(...items);
        if ($('adminLoginUsersCount')) $('adminLoginUsersCount').textContent = names.length + '人';
        if (status) status.textContent = names.length ? '自動更新は約1分ごとです。' : 'ログイン状態のアカウントはありません。';
        lastLoaded = Date.now();
        return true;
      } catch (_) {
        if (allowed() && user === String(options.getUserId()) && seq === generation) {
          lastLoaded = 0;
          $('adminLoginUsersList')?.replaceChildren();
          if ($('adminLoginUsersCount')) $('adminLoginUsersCount').textContent = '';
          if (status) status.textContent = '⚠ 取得できませんでした。ログイン状態を確認して更新してください。';
        }
        return false;
      } finally {
        if (busy === task) {
          busy = null;
          if (button) button.disabled = false;
        }
      }
    });
    busy = task;
    return task;
  }

  function onTabChanged(tab) {
    if (tab === 'dev' && allowed() && visible()) void refresh();
  }

  function init(config) {
    if (options) return;
    options = config;
    const panel = $('adminLoginUsersPanel');
    if (!panel) return;
    const fold = panel.closest('details.dev-accordion');
    fold?.addEventListener('toggle', () => { if (fold.open) void refresh(true); });
    $('adminLoginUsersReload')?.addEventListener('click', () => { void refresh(true); });
    document.addEventListener('visibilitychange', () => { if (visible()) void refresh(); });
    setInterval(() => { if (visible()) void refresh(); }, 60000);
    onAuthChanged();
  }

  window.TorecaAdminLoginUsers = { init, onAuthChanged, onTabChanged, refresh };
})();
