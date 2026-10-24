#!/usr/bin/env python3
"""LivePocket v7: conservative store-name repair and browser-facing JSON export.

This script does NOT request LivePocket or infer store names from bare URLs.
It recovers stores only from recognizable heading/product/URL blocks in the
Discord text already associated with a given event URL.

The exported JSON intentionally omits Discord message texts, IDs and
collector internals. Publishing a different JSON does NOT make the existing
raw file private when the repo/GitHub Pages source is public.
"""
from __future__ import annotations
import livepocket_arrival_policy as arrival_policy

import copy
import json
import os
import re
from pathlib import Path

DATA_PATH = Path(os.environ.get('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.environ.get('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
EVENT_URL = re.compile(r'^https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}$')
STORE_HINTS = re.compile(
    r'(?:店|SHOP|STORE|TSUTAYA|PAO|ホビーステーション|キデイランド|'
    r'竜星|トレカ|カードショップ|ふるいち|古本市場|ブックエース)', re.I
)
PRODUCT_HINTS = re.compile(
    r'30th\s*CELEBRATION|エーフィ|ブラッキー|ストームエメラルダ|'
    r'メガシンフォニア|プレミアムデッキセット|遊戯王\s*ART\s*WORK|'
    r'世界最強の戦士|Heroines\s*Edition', re.I
)
BAD_NAME = re.compile(r'(?:https?://|livepocket|[„�]|гАР|Ôľ|\.\.\.|…)', re.I)
# Explicit minimal browser-facing allowlist. Never export post_excerpt / Discord IDs.
PUBLIC_FIELDS = (
    'url', 'store_name', 'prefecture', 'product_name', 'event_title',
    'event_date', 'event_start_date', 'event_end_date', 'venue_name',
    'venue_address', 'opening_hours', 'registration_type',
    'application_period', 'application_start_at', 'application_end_at',
    'lottery_result_period', 'lottery_result_start_date',
    'lottery_result_end_date', 'ticket_name', 'ticket_price_yen',
    'ticket_application_limit', 'sales_period', 'discord_posted_at',
)


def is_shop(value):
    return (isinstance(value, str) and 2 <= len(value.strip()) <= 80
            and not arrival_policy.unknown_shop(value)
            and not BAD_NAME.search(value) and STORE_HINTS.search(value)
            and not PRODUCT_HINTS.search(value))


def is_product(value):
    return (isinstance(value, str) and 2 <= len(value.strip()) <= 110
            and not BAD_NAME.search(value) and bool(PRODUCT_HINTS.search(value)))


def source_entries(body):
    """Find direct URL->(store,product) links in two specific Discord layouts.

    Layout 1: standalone shop heading, then '・product', then event URL.
    Layout 2: '* shop' at indent 0, then '    * product', then event URL.
    Never use ambiguous line names (e.g. only '府中') as shops.
    """
    if not isinstance(body, str):
        return {}
    found = {}
    shop = None
    product = None
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(('■', '【', '🔗', '📢', '※', '📍')):
            shop = None
            product = None
            continue
        if EVENT_URL.fullmatch(line):
            if shop and product:
                found[line] = {'store_name': shop, 'product_name': product}
            product = None
            continue
        # Top-level Markdown list groups (v5 Kiddyland source).
        if raw.startswith('* ') and is_shop(line[2:].strip()):
            shop = line[2:].strip()
            product = None
            continue
        # Unindented store headings (v5 Oct 3 roundup).
        if not raw.startswith((' ', '\t', '・', '*')) and is_shop(line):
            shop = line
            product = None
            continue
        # A product heading must be directly followed by a URL to be applied.
        if re.match(r'^\s*(?:・|\*)\s*', raw):
            possible = re.sub(r'^\s*(?:・|\*)\s*', '', raw).strip()
            product = possible if shop and is_product(possible) else None
            continue
        # Break adjacency on unrecognized content, especially non-product bullets.
        product = None
    return found


def bogus_shop(item):
    shop = item.get('store_name')
    prod = item.get('product_name')
    if not isinstance(shop, str) or not shop.strip():
        return False
    if not isinstance(prod, str) or not prod.strip():
        return False
    def normalized(s):
        return re.sub(r'\s+', '', re.sub(r'^\s*\*\s*', '', s)).casefold()
    old = normalized(shop)
    name = normalized(prod)
    return old == name or old.startswith(name+'再販') or old.startswith(name+'3次抽選')


def enrich(data):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('items array is required')
    out = copy.deepcopy(data)
    posts = {}
    for item in out['items']:
        if not isinstance(item, dict):
            raise ValueError('Each item must be an object')
        post_id = str(item.get('discord_message_id') or '')
        text = item.get('post_excerpt')
        if post_id and isinstance(text, str) and (
            post_id not in posts or len(text) > len(posts[post_id])
        ):
            posts[post_id] = text
    candidates = {post_id: source_entries(text) for post_id, text in posts.items()}
    stats = {'total_urls': len(out['items']), 'bogus_stores_corrected': 0,
             'store_names_recovered': 0, 'products_recovered': 0}
    for item in out['items']:
        if bogus_shop(item):
            old = item['store_name']
            item.setdefault('store_name_original', old)
            item['store_name'] = None
            stats['bogus_stores_corrected'] += 1
        post_id = str(item.get('discord_message_id') or '')
        entry = candidates.get(post_id, {}).get(item.get('url'))
        if not entry:
            continue
        for field in ('store_name', 'product_name'):
            label = entry[field]
            if not item.get(field):
                item[field] = label
                item.setdefault('field_sources', {})[field] = 'discord_heading:' + post_id
                stats['store_names_recovered' if field == 'store_name' else 'products_recovered'] += 1
    # Keep derived counts aligned with the corrected meaning of store_name.
    out['field_counts'] = {
        **out.get('field_counts', {}),
        **{k: sum(bool(x.get(k)) for x in out['items'])
           for k in ('store_name', 'prefecture', 'product_name', 'event_title',
                     'application_period', 'sales_period')},
    }
    return out, stats


def public_export(data):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('items array is required')
    result = []
    seen = set()
    for item in data['items']:
        url = item.get('url')
        if not isinstance(url, str) or not EVENT_URL.fullmatch(url):
            continue
        if url in seen:
            raise ValueError(f'Duplicate URL in source: {url}')
        seen.add(url)
        record = {k: item[k] for k in PUBLIC_FIELDS if k in item and item[k] is not None}
        fields = item.get('field_sources') or {}
        if isinstance(fields, dict) and any(
            isinstance(v, str) and v.startswith('user_safari_screenshots') for v in fields.values()
        ):
            record['detail_provenance'] = 'screen_verified'
        result.append(record)
    return {'schema_version': 7, 'collected_at': data.get('collected_at'),
            'unique_livepocket_urls': len(result), 'items': result}


def write_if_different(path, data):
    payload = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if path.is_file() and path.read_text(encoding='utf-8') == payload:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(payload, encoding='utf-8')
    tmp.replace(path)
    return True


def main():
    source = json.loads(DATA_PATH.read_text(encoding='utf-8'))
    updated, stats = enrich(source)
    changed = write_if_different(DATA_PATH, updated)
    public = public_export(updated)
    public_changed = write_if_different(PUBLIC_PATH, public)
    for key, value in stats.items():
        print(f'{key}: {value}')
    print(f'raw_updated: {changed}, public_updated: {public_changed}')
    print(f'published_items: {len(public["items"])}')


if __name__ == '__main__':
    main()
