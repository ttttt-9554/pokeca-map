// Public page extraction. Only unambiguous, explicitly labelled data is returned.
export const STARBOX_HOST = 'shoplottery.e-starbox.com';
export const CUSTOMFORM_HOST = 'customform.jp';
export const GEO_HOST = 'draw.geo-online.co.jp';
export const RAKUTEN_BOOKS_HOST = 'books.rakuten.co.jp';

export function supportedUrl(value) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash) return false;
    if(u.hostname==='docs.google.com') return /^\/forms\/d\/e\/[A-Za-z0-9_-]{20,180}\/(?:viewform|closedform)\/?$/.test(u.pathname) && !u.search;
    if(u.hostname==='e-yamashiroya.com') return /^\/(?:%[\da-f]{2}|[a-z\d_\-\/])+$/i.test(u.pathname) && !u.search && !u.pathname.includes('//');
    if(u.hostname==='7net.omni7.jp') return /^\/detail\/\d+\.html$/.test(u.pathname) && !u.search;
    if(u.hostname==='famima-online.family.co.jp') return u.pathname==='/item' && /^\?itemCode=\d{10,25}$/.test(u.search);
    if(u.hostname==='cloud-pass.jp') return /^\/pr\/[a-f0-9]{64}\/?$/i.test(u.pathname) && !u.search;
    if(u.hostname===STARBOX_HOST) return u.pathname==='/lottery/entry' && /^\?code=[A-Za-z0-9]{10}$/.test(u.search);
    if(u.hostname===GEO_HOST) return /^\/lottery\/[1-9]\d{0,8}\/?$/.test(u.pathname) && !u.search;
    if(u.hostname===RAKUTEN_BOOKS_HOST) {
      return /^\/rb\/[1-9]\d{0,9}\/?$/.test(u.pathname) && (!u.search || u.search === '?bkts=1');
    }
    if(u.hostname===CUSTOMFORM_HOST) return /^\/form\/input\/\d{1,10}\/?$/.test(u.pathname) &&
      (!u.search || /^\?key=[a-zA-Z0-9_-]{8,64}$/.test(u.search));
    return false;
  } catch {return false;}
}

export function lotteryPageRequest(value) {
  const url = new URL(value);
  const headers = {'User-Agent': 'TorecaRadar/1.0', Accept: 'text/html,application/xhtml+xml'};
  if (url.hostname === GEO_HOST || url.hostname === RAKUTEN_BOOKS_HOST) {
    url.pathname = url.pathname.replace(/\/?$/, '/');
  }
  if (url.hostname === RAKUTEN_BOOKS_HOST) {
    url.search = '?bkts=1';
    headers['Accept-Language'] = 'ja';
  }
  return {url, headers};
}

function decode(s){
  return String(s||'').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{
    let c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);
    return c>0&&c<=0x10ffff?String.fromCodePoint(c):'';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi,(_,n)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[n.toLowerCase()]));
}
function plain(html){return decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ')
 .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ')
 .replace(/<[^>]*>/g,' ')).replace(/[\s\u3000]+/g,' ').trim();}
const datePattern='(\\d{4})\\s*(?:年|[\\/.-])\\s*(\\d{1,2})\\s*(?:月|[\\/.-])\\s*(\\d{1,2})\\s*日?\\s*(?:[（(][^）)]{1,8}[）)])?\\s*(\\d{1,2})[:：](\\d{2})';
function validDate(parts){
  const [y,m,d,h,minute]=parts.map(Number);
  if(y<2020||y>2100||m<1||m>12||d<1||h>23||minute>59)return null;
  const x=new Date(Date.UTC(y,m-1,d,h,minute));
  if(x.getUTCFullYear()!==y||x.getUTCMonth()!==m-1||x.getUTCDate()!==d)return null;
  const p=n=>String(n).padStart(2,'0');
  return `${y}-${p(m)}-${p(d)}T${p(h)}:${p(minute)}:00+09:00`;
}
function oneDate(text,label){
  const regex=new RegExp(label+'\\s*[:：]?\\s*'+datePattern,'g');
  const values=[...text.matchAll(regex)].map(m=>validDate(m.slice(1,6)));
  if(!values.length||values.some(x=>!x))return null;
  const unique=[...new Set(values)];return unique.length===1?unique[0]:null;
}
function tagContents(html, tag, className) {
  const pattern = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
  return [...html.matchAll(pattern)]
    .filter(([, attrs]) => !className || attrs.match(/(?:^|\s)class\s*=\s*(["'])(.*?)\1/i)?.[2]
      .split(/\s+/).includes(className))
    .map(match => match[2]);
}

function uniqueText(values) {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length === 1 ? unique[0] : '';
}

function cloudPassFields(html) {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const title = uniqueText(tagContents(markup, 'h3', 'title').map(plain));
  if (title.length < 5 || title.length > 200 || !title.includes('抽選')) return {};
  const fields = {event_title: title};

  // The calendar below this section lists pickup days. Read only the
  // application period explicitly named in the event summary.
  const periods = tagContents(markup, 'dl', 'date').flatMap(block =>
    [...block.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt\s*>\s*<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi)]
      .filter(match => plain(match[1]) === '申込期間')
      .map(match => plain(match[2]))
  );
  const range = new RegExp('^' + datePattern + '\\s*[～〜~−–—-]\\s*' + datePattern + '$');
  const period = uniqueText(periods).match(range);
  if (period) {
    const start = validDate(period.slice(1, 6));
    const end = validDate(period.slice(6, 11));
    if (start && end && start < end) {
      fields.application_start_at = start;
      fields.application_end_at = end;
    }
  }

  const project = uniqueText(tagContents(markup, 'h3', 'projectName').map(plain));
  const paragraphs = tagContents(markup, 'p').map(plain).filter(Boolean);
  const pickup = uniqueText(paragraphs
    .filter((_, index) => /^≪受取場所≫$/.test(paragraphs[index - 1] || '')));
  if (project && project.length <= 200 && pickup.includes(project)) {
    fields.store_name = project;
    // https://shibuyatsutaya.tsite.jp/facilities/
    if (project === 'SHIBUYA TSUTAYA') fields.prefecture = '東京都';
  }
  if (/ポケモン|ポケカ|POK[ÉE]MON/i.test(title)) {
    fields.review_category = 'pokemon';
    if (title.includes('拡張パック') && !title.includes('デッキ')) fields.product_type = 'pack';
    if (title.includes('デッキ') && !title.includes('拡張パック')) fields.product_type = 'deck';
  } else if (/ワンピース|ONE\s*PIECE/i.test(title)) {
    fields.review_category = 'onepiece';
  } else if (title.includes('遊戯王')) {
    fields.review_category = 'yugioh';
  }
  return fields;
}

function starboxDateTime(parts) {
  const minute = validDate(parts.slice(0, 5));
  return minute ? minute.slice(0, 16) + ':' + (parts[5] || '00') + '+09:00' : '';
}

function starboxSchedulePoint(value, anchor) {
  const match = value.trim().match(/^(?:(\d{4})\s*(?:年|\/)\s*)?(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})(?!\d)\s*日?(?:\s*\([月火水木金土日](?:曜(?:日)?)?\))?\s*(.*)$/);
  if (!match) return '';
  const [, explicitYear, month, day, suffix] = match;
  const year = Number(anchor.slice(0, 4));
  const date = (explicitYear ? [Number(explicitYear)] : [year, year + 1])
    .map(y => validDate([y, month, day, 0, 0])?.slice(0, 10))
    .find(d => d && d >= anchor);
  // A month/day in the notes is tied to the application deadline's year.
  // Permit a nearby December-to-January rollover, not an assumed date a year later.
  if (!date || (!explicitYear && Date.parse(date) - Date.parse(anchor) > 90 * 86400000)) return '';
  if (!suffix || /^(?:中|(?:開店|閉店|営業開始|営業終了)(?:時(?:刻)?)?)$/.test(suffix)) return date;
  const clock = suffix.match(/^(?:の\s*)?(\d{1,2})(?::(\d{2})|\s*時(?:\s*(?:(\d{1,2})\s*分|(半)))?)\s*(頃|ごろ|前後)?$/);
  if (!clock) return '';
  const [, hour, colonMinute, japaneseMinute, half, approximate] = clock;
  const minutes = colonMinute || japaneseMinute || (half ? '30' : '0');
  if (Number(hour) > 23 || Number(minutes) > 59) return '';
  return approximate ? date : `${date}T${hour.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

function starboxScheduleRange(value, anchor) {
  const [from, to, extra] = value.split(/\s*(?:[~〜～–—]|から)\s*/);
  if (!to || extra !== undefined) return [];
  const start = starboxSchedulePoint(from, anchor);
  if (!start) return [];
  const endText = /^\d{1,2}日/.test(to) ? `${start.slice(5, 7)}月${to}` : to;
  const end = starboxSchedulePoint(endText, start.slice(0, 10));
  return end && !(start.length > 10 && end.length > 10 && start > end) ? [start, end] : [];
}

function starboxScheduleFields(detail, applicationEnd) {
  const anchor = applicationEnd.slice(0, 10);
  const lines = detail.replace(/\r?\n/g, ' ')
    .replace(/<br\b[^>]*>|<\/(?:div|p|li|h[1-6])\s*>/gi, '\n')
    .split('\n').map(line => plain(line).normalize('NFKC')).filter(Boolean);
  const labeled = pattern => lines.flatMap((line, i) => {
    const match = line.match(pattern);
    return match ? [match[1].trim() || lines[i + 1] || ''] : [];
  });
  const announced = uniqueText(labeled(/^(?:[▼■]\s*)?(?:抽選結果(?:の)?発表|抽選発表|結果発表|当選発表)(?:に関して|について|予定(?:日時|日)?|日時|日|期間)?\s*:?\s*(.*)$/)
    .map(value => value.replace(/\s*(?:を予定しております|を予定しています|予定です|予定|です)[。.]?$/, '').trim())
    .map(value => /[~〜～–—]|から/.test(value) ? starboxScheduleRange(value, anchor)[1] : starboxSchedulePoint(value, anchor)));
  const buyNotes = labeled(/^(?:[▼■]\s*)?(?:当選者(?:様)?(?:の|向け)?\s*)?(?:購入|販売|商品受取|受け取り|受取)(?:可能)?期間\s*:?\s*(.*)$/);
  // Store-specific prose may give a purchase window without a heading.
  for (const line of lines) {
    const sentence = line.match(/^(\d[^。]*?)\s*まで(?:に)?\s*(?:お買い求め|ご購入|お受け取り)(?:ください)?[。.]?$/);
    if (sentence) buyNotes.push(sentence[1]);
  }
  const purchase = uniqueText(buyNotes.map(value => starboxScheduleRange(value.replace(/まで[。.]?$/, '').trim(), anchor).join('|')));
  const fields = {};
  if (announced) {
    fields.result_announcement_date = announced.slice(0, 10);
    if (announced.length > 10) fields.result_announcement_time = announced.slice(11);
  }
  if (purchase) {
    const [start, end] = purchase.split('|');
    fields.purchase_start_date = start.slice(0, 10);
    fields.purchase_end_date = end.slice(0, 10);
    if (start.length > 10) fields.purchase_start_time = start.slice(11);
    if (end.length > 10) fields.purchase_end_time = end.slice(11);
  }
  return fields;
}

function starboxFields(html) {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const detail = markup.match(/<div\b[^>]*\bid=["']lottery-detail["'][^>]*>([\s\S]*?)(?=<div\b[^>]*\bid=["']lottery-tutorial["']|<\/main\s*>|$)/i)?.[1];
  const title = uniqueText(tagContents(markup, 'h1').map(plain));
  if (!detail || title.length < 5 || title.length > 200 || !title.includes('抽選')) return {};
  const fields = {event_title: title};
  const periods = [...detail.matchAll(/<h[2-6]\b[^>]*>([^<]+)<\/h[2-6]\s*>\s*<div\b[^>]*>([^<]+)<\/div\s*>/gi)]
    .filter(m => plain(m[1]) === '応募期間').map(m => plain(m[2]).normalize('NFKC'));
  const timestamp = datePattern + '(?::([0-5]\\d))?';
  const period = uniqueText(periods).match(new RegExp('^' + timestamp + '\\s*[~〜～–—-]\\s*' + timestamp + '$'));
  if (period) {
    const start = starboxDateTime(period.slice(1, 7));
    const end = starboxDateTime(period.slice(7, 13));
    if (start && end && start < end) {
      fields.application_start_at = start;
      fields.application_end_at = end;
      Object.assign(fields, starboxScheduleFields(detail, end));
    }
  }
  const store = title.match(/^【([^】、,／]{2,100}店)(?:限定)?】/)?.[1];
  if (store) fields.store_name = store;
  // Exact branch confirmed by the operator's store guide.
  // https://www.kyowa-corp.co.jp/am/shop/13-101/
  if (store === 'トレーディングカードピット亀戸店') fields.prefecture = '東京都';

  const product = uniqueText([...markup.matchAll(/<label\b[^>]*\bfor=["']input-item_no-\d+["'][^>]*>([\s\S]*?)<\/label\s*>/gi)]
    .map(match => plain(match[1])));
  if (product && product.length <= 200) fields.product_name = product;
  const text = title + ' ' + plain(detail);
  const genre = uniqueText([
    /ポケモンカード|ポケカ|POK[ÉE]MON/i.test(text) ? 'pokemon' : '',
    /ワンピースカード|ONE\s*PIECE/i.test(text) ? 'onepiece' : '',
    /遊戯王/.test(text) ? 'yugioh' : ''
  ]);
  if (genre) fields.review_category = genre;
  const pack = /拡張パック|ブースターパック/.test(title);
  const deck = /デッキ/.test(title);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  return fields;
}

function customformFields(html, url) {
  const snapshots = [...html.matchAll(/\bwire:snapshot\s*=\s*(["'])([\s\S]*?)\1/gi)];
  const forms = snapshots.flatMap(([, , value]) => {
    try {
      const data = JSON.parse(decode(value)).data;
      const form = Array.isArray(data?.customform) ? data.customform[0] : data?.customform;
      return form && String(form.customform_id) === new URL(url).pathname.split('/').filter(Boolean).pop()
        ? [{data, form}] : [];
    } catch { return []; }
  });
  if (forms.length !== 1) return {};
  const {data, form} = forms[0];
  const title = uniqueText(tagContents(html, 'h1').map(plain));
  if (title !== String(form.title || '').trim() || title.length < 5 || title.length > 200 ||
      !title.includes('抽選') || data.closed === true) return {};
  const fields = {event_title: title};
  const lines = String(form.description || '').replace(/<br\b[^>]*>/gi, '\n')
    .split(/\r?\n/).map(line => plain(line).normalize('NFKC').replace(/^[■◆▼]\s*/, '')).filter(Boolean);
  const labeled = pattern => uniqueText(lines.flatMap(line => {
    const match = line.match(pattern);
    return match ? [match[1]] : [];
  }));

  // The form supplies full calendar years. The advertised application period
  // takes precedence over the server's automatic form-closing clock.
  const reference = [form.close_time, form.open_time, form.release_time, form.create_time]
    .find(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]/.test(value));
  if (reference) {
    const anchorTime = Date.parse(reference.slice(0, 10) + 'T00:00:00Z') - 90 * 86400000;
    if (Number.isFinite(anchorTime)) {
      const anchor = new Date(anchorTime).toISOString().slice(0, 10);
      const period = labeled(/^(?:抽選)?応募期間\s*:\s*(.+)$/);
      const range = starboxScheduleRange(period, anchor);
      if (range.length && range.every(value => value.length === 16)) {
        fields.application_start_at = range[0] + ':00+09:00';
        fields.application_end_at = range[1] + ':00+09:00';
        const end = range[1].slice(0, 10);
        const purchaseText = labeled(/^(?:当選)?販売期間(?:は\s*[:、]?|\s*:)\s*(.+)$/)
          .replace(/(?:の\d+日間|で、|です|各店舗|各当選店舗).*$/, '').trim();
        const purchase = starboxScheduleRange(purchaseText, end);
        if (purchase.length) {
          fields.purchase_start_date = purchase[0].slice(0, 10);
          fields.purchase_end_date = purchase[1].slice(0, 10);
          if (purchase[0].length > 10) fields.purchase_start_time = purchase[0].slice(11);
          if (purchase[1].length > 10) fields.purchase_end_time = purchase[1].slice(11);
        }
        const announcementText = labeled(/^(?:当選メール案内期間|当選(?:者)?(?:への)?案内(?:開始)?(?:日時|日)?)\s*:\s*(.+)$/)
          .replace(/[~〜～]\s*$/, '').replace(/以降.*$/, '').trim();
        const announcement = starboxSchedulePoint(announcementText, end);
        if (announcement) {
          fields.result_announcement_date = announcement.slice(0, 10);
          if (announcement.length > 10) fields.result_announcement_time = announcement.slice(11);
        }
      }
    }
  }
  const questions = Array.isArray(data.questions) ? data.questions[0] : data.questions;
  const storeLists = Object.values(questions || {}).flatMap(value => {
    const question = Array.isArray(value) ? value[0] : value;
    if (question?.input_type !== 3 || !/(?:店舗|応募店|受取店)/.test(question.title || '') ||
        !/選択|選ん/.test(question.title || '')) return [];
    const options = Array.isArray(question.options?.[0]) ? question.options[0] : question.options;
    if (!Array.isArray(options) || !options.length || options.length > 100) return [];
    const stores = options.filter(value => typeof value === 'string' && value.trim())
      .map(value => value.normalize('NFKC').trim().replace(/^WG\s*/i, 'WonderGOO')
        .replace(/^(新星堂|WonderGOO|Ganryu)\s+/, '$1'))
      .filter(name => !/^(?:選択してください|選んでください|未選択|その他|[-ー]+)$/.test(name));
    return stores.length && stores.every(name => name.length <= 200) ? [stores] : [];
  });
  if (storeLists.length === 1) {
    fields.stores = [...new Set(storeLists[0])].map(name => ({name, prefecture: ''}));
    fields.store_name = fields.stores[0]?.name || '';
  }
  const product = labeled(/^(?:抽選商品|対象商品)\s*:\s*(.+)$/);
  if (product && product.length <= 200) fields.product_name = product;
  const subject = title + ' ' + product;
  if (/ワンピース|ONE\s*PIECE/i.test(subject)) fields.review_category = 'onepiece';
  else if (/ポケモン|ポケカ|POK[ÉE]MON/i.test(subject)) fields.review_category = 'pokemon';
  else if (/遊戯王/.test(subject)) fields.review_category = 'yugioh';
  const pack = /拡張パック|ブースターパック/.test(subject), deck = /デッキ/.test(subject);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  return fields;
}

function geoScheduleText(value) {
  const text = value.normalize('NFKC').trim();
  const quoted = text.match(/^「([^」]+)」/)?.[1] || text;
  return quoted.replace(/(\d{4})[.-](\d{1,2})[.-](\d{1,2})/g, '$1/$2/$3')
    .replace(/\s+-\s+/g, ' ~ ')
    .replace(/\s*(?:まで(?:となり.*|です)?|予定(?:です)?|以降(?:順次)?)\s*[。.]?$/, '')
    .trim();
}

function geoExplicitDate(value) {
  const parts = value.match(/^(\d{4})\s*(?:年|\/)\s*(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})(?!\d)/);
  return parts ? validDate([...parts.slice(1), 0, 0])?.slice(0, 10) : '';
}

function geoFields(html) {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const lines = markup.replace(/\r?\n/g, ' ')
    .replace(/<br\b[^>]*>|<\/(?:div|p|li|dt|dd|th|td|h[1-6])\s*>/gi, '\n')
    .split('\n').map(plain).filter(Boolean);
  const labeled = label => {
    const pattern = new RegExp('^(?:' + label + ')(?=\\s|[:：は】〗≫]|$)\\s*[】〗≫]?\\s*(?:[:：]|は[、,]?)?\\s*(.*)$');
    return lines.flatMap((line, index) => {
      const match = line.replace(/^[【〖≪■◆▼●]\s*/, '').match(pattern);
      return match ? [match[1].trim() || lines[index + 1] || ''] : [];
    });
  };

  // Accept a year printed in the period or an explicit publication date.
  // The fetch date is not evidence for the event's year.
  const publication = uniqueText(lines.filter(line => /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(line))
    .map(line => geoExplicitDate(geoScheduleText(line))));
  const ranges = (label, anchor) => uniqueText(labeled(label).map(value => {
    const text = geoScheduleText(value);
    const reference = geoExplicitDate(text) || anchor;
    return reference ? starboxScheduleRange(text, reference).join('|') : '';
  }));
  const period = ranges('抽選応募期間|抽選受付期間|申込期間|応募期間|受付期間', publication);
  if (!period) return {};
  const [start, end] = period.split('|');
  if (start >= end) return {};

  const productLabel = uniqueText(labeled('抽選商品(?:名)?|対象商品(?:名)?|商品名')
    .map(value => value.replace(/^[・●]\s*/, '').trim()).filter(value => value.length >= 4 && value.length <= 200));
  const subject = ['h1', 'h2', 'h3', 'title'].map(tag => uniqueText(tagContents(markup, tag)
    .map(value => plain(value).replace(/\s*(?:[|｜]|\s-\s)\s*(?:ゲオ|GEO).*$/i, ''))
    .filter(value => value.length <= 200 && /ポケモンカード|ポケカ|ONE\s*PIECE|ワンピースカード|遊戯王|デュエル[・･]マスターズ/i.test(value))))
    .find(Boolean);
  const title = subject || productLabel;
  if (!title) return {};
  const product = productLabel || title.replace(/^(?:[【〖]抽選販売[】〗]\s*)/, '')
    .replace(/\s*(?:の)?(?:購入権)?抽選(?:販売|受付|応募)?(?:のお知らせ)?\s*$/, '').trim();
  const fields = {event_title: title, store_name: 'ゲオ'};
  if (product) fields.product_name = product;
  if (start.length > 10) fields.application_start_at = start + ':00+09:00';
  if (end.length > 10) fields.application_end_at = end + ':00+09:00';

  const area = uniqueText(labeled('対象店舗|実施店舗|販売店舗|受取店舗|受け取り店舗|対象地域'));
  if (/^全国(?:$|の|\s)/.test(area)) fields.prefecture = '全国';
  else if (/^(?:ゲオ|GEO)\s*[^、,／/・]{1,70}店$/i.test(area)) fields.store_name = area;

  const anchor = end.slice(0, 10);
  const announced = uniqueText(labeled('当選者への連絡日|当選(?:結果|発表)(?:日時|日|期間)?|抽選結果(?:の)?発表(?:日時|日|期間)?|結果発表(?:日時|日|期間)?')
    .map(value => {
      const text = geoScheduleText(value).replace(/[~〜～]\s*$/, '').trim();
      return /[~〜～–—]|から/.test(text) ? starboxScheduleRange(text, anchor)[1] : starboxSchedulePoint(text, anchor);
    }));
  if (announced) {
    fields.result_announcement_date = announced.slice(0, 10);
    if (announced.length > 10) fields.result_announcement_time = announced.slice(11);
  }
  const purchase = ranges('当選者へのお渡し期間|当選者購入期間|購入期間|販売期間|お渡し期間|受け取り期間|受取期間', anchor);
  if (purchase) {
    const [first, last] = purchase.split('|');
    fields.purchase_start_date = first.slice(0, 10);
    fields.purchase_end_date = last.slice(0, 10);
    if (first.length > 10) fields.purchase_start_time = first.slice(11);
    if (last.length > 10) fields.purchase_end_time = last.slice(11);
  }
  if (/ポケモンカード|ポケカ/i.test(title + ' ' + product)) fields.review_category = 'pokemon';
  else if (/ONE\s*PIECE|ワンピースカード/i.test(title + ' ' + product)) fields.review_category = 'onepiece';
  else if (/遊戯王/.test(title + ' ' + product)) fields.review_category = 'yugioh';
  const pack = /拡張パック|ブースターパック/.test(product), deck = /デッキ/.test(product);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  return fields;
}

function rakutenBooksFields(html) {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const title = uniqueText([...markup.matchAll(/<h1\b[^>]*\bitemprop\s*=\s*(['"])name\1[^>]*>([\s\S]*?)<\/h1\s*>/gi)]
    .map(match => plain(match[2].replace(/<a\b[^>]*\bclass\s*=\s*["']authorLink["'][^>]*>[\s\S]*?<\/a\s*>/gi, ''))));
  if (title.length < 5 || title.length > 200) return {};

  // The product page also displays a sales window outside the lottery section.
  const lines = [...markup.matchAll(/<h([2-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>([\s\S]*?)(?=<h[1-6]\b|$)/gi)]
    .filter(match => plain(match[2]).replace(/^■\s*/, '') === '抽選販売スケジュール')
    .flatMap(match => match[3].replace(/<br\b[^>]*>|<\/(?:p|li|div|tr)\s*>/gi, '\n').split('\n'))
    .map(line => plain(line).normalize('NFKC'));
  const labeled = label => {
    const pattern = new RegExp('^(?:' + label + ')\\s*:\\s*(.+)$');
    return uniqueText(lines.map(line => line.match(pattern)?.[1]));
  };
  const application = geoScheduleText(labeled('抽選受付期間|抽選応募期間'));
  const yearAnchor = geoExplicitDate(application);
  if (!yearAnchor) return {};
  const [start, end] = starboxScheduleRange(application, yearAnchor);
  if (!start || !end || start.length <= 10 || end.length <= 10 || start >= end) return {};

  const fields = {
    event_title: title,
    product_name: title,
    store_name: '楽天ブックス',
    prefecture: '全国',
    application_start_at: start + ':00+09:00',
    application_end_at: end + ':00+09:00',
  };
  const sale = geoScheduleText(labeled('当選者(?:向け)?(?:販売|購入)期間'));
  const [first, last] = starboxScheduleRange(sale, end.slice(0, 10));
  if (first && last && (first.length === 10 || first >= end)) {
    fields.purchase_start_date = first.slice(0, 10);
    fields.purchase_end_date = last.slice(0, 10);
    if (first.length > 10) fields.purchase_start_time = first.slice(11);
    if (last.length > 10) fields.purchase_end_time = last.slice(11);
  }

  // A promise to email by the sales start is not an announced result date.
  const result = labeled('(?:抽選結果発表|当落結果発表|結果発表|当選発表|抽選結果通知|当選通知)(?:予定)?(?:日時|日|期間)?');
  if (result && !/まで|以内|以降/.test(result)) {
    const anchor = end.slice(0, 10);
    const announced = /[~〜～–—]|から/.test(result)
      ? starboxScheduleRange(result, anchor)[1]
      : starboxSchedulePoint(result, anchor);
    if (announced) {
      fields.result_announcement_date = announced.slice(0, 10);
      if (announced.length > 10) fields.result_announcement_time = announced.slice(11);
    }
  }

  if (/ポケモンカード|ポケカ/i.test(title)) fields.review_category = 'pokemon';
  else if (/ONE\s*PIECE|ワンピースカード/i.test(title)) fields.review_category = 'onepiece';
  else if (/遊戯王/.test(title)) fields.review_category = 'yugioh';
  const pack = /拡張パック|ブースターパック/.test(title);
  const deck = /デッキ|スターターセット/.test(title);
  if (pack || deck) fields.product_type = pack && deck ? 'pack/deck' : pack ? 'pack' : 'deck';
  return fields;
}

export function extract(html,url){
  const body=plain(html), u=new URL(url), result={};
  if(!body||/(?:verify you are human|verify that you are human|アクセスが制限されています|ロボットではありません)/i.test(body))return {};
  if (u.hostname === 'cloud-pass.jp') return supportedUrl(url) ? cloudPassFields(html) : {};
  if (u.hostname === STARBOX_HOST) return supportedUrl(url) ? starboxFields(html) : {};
  if (u.hostname === CUSTOMFORM_HOST) return supportedUrl(url) ? customformFields(html, url) : {};
  if (u.hostname === GEO_HOST) return supportedUrl(url) ? geoFields(html) : {};
  if (u.hostname === RAKUTEN_BOOKS_HOST) return supportedUrl(url) ? rakutenBooksFields(html) : {};
  const raw=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1]||html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]||'';
  const title=plain(raw).replace(/\s*[|｜]\s*(?:ファミマオンライン|ヤマシロヤ|セブンネットショッピング).*$/,'').trim();
  if(title.length>=5&&title.length<=200&&/抽選/.test(title)&&!/(?:受付終了|Google フォーム|closed form)/i.test(title))result.event_title=title;
  let start=oneDate(body,'(?:予約開始日|応募開始(?:日|日時)?)'),end=oneDate(body,'(?:予約終了日|応募締切(?:日|日時)?|応募終了(?:日|日時)?)');
  const range=new RegExp('(?:抽選応募期間|応募期間|抽選期間)\\s*[:：]?\\s*'+datePattern+'\\s*[～〜~−–-]\\s*'+datePattern,'g');
  const periods=[...body.matchAll(range)].map(m=>[validDate(m.slice(1,6)),validDate(m.slice(6,11))]);
  const uniq=[...new Set(periods.filter(p=>p[0]&&p[1]&&p[0]<p[1]).map(p=>p.join('|')))];
  if(uniq.length===1){const v=uniq[0].split('|');start=start||v[0];end=end||v[1];}
  if(start&&end&&start<end){result.application_start_at=start;result.application_end_at=end;}
  const evidence=(title+' '+body.slice(0,16000));
  if(/抽選/.test(evidence)){
    if(u.hostname==='7net.omni7.jp'){result.store_name='セブンイレブン';result.prefecture='全国';}
    else if(u.hostname==='famima-online.family.co.jp'){result.store_name='ファミリーマート';result.prefecture='全国';}
    else if(/ヤマシロヤ\s*オンラインショップ/.test(evidence)){result.store_name='ヤマシロヤ オンラインショップ';}
    if(/(?:対象地域|対象エリア|応募対象地域)\s*[:：]?\s*全国/.test(evidence))result.prefecture='全国';
  }
  return result;
}
