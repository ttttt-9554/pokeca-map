#!/usr/bin/env python3
"""LivePocket v10: evidence-only category hints and verified updates queue.

Run AFTER v9. Reads v7/v9 raw and public JSON. Does not scrape LivePocket.
The optional editable livepocket_verified_updates.csv is authoritative only for
rows explicitly marked verified=yes AND source_url equal to the item's URL.
Existing nonempty fields are never overwritten.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
from collections import Counter
from pathlib import Path

RAW_PATH = Path(os.environ.get('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.environ.get('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
QUEUE_PATH = Path(os.environ.get('LIVEPOCKET_REVIEW_FILE', 'livepocket_review_queue.csv'))
VERIFIED_PATH = Path(os.environ.get('LIVEPOCKET_VERIFIED_FILE', 'livepocket_verified_updates.csv'))
URL_RE = re.compile(r'https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}\Z')
PREFS = set(('北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 '
    '埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 '
    '岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 '
    '和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 '
    '愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 '
    '鹿児島県 沖縄県').split())
FIELDS = ('store_name', 'product_name', 'prefecture', 'event_title', 'application_period')
INPUT_COLUMNS = ('url', 'verified', 'source_url') + FIELDS
REVIEW_COLUMNS = ('url', 'store_name', 'product_name', 'prefecture',
    'source_preview', 'review_category', 'review_priority', 'review_reason',
    'needs_store', 'needs_product', 'needs_prefecture', 'needs_application_period',
    'discord_posted_at')
# These tags only mean that the URL-specific title/snippet mentions that genre.
# Tags are not verified item names; conflicting genre hints => unknown.
CATEGORY_RULES = {
    'pokemon': re.compile(r'ポケカ|ポケモンカード|pokemon|pok[eé]mon|エーフィ|ブラッキー|メガシンフォニア|メガブレイブ', re.I),
    'onepiece': re.compile(r'ONE\s*PIECE|ワンピース', re.I),
    'yugioh': re.compile(r'遊戯王|yu[\s-]?gi[\s-]?oh|yugioh', re.I),
}


def valid_url(url):
    return isinstance(url, str) and bool(URL_RE.fullmatch(url))


def clean_text(text, max_chars):
    if not isinstance(text, str):
        return None
    text = ' '.join(text.split()).strip()
    if not 2 <= len(text) <= max_chars or any(ord(c) < 32 for c in text):
        return None
    if re.search(r'https?://|[„�]|гАР|Ôľ', text, re.I):
        return None
    return text


def category_of(item):
    """Only item-specific fields; do not use whole Discord post excerpts."""
    evidence = ' '.join(str(item.get(k) or '') for k in
       ('product_name', 'event_title', 'source_preview'))
    matches = [name for name, pattern in CATEGORY_RULES.items() if pattern.search(evidence)]
    return matches[0] if len(matches) == 1 else 'unknown'


def verify_input(reader, raw_index):
    """Validate the *entire* input before applying ANY of its rows."""
    if not reader.fieldnames or any(c not in reader.fieldnames for c in INPUT_COLUMNS):
        raise ValueError('Verified CSV missing required columns: ' + ', '.join(INPUT_COLUMNS))
    accepted = []
    seen = set()
    for lineno, row in enumerate(reader, 2):
        if not any((v or '').strip() for v in row.values() if isinstance(v, str)):
            continue
        url = (row.get('url') or '').strip()
        flag = (row.get('verified') or '').strip().lower()
        if flag not in ('yes', 'no', ''):
            raise ValueError(f'Line {lineno}: verified must be yes/no')
        if flag != 'yes':
            continue
        if not valid_url(url) or url not in raw_index:
            raise ValueError(f'Line {lineno}: verified URL is absent from collected events')
        if url in seen:
            raise ValueError(f'Line {lineno}: duplicate verified URL')
        seen.add(url)
        if (row.get('source_url') or '').strip() != url:
            raise ValueError(f'Line {lineno}: source_url must match the same event URL')
        values = {}
        for key in FIELDS:
            val = (row.get(key) or '').strip()
            if not val:
                continue
            if key == 'prefecture':
                if val not in PREFS:
                    raise ValueError(f'Line {lineno}: invalid prefecture')
            else:
                val = clean_text(val, 160 if key == 'event_title' else 110)
                if not val:
                    raise ValueError(f'Line {lineno}: invalid {key}')
            values[key] = val
        if not values:
            raise ValueError(f'Line {lineno}: verified=yes but no fields supplied')
        accepted.append((url, values))
    return accepted


def csv_escape(value):
    """Prevent formula execution when opened in spreadsheet apps."""
    if not isinstance(value, str):
        return value
    if value.startswith(('=', '+', '-', '@', '\t', '\r', '\n')):
        return "'" + value
    return value


def transform(raw, public, verified_rows=()):
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list):
        raise ValueError('Invalid raw JSON')
    if not isinstance(public, dict) or not isinstance(public.get('items'), list):
        raise ValueError('Invalid public JSON')
    raw = json.loads(json.dumps(raw, ensure_ascii=False))
    public = json.loads(json.dumps(public, ensure_ascii=False))
    rindex = {}
    pindex = {}
    for collection, index in ((raw['items'], rindex), (public['items'], pindex)):
        for item in collection:
            if not isinstance(item, dict) or not valid_url(item.get('url')):
                raise ValueError('Invalid event URL')
            if item['url'] in index:
                raise ValueError('Duplicate URL')
            index[item['url']] = item
    if rindex.keys() != pindex.keys():
        raise ValueError('Raw/public URL sets differ; refusing update')
    stats = {'urls': len(rindex), 'verified_rows': 0, 'verified_fields_added': 0,
             'review_rows': 0, 'category_hint_urls': 0}
    for url, fields in verified_rows:
        if url not in rindex:
            raise ValueError('Unrecognized verified event URL')
        stats['verified_rows'] += 1
        for field, value in fields.items():
            if field not in FIELDS:
                raise ValueError('Field not permitted')
            old = rindex[url].get(field) or pindex[url].get(field)
            if old:
                if old != value:
                    # Never override preexisting values, especially screenshot-verified.
                    print(f'v10: retaining existing {field} for {url}')
                continue
            rindex[url][field] = value
            rindex[url].setdefault('field_sources', {})[field] = 'v10_user_verified_csv'
            pindex[url][field] = value
            pindex[url]['detail_provenance'] = 'user_verified_csv'
            stats['verified_fields_added'] += 1

    rows = []
    for item in public['items']:
        cat = category_of(item)
        # A categorization is a search hint, NOT a product name.
        if cat != 'unknown':
            item['review_category'] = cat
            if item.get('source_preview') and not item.get('product_name') and not item.get('event_title'):
                stats['category_hint_urls'] += 1
        else:
            item.pop('review_category', None)
        missing_store = not (item.get('store_name') or item.get('venue_name'))
        missing_product = not (item.get('product_name') or item.get('event_title'))
        missing_pref = not item.get('prefecture')
        missing_period = not (item.get('application_period') or item.get('application_end_at'))
        if not (missing_store or missing_product):
            continue
        reasons = []
        if missing_store: reasons.append('store_unknown')
        if missing_product: reasons.append('product_or_event_unknown')
        if missing_pref: reasons.append('prefecture_unknown')
        if missing_period: reasons.append('application_period_unknown')
        preview = bool(item.get('source_preview'))
        priority = 'high' if preview else ('medium' if not missing_store else 'low')
        row = {k: '' for k in REVIEW_COLUMNS}
        for key in ('url', 'store_name', 'product_name', 'prefecture',
                    'source_preview', 'discord_posted_at'):
            row[key] = item.get(key) or ''
        row.update({'review_category': '' if cat == 'unknown' else cat,
            'review_priority': priority, 'review_reason': ';'.join(reasons),
            'needs_store': 'yes' if missing_store else '',
            'needs_product': 'yes' if missing_product else '',
            'needs_prefecture': 'yes' if missing_pref else '',
            'needs_application_period': 'yes' if missing_period else ''})
        rows.append({k: csv_escape(v) for k, v in row.items()})
    # Sort newest-first within actionable priority groups.
    rows.sort(key=lambda x: x['discord_posted_at'], reverse=True)
    order = {'high': 0, 'medium': 1, 'low': 2}
    rows.sort(key=lambda x: order[x['review_priority']])
    stats['review_rows'] = len(rows)
    public['schema_version'] = 10
    raw['field_counts'] = {**raw.get('field_counts', {}), **{
        key: sum(bool(x.get(key)) for x in raw['items']) for key in FIELDS}}
    public['unique_livepocket_urls'] = len(public['items'])
    return raw, public, rows, stats


def write_json(path, value):
    data = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    return write_file(path, data, encoding='utf-8')


def write_file(path, data, encoding):
    if path.exists() and path.read_text(encoding=encoding) == data:
        return False
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(data, encoding=encoding)
    tmp.replace(path)
    return True


def write_csv(path, rows):
    buff = io.StringIO(newline='')
    writer = csv.DictWriter(buff, fieldnames=REVIEW_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return write_file(path, buff.getvalue(), encoding='utf-8-sig')


def main():
    raw = json.loads(RAW_PATH.read_text(encoding='utf-8'))
    public = json.loads(PUBLIC_PATH.read_text(encoding='utf-8'))
    by_url = {a['url']: a for a in raw['items']}
    verified = []
    if VERIFIED_PATH.exists():
        with VERIFIED_PATH.open(encoding='utf-8-sig', newline='') as file:
            verified = verify_input(csv.DictReader(file), by_url)
    new_raw, new_public, rows, stats = transform(raw, public, verified)
    print('--- LivePocket v10 result ---')
    for key, value in stats.items():
        print(f'{key}: {value}')
    print(f'raw_updated: {write_json(RAW_PATH, new_raw)}')
    print(f'public_updated: {write_json(PUBLIC_PATH, new_public)}')
    print(f'queue_updated: {write_csv(QUEUE_PATH, rows)}')


if __name__ == '__main__':
    main()
