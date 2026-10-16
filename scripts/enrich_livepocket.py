"""Extract verified details from public LivePocket pages and per-URL Discord blocks.
Only public HTML; no login, CAPTCHA bypass, or private API. Unknowns remain null.
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

SOURCE = Path('output/livepocket_urls.json')
MAX_ITEMS = max(0, int(os.getenv('LIVEPOCKET_MAX_ITEMS', '350')))
DELAY = max(0.2, float(os.getenv('LIVEPOCKET_REQUEST_DELAY', '0.8')))
PREFS = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split()
URL_RE = re.compile(r'https?://(?:www\.)?livepocket\.jp/e/[\w-]+', re.I)
DATE = r'(?:20\d{2}\s*[年/.-]\s*)?\d{1,2}\s*[月/.-]\s*\d{1,2}\s*日?(?:\s*[(（][^()（）]{1,5}[)）])?(?:\s*\d{1,2}\s*[:：]\s*\d{2})?'
RANGE = re.compile(r'(' + DATE + r')\s*(?:[～〜~－–—-]|から|より|\bto\b)\s*(' + DATE + r')', re.I)
PRODUCTS = re.compile(r'(?:ポケモンカード(?:ゲーム)?|ポケカ|拡張パック|強化拡張パック|ハイクラスパック|スペシャル(?:BOX|セット)|プレミアムトレーナーボックス|スタートデッキ|デッキビルドBOX|メガブレイブ|メガシンフォニア|インフェルノX|ブラックボルト|ホワイトフレア|ロケット団の栄光|テラスタルフェス|バトルパートナーズ)', re.I)

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_parts=[];self.meta={};self.text=[];self.skip=0;self.title=False;self.ld=False;self.ld_parts=[];self.jsonld=[]
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag=='title':self.title=True
        if tag=='meta':
            key=(a.get('property') or a.get('name') or '').lower()
            if key and a.get('content'):self.meta[key]=a['content']
        if tag in ('script','style','noscript'):
            self.skip+=1
            if tag=='script' and a.get('type','').lower()=='application/ld+json':self.ld=True;self.ld_parts=[]
        if tag in ('p','div','section','h1','h2','h3','h4','li','br','tr','td','dt','dd','article'):
            self.text.append('\n')
    def handle_endtag(self,tag):
        if tag=='title':self.title=False
        if tag in ('script','style','noscript'):
            if tag=='script' and self.ld:
                try:self.jsonld.append(json.loads(''.join(self.ld_parts)))
                except (ValueError,TypeError):pass
                self.ld=False
            self.skip=max(0,self.skip-1)
    def handle_data(self,data):
        if self.title:self.title_parts.append(data)
        if self.ld:self.ld_parts.append(data)
        if not self.skip:self.text.append(data)

def clean(value):return re.sub(r'\s+',' ',html.unescape(str(value or ''))).strip()
def safe_url(url):
    p=urllib.parse.urlsplit(url)
    return p.scheme=='https' and p.hostname in ('livepocket.jp','www.livepocket.jp') and not p.username and not p.password and bool(re.fullmatch(r'/e/[A-Za-z0-9_-]+/?',p.path))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):raise RuntimeError('redirect_blocked')
def fetch(url):
    if not safe_url(url):raise RuntimeError('invalid_url')
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; PokecaMapPublicEventReader/2.0)','Accept':'text/html','Accept-Language':'ja-JP,ja;q=0.9'})
    try:
        with urllib.request.build_opener(NoRedirect).open(req,timeout=14) as r:
            if 'html' not in r.headers.get('Content-Type','').lower():raise RuntimeError('not_html')
            raw=r.read(1000001)
            if len(raw)>1000000:raise RuntimeError('page_too_large')
            return raw.decode(r.headers.get_content_charset() or 'utf-8',errors='replace')
    except urllib.error.HTTPError as e:raise RuntimeError('http_'+str(e.code)) from e

def event_objects(obj):
    if isinstance(obj,list):
        for v in obj:yield from event_objects(v)
    elif isinstance(obj,dict):
        t=obj.get('@type',[]);t=[t] if isinstance(t,str) else t
        if any(str(x).endswith('Event') for x in t):yield obj
        if '@graph' in obj:yield from event_objects(obj['@graph'])

def labeled_value(lines,labels):
    for idx,line in enumerate(lines):
        for label in labels:
            m=re.match(r'^'+re.escape(label)+r'\s*[：:]\s*(.{2,130})$',line)
            if m:return clean(m.group(1))
            if line.rstrip('：:')==label and idx+1<len(lines):
                candidate=lines[idx+1]
                if len(candidate)<130 and not URL_RE.search(candidate):return candidate
    return None

def extract_period(lines,labels):
    for idx,line in enumerate(lines):
        if not any(label in line for label in labels):continue
        # Keep date context near the label; never borrow unrelated dates far away.
        snippet=' '.join(lines[idx:idx+3])[:230]
        m=RANGE.search(snippet)
        if m:return clean(m.group(1)+' ～ '+m.group(2))
        matches=list(re.finditer(DATE,snippet))
        if len(matches)>=2 and matches[1].start()-matches[0].end()<32:
            return clean(matches[0].group()+' ～ '+matches[1].group())
        if len(matches)==1:return clean(matches[0].group())
    return None

def product_from_title(title):
    t=clean(re.sub(r'\s*[-|｜]\s*LivePocket.*$','',title,flags=re.I))
    if not PRODUCTS.search(t):return None
    # A whole event headline can be misleading as a product name; prefer explicit bracketed product.
    for pattern in (r'[『「【]([^』」】]{2,85})[』」】]',r'(?:ポケモンカードゲーム|ポケカ)\s*[「『【]?([^\n｜|]{2,75})'):
        for m in re.finditer(pattern,t):
            v=clean(m.group(1))
            if PRODUCTS.search(v) or re.search(r'(?:BOX|パック|デッキ)',v,re.I):return v
    return None

def analyze(page):
    p=Parser();p.feed(page)
    title=clean(p.meta.get('og:title') or ''.join(p.title_parts))
    lines=[clean(x) for x in ''.join(p.text).splitlines() if clean(x)]
    result={'store_name':None,'prefecture':None,'product_name':None,'application_period':None,'sales_period':None,'page_title':title or None}
    for event in event_objects(p.jsonld):
        loc=event.get('location') or {};loc=loc[0] if isinstance(loc,list) and loc else loc
        if isinstance(loc,dict):
            result['store_name']=clean(loc.get('name')) or None
            addr=loc.get('address') or {}
            if isinstance(addr,dict) and clean(addr.get('addressRegion')) in PREFS:result['prefecture']=clean(addr['addressRegion'])
        break
    result['store_name']=result['store_name'] or labeled_value(lines,['販売店舗','対象店舗','店舗名','開催店舗'])
    # Only explicitly labeled location data, not any prefecture mentioned in terms and conditions.
    pref_text=labeled_value(lines,['都道府県','所在地','住所','開催場所'])
    if pref_text and not result['prefecture']:
        result['prefecture']=next((pref for pref in PREFS if pref in pref_text),None)
    result['product_name']=labeled_value(lines,['対象商品','販売商品','商品名','抽選対象商品','対象パック']) or product_from_title(title)
    result['application_period']=extract_period(lines,['応募期間','抽選受付期間','申込期間','申し込み期間','エントリー期間','受付期間','応募受付','抽選申込'])
    result['sales_period']=extract_period(lines,['販売期間','購入期間','受取期間','販売日時','購入可能期間','商品受取期間'])
    return result

def discord_block(item):
    text=item.get('post_excerpt') or '';url=item.get('url') or ''
    lines=[clean(x) for x in text.splitlines()]
    matches=[i for i,x in enumerate(lines) if url in URL_RE.findall(x)]
    if not matches:return []
    idx=matches[0]
    start=max([i for i in range(idx) if lines[i].startswith('📍')],default=-1)
    if start<0 or idx-start>12:return []
    # Only metadata between the nearest location marker and THIS link.
    return [x for x in lines[start+1:idx] if x and not URL_RE.search(x)]

def enrich_discord(item):
    block=discord_block(item)
    if not block:return
    product=labeled_value(block,['対象商品','販売商品','商品名','抽選対象商品'])
    if product and not item.get('product_name'):item['product_name']=product;item['product_source']='discord_post'
    for field,labels in [('application_period',['応募期間','抽選受付期間','申込期間','受付期間']),('sales_period',['販売期間','購入期間','受取期間'])]:
        value=extract_period(block,labels)
        if value and not item.get(field):item[field]=value;item[field+'_source']='discord_post'

def main():
    if not SOURCE.exists():raise RuntimeError('Missing output/livepocket_urls.json')
    data=json.loads(SOURCE.read_text(encoding='utf-8'));items=data.get('items',[])
    counts={};field_counts={}
    for idx,item in enumerate(items):
        enrich_discord(item)
        if idx>=MAX_ITEMS:
            item['extraction_status']='not_checked_limit'
            counts['not_checked_limit']=counts.get('not_checked_limit',0)+1
            continue
        try:
            details=analyze(fetch(item['url']))
            for field,value in details.items():
                if value and not item.get(field):
                    item[field]=value
                    if field in ('product_name','application_period','sales_period'):item[field+'_source']='livepocket_page'
            item['extraction_status']='parsed' if any(item.get(k) for k in ('store_name','prefecture','product_name','application_period','sales_period')) else 'no_structured_details'
        except Exception as e:
            item['page_error']=str(e)[:80]
            item['extraction_status']='discord_post_only' if any(item.get(k) for k in ('store_name','prefecture','product_name','application_period','sales_period')) else str(e)[:80]
        status=item['extraction_status'];counts[status]=counts.get(status,0)+1
        if idx<min(len(items),MAX_ITEMS)-1:time.sleep(DELAY)
    for key in ('store_name','prefecture','product_name','application_period','sales_period'):
        field_counts[key]=sum(bool(item.get(key)) for item in items)
    data['enriched_at']=datetime.now(timezone.utc).isoformat()
    data['enrichment_counts']=counts;data['field_counts']=field_counts
    SOURCE.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Enrichment statuses:',counts,'field counts:',field_counts,'total:',len(items))

if __name__=='__main__':
    try:main()
    except Exception as e:print('ERROR:',e,file=sys.stderr);sys.exit(1)
