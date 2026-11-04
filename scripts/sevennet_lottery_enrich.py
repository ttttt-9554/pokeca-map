#!/usr/bin/env python3
"""Read public Sevennet lottery pages for URLs already collected from Discord."""
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

JST = timezone(timedelta(hours=9))
PATH = Path('other_lottery_public.json')
PAGE = re.compile(r'^https://7net\.omni7\.jp/detail/\d+\.html$')
DATE = r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2}):(\d{2})'
PERIOD = re.compile(r'応募期間\s*[:：]?\s*' + DATE + r'\s*[～〜~]\s*' + DATE)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_h1 = False
        self.h1 = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag == 'h1': self.in_h1 = True

    def handle_endtag(self, tag):
        if tag == 'h1': self.in_h1 = False

    def handle_data(self, text):
        self.text.append(text)
        if self.in_h1: self.h1.append(text)


def extract(page):
    parser = PageParser()
    parser.feed(page)
    title = ' '.join(' '.join(parser.h1).split())
    if not title or len(title) > 200 or not re.search(r'抽選(?:応募|販売)', title):
        return None
    text = ' '.join(parser.text)
    periods = set()
    for match in PERIOD.finditer(text):
        try:
            values = list(map(int, match.groups()))
            start = datetime(*values[:5], tzinfo=JST)
            end = datetime(*values[5:], tzinfo=JST)
            if start < end: periods.add((start.isoformat(), end.isoformat()))
        except ValueError:
            continue
    if len(periods) != 1: return None
    start, end = periods.pop()
    result = {'event_title': title, 'official_event_title': title,
              'event_title_provisional': False, 'application_start_at': start,
              'application_end_at': end, 'store_name': 'セブンイレブン',
              'prefecture': '全国', 'external_url_unverified': False}
    if re.search(r'ポケモン|ポケカ|POKEMON', title, re.I): result['review_category'] = 'pokemon'
    elif re.search(r'ワンピース|ONE\s*PIECE', title, re.I): result['review_category'] = 'onepiece'
    return result


class SamePageRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if newurl != req.full_url: raise urllib.error.HTTPError(newurl, code, 'redirect refused', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url):
    opener = urllib.request.build_opener(SamePageRedirect())
    request = urllib.request.Request(url, headers={'User-Agent': 'TorecaRadar/1.0'})
    with opener.open(request, timeout=15) as response:
        return response.read(2_000_001).decode('utf-8', errors='replace')


def enrich(data, loader=fetch, now=None, limit=8):
    now = now or datetime.now(timezone.utc)
    changed = 0
    for item in data.get('items', []):
        url = item.get('url', '')
        if not isinstance(url, str) or not PAGE.fullmatch(url) or item.get('sevennet_verified_at'):
            continue
        try:
            attempted = datetime.fromisoformat(item.get('sevennet_checked_at', ''))
            if attempted.tzinfo and now - attempted < timedelta(hours=24): continue
        except (ValueError, TypeError): pass
        if changed >= limit: break
        item['sevennet_checked_at'] = now.isoformat()
        changed += 1
        try:
            page = loader(url)
            result = extract(page) if len(page) <= 2_000_000 else None
        except (OSError, ValueError):
            result = None
        if result:
            item.update(result)
            item['sevennet_verified_at'] = now.isoformat()
    return changed


def main():
    if not PATH.exists(): return
    data = json.loads(PATH.read_text(encoding='utf-8'))
    count = enrich(data)
    if count:
        temp = PATH.with_suffix('.tmp')
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temp.replace(PATH)
    print('Sevennet pages checked:', count)


if __name__ == '__main__': main()
