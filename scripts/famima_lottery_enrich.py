#!/usr/bin/env python3
"""Enrich collected Famima lottery URLs using the project's Tokyo database."""
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

JST = timezone(timedelta(hours=9))
PATH = Path('other_lottery_public.json')
DATE = r'(\d{4})/(\d{1,2})/(\d{1,2})(?:\s*[(（][^()（）]{1,5}[)）])?\s+(\d{1,2}):(\d{2})'


def item_code(url):
    if not isinstance(url, str): return None
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc.lower() != 'famima-online.family.co.jp' or parsed.path != '/item': return None
        values = urllib.parse.parse_qs(parsed.query).get('itemCode', [])
        return values[0] if len(values) == 1 and re.fullmatch(r'\d{10,25}', values[0]) else None
    except ValueError: return None


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = []; self.text = []; self.in_title = False
    def handle_starttag(self, tag, attrs):
        if tag == 'title': self.in_title = True
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
    def handle_data(self, text):
        self.text.append(text)
        if self.in_title: self.title.append(text)


def extract(html):
    page = Page(); page.feed(html)
    title = ' '.join(' '.join(page.title).split()).split(' | ファミマオンライン', 1)[0].strip()
    if not title or len(title) > 200 or '抽選商品' not in title: return None
    body = ' '.join(page.text)
    dates = []
    for label in ('予約開始日', '予約終了日'):
        matches = re.findall(label + r'\s*[:：]\s*' + DATE, body)
        try:
            values = {datetime(*map(int, match), tzinfo=JST) for match in matches}
        except ValueError: return None
        if len(values) != 1: return None
        dates.append(values.pop())
    if dates[0] >= dates[1]: return None
    result = {'event_title': title, 'official_event_title': title, 'event_title_provisional': False,
              'application_start_at': dates[0].isoformat(), 'application_end_at': dates[1].isoformat(),
              'store_name': 'ファミリーマート', 'prefecture': '全国', 'external_url_unverified': False}
    if re.search(r'ポケモン|ポケカ|POKEMON', title, re.I): result['review_category'] = 'pokemon'
    elif re.search(r'ワンピース|ONE\s*PIECE', title, re.I): result['review_category'] = 'onepiece'
    return result


def rpc(base, key, method, payload):
    url = base.rstrip('/') + '/rest/v1/rpc/' + method
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method='POST', headers={
        'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def fetch(code, base, key):
    request_id = rpc(base, key, 'famima_lottery_begin_v1', {'item_code': code})
    for _ in range(15):
        result = rpc(base, key, 'famima_lottery_result_v1', {'request_id': request_id})
        if result is not None:
            if result.get('status_code') != 200 or result.get('timed_out') or result.get('error'):
                raise ValueError('Page request failed')
            return result.get('content') or ''
        time.sleep(1)
    raise ValueError('Page request timed out')


def enrich(data, loader, now=None, limit=8):
    now = now or datetime.now(timezone.utc)
    count = 0
    for item in data.get('items', []):
        code = item_code(item.get('url', ''))
        if not code or item.get('famima_verified_at'): continue
        try:
            attempted = datetime.fromisoformat(item.get('famima_checked_at', ''))
            if attempted.tzinfo and now - attempted < timedelta(hours=24): continue
        except (ValueError, TypeError): pass
        if count >= limit: break
        item['famima_checked_at'] = now.isoformat(); count += 1
        try:
            html = loader(code)
            result = extract(html) if len(html) <= 2_000_000 else None
        except (OSError, ValueError, TypeError, KeyError): result = None
        if result:
            item.update(result); item['famima_verified_at'] = now.isoformat()
    return count


def main():
    base = os.environ.get('SUPABASE_URL', '')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not base or not key or not PATH.exists():
        print('Famima check skipped: database configuration unavailable'); return
    data = json.loads(PATH.read_text(encoding='utf-8'))
    count = enrich(data, lambda code: fetch(code, base, key))
    if count:
        temp = PATH.with_suffix('.tmp')
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temp.replace(PATH)
    print('Famima pages checked:', count)


if __name__ == '__main__': main()
