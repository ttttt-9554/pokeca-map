import {bodyLines, compact, htmlAttributes, section, stripInactive, textOf} from './public-html.mjs';
import {datePoint, dateRange, dateStamp} from './google-forms.mjs';

export const CENTER_HOST = 'shop.pokemon.co.jp';
export const CENTER_DIRECTORY = 'https://' + CENTER_HOST + '/ja/';
const profilePath = /^\/ja\/shop\/(?:pokemoncenter|pokemonstore)-[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const noticePath = /^(\/ja\/shop\/(?:pokemoncenter|pokemonstore)-[a-z0-9]+(?:-[a-z0-9]+)*\/)news\/20\d{2}(?:0[1-9]|1[0-2])\/\d{6}\.html$/;
const clean = value => compact(value.normalize('NFKC').replace(/[\u200b\u00ad\ufeff]/g, ''));
const links = html => html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi);

export function pokemonCenterNoticeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== CENTER_HOST || url.username || url.password ||
        url.port || url.hash || !noticePath.test(url.pathname) ||
        [...url.searchParams].some(([key]) => !/^utm_(?:source|medium|campaign|content|term)$/.test(key))) return null;
    url.search = '';
    return url;
  } catch { return null; }
}

export function centerProfileUrl(source) {
  return source.origin + source.pathname.match(noticePath)[1];
}

function pageIdentity(html, expected) {
  const ids = [...html.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map(match => htmlAttributes(match[0]))
    .filter(a => a.rel === 'canonical' || a.property === 'og:url');
  return ids.length > 0 && ids.every(a => (a.href || a.content) === expected);
}

export function pokemonCenterDirectory(html) {
  const stores = new Map();
  const markup = stripInactive(html);
  if (!pageIdentity(markup, CENTER_DIRECTORY)) return stores;
  const cards = section(markup, 'ul', 'c-store-list');
  for (const [, tag, card] of links(cards)) {
    const href = htmlAttributes(tag).href?.trim();
    if (!profilePath.test(href || '')) continue;
    const info = section(card, 'div', 'c-store-list__info');
    const name = clean(textOf(section(info, 'p', 'c-store-list__title')));
    const address = clean(textOf(info.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.replace(/<br\b[^>]*>/gi, ' ') || ''));
    const prefecture = address.match(/^(北海道|東京都|京都府|大阪府|[^\s市区郡]{2,3}県)/)?.[1];
    if (prefecture && /^(?:ポケモンセンター|ポケモンストア)/.test(name))
      stores.set(new URL(href, CENTER_DIRECTORY).href, {name, prefecture, address});
  }
  return stores;
}

export function centerNewsLinks(html, profile, now) {
  const markup = stripInactive(html);
  if (!pageIdentity(markup, profile + 'news/')) return [];
  const cutoff = new Date(+now - 14 * 86400000 + 9 * 3600000).toISOString().slice(0,10);
  const today = new Date(+now + 9 * 3600000).toISOString().slice(0,10);
  const urls = new Set();
  for (const [, tag, card] of links(section(markup, 'ul', 'c-news-list'))) {
    const href = htmlAttributes(tag).href?.trim();
    if (!href || !href.startsWith('/ja/shop/')) continue;
    const source = pokemonCenterNoticeUrl(new URL(href, CENTER_DIRECTORY).href);
    const title = clean(textOf(section(card, 'p', 'c-news-list__title')));
    const day = htmlAttributes(card.match(/<time\b[^>]*>/i)?.[0] || '').datetime || '';
    if (source && centerProfileUrl(source) === profile && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoff && day <= today &&
        (/抽選/.test(title) || /カード/.test(title) && /販売|購入/.test(title))) urls.add(source.href);
  }
  return [...urls];
}

function labeled(lines, names) {
  const name = '(?:' + names + ')';
  const heading = new RegExp('^(?:<' + name + '>|【' + name + '】|■\\s*' + name + '(?=\\s|:|$|\\d)|' + name + '(?=\\s*:|$))\\s*:?\\s*(.*)$');
  const found = [];
  for (const [i, line] of lines.entries()) {
    const match = line.match(heading);
    if (match) found.push({value: match[1] || lines[i+1] || '', next: i + (match[1] ? 1 : 2)});
  }
  return found.length === 1 ? found[0] : null;
}

function applicationBranch(line) {
  return line.replace(/\s/g,'').match(/^■((?:ポケモンセンター|ポケモンストア).+?)(?:お?申し?込み?)ページ$/)?.[1] || '';
}

function applicationLink(body, store) {
  // Retain only the hyperlink immediately after this branch's application heading.
  const withUrls = body.replace(/<a\b([^>]*)>[\s\S]*?<\/a\s*>/gi, (_, tag) => '\nHREF ' + (htmlAttributes(tag).href || '') + '\n');
  const lines = bodyLines(withUrls).map(clean).filter(Boolean);
  const found = lines.flatMap((line,i) => applicationBranch(line) === store.replace(/\s/g,'') ? [lines[i+1] || ''] : []);
  const href = found.length === 1 && found[0].startsWith('HREF ') ? found[0].slice(5) : '';
  return /^https:\/\/miniapp\.line\.me\/\d{8,13}-[A-Za-z0-9]{5,16}\/events\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(href) ? href : '';
}

function saleDates(fields, lines, anchor) {
  const sale = labeled(lines, '販売期間|購入期間|受取期間');
  if (!sale) return;
  // A daily time-slot range can immediately follow the last date in the same paragraph.
  const window = /(?:各日\s*)?(\d{1,2}(?::\d{2}|時(?:\d{1,2}分)?))\s*[~〜～]\s*(\d{1,2}(?::\d{2}|時(?:\d{1,2}分)?))(?:\s*の間で\s*(\d{1,3})分単位)?/;
  const values = [sale.value, ...lines.slice(sale.next)];
  const days = [], notes = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const dates = dateRange(value.replace(window, '').trim(), anchor);
    if (!dates.length || (dates.length === 1 && !/^(?:のみ|限り)?$/.test(dates[0].rest))) break;
    if (days.length && Date.parse(dates[0].date) - Date.parse(days.at(-1).date) !== 86400000) return;
    days.push(...dates);
    let slots = value.match(window);
    if (!slots && (values[i+1] || '').match(window)?.index === 0) slots = values[++i].match(window);
    let hours = '';
    if (slots) {
      const start = datePoint(anchor + ' ' + slots[1], anchor)?.time;
      const end = datePoint(anchor + ' ' + slots[2], anchor)?.time;
      if (start && end && start < end) hours = start + '～' + end + (slots[3] ? 'の間で' + Number(slots[3]) + '分単位' : '');
    }
    notes.push({date:dates[0].date, hours});
    if (dates.length === 2) break;
  }
  if (!days.length) return;
  const first = days[0], last = days.at(-1);
  fields.purchase_start_date = first.date;
  fields.purchase_end_date = last.date;
  if (first.time) fields.purchase_start_time = first.time;
  if (last.time) fields.purchase_end_time = last.time;
  if (notes.some(note => note.hours)) {
    const same = notes.every(note => note.hours === notes[0].hours);
    fields.store_notice_purchase_note = (same ? notes[0].hours : notes.filter(note => note.hours)
      .map(note => note.date.slice(5).replace('-', '/') + ' ' + note.hours).join('、')) +
      (lines.some(line => /当選.*呼出時間枠.*のみ.*購入/.test(line)) ? '、当選した時間枠のみ' : '');
  }
}

export function pokemonCenterFields(markup, source) {
  const main = section(markup, 'main');
  const article = section(main, 'div', 'l-container');
  const body = section(article, 'div', 'l-entry');
  const header = section(main, 'div', 'c-store-header');
  const store = clean(textOf(section(header, 'div', 'c-store-header__title')));
  const profile = centerProfileUrl(source);
  if (!/^(?:ポケモンセンター|ポケモンストア)[^<>]{1,55}$/.test(store) ||
      ![...links(header)].some(([, tag]) => htmlAttributes(tag).href?.trim() === new URL(profile).pathname)) return {};
  const title = textOf(section(article, 'h1', 'c-heading')).replace(/[\u200b\u00ad\ufeff]/g, '');
  const anchor = htmlAttributes(article.match(/<time\b[^>]*>/i)?.[0] || '').datetime || '';
  if (!body || !title || title.length > 200 || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return {};
  const lines = bodyLines(body).map(clean).filter(Boolean);
  const branchLabels = lines.map(applicationBranch).filter(Boolean);
  if (branchLabels.some(name => name !== store.replace(/\s/g, ''))) return {};
  const product = labeled(lines, '対象商品|抽選対象商品');
  const period = labeled(lines, '受け?付け?期間|応募期間|申し?込み?期間');
  if (!product || !period || !lines.some(line => /事前抽選|抽選販売|購入時間帯抽選/.test(line)) ||
      lines.some(line => /(?:本抽選|今回の抽選|本抽選販売)(?:販売)?(?:は|を)中止/.test(line))) return {};
  const products = [product.value];
  for (const line of lines.slice(product.next)) {
    if (!line.startsWith('・')) break;
    products.push(line);
  }
  const names = [...new Set(products.map(line => line.replace(/^[・●]\s*/, '')
    .replace(/\s*[(](?:お?(?:一人|1人|ひとり)様|1人)[^()]{0,45}[)]\s*$/, '').trim()).filter(Boolean))];
  if (!names.length || !names.every(name => name.length <= 180 && !/^[■【<※]/.test(name)) || !/ポケモンカード(?:ゲーム)?/.test([title,...names].join(' '))) return {};
  const range = dateRange(period.value, anchor);
  if (range.length !== 2 || !/^(?:$|まで)/.test(range[1].rest)) return {};
  const fields = {event_title:title, store_name:store, stores:[{name:store,prefecture:''}],
    review_category:'pokemon', application_start_at:dateStamp(range[0]), application_end_at:dateStamp(range[1])};
  const productName = names.join(' ／ ');
  if (productName.length <= 200) fields.product_name = productName;
  const pack = /拡張パック|ブースターパック|ハイクラスパック/.test(productName);
  const deck = /デッキ|スターターセット/.test(productName);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  const result = dateRange(labeled(lines, '結果発表|抽選結果発表|当選発表')?.value || '', anchor).at(-1);
  if (result) {
    fields.result_announcement_date = result.date;
    if (result.time && /^(?:以降|以後|から順次|より順次)/.test(result.rest))
      fields.store_notice_result_note = result.time + '以降' + (/順次/.test(result.rest) ? '順次' : '');
    else if (result.time) fields.result_announcement_time = result.time;
  }
  saleDates(fields, lines, anchor);
  const url = applicationLink(body, store);
  if (url) fields.application_url = url;
  return fields;
}
