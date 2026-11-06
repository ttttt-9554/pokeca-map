const areas = new Set((
  '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 ' +
  '東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 ' +
  '滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 ' +
  '香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県 全国'
).split(' '));
const unknownStore = /^(?:未確認|不明|店名未確認|店舗未確認|店舗名未確認|店舗名不明|店名不明|対象店舗|対象店舗未確認|情報未登録|未取得|店舗情報なし|店舗情報未確認|未設定|なし)$/;
const unknownTitle = /^(?:未確認|不明|抽選名未確認|イベント名未確認|イベントタイトル未確認|仮イベント名|イベント情報|イベント|チケット情報|チケット|受付中)$/;
const cleanText = value => typeof value === 'string' ? value.trim() : '';

export const automaticLotteryFields = [
  'event_title', 'store_name', 'prefecture', 'stores', 'application_start_at', 'application_end_at'
];

function canonicalUrl(value) {
  if (!/^https?:\/\/[^\s<>"\\]{4,1992}$/i.test(value)) return '';
  const url = new URL(value);
  const host = url.hostname.replace(/\.$/, '');
  if (url.username || url.password || url.port ||
      !/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(host) ||
      /(^|\.)(?:livepocket\.jp|ttttt-9554\.github\.io)$/.test(host) ||
      /\.(?:local|localhost|internal)$/.test(host)) return '';
  url.hostname = host;
  url.hash = '';
  if (host === 'cloud-pass.jp') url.pathname = url.pathname.replace(/\/$/, '');
  if (host === 'famima-online.family.co.jp' && url.pathname === '/item') {
    const codes = url.searchParams.getAll('itemCode');
    if (codes.length === 1 && /^\d{10,25}$/.test(codes[0])) url.search = '?itemCode=' + codes[0];
  }
  return url.href.length <= 2000 ? url.href : '';
}

function applicationTime(value) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match) return NaN;
  const day = new Date(match[1] + 'T00:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1]
    ? Date.parse(value) : NaN;
}

function notificationEvent(item) {
  // Only the automatic enrichers clear this flag and publish an official title.
  if (item?.external_url_unverified !== false || item.event_title_provisional ||
      item.app_lottery || item.manual_card_hidden || item.manual_page_unavailable) return null;
  const eventUrl = cleanText(item.url);
  const title = cleanText(item.official_event_title).replace(/\s+/g, ' ');
  if (title.length < 5 || title.length > 160 || unknownTitle.test(title) ||
      /(?:\.\.\.|…|https?:\/\/|[<>\uFFFD„\x00-\x1F\x7F]|\b(?:captcha|access denied|just a moment|403 forbidden|robot check)\b|アクセスが制限|チケット購入・予約・販売)/i.test(title))
    return null;
  let identity;
  try { identity = canonicalUrl(eventUrl); } catch { return null; }
  if (!identity) return null;

  const stores = (Array.isArray(item.stores) && item.stores.length
    ? item.stores : [{name: item.store_name, prefecture: item.prefecture}]
  ).map(store => ({name: cleanText(store?.name), prefecture: cleanText(store?.prefecture)}));
  if (stores.some(store => !store.name || unknownStore.test(store.name) || !areas.has(store.prefecture)))
    return null;
  const start = applicationTime(cleanText(item.application_start_at));
  const end = applicationTime(cleanText(item.application_end_at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;

  return {
    identity,
    event_url: eventUrl,
    event_title: title,
    stores,
    prefecture: [...new Set(stores.map(store => store.prefecture))].join('・'),
    application_start_at: new Date(start).toISOString(),
    application_end_at: new Date(end).toISOString()
  };
}

export function externalLotteryNotificationEvents(catalog) {
  if (!Array.isArray(catalog?.items)) throw Error('Invalid external lottery public catalog');
  return catalog.items.map(notificationEvent).filter(Boolean);
}
