#!/usr/bin/env python3
"""LivePocket v21: map-catalog-assisted Pokémon classification & store-aware review.

Reads existing map catalog CSVs; no API, no new event fetch. v20 remains
responsible for browsing, deadlines, all stores, new-arrival prioritization.
The catalog is a classifier, NEVER a source of invented ticket product names.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v16 as v16
import livepocket_v19 as v19
import livepocket_v20 as v20

RAW_PATH = v14.RAW_PATH
PUBLIC_PATH = v14.PUBLIC_PATH
PACK_PATH = Path(os.environ.get('POKEMON_PACKS_FILE', 'pokemon_packs.csv'))
DECK_PATH = Path(os.environ.get('POKEMON_DECKS_FILE', 'pokemon_decks.csv'))
REPORT_COLUMNS = v20.REPORT_COLUMNS + (
    'map_catalog_match', 'map_catalog_type', 'map_catalog_evidence',
    'store_info_complete',
)

# Actual repository CSV content is not shipped with this patch. The loader
# accepts standard Japanese/English title headers, but validates rather than
# guessing a column when it cannot find a recognized header.
NAME_HEADERS = frozenset({
    '商品名', '名称', '品名', 'パック名', 'デッキ名', 'タイトル', '商品名称',
    '商品', '商品タイトル', '表示名', '商品名表示用',
    'name', 'productname', 'packname', 'deckname', 'title', 'product',
    'displayname', 'itemname', 'nameja', 'namejp',
})
OTHER_GENRES = re.compile(r'ONE\s*PIECE|ワンピース|遊戯王|YU[\s-]?GI[\s-]?OH|YUGIOH', re.I)
GENERIC_PRODUCT = re.compile(
    r'(?:ポケモンカードゲーム|ポケモンカード|ポケカ|POK[EÉ]MON\s*CARD\s*GAME|'
    r'ポケットモンスター|強化拡張パック|拡張パック|ハイクラスパック|'
    r'プレミアムデッキセット|デッキセット|構築済みデッキ|構築デッキ|'
    r'スターターデッキ|スタートデッキ|デッキ|BOX|ボックス|パック|'
    r'セット|抽選販売|抽選受付|予約受付|再販分|再入荷分|再入荷|'
    r'販売予約|販売会|販売|予約|受付|MEGA)(?![A-Za-z])', re.I)
ONLY_GENERIC = frozenset({
    'pokemon', 'pokemontcg', 'mega', 'box', 'パック', 'ポケモンカード',
    'プレミアム', '商品', 'カード', 'カードゲーム', '応募', '抽選',
})


def name_key(value):
    """Normalize NFKC (width), spelling separators and generic product form."""
    if not isinstance(value, str):
        return ''
    v = unicodedata.normalize('NFKC', value).casefold()
    # Japanese katakana/English product names survive while wrapper words do not.
    v = GENERIC_PRODUCT.sub('', v)
    v = re.sub(r'[\s\u3000・･&＆/／\\|:：;；、。，．!！?？()（）\[\]【】「」『』"\'\-_+＋~〜～=]', '', v)
    return v


def usable_key(key):
    if not key or key in ONLY_GENERIC or '…' in key or '...' in key:
        return False
    # Reject short numbers and ambiguous abbreviations, e.g. "151", "ex".
    letters = sum(ch.isalpha() for ch in key)
    return len(key) >= 5 and letters >= 3


def _headers(text):
    return re.sub(r'[\s\-_]+', '', unicodedata.normalize('NFKC', text or '').strip()).casefold()


def read_catalog(path, kind):
    if not path.is_file():
        raise FileNotFoundError(f'発見マップの商品マスタが見つかりません: {path}')
    try:
        source = path.read_text(encoding='utf-8-sig')
    except UnicodeDecodeError:
        source = path.read_text(encoding='cp932')
    if not source.strip():
        raise ValueError(f'商品マスタが空です: {path}')
    reader = csv.DictReader(io.StringIO(source))
    if not reader.fieldnames:
        raise ValueError(f'商品マスタのヘッダーがありません: {path}')
    header = next((h for h in reader.fieldnames if _headers(h) in NAME_HEADERS), None)
    if not header:
        raise ValueError(f'商品名列を検出できません: {path.name} / ヘッダー: {reader.fieldnames}。商品名列の情報を教えてください。')
    names = {}
    for row in reader:
        label = (row.get(header) or '').strip()
        if not label or label.startswith(('#', '//')) or len(label) > 180:
            continue
        key = name_key(label)
        if usable_key(key):
            names.setdefault(key, {'name': label, 'kind': kind})
    return names


def load_catalog(pack_path=PACK_PATH, deck_path=DECK_PATH):
    packs = read_catalog(pack_path, 'pack')
    decks = read_catalog(deck_path, 'deck')
    # Duplicate labels across different CSVs are still valid; they are
    # one product identity with potentially two catalog memberships.
    result = {}
    for key, entry in list(packs.items()) + list(decks.items()):
        if key not in result:
            result[key] = entry.copy()
        elif result[key]['kind'] != entry['kind']:
            result[key]['kind'] = 'pack/deck'
    if not result:
        raise ValueError('発見マップの商品マスタから照合可能な商品名を取得できません')
    return result


def candidate_product(item, catalog):
    """Match a real catalog name as a substring of an event's own name/title.

    A short, generic or truncated string cannot match. If several unrelated
    names are found, classification remains unknown rather than guessing.
    """
    if not isinstance(item, dict):
        return None
    for field in ('product_name', 'event_title'):
        text = item.get(field) or ''
        if not isinstance(text, str) or OTHER_GENRES.search(text):
            continue
        key = name_key(text)
        if not usable_key(key):
            continue
        candidates = [(len(canonical), canonical, meta) for canonical, meta in catalog.items()
                      if canonical in key or (key in canonical and len(key) >= 7)]
        if not candidates:
            continue
        maxlen = max(x[0] for x in candidates)
        # A shorter known model may be a substring of the longer product.
        best = [(key2, meta) for size, key2, meta in candidates if size == maxlen]
        if len(best) == 1:
            matched_key, meta = best[0]
            # Reject partial evidence which might refer to any of several
            # different products sharing a short prefix (e.g. "エーフィ").
            if matched_key not in key:
                competing = [c for c in catalog if key in c]
                if len(competing) != 1:
                    continue
            return {**meta, 'evidence': field}
    return None


def stores_known(item):
    stores = item.get('stores') if isinstance(item, dict) else None
    return isinstance(stores, list) and bool(stores) and all(
        isinstance(s, dict) and v19.safe_name(s.get('name')) for s in stores)


def missing_details_v21(item):
    missing = v16_original_missing(item)
    if stores_known(item):
        return [key for key in missing if key != 'store_name']
    return missing


v16_original_missing = v16.missing_details


@contextmanager
def use_store_aware_missing():
    # v16 retry and v18 history selection both use this function at runtime.
    # Patch only inside one synchronous plan/process call; restore after.
    original = v16.missing_details
    v16.missing_details = missing_details_v21
    try:
        yield
    finally:
        v16.missing_details = original


def classify(raw, public, catalog):
    ri, pi = v11.indices(raw, public)
    stats = {'map_catalog_entries': len(catalog), 'map_matches': 0,
             'map_new_pokemon_hints': 0, 'map_conflicts_skipped': 0}
    for url, item in pi.items():
        # v10 may mark a different category from source_preview. Never
        # reclassify an event containing explicit other-TCG evidence.
        explicit = ' '.join(str(item.get(k) or '') for k in
                            ('product_name', 'event_title'))
        if OTHER_GENRES.search(explicit):
            matched = None
            stats['map_conflicts_skipped'] += 1
        else:
            matched = candidate_product(item, catalog)
            if matched and item.get('review_category') in ('onepiece', 'yugioh'):
                # Source-preview classifications can be stale/mixed; be safe.
                stats['map_conflicts_skipped'] += 1
                matched = None
        if matched:
            was_pokemon = item.get('review_category') == 'pokemon'
            item['review_category'] = 'pokemon'
            item['pokemon_map_match'] = matched['name']
            item['pokemon_map_type'] = matched['kind']
            item['pokemon_map_evidence'] = matched['evidence']
            stats['map_matches'] += 1
            if not was_pokemon:
                stats['map_new_pokemon_hints'] += 1
        else:
            # Keep legacy category results, but never retain outdated matches
            # when map CSV content changes.
            for k in ('pokemon_map_match', 'pokemon_map_type', 'pokemon_map_evidence'):
                item.pop(k, None)
    return stats


def process(raw, public, fetch, *, catalog, now=None, new_limit=15,
            background_limit=0, retry_limit=3, verified=None, v19_verified=None):
    before = {item['url']: json.dumps(item, ensure_ascii=False, sort_keys=True)
              for item in public.get('items', [])}
    with use_store_aware_missing():
        raw, public, review, deadlines, sources, content, stats = v20.process(
            raw, public, fetch, now=now, new_limit=new_limit,
            background_limit=background_limit, retry_limit=retry_limit,
            verified=verified, v19_verified=v19_verified)
    stats.update(classify(raw, public, catalog))
    _, pi = v11.indices(raw, public)
    for row in content:
        item = pi[row['url']]
        row['missing_details'] = ','.join(missing_details_v21(item))
        if stores_known(item):
            row['store_name'] = v10.csv_escape(item.get('store_name') or
                                              item['stores'][0]['name'])
        row['map_catalog_match'] = v10.csv_escape(item.get('pokemon_map_match') or '')
        row['map_catalog_type'] = item.get('pokemon_map_type') or ''
        row['map_catalog_evidence'] = item.get('pokemon_map_evidence') or ''
        row['store_info_complete'] = 'yes' if stores_known(item) or item.get('store_name') else 'no'
    # Reconciliation of the legacy review queue happens in v19.enrich_reports.
    for row in review:
        item = pi[row['url']]
        if stores_known(item):
            row['needs_store'] = ''
            reasons = set(filter(None, (row.get('review_reason') or '').split(';')))
            reasons.discard('store_unknown')
            row['review_reason'] = ';'.join(sorted(reasons))
        if item.get('pokemon_map_match'):
            row['review_category'] = 'pokemon'
    review[:] = [r for r in review if r.get('needs_store') or r.get('needs_product')]
    public['schema_version'] = 21
    stats['review_remaining'] = len(review)
    if any(before.get(i['url']) != json.dumps(i, ensure_ascii=False, sort_keys=True)
           for i in public['items']):
        stamp = (now or datetime.now(timezone.utc))
        public['updated_at'] = stamp.isoformat()
    return raw, public, review, deadlines, sources, content, stats


def write_content(path, rows):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=REPORT_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, output.getvalue(), 'utf-8-sig')


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ('plan', 'process'):
        raise SystemExit('Usage: python scripts/livepocket_v21.py plan|process')
    catalog = load_catalog()
    raw, public = v14.read_pair()
    known = {item['url'] for item in raw['items']}
    verified = v20.read_verified(v20.MANUAL_PATH, known)
    v19_verified = v19.read_manual(v19.MANUAL_PATH, known)
    new_limit = v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25)
    background_limit = (v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                        if v14.wants_background() else 0)
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    with use_store_aware_missing():
        work = v19.v18.plan(raw, public, new_limit=new_limit,
                           background_limit=background_limit, retry_limit=retry_limit)
    if sys.argv[1] == 'plan':
        print('v21 browser plan:', work, 'map catalog products:', len(catalog))
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as fh:
                fh.write('browser_needed=' + ('true' if work['browser_needed'] else 'false') + '\n')
        return
    ready = os.getenv('LIVEPOCKET_V21_BROWSER_READY', '')
    if ready == 'false':
        new_limit = background_limit = retry_limit = 0
        needed = False
    else:
        needed = ready == 'true' or work['browser_needed']
    if needed:
        fetch, close = v20.browser_fetcher()
    else:
        def fetch(_url):
            raise AssertionError('Unexpected browser fetch')
        close = lambda: None
    try:
        data = process(raw, public, fetch, catalog=catalog,
                       new_limit=new_limit, background_limit=background_limit,
                       retry_limit=retry_limit, verified=verified,
                       v19_verified=v19_verified)
    finally:
        close()
    raw, public, review, deadlines, sources, content, stats = data
    for k, value in stats.items():
        print(f'{k}: {value}')
    print('raw_updated:', v11.write_json(RAW_PATH, raw))
    print('public_updated:', v11.write_json(PUBLIC_PATH, public))
    print('review_updated:', v10.write_csv(v20.v15.REVIEW_PATH, review))
    print('deadline_review_updated:', v11.write_csv(v14.REVIEW_PATH, deadlines))
    print('deadline_sources_updated:', v12.write_report(v14.SOURCES_PATH, sources))
    print('content_checks_updated:', write_content(v14.CHECKS_PATH, content))


if __name__ == '__main__':
    main()
