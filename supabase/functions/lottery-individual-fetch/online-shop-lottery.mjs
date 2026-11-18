// Public lottery panels only. Product release/shipping dates are not deadlines.
export const ONLINE_SHOP_PARSER_VERSION = 1;
export const DMM_HOST = 'www.dmm.com';
export const BANDAI_HOST = 'p-bandai.jp';
const tracking = new Set(['utm_medium','utm_source','utm_term','utm_campaign','utm_content']);

export function onlineShopUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 1000) return null;
    let u = new URL(value);
    const safe = u => u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash;
    if (!safe(u)) return null;
    if (u.hostname === 'al.dmm.com') {
      if (u.pathname !== '/' || [...u.searchParams.keys()].some(k =>
        !['lurl','af_id','ch','ch_id'].includes(k) || u.searchParams.getAll(k).length !== 1)) return null;
      u = new URL(u.searchParams.get('lurl'));
      if (!safe(u) || u.hostname !== DMM_HOST) return null;
    }
    if ([...u.searchParams.keys()].some(k => !tracking.has(k) || u.searchParams.getAll(k).length !== 1)) return null;
    const valid = u.hostname === DMM_HOST
      ? /^\/mono\/hobby\/-\/detail\/\=\/cid\=[a-z0-9_]{1,80}\/$/.test(u.pathname)
      : u.hostname === BANDAI_HOST && /^\/item\/item-[1-9]\d{6,14}\/$/.test(u.pathname);
    if (!valid) return null;
    u.search = '';
    return u;
  } catch { return null; }
}

const decode = text => String(text || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, n) =>
  ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[n.toLowerCase()]));
function plain(html) {
  // WOVN keeps the official Japanese text in a comment on each translated leaf.
  const original = [...html.matchAll(/<!--wovn-src:([\s\S]*?)-->/g)];
  if (original.length === 1) html = original[0][1];
  return decode(html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<[^>]*>/g,' ')).replace(/[\s\u3000]+/g,' ').trim();
}
function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(m => [m[1].toLowerCase(),decode(m[2] ?? m[3])]));
}
function tags(html, name, matches) {
  return [...html.matchAll(new RegExp('<'+name+'\\b([^>]*)>([\\s\\S]*?)<\\/'+name+'\\s*>','gi'))]
    .filter(m => matches(attrs(m[1]))).map(m => m[2]);
}
const hasClass = (a, name) => (a.class || '').split(/\s+/).includes(name);
const unique = values => {
  const set = [...new Set(values.filter(Boolean))];
  return set.length === 1 ? set[0] : '';
};
const datePart = '(\\d{4})年\\s*(\\d{1,2})月\\s*(\\d{1,2})日\\s*(?:\\([^)]{1,5}\\))?\\s*';
const timePart = '(?:(\\d{1,2}):(\\d{2})|(\\d{1,2})時(?:\\s*(\\d{1,2})分)?)';
function dates(text, requireTime = false) {
  return [...text.normalize('NFKC').matchAll(new RegExp(datePart + (requireTime ? timePart : '(?:'+timePart+')?'),'g'))]
    .map(m => {
      const [year, month, day] = m.slice(1,4).map(Number);
      const hour = Number(m[4] ?? m[6] ?? 0), minute = Number(m[5] ?? m[7] ?? 0);
      const date = new Date(Date.UTC(year,month-1,day,hour,minute));
      if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 ||
          date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day) return null;
      const pad = n => String(n).padStart(2,'0');
      const value = `${year}-${pad(month)}-${pad(day)}`;
      return {date:value,time:m[4] !== undefined || m[6] !== undefined ? pad(hour)+':'+pad(minute) : '',
        index:m.index,end:m.index+m[0].length};
    });
}
function range(text) {
  const found = dates(text,true);
  if (found.length !== 2 || found.some(d => !d)) return null;
  const normalized = text.normalize('NFKC');
  if (!/^[\s~〜～–—-]*(?:から)?[\s~〜～–—-]*$/.test(normalized.slice(found[0].end,found[1].index))) return null;
  const values = found.map(d => d.date+'T'+d.time+':00+09:00');
  return values[0] < values[1] && Date.parse(values[1])-Date.parse(values[0]) <= 180*86400000 ? values : null;
}

export function onlineShopFields(html, value) {
  const source = onlineShopUrl(value);
  if (!source || typeof html !== 'string' || html.length > 2_000_000) return {};
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const identities = [...markup.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map(m => attrs(m[0]))
    .filter(a => a.rel === 'canonical' || a.property === 'og:url').map(a => a.href || a.content);
  if (!identities.length || identities.some(url => onlineShopUrl(url)?.href !== source.href)) return {};
  const dmm = source.hostname === DMM_HOST;
  const title = unique(tags(markup,'h1',a => dmm ? a.id === 'title' : hasClass(a,'pb24-item-main__title')).map(plain));
  if (title.length < 5 || title.length > 200 || (!dmm && !/抽選/.test(title))) return {};
  const panels = tags(markup,'dl',a => hasClass(a,dmm ? 'box-chuseninfo' : 'pb24-item-main__lotterycart--data'));
  const pairs = panels.flatMap(panel => [...panel.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)]
    .map(m => [plain(m[1]),plain(m[2])]));
  const field = pattern => unique(pairs.filter(([label]) => pattern.test(label)).map(([,value]) => value));
  const period = range(field(dmm ? /^抽選申し込み期間$/ : /^受付期間$/));
  if (!period) return {};
  const store = dmm ? 'DMM通販' : 'プレミアムバンダイ';
  const fields = {event_title:title,product_name:title,store_name:store,prefecture:'全国',
    stores:[{name:store,prefecture:'全国'}],application_start_at:period[0],application_end_at:period[1]};
  const resultText = field(/^(?:当選発表|抽選結果発表)$/);
  if (resultText) fields.online_shop_result_text = resultText.slice(0,500);
  // Relative promises such as "から4日以内" and "下旬" are not exact dates.
  if (resultText && !/以内|以降|上旬|中旬|下旬|ごろ|頃|順次|未定/.test(resultText)) {
    const found = dates(resultText);
    if (found.length === 1 && found[0]) {
      fields.result_announcement_date = found[0].date;
      if (found[0].time) fields.result_announcement_time = found[0].time;
    } else if (found.length === 2 && found.every(Boolean) && /[〜～~]|から/.test(resultText) && found[0].date <= found[1].date) {
      fields.result_announcement_date = found[1].date;
      if (found[1].time) fields.result_announcement_time = found[1].time;
    }
  }
  const purchase = range(field(/^(?:当選者(?:向け)?(?:購入|注文手続き)期間|購入期間)$/));
  if (purchase && purchase[0] >= period[1]) {
    fields.purchase_start_date = purchase[0].slice(0,10); fields.purchase_start_time = purchase[0].slice(11,16);
    fields.purchase_end_date = purchase[1].slice(0,10); fields.purchase_end_time = purchase[1].slice(11,16);
  }
  if (/ポケモンカード|ポケカ/i.test(title)) fields.review_category = 'pokemon';
  else if (/ONE\s*PIECE|ワンピースカード/i.test(title)) fields.review_category = 'onepiece';
  else if (/遊戯王/.test(title)) fields.review_category = 'yugioh';
  const pack = /拡張パック|ブースター?パック/.test(title), deck = /デッキ|スターターセット/.test(title);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  return fields;
}

// Catalog URLs remain unchanged so existing applications keep their event key.
export function collectedOnlineShop(catalog, value) {
  const source = onlineShopUrl(value);
  if (!source) return null;
  const rows = (catalog?.items || []).filter(row => onlineShopUrl(row?.url)?.href === source.href &&
    row.online_shop_parser_version === ONLINE_SHOP_PARSER_VERSION && row.online_shop_verified_at &&
    row.external_url_unverified === false && row.event_title && row.application_start_at && row.application_end_at);
  return rows.sort((a,b) => Date.parse(b.online_shop_verified_at)-Date.parse(a.online_shop_verified_at))[0] || null;
}
