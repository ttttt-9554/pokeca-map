"""Enrich collected LivePocket URLs using public event page metadata/text.
No login, CAPTCHA bypass, or private API access. Missing data remains null.
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
from pathlib import Path
from html.parser import HTMLParser

SOURCE = Path('output/livepocket_urls.json')
PREFS = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split()
UA = 'Mozilla/5.0 (compatible; PokecaMapLivePocketMetadata/1.0; public-event-info)'
MAX_ITEMS = max(0, int(os.getenv('LIVEPOCKET_MAX_ITEMS', '100')))

class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ''
        self.text = []
        self.meta = {}
        self.in_title = False
        self.skip = 0
        self.jsonld = []
        self.in_ld = False
        self.ld_parts = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style', 'noscript'):
            self.skip += 1
            if tag == 'script' and a.get('type', '').lower() == 'application/ld+json':
                self.in_ld = True
                self.ld_parts = []
        if tag == 'title': self.in_title = True
        if tag == 'meta':
            key = (a.get('property') or a.get('name') or '').lower()
            if key and a.get('content'): self.meta[key] = a['content'].strip()
        if tag in ('p', 'div', 'section', 'h1', 'h2', 'h3', 'li', 'br', 'tr'):
            self.text.append('\n')
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
        if tag in ('script', 'style', 'noscript'):
            if tag == 'script' and self.in_ld:
                try: self.jsonld.append(json.loads(''.join(self.ld_parts)))
                except (ValueError, TypeError): pass
                self.in_ld = False
            self.skip = max(0, self.skip - 1)
    def handle_data(self, data):
        if self.in_ld: self.ld_parts.append(data)
        if self.in_title: self.title += data
        if not self.skip: self.text.append(data)

def safe_url(url):
    u = urllib.parse.urlsplit(url)
    return u.scheme == 'https' and u.hostname in ('livepocket.jp', 'www.livepocket.jp') and bool(re.fullmatch(r'/e/[A-Za-z0-9_-]+/?', u.path)) and not u.username and not u.password

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('redirect_blocked')

def fetch(url):
    if not safe_url(url): raise RuntimeError('invalid_url')
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ja,en;q=0.8'})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=18) as response:
            content_type = response.headers.get('Content-Type', '')
            if 'html' not in content_type.lower(): raise RuntimeError('not_html')
            raw = response.read(1_000_001)
            if len(raw) > 1_000_000: raise RuntimeError('page_too_large')
            encoding = response.headers.get_content_charset() or 'utf-8'
            return raw.decode(encoding, errors='replace')
    except urllib.error.HTTPError as e:
        raise RuntimeError('http_' + str(e.code)) from e

def clean(s):
    return re.sub(r'\s+', ' ', html.unescape(str(s or ''))).strip()

def event_objects(data):
    if isinstance(data, list):
        for x in data: yield from event_objects(x)
    elif isinstance(data, dict):
        types = data.get('@type', [])
        if isinstance(types, str): types = [types]
        if 'Event' in types or any(str(t).endswith('Event') for t in types): yield data
        if '@graph' in data: yield from event_objects(data['@graph'])

def first_line_match(text, labels):
    for line in text.splitlines():
        s = clean(line)
        for label in labels:
            m = re.match(r'^' + re.escape(label) + r'\s*[：:]\s*(.{2,110})$', s)
            if m: return clean(m.group(1))
    return None

def period(text, words):
    lines = [clean(s) for s in text.splitlines() if clean(s)]
    for i, line in enumerate(lines):
        if any(w in line for w in words):
            context = ' '.join(lines[i:i+3])[:240]
            dates = re.findall(r'(?:20\d{2}[年/.-])?\s*\d{1,2}[月/.-]\s*\d{1,2}日?(?:\s*\([^)]{1,4}\))?(?:\s*\d{1,2}[:：]\d{2})?', context)
            if len(dates) >= 2: return clean(dates[0] + ' ～ ' + dates[1])
            if len(dates) == 1: return clean(context[:120])
    return None

def analyze(page):
    p = PageParser()
    p.feed(page)
    title = clean(p.meta.get('og:title') or p.title)
    text = ''.join(p.text)
    result = {'store_name': None, 'prefecture': None, 'product_name': None, 'application_period': None, 'sales_period': None}
    for event in event_objects(p.jsonld):
        location = event.get('location') or {}
        if isinstance(location, list): location = location[0] if location else {}
        if isinstance(location, dict):
            name = location.get('name')
            if name: result['store_name'] = clean(name)
            address = location.get('address') or {}
            if isinstance(address, dict):
                region = clean(address.get('addressRegion'))
                if region in PREFS: result['prefecture'] = region
        break
    result['store_name'] = result['store_name'] or first_line_match(text, ['販売店舗', '対象店舗', '店舗名', '開催店舗', '会場'])
    for pref in PREFS:
        if pref in text or (result['store_name'] and pref in result['store_name']):
            result['prefecture'] = pref
            break
    result['product_name'] = first_line_match(text, ['対象商品', '販売商品', '商品名', '抽選対象商品'])
    result['application_period'] = period(text, ['応募期間', '抽選受付期間', '申込期間', 'エントリー期間', '受付期間'])
    result['sales_period'] = period(text, ['販売期間', '購入期間', '受取期間', '販売日時'])
    result['page_title'] = title or None
    return result

def main():
    if not SOURCE.exists(): raise RuntimeError('Missing output/livepocket_urls.json; run Discord collector first')
    data = json.loads(SOURCE.read_text(encoding='utf-8'))
    items = data.get('items', [])
    counts = {}
    for idx, item in enumerate(items):
        if idx >= MAX_ITEMS:
            item['extraction_status'] = 'not_checked_limit'
            continue
        try:
            item.update(analyze(fetch(item['url'])))
            item['extraction_status'] = 'parsed' if any(item.get(k) for k in ('store_name', 'prefecture', 'product_name', 'application_period', 'sales_period')) else 'no_structured_details'
        except Exception as e:
            item['extraction_status'] = str(e)[:80]
        counts[item['extraction_status']] = counts.get(item['extraction_status'], 0) + 1
        if idx < len(items) - 1: time.sleep(1.5)
    data['enriched_at'] = datetime.now(timezone.utc).isoformat()
    data['enrichment_counts'] = counts
    SOURCE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Enrichment summary:', counts, 'total:', len(items))

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print('ERROR:', e, file=sys.stderr)
        sys.exit(1)
