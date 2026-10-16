#!/usr/bin/env python3
"""LivePocket v9: cautious prefecture linking and URL-specific preview queue.

No external requests, no inference from URL IDs, and no changes to verified
store/product/title/date information. v7 creates the public JSON first.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
from collections import defaultdict
from pathlib import Path

RAW_PATH = Path(os.environ.get('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.environ.get('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
QUEUE_PATH = Path(os.environ.get('LIVEPOCKET_REVIEW_FILE', 'livepocket_review_queue.csv'))
URL_RE = re.compile(r'^https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}$')
URL_ANY = re.compile(r'https?://\S+', re.I)
PREFECTURES = {
    '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県',
    '栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県',
    '石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県',
    '滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県',
    '岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県',
    '佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県',
}
# Never accept a date-only line or a general LivePocket roundup as an event hint.
CARD_HINT = re.compile(
    r'ポケカ|ポケモン|ワンピース|ONE\s*PIECE|カードゲーム|30th\s*C|'
    r'エーフィ|ブラッキー|ストーム|プレミアムデッキ|メガブ|スター', re.I)
UNSAFE = re.compile(r'[„�]|гАР|Ôľ|livepocket|チケット販売情報|まとめ', re.I)
QUEUE_FIELDS = (
    'url', 'store_name', 'product_name', 'prefecture', 'source_preview',
    'needs_store', 'needs_product', 'needs_prefecture', 'needs_application_period',
    'discord_posted_at',
)


def valid_url(url):
    return isinstance(url, str) and bool(URL_RE.fullmatch(url))


def meaningful_label(value):
    if not isinstance(value, str):
        return None
    value = re.sub(r'\s+', ' ', value).strip(' \t\n*・')
    if not 6 <= len(value) <= 85:
        return None
    if URL_ANY.search(value) or UNSAFE.search(value) or not CARD_HINT.search(value):
        return None
    if value.startswith(('📍', '🔗', '■', '#', 'http')):
        return None
    return value


def preview_for(item):
    """Only use the heading immediately before THIS exact URL within its post."""
    if item.get('store_name') or item.get('product_name') or item.get('event_title'):
        return None
    body = item.get('post_excerpt')
    url = item.get('url')
    if not isinstance(body, str) or not valid_url(url):
        return None
    lines = body.splitlines()
    labels = []
    for idx, line in enumerate(lines):
        if line.strip() != url or idx == 0:
            continue
        label = meaningful_label(lines[idx-1])
        if label:
            labels.append(label)
    # Do not accept conflicting headings for the same URL.
    return labels[0] if labels and len(set(labels)) == 1 else None


def transform(raw, public):
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list):
        raise ValueError('Invalid raw JSON')
    if not isinstance(public, dict) or not isinstance(public.get('items'), list):
        raise ValueError('Invalid public JSON')
    raw_items, public_items = raw['items'], public['items']
    raw_urls = [a.get('url') for a in raw_items]
    public_urls = [a.get('url') for a in public_items]
    if not all(map(valid_url, raw_urls + public_urls)):
        raise ValueError('Invalid event URL')
    if len(raw_urls) != len(set(raw_urls)) or len(public_urls) != len(set(public_urls)):
        raise ValueError('Duplicate URL; refusing to update')
    if set(raw_urls) != set(public_urls):
        raise ValueError('Public/raw URL sets differ; refusing to update')

    # Link only EXACT shop names with ONE consistent, already observed prefecture.
    shops = defaultdict(set)
    for item in raw_items:
        name = item.get('store_name')
        pref = item.get('prefecture')
        if isinstance(name, str) and name.strip() and pref in PREFECTURES:
            shops[name.strip()].add(pref)

    raw_out = json.loads(json.dumps(raw, ensure_ascii=False))
    pub_out = json.loads(json.dumps(public, ensure_ascii=False))
    public_by_url = {a['url']: a for a in pub_out['items']}
    stats = {'urls': len(raw_items), 'prefectures_added': 0,
             'review_previews_added': 0, 'review_queue_rows': 0}

    for item in raw_out['items']:
        pub = public_by_url[item['url']]
        name = item.get('store_name')
        if not item.get('prefecture') and isinstance(name, str):
            known = shops.get(name.strip(), set())
            if len(known) == 1:
                prefecture = next(iter(known))
                item['prefecture'] = prefecture
                item.setdefault('field_sources', {})['prefecture'] = 'v9_exact_store_cross_reference'
                pub['prefecture'] = prefecture
                stats['prefectures_added'] += 1
        hint = preview_for(item)
        if hint and not pub.get('source_preview'):
            pub['source_preview'] = hint
            stats['review_previews_added'] += 1

    # Deterministic queue: newer posts first, without original Discord content or IDs.
    pending = []
    for pub in pub_out['items']:
        missing_store = not (pub.get('store_name') or pub.get('venue_name'))
        missing_product = not (pub.get('product_name') or pub.get('event_title'))
        if not (missing_store or missing_product):
            continue
        row = {k: pub.get(k) or '' for k in QUEUE_FIELDS}
        row.update({
            'needs_store': 'yes' if missing_store else '',
            'needs_product': 'yes' if missing_product else '',
            'needs_prefecture': 'yes' if not pub.get('prefecture') else '',
            'needs_application_period': 'yes' if not pub.get('application_period') else '',
        })
        # Spreadsheet-formula injection guard. Text fields are untrusted.
        for k, v in row.items():
            if isinstance(v, str) and v.startswith(('=', '+', '-', '@', '\t', '\r')):
                row[k] = "'" + v
        pending.append(row)
    # Prefer preview-present entries, then recent event posts.
    pending.sort(key=lambda x: x['discord_posted_at'], reverse=True)
    pending.sort(key=lambda x: not bool(x['source_preview']))
    stats['review_queue_rows'] = len(pending)
    raw_out.setdefault('field_counts', {})['prefecture'] = sum(
        bool(x.get('prefecture')) for x in raw_out['items'])
    pub_out['schema_version'] = 9
    return raw_out, pub_out, pending, stats


def write_json(path, obj):
    payload = json.dumps(obj, ensure_ascii=False, indent=2) + '\n'
    if path.exists() and path.read_text(encoding='utf-8') == payload:
        return False
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(payload, encoding='utf-8')
    tmp.replace(path)
    return True


def write_csv(path, rows):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=QUEUE_FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    payload = out.getvalue()
    if path.exists() and path.read_text(encoding='utf-8-sig') == payload:
        return False
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(payload, encoding='utf-8-sig')
    tmp.replace(path)
    return True


def main():
    raw = json.loads(RAW_PATH.read_text(encoding='utf-8'))
    pub = json.loads(PUBLIC_PATH.read_text(encoding='utf-8'))
    raw, pub, rows, stats = transform(raw, pub)
    print('--- LivePocket v9 result ---')
    for k, v in stats.items():
        print(f'{k}: {v}')
    print(f'raw_updated: {write_json(RAW_PATH, raw)}')
    print(f'public_updated: {write_json(PUBLIC_PATH, pub)}')
    print(f'queue_updated: {write_csv(QUEUE_PATH, rows)}')


if __name__ == '__main__':
    main()
