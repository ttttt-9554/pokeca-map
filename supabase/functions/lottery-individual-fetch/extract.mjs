// Public page extraction. Only unambiguous, explicitly labelled data is returned.
export function supportedUrl(value) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash) return false;
    if(u.hostname==='docs.google.com') return /^\/forms\/d\/e\/[A-Za-z0-9_-]{20,180}\/(?:viewform|closedform)\/?$/.test(u.pathname) && !u.search;
    if(u.hostname==='e-yamashiroya.com') return /^\/(?:%[\da-f]{2}|[a-z\d_\-\/])+$/i.test(u.pathname) && !u.search && !u.pathname.includes('//');
    if(u.hostname==='7net.omni7.jp') return /^\/detail\/\d+\.html$/.test(u.pathname) && !u.search;
    if(u.hostname==='famima-online.family.co.jp') return u.pathname==='/item' && /^\?itemCode=\d{10,25}$/.test(u.search);
    if(u.hostname==='cloud-pass.jp') return /^\/pr\/[a-f0-9]{64}\/?$/i.test(u.pathname) && !u.search;
    return false;
  } catch {return false;}
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

export function extract(html,url){
  const body=plain(html), u=new URL(url), result={};
  if(!body||/(?:verify you are human|verify that you are human|アクセスが制限されています|ロボットではありません)/i.test(body))return {};
  if (u.hostname === 'cloud-pass.jp') return supportedUrl(url) ? cloudPassFields(html) : {};
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
