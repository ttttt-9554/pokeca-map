import {bodyLines, htmlAttributes, section, stripInactive, textOf} from './public-html.mjs';
import {datePoint, dateRange, dateStamp} from './google-forms.mjs';

export const SEVENNET_HOST = '7net.omni7.jp';

export function sevennetFairUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== SEVENNET_HOST || url.port || url.hash ||
        url.username || url.password || !/^\/general\/\d{6}\/fair-[a-z0-9-]{1,100}\.html$/.test(url.pathname) ||
        [...url.searchParams].some(([key]) => !/^utm_(?:source|medium|campaign|term|content)$/.test(key))) return null;
    url.search = '';
    return url;
  } catch { return null; }
}

// These campaign pages identify themselves in the final BreadcrumbList item.
// The HTML title can be empty and the main heading is shared by several draws.
export function sevennetFairFields(html, source) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const crumbs = [];
  for (const match of clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (htmlAttributes(match[1]).type !== 'application/ld+json') continue;
    let data;
    try { data = JSON.parse(match[2]); } catch { continue; }
    if (data?.['@type'] === 'BreadcrumbList' && Array.isArray(data.itemListElement))
      crumbs.push(data.itemListElement.at(-1)?.item);
  }
  if (crumbs.length !== 1 || sevennetFairUrl(crumbs[0]?.['@id'])?.href !== source.href) return {};
  const title = typeof crumbs[0].name === 'string' ? crumbs[0].name.trim() : '';
  const article = section(stripInactive(clean), 'div', 'st-ns_freecontainer');
  if (!/抽選/.test(title) || title.length > 200 || !/抽選/.test(textOf(section(article, 'h1')))) return {};

  const sections = new Map();
  const headings = [...article.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)];
  for (const [i, heading] of headings.entries()) {
    const label = textOf(heading[1]).replace(/^■\s*/, '');
    const lines = bodyLines(article.slice(heading.index + heading[0].length, headings[i+1]?.index));
    // Multiple sections with the same label can describe separate draws.
    sections.set(label, sections.has(label) ? [] : lines);
  }
  const value = label => sections.get(label)?.[0] || '';
  const periodLines = (sections.get('応募期間') || []).filter(line => !/^[※・]/.test(line));
  const interval = periodLines.length === 1 ? periodLines[0] : '';
  const year = interval.match(/^(\d{4})年/)?.[1];
  if (!year) return {};
  const application = dateRange(interval, year + '-01-01');
  if (application.length !== 2 || !/^(?:まで)?[。.]?$/.test(application[1].rest)) return {};

  const fields = {event_title: title, application_start_at: dateStamp(application[0]),
    application_end_at: dateStamp(application[1]), store_name: 'セブンイレブン', prefecture: '全国',
    stores: [{name: 'セブンイレブン', prefecture: '全国'}]};
  const products = (sections.get('対象商品') || []).filter(line => !/^(?:販売価格|価格|税込|※|・販売価格)/.test(line));
  if (products.length === 1 && products[0].length <= 200) fields.product_name = products[0];
  const subject = title + ' ' + (fields.product_name || '');
  if (/ポケモンカード|ポケカ/.test(subject)) fields.review_category = 'pokemon';
  else if (/ワンピース|ONE\s*PIECE/i.test(subject)) fields.review_category = 'onepiece';
  if (/デッキ/.test(subject)) fields.product_type = 'deck';
  else if (/拡張パック|ブースターパック/.test(subject)) fields.product_type = 'pack';

  const anchor = application[1].date;
  const result = dateRange(value('当選発表'), anchor).at(-1);
  if (result && result.date >= anchor) {
    fields.result_announcement_date = result.date;
    if (result.time) fields.result_announcement_time = result.time;
    if (/^までに/.test(result.rest)) fields.store_notice_result_note = 'この日時までに連絡';
  }
  const delivery = datePoint(value('商品のお届け・お支払いについて'), anchor);
  if (delivery && /^(?:より|から)順次お届け/.test(delivery.rest)) fields.delivery_start_date = delivery.date;
  return fields;
}
