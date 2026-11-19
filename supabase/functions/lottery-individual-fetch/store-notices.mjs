import {CENTER_HOST, CENTER_DIRECTORY, pokemonCenterNoticeUrl, pokemonCenterFields, pokemonCenterDirectory, centerProfileUrl} from './pokemon-center.mjs';
import {readPublicHtml, htmlAttributes, textOf, stripInactive, section, bodyLines} from './public-html.mjs';
import {datePoint, dateRange, dateStamp} from './google-forms.mjs';

export const SKIP_HOST = 'www.skip-tcg.com';
export const OTAKARA_HOST = 'www.otakarasouko.com';
export const STORE_DIRECTORY = 'https://' + OTAKARA_HOST + '/store/';

export function storeNoticeUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname === CENTER_HOST) return pokemonCenterNoticeUrl(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) return null;
    if (url.hostname === SKIP_HOST && /^\/view\/news\/\d{14}\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/$/, '');
      return url;
    }
    if (url.hostname === OTAKARA_HOST && /^\/information\/[1-9]\d{0,11}\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/?$/, '/');
      return url;
    }
    return null;
  } catch { return null; }
}

function labeledLine(lines, labels) {
  const pattern = new RegExp('^(?:【|・)?(?:' + labels + ')(?:】|:|$)\\s*(.*)$');
  const values = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(pattern);
    if (match) values.push({value: match[1] || lines[index + 1] || '', next: index + (match[1] ? 1 : 2)});
  }
  return values.length === 1 ? values[0] : null;
}

function purchaseWindow(lines, anchor) {
  const entry = labeledLine(lines, '当選者購入期間|購入期間|受取期間');
  if (!entry) return [];
  const days = dateRange(entry.value, anchor);
  if (days.length !== 1 || days[0].rest) return days.length === 2 ? days : [];
  // Some notices list individual purchase dates, one per line.
  for (const line of lines.slice(entry.next)) {
    const date = datePoint(line, anchor);
    if (!date || date.rest) break;
    if (Date.parse(date.date) - Date.parse(days.at(-1).date) !== 86400000) return [];
    days.push(date);
  }
  return [days[0], days.at(-1)];
}

function branchList(lines) {
  const start = lines.indexOf('【対象店舗一覧】');
  if (start < 0) return [];
  const names = new Set();
  let chain = '';
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('【')) break;
    if (line.startsWith('■')) {
      chain = line.match(/^■\s*([^■【】]{1,45}?)\s*店舗$/)?.[1]?.trim() || '';
      if (chain === 'メディオ!') chain = 'メディオ！';
    } else if (chain && /^・[^・【】]{1,65}店$/.test(line)) {
      names.add(chain + ' ' + line.slice(1).trim());
    }
  }
  return [...names].map(name => ({name, prefecture: ''}));
}

export function applyDirectory(stores, directory) {
  const regions = new Map();
  const key = name => name.normalize('NFKC').replace(/\s/g, '');
  const pairs = /<p\b[^>]*class=["']name["'][^>]*>([\s\S]*?)<\/p>\s*<p\b[^>]*class=["']address["'][^>]*>([\s\S]*?)<\/p>/gi;
  for (const match of stripInactive(directory).matchAll(pairs)) {
    const name = key(textOf(match[1]));
    const address = textOf(match[2]).replace(/^〒?\d{3}[-－]?\d{4}\s*/, '');
    const area = address.match(/^(北海道|東京都|京都府|大阪府|[^\s市区郡]{2,3}県)/)?.[1]
      || (address.startsWith('京都市') ? '京都府' : '');
    if (!area) continue;
    if (!regions.has(name)) regions.set(name, new Set());
    regions.get(name).add(area);
  }
  for (const store of stores) {
    const found = regions.get(key(store.name));
    if (found?.size === 1) store.prefecture = [...found][0];
  }
}

export function storeNoticeFields(html, value) {
  const source = storeNoticeUrl(value);
  if (!source || typeof html !== 'string' || html.length > 2_000_000) return {};
  const markup = stripInactive(html);
  const ids = [...markup.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map(m => htmlAttributes(m[0]))
    .filter(a => a.rel === 'canonical' || a.property === 'og:url').map(a => storeNoticeUrl(a.href || a.content)?.href);
  if (!ids.length || !ids.every(id => id === source.href)) return {};
  if (source.hostname === CENTER_HOST) return pokemonCenterFields(markup, source);
  const skip = source.hostname === SKIP_HOST;
  const article = skip ? section(markup, 'div', 'news-wrap') : section(markup, 'article', 'article-detail');
  const title = textOf(skip ? section(article, 'h2', 'sec_ttl') : section(article, 'h1', 'article-detail__title'));
  const body = skip ? section(article, 'div', 'news-content') : section(article, 'section', 'article-detail__cont');
  if (!body || !/抽選/.test(title) || title.length > 200) return {};
  const lines = bodyLines(body);
  const period = labeledLine(lines, '抽選受付期間|応募期間|抽選応募期間');
  if (!period) return {};
  const published = skip ? lines[0] : textOf(section(article, 'div', 'article-detail__date'));
  const anchor = published.match(/\d{4}[.\/-]\d{1,2}[.\/-]\d{1,2}/)?.[0].replace(/[./]/g, '-') || '';
  const application = dateRange(period.value.replace(/(?:ひる|昼)\s*(?=12時)/g, ''), anchor);
  const fields = {event_title: title};
  if (application.length === 2) {
    fields.application_start_at = dateStamp(application[0]);
    fields.application_end_at = dateStamp(application[1]);
  } else if (application.length === 1 && /締切|まで/.test(application[0].rest)) {
    fields.application_end_at = dateStamp(application[0]);
  }
  const product = labeledLine(lines, '抽選対象商品|対象商品')?.value.split('※')[0].trim()
    .replace(/^(ポケモンカードゲーム)\s*\1/, '$1');
  if (product && product.length <= 200) fields.product_name = product;
  const subject = title + ' ' + (product || '');
  if (/ポケモンカード|ポケカ/.test(subject)) fields.review_category = 'pokemon';
  else if (/ワンピース|ONE\s*PIECE/i.test(subject)) fields.review_category = 'onepiece';
  else if (/遊戯王/.test(subject)) fields.review_category = 'yugioh';
  if (/拡張パック|ブースターパック/.test(subject)) fields.product_type = 'pack';
  else if (/デッキ/.test(subject)) fields.product_type = 'deck';
  const resultText = labeledLine(lines, '当選通知|当選発表|抽選結果発表')?.value || '';
  const result = dateRange(resultText.replace(/^当選された方には[、,]?\s*/, ''), anchor).at(-1);
  if (result) {
    fields.result_announcement_date = result.date;
    if (result.time) fields.result_announcement_time = result.time;
  }
  const purchase = purchaseWindow(lines, anchor);
  if (purchase.length === 2) {
    fields.purchase_start_date = purchase[0].date;
    fields.purchase_end_date = purchase[1].date;
    if (purchase[0].time) fields.purchase_start_time = purchase[0].time;
    if (purchase[1].time) fields.purchase_end_time = purchase[1].time;
  }
  // https://www.skip-tcg.com/view/page/tenpo_guide identifies the pickup shop.
  const stores = skip ? [] : branchList(lines);
  if (skip && lines.some(line => /店頭(?:販売|での受け渡し)のみ/.test(line))) {
    stores.push({name: 'トレカショップ スキップ', prefecture: '大阪府'});
  }
  if (stores.length) {
    fields.stores = stores;
    fields.store_name = stores[0].name;
    if (stores.length === 1 && stores[0].prefecture) fields.prefecture = stores[0].prefecture;
  }
  return fields;
}

export async function loadOfficialHtml(url) {
  const response = await fetch(url, {method: 'GET', redirect: 'manual',
    headers: {Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'TorecaRadar/1.0'},
    signal: AbortSignal.timeout(12000)});
  return readPublicHtml(response);
}

export async function fetchStoreNotice(value, load = loadOfficialHtml, directory = () => load(STORE_DIRECTORY)) {
  const source = storeNoticeUrl(value);
  if (!source) throw Error('Unsupported store notice');
  const fields = storeNoticeFields(await load(source.href), source.href);
  if (source.hostname === CENTER_HOST && fields.stores?.length) {
    const html = await load(CENTER_DIRECTORY).catch(() => '');
    const branch = pokemonCenterDirectory(html).get(centerProfileUrl(source));
    if (branch?.name === fields.store_name) fields.stores[0].prefecture = fields.prefecture = branch.prefecture;
  }
  if (source.hostname === OTAKARA_HOST && fields.stores?.length) {
    // Branch participation comes only from this article. The fixed operator
    // directory supplies an area for exact matches, never additional branches.
    const html = await directory().catch(() => '');
    if (html) applyDirectory(fields.stores, html);
    if (fields.stores.length === 1 && fields.stores[0].prefecture) fields.prefecture = fields.stores[0].prefecture;
  }
  return fields;
}
