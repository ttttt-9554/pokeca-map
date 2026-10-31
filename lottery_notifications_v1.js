/* Toreca Radar: private, in-app lottery reminders (v21.142).
 * No system push, browser permission, or private account information is uploaded.
 * Data arrives only after the app verifies the current Discord session.
 */
(function () {
  'use strict';

  const TZ = 'Asia/Tokyo';
  const PICKUP_LEAD_DAYS = 3;
  const MAX_PAST_RESULT_DAYS = 7;
  const MAX_OVERDUE_PICKUP_DAYS = 2;
  const BASE = 'toreca-lottery-notifications-v1:';
  let userId = '';
  let records = [];
  let notices = [];
  let readMap = {};
  let toastedMap = {};
  let bell = null;
  let badge = null;
  let panel = null;
  let panelList = null;
  let markAll = null;
  let toast = null;
  let toastTimer = null;
  let panelOpen = false;

  function todayJst(now) {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(now));
  }

  function utcDay(iso) {
    return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1,
      Number(iso.slice(8, 10)));
  }

  function parseJstDateTime(input) {
    const text = String(input || '').replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return NaN;
    const time = Date.parse(text + ':00+09:00');
    return Number.isFinite(time) ? time : NaN;
  }

  function hashKey(input) {
    // Hash only: do not persist event URLs, titles, accounts or notes locally.
    let a = 2166136261, b = 2166136261;
    for (let i = 0; i < input.length; i++) {
      a = Math.imul(a ^ input.charCodeAt(i), 16777619);
      b = Math.imul(b ^ input.charCodeAt(i), 2246822519);
    }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
  }

  function readStored(kind) {
    if (!userId) return {};
    try {
      const data = JSON.parse(localStorage.getItem(BASE + kind + ':' + userId) || '{}');
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (_) {}
    return {};
  }

  function saveStored(kind, value) {
    if (!userId) return;
    try {
      const recent = Object.entries(value).filter(item =>
        typeof item[0] === 'string' && typeof item[1] === 'number'
      ).sort((a, b) => b[1] - a[1]).slice(0, 500);
      localStorage.setItem(BASE + kind + ':' + userId, JSON.stringify(Object.fromEntries(recent)));
    } catch (_) {}
  }

  function makeNotice(record, kind, stage, priority, time, headline, details) {
    const id = hashKey(kind + '\x1f' + record.event_url + '\x1f' +
      time + '\x1f' + stage);
    return {
      id, kind, stage, priority, time,
      event_url: record.event_url,
      title: String(record.title || '抽選名未確認').slice(0, 160),
      headline, details
    };
  }

  function evaluate(rows, now) {
    const currentDay = todayJst(now);
    const output = [];
    for (const r of rows) {
      if (!r || typeof r.event_url !== 'string' || !r.event_url) continue;
      const status = String(r.status || '');
      if (status === 'applied') {
        const resultAt = parseJstDateTime(r.result_announcement_at);
        if (Number.isFinite(resultAt)) {
          const hours = (resultAt - now) / 3600000;
          if (hours > 0 && hours <= 24) {
            output.push(makeNotice(r, 'result', 'before', 3, resultAt,
              '📣 抽選結果の発表が近づいています',
              '発表予定：' + String(r.result_announcement_at).replace('T', ' ') +
              '（日本時間）／ 24時間以内です'));
          } else if (hours <= 0 && hours >= -24 * MAX_PAST_RESULT_DAYS) {
            output.push(makeNotice(r, 'result', 'due', 1, resultAt,
              '📣 抽選結果の発表予定時刻になりました',
              '発表予定：' + String(r.result_announcement_at).replace('T', ' ') +
              '（日本時間）／ 公式サイトで当落を確認してください'));
          }
        }
      }
      if (status !== 'won' || !/^\d{4}-\d{2}-\d{2}$/.test(r.pickup_end || '')) continue;
      const days = Math.round((utcDay(r.pickup_end) - utcDay(currentDay)) / 86400000);
      if (days > PICKUP_LEAD_DAYS || days < -MAX_OVERDUE_PICKUP_DAYS) continue;
      const cutoffTime = /^\d{2}:\d{2}$/.test(r.pickup_end_time || '') ?
        r.pickup_end_time : '';
      const cutoff = cutoffTime ?
        parseJstDateTime(r.pickup_end + 'T' + cutoffTime) : NaN;
      const overdue = days < 0 || (days === 0 && Number.isFinite(cutoff) && now > cutoff);
      let stage, priority, headline;
      if (overdue) {
        stage = 'overdue'; priority = 0; headline = '⚠️ 受け取り期限を過ぎています';
      } else if (days === 0) {
        stage = 'today'; priority = 0; headline = '⚠️ 今日が受け取り期限です';
      } else if (days === 1) {
        stage = 'tomorrow'; priority = 1; headline = '📦 明日が受け取り期限です';
      } else {
        stage = 'soon'; priority = 2; headline = '📦 受け取り期限まであと' + days + '日';
      }
      const details = '受け取り期限：' + r.pickup_end.replaceAll('-', '/') +
        (cutoffTime ? ' ' + cutoffTime : '（終了時刻は未登録）') +
        ' ／ 必ず公式案内を確認してください';
      output.push(makeNotice(r, 'pickup', stage, priority, r.pickup_end,
        headline, details));
    }
    return output.sort((a, b) =>
      a.priority - b.priority || String(a.time).localeCompare(String(b.time)) ||
      a.title.localeCompare(b.title));
  }

  function dismissToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    if (toast) toast.hidden = true;
  }

  function showToast(fresh) {
    if (!toast || !fresh.length || document.visibilityState === 'hidden') return;
    dismissToast();
    const label = fresh.length === 1 ? fresh[0].headline :
      '🔔 抽選に関する新しいお知らせが' + fresh.length + '件あります';
    const title = toast.querySelector('.trn-toast-label');
    if (title) title.textContent = label;
    toast.hidden = false;
    toastTimer = setTimeout(dismissToast, 8500);
  }

  function setPanelOpen(open) {
    panelOpen = !!open && !!userId;
    if (!panel || !bell) return;
    panel.hidden = !panelOpen;
    bell.setAttribute('aria-expanded', String(panelOpen));
    if (panelOpen) {
      dismissToast();
      drawList();
      const close = document.getElementById('trnClose');
      if (close) close.focus();
    } else if (document.activeElement && panel.contains(document.activeElement)) {
      bell.focus();
    }
  }

  function mark(id) {
    if (!userId) return;
    readMap[id] = Date.now();
    saveStored('read', readMap);
    draw();
  }

  function markAllRead() {
    const now = Date.now();
    notices.forEach(n => { readMap[n.id] = now; });
    saveStored('read', readMap);
    draw();
  }

  function openRecord(item) {
    if (!userId || !records.some(r => r.event_url === item.event_url)) return;
    mark(item.id);
    setPanelOpen(false);
    window.dispatchEvent(new CustomEvent('toreca:open-private-lottery', {
      detail: { event_url: item.event_url }
    }));
  }

  function drawList() {
    if (!panelList || !markAll || !userId) return;
    panelList.replaceChildren();
    const unread = notices.filter(n => !readMap[n.id]).length;
    markAll.disabled = !unread;
    if (!notices.length) {
      const empty = document.createElement('p');
      empty.className = 'trn-empty';
      empty.textContent = '今のところ、発表予定・受け取り期限の通知はありません。';
      panelList.append(empty);
      return;
    }
    notices.slice(0, 100).forEach(item => {
      const row = document.createElement('article');
      row.className = 'trn-item' + (readMap[item.id] ? ' is-read' : '') +
        (item.priority === 0 ? ' is-urgent' : '');
      const heading = document.createElement('strong');
      heading.textContent = item.headline;
      const title = document.createElement('p');
      title.className = 'trn-item-title';
      title.textContent = item.title;
      const detail = document.createElement('p');
      detail.className = 'trn-item-detail';
      detail.textContent = item.details;
      const actions = document.createElement('div');
      actions.className = 'trn-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = '個別管理を開く';
      open.addEventListener('click', () => openRecord(item));
      actions.append(open);
      if (!readMap[item.id]) {
        const acknowledge = document.createElement('button');
        acknowledge.type = 'button';
        acknowledge.className = 'trn-secondary';
        acknowledge.textContent = '既読にする';
        acknowledge.addEventListener('click', () => mark(item.id));
        actions.append(acknowledge);
      }
      row.append(heading, title, detail, actions);
      panelList.append(row);
    });
    if (notices.length > 100) {
      const more = document.createElement('p');
      more.className = 'trn-empty';
      more.textContent = 'ほか' + (notices.length - 100) + '件は抽選管理から確認してください。';
      panelList.append(more);
    }
  }

  function draw() {
    if (!bell || !badge || !panel) return;
    const signedIn = !!userId;
    bell.hidden = !signedIn;
    if (!signedIn) {
      panel.hidden = true;
      panelOpen = false;
      dismissToast();
      return;
    }
    const unread = notices.filter(n => !readMap[n.id]).length;
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    bell.setAttribute('aria-label', '抽選通知' + (unread ? '・未読' + unread + '件' : ''));
    if (panelOpen) drawList();
  }

  function update() {
    if (!userId) { draw(); return; }
    notices = evaluate(records, Date.now());
    draw();
    const fresh = notices.filter(n => !toastedMap[n.id] && !readMap[n.id]);
    if (fresh.length) {
      const at = Date.now();
      fresh.forEach(n => { toastedMap[n.id] = at; });
      saveStored('toast', toastedMap);
      showToast(fresh);
    }
  }

  function sync(payload) {
    if (!payload || !/^[a-f\d-]{36}$/i.test(String(payload.userId || ''))) {
      clear(); return;
    }
    if (userId !== payload.userId) {
      userId = payload.userId;
      readMap = readStored('read');
      toastedMap = readStored('toast');
      dismissToast();
      setPanelOpen(false);
    }
    records = Array.isArray(payload.records) ? payload.records : [];
    update();
  }

  function clear() {
    userId = '';
    records = [];
    notices = [];
    readMap = {};
    toastedMap = {};
    setPanelOpen(false);
    draw();
  }

  function mount() {
    if (document.getElementById('trnBell')) return;
    const style = document.createElement('style');
    style.id = 'trnStyles';
    style.textContent = [
      '#trnBell{position:fixed;right:14px;bottom:calc(88px + env(safe-area-inset-bottom));z-index:7200;width:56px;height:56px;border-radius:50%;display:flex;justify-content:center;align-items:center;font-size:25px;cursor:pointer;border:1px solid var(--app-border,#cad6e7);background:var(--app-surface,#fff);color:var(--app-text,#172033);box-shadow:0 7px 25px #0004}',
      '#trnBell[hidden],#trnPanel[hidden],#trnToast[hidden],#trnBadge[hidden]{display:none!important}',
      '#trnBell:focus-visible,#trnPanel button:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}',
      '#trnBadge{position:absolute;top:-6px;right:-5px;min-width:21px;height:21px;padding:0 4px;box-sizing:border-box;border-radius:20px;background:#dc2626;color:white;font-size:11px;font-weight:800;line-height:21px;text-align:center;border:1px solid white}',
      '#trnPanel{position:fixed;right:12px;bottom:calc(156px + env(safe-area-inset-bottom));z-index:7201;width:min(430px,calc(100vw - 24px));max-height:min(68dvh,650px);box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--app-border,#cbd5e1);border-radius:16px;background:var(--app-surface,#fff);color:var(--app-text,#172033);box-shadow:0 16px 45px #0006}',
      '.trn-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px;border-bottom:1px solid var(--app-border,#cbd5e1)}',
      '.trn-head h3{margin:0;font-size:17px;color:inherit}.trn-head button{font-size:14px;min-height:36px}',
      '#trnList{padding:0 14px;overflow:auto;overscroll-behavior:contain;min-height:0;flex:1}',
      '.trn-item{border-bottom:1px solid var(--app-border,#cbd5e1);padding:13px 0;color:var(--app-text,#172033)}',
      '.trn-item.is-urgent>strong{color:#dc2626}html[data-theme="dark"] .trn-item.is-urgent>strong{color:#fda4af}',
      '.trn-item.is-read{opacity:.7}.trn-item strong{font-size:13px;line-height:1.5;display:block;overflow-wrap:anywhere}',
      '.trn-item-title{font-weight:700;font-size:13px!important;line-height:1.5;margin:6px 0!important;color:inherit!important;overflow-wrap:anywhere}',
      '.trn-item-detail{font-size:12px!important;line-height:1.6;margin:4px 0 10px!important;color:var(--app-muted,#64748b)!important;overflow-wrap:anywhere}',
      '.trn-actions{display:flex;gap:8px;flex-wrap:wrap}.trn-actions button{padding:8px 11px;border-radius:9px;background:#2563eb;color:#fff!important;font-size:12px;border:1px solid #2563eb;min-height:36px;cursor:pointer}',
      '.trn-actions button.trn-secondary{background:var(--app-surface2,#f1f5f9);color:var(--app-text,#172033)!important;border-color:var(--app-border,#cbd5e1)}',
      '.trn-empty{padding:15px 0;font-size:13px!important;color:var(--app-muted,#64748b)!important}',
      '.trn-foot{margin:0;padding:10px 14px;border-top:1px solid var(--app-border,#cbd5e1);font-size:11px!important;line-height:1.5;color:var(--app-muted,#64748b)!important}',
      '#trnToast{position:fixed;top:calc(75px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:7202;width:min(430px,calc(100vw - 24px));box-sizing:border-box;border-radius:12px;background:var(--app-surface,#fff);color:var(--app-text,#172033);border:2px solid #60a5fa;box-shadow:0 12px 32px #0005;padding:12px;display:flex;align-items:center;gap:8px}',
      '#trnToast .trn-toast-label{flex:1;font-size:13px;font-weight:700;line-height:1.5}',
      '#trnToast button{white-space:nowrap;background:#2563eb;color:white;border:0;border-radius:8px;padding:9px;font-size:12px;cursor:pointer}',
      '@media(max-height:580px){#trnPanel{max-height:calc(100dvh - 175px)}}'
    ].join('\n');
    document.head.append(style);

    bell = document.createElement('button');
    bell.id = 'trnBell';
    bell.type = 'button';
    bell.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
    bell.setAttribute('aria-controls', 'trnPanel');
    bell.setAttribute('aria-label', '抽選通知');
    bell.textContent = '🔔';
    badge = document.createElement('span');
    badge.id = 'trnBadge';
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');
    bell.append(badge);

    panel = document.createElement('section');
    panel.id = 'trnPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '自分の抽選通知');
    panel.innerHTML = '<div class="trn-head"><h3>🔔 自分の抽選通知</h3>' +
      '<div><button type="button" id="trnReadAll">すべて既読</button> ' +
      '<button type="button" id="trnClose" aria-label="通知を閉じる">× 閉じる</button></div></div>' +
      '<div id="trnList"></div>' +
      '<p class="trn-foot">登録した発表日時と受取期限から自動表示します。' +
      'アプリを開いている間と次回起動時に確認できます。' +
      '終了時刻・当落結果は公式案内で必ず確認してください。</p>';
    panelList = panel.querySelector('#trnList');
    markAll = panel.querySelector('#trnReadAll');

    toast = document.createElement('div');
    toast.id = 'trnToast';
    toast.hidden = true;
    toast.setAttribute('role', 'status');
    const toastText = document.createElement('span');
    toastText.className = 'trn-toast-label';
    const toastButton = document.createElement('button');
    toastButton.type = 'button';
    toastButton.textContent = '通知を見る';
    toastButton.addEventListener('click', () => setPanelOpen(true));
    toast.append(toastText, toastButton);
    document.body.append(bell, panel, toast);

    bell.addEventListener('click', () => {
      setPanelOpen(!panelOpen);
      if (panelOpen) window.dispatchEvent(new Event('toreca:notification-refresh-request'));
    });
    panel.querySelector('#trnClose').addEventListener('click', () => setPanelOpen(false));
    markAll.addEventListener('click', markAllRead);
    document.addEventListener('pointerdown', e => {
      if (panelOpen && !panel.contains(e.target) && !bell.contains(e.target) &&
          !toast.contains(e.target)) setPanelOpen(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && panelOpen) {
        e.stopPropagation();
        setPanelOpen(false);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') update();
    });
    window.addEventListener('focus', () => { if (userId) update(); });
    setInterval(() => {
      if (userId && document.visibilityState === 'visible') update();
    }, 60000);
    draw();
  }

  window.TorecaLotteryNotify = { sync, clear };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
