// Public Google Forms metadata only. Never submit a form or read responses.
export const GOOGLE_FORMS_PARSER_VERSION = 2;
export function googleFormUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return '';
    if ([...url.searchParams].some(([key, value]) => !['usp', 'embedded', 'hl'].includes(key) || value.length > 100)) return '';
    const allowed = url.hostname === 'docs.google.com'
      ? /^\/forms\/d\/(?:e\/)?[A-Za-z0-9_-]{20,180}\/(?:viewform|closedform)\/?$/.test(url.pathname)
      : url.hostname === 'forms.gle' && /^\/[A-Za-z0-9_-]{8,100}\/?$/.test(url.pathname);
    if (!allowed) return '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  } catch { return ''; }
}

export async function fetchGoogleForm(value, request = fetch) {
  let url = googleFormUrl(value);
  if (!url) throw Error('Unsupported Google Form URL');
  const seen = new Set();
  for (let hop = 0; hop < 4; hop++) {
    if (seen.has(url)) throw Error('Google Form redirect loop');
    seen.add(url);
    const response = await request(url, {method: 'GET', redirect: 'manual',
      headers: {'User-Agent': 'TorecaRadar/1.0', Accept: 'text/html,application/xhtml+xml'},
      signal: AbortSignal.timeout(12000)});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const next = location ? googleFormUrl(new URL(location, url).href) : '';
      await response.body?.cancel();
      // A sign-in or non-Forms destination is never followed.
      if (!next) throw Error('Google Form is not publicly accessible');
      if (new URL(url).hostname === 'docs.google.com' &&
          new URL(next).pathname.replace(/\/(viewform|closedform)$/, '') !==
          new URL(url).pathname.replace(/\/(viewform|closedform)$/, ''))
        throw Error('Google Form identity changed');
      url = next;
      continue;
    }
    if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length') || 0) > 2000000 || !response.body) {
      await response.body?.cancel();
      throw Error('Google Form page unavailable');
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let html = '', size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2000000) { await reader.cancel(); throw Error('Google Form page too large'); }
        html += decoder.decode(value, {stream: true});
      }
    } finally { reader.releaseLock(); }
    return {url, html: html + decoder.decode()};
  }
  throw Error('Too many Google Form redirects');
}

const clean = value => typeof value === 'string' ? value.normalize('NFKC').replace(/[\u00a0\u3000]/g, ' ').trim() : '';
const single = values => { const unique = [...new Set(values.filter(Boolean))]; return unique.length === 1 ? unique[0] : ''; };
const pad = value => String(value).padStart(2, '0');
function calendar(year, month, day) {
  const value = `${year}-${pad(month)}-${pad(day)}`;
  const date = new Date(value + 'T00:00:00Z');
  return year >= 2020 && year <= 2100 && Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : '';
}

function point(value, anchor) {
  const text = clean(value);
  const match = text.match(/^(?:(\d{4})\s*(?:年|[\/.-])\s*)?(\d{1,2})\s*(?:月|[\/.-])\s*(\d{1,2})(?!\d)\s*日?/);
  if (!match) return null;
  let rest = text.slice(match[0].length).trim();
  const weekday = rest.match(/^\(([日月火水木金土])(?:曜(?:日)?)?\)/);
  if (weekday) rest = rest.slice(weekday[0].length).trim();
  const reference = new Date(anchor + 'T00:00:00Z');
  const year = reference.getUTCFullYear();
  const dates = (match[1] ? [Number(match[1])] : [year - 1, year, year + 1])
    .map(y => calendar(y, Number(match[2]), Number(match[3]))).filter(Boolean)
    .filter(date => !weekday || '日月火水木金土'[new Date(date + 'T00:00:00Z').getUTCDay()] === weekday[1])
    .sort((a,b) => Math.abs(Date.parse(a) - reference) - Math.abs(Date.parse(b) - reference));
  const date = dates[0];
  // Yearless dates belong to this recent discovery, not a guessed future year.
  if (!date || (!match[1] && Math.abs(Date.parse(date) - reference) > 90 * 86400000)) return null;
  const clock = rest.match(/^(?:の\s*)?(\d{1,2})(?::(\d{2})(?!\d)|時(?:\s*(?:(\d{1,2})分|(半)))?)/);
  let time = '';
  if (clock) {
    const hour = Number(clock[1]), minute = Number(clock[2] || clock[3] || (clock[4] ? 30 : 0));
    if (hour > 23 || minute > 59) return null;
    rest = rest.slice(clock[0].length).trim();
    if (!/^(?:頃|ごろ|前後)/.test(rest)) time = `${pad(hour)}:${pad(minute)}`;
  }
  return {date, time, rest};
}

function period(value, anchor) {
  const start = point(value, anchor);
  if (!start) return [];
  const separator = start.rest.match(/^(?:[~〜～–—－-]|から)\s*/);
  if (!separator) return [start];
  let tail = start.rest.slice(separator[0].length);
  if (/^\d{1,2}日/.test(tail)) tail = start.date.slice(5, 7) + '月' + tail;
  const end = point(tail, start.date);
  if (!end || end.date < start.date ||
      (end.date === start.date && start.time && end.time && end.time < start.time)) return [];
  return [start, end];
}

function stamp(value) { return value.time ? `${value.date}T${value.time}:00+09:00` : value.date; }

function storeName(value) {
  const name = clean(value).replace(/^(?:TC|トーナメントセンター)\s*(?=バトロコ)/i, '')
    .replace(/^(バトロコ|TSUTAYA|WonderGOO|新星堂)\s+/, '$1');
  return name.length >= 3 && name.length <= 200 &&
    !/抽選|応募|対象商品|発売|同意|選択して|未選択|^その他$|[<>\r\n]/.test(name) &&
    /店$|^(?:バトロコ|TSUTAYA|WonderGOO|カードラボ|ホビーステーション)/.test(name) ? name : '';
}

// Exact branches verified against the operator's store directory, not inferred
// from a city-name substring. Other stores use the existing unique master lookup.
// https://www.vidaway.co.jp/shop_area/kanto/kanagawa
// https://www.vidaway.co.jp/shop_area/kanto/tokyo
const verifiedAreas = new Map([
  ['バトロコ川崎駅前店', '神奈川県'], ['バトロコ川崎駅前', '神奈川県'],
  ['バトロコ立川駅前店', '東京都'], ['バトロコ立川駅前', '東京都'],
  ['バトロコ小田原駅前店', '神奈川県'], ['バトロコ小田原駅前', '神奈川県'],
  ['バトロコ横浜伊勢佐木町店', '神奈川県'], ['バトロコ横浜伊勢佐木町', '神奈川県'],
  ['バトロコ高田馬場店', '東京都'], ['バトロコ高田馬場', '東京都']
]);

export function googleFormFields(html, source, {referenceDate = new Date().toISOString()} = {}) {
  const url = googleFormUrl(source);
  if (!url || new URL(url).hostname !== 'docs.google.com') return {};
  const snapshots = [...html.matchAll(/\bFB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script\s*>/g)];
  if (snapshots.length !== 1) return {};
  let data;
  try { data = JSON.parse(snapshots[0][1]); } catch { return {}; }
  const id = new URL(url).pathname.replace(/^\/forms\/d\//, '').replace(/\/(?:viewform|closedform)$/, '');
  if (!Array.isArray(data) || data[14] !== id || !Array.isArray(data[1])) return {};
  const title = clean(data[1][8]).replace(/\s+/g, ' ');
  if (title.length < 5 || title.length > 200 || !/抽選/.test(title) || /[<>]|ログイン|アクセス権|受付終了/.test(title)) return {};
  const fields = {event_title: title};
  const sections = (Array.isArray(data[1][1]) ? data[1][1] : [])
    .filter(question => Array.isArray(question) && [6,8].includes(question[3]))
    .flatMap(question => [clean(question[1]), clean(question[2])]);
  const lines = [clean(data[1][0]), ...sections].join('\n').split(/\r?\n/).map(clean).filter(Boolean);
  const labelValues = names => lines.flatMap((line, index) => {
    const match = line.match(new RegExp('^(?:[■◆◇▼●【\\[]\\s*)?(?:' + names + ')[\\s:：】\\]]*(.*)$'));
    return match ? [match[1] || lines[index + 1] || ''] : [];
  });
  const labeled = names => single(labelValues(names));
  const reference = new Date(referenceDate);
  const anchor = Number.isFinite(+reference) ? new Date(+reference + 9*3600000).toISOString().slice(0,10) : '';
  if (anchor) {
    const applicationLabels = '(?:抽選)?(?:応募|申込|申し込み)(?:受付)?期間|受付期間';
    const startLabels = '(?:応募|申込|受付)開始(?:日時|日)?';
    const deadlineLabels = '(?:応募|申込|受付)(?:締切|締め切り|締め切|〆切|終了)(?:日時|日)?';
    const application = labeled(applicationLabels);
    const range = period(application, anchor);
    if (range.length === 2) {
      fields.application_start_at = stamp(range[0]);
      fields.application_end_at = stamp(range[1]);
    } else if (range.length === 1 && /まで|締切|〆切/.test(range[0].rest)) {
      fields.application_end_at = stamp(range[0]);
    }
    for (const [field, labels] of [
      ['application_start_at', startLabels],
      ['application_end_at', deadlineLabels]
    ]) {
      const date = point(labeled(labels), anchor);
      if (date && !fields[field]) fields[field] = stamp(date);
    }
    // A clearly stated deadline-only schedule is different from a failed parse.
    // Do not use Discord timestamps or other branches' dates as the start date.
    const deadlineOnly = (range.length === 1 && /まで|締切|〆切/.test(range[0].rest)) ||
      (!labelValues(applicationLabels).length && !!point(labeled(deadlineLabels), anchor));
    const startHint = lines.some(line =>
      /(?:応募|申込|申し込|受付|募集)[^。]*?(?:開始|スタート|から|より|[~〜～])|(?:から|より)[^。]*(?:応募|申込|受付|募集)/.test(line));
    fields.google_forms_start_not_stated = !!(fields.application_end_at && !fields.application_start_at &&
      deadlineOnly && !labelValues(startLabels).length && !startHint);
    const scheduleAnchor = (fields.application_end_at || anchor).slice(0,10);
    const resultLabels = '(?:抽選結果|当選(?:者)?|当落|結果|抽選)(?:の)?(?:発表|通知)(?:予定)?(?:日時|日|期間)?(?:は)?';
    const resultText = single(labelValues(resultLabels).filter(value =>
      // A second sentence such as "当選発表はX上で行います" names a channel,
      // not another announcement date. Conflicting date values still fail.
      !/^(?:当店の)?(?:公式)?(?:X|Twitter|SNS|店頭)(?:上|で|にて|に)/i.test(value)));
    const result = period(resultText, scheduleAnchor).at(-1);
    if (result) {
      fields.result_announcement_date = result.date;
      if (result.time) fields.result_announcement_time = result.time;
    }
    const purchaseLabels = '(?:商品)?(?:購入|販売|受取|受け取り)(?:可能)?期間';
    const purchase = period(labeled(purchaseLabels), scheduleAnchor);
    if (purchase.length === 2) {
      fields.purchase_start_date = purchase[0].date;
      fields.purchase_end_date = purchase[1].date;
      if (purchase[0].time) fields.purchase_start_time = purchase[0].time;
      if (purchase[1].time) fields.purchase_end_time = purchase[1].time;
    } else if (purchase.length === 1) {
      fields.purchase_end_date = purchase[0].date;
      if (purchase[0].time) fields.purchase_end_time = purchase[0].time;
    } else if (!labelValues(purchaseLabels).length) {
      // Some stores state the opening and closing days in separate sentences.
      // Opening/closing hours remain blank unless an actual time is written.
      const candidates = {start: [], end: []};
      for (const line of lines) {
        const date = point(line.replace(/^[■◆◇▼●]\s*/, ''), scheduleAnchor);
        if (!date || /できません|できない|不可|いたしません|しません|中止|延期/.test(date.rest)) continue;
        const beforePurchase = date.rest.split(/販売|購入|受取|受け取り/)[0];
        if (/応募|申込|受付|抽選|当選|発表/.test(beforePurchase)) continue;
        if (/(?:より|から).*(?:販売|購入|受取|受け取り)/.test(date.rest)) candidates.start.push(date);
        if (/まで(?:に)?.*(?:販売|購入|受取|受け取り)/.test(date.rest)) candidates.end.push(date);
      }
      const one = values => new Set(values.map(stamp)).size === 1 ? values[0] : null;
      const start = one(candidates.start), end = one(candidates.end);
      if (!(start && end && (start.date > end.date ||
          (start.date === end.date && start.time && end.time && start.time > end.time)))) {
        for (const [side, date] of [['start', start], ['end', end]]) {
          if (!date) continue;
          fields['purchase_' + side + '_date'] = date.date;
          if (date.time) fields['purchase_' + side + '_time'] = date.time;
        }
      }
    }
  }
  const product = labeled('抽選対象商品|抽選商品|対象商品').replace(/\s*\d+\s*(?:BOX|ボックス|箱)\s*$/i, '').trim();
  if (product && product.length <= 200) fields.product_name = product;
  const lists = (Array.isArray(data[1][1]) ? data[1][1] : []).flatMap(question => {
    if (!Array.isArray(question) || !/(?:店舗|応募店|受取店)/.test(clean(question[1])) ||
        !/選択|選ん/.test(clean(question[1])) || ![2,3,4].includes(question[3])) return [];
    const options = question[4]?.[0]?.[1];
    if (!Array.isArray(options) || !options.length || options.length > 100) return [];
    const stores = options.map(option => storeName(option?.[0]));
    return stores.every(Boolean) ? [stores] : [];
  });
  const explicitStore = storeName(labeled('対象店舗|店舗名|受取店舗|応募店舗'));
  const titleStore = storeName(title.match(/^[【〖\[]([^】〗\]]+)[】〗\]]/)?.[1]);
  const names = lists.length === 1 ? lists[0] : [explicitStore || titleStore].filter(Boolean);
  if (names.length) {
    fields.stores = [...new Set(names)].map(name => ({name, prefecture: verifiedAreas.get(name) || ''}));
    fields.store_name = fields.stores[0].name;
    if (fields.stores.length === 1 && fields.stores[0].prefecture) fields.prefecture = fields.stores[0].prefecture;
  }
  const subject = title + ' ' + product;
  if (/ワンピース|ONE\s*PIECE/i.test(subject)) fields.review_category = 'onepiece';
  else if (/ポケモン|ポケカ|POK[ÉE]MON/i.test(subject)) fields.review_category = 'pokemon';
  else if (/遊戯王/.test(subject)) fields.review_category = 'yugioh';
  const pack = /拡張パック|ブースターパック/.test(subject), deck = /デッキ/.test(subject);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  return fields;
}
