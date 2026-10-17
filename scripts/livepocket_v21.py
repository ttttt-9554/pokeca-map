#!/usr/bin/env python3
"""LivePocket v21.3: safer title recovery + v21.1 catalog classifier.

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
    """Match map product names, prioritizing observed whole product names.

    1. A catalog key contained in a longer ticket product/title is the
       strongest evidence (exact/full match takes priority).
    2. Only if no full key is present, accept a sufficiently distinctive
       part of exactly ONE catalog product. This handles abbreviated names
       such as "エーフィ・ブラッキー" without mistaking
       "30th CELEBRATION" for the deck containing that pack title.
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

        # Direct matches are strongest. Prefer the exact key when possible.
        if key in catalog:
            return {**catalog[key], 'evidence': field}
        direct = [(len(canonical), canonical, meta)
                  for canonical, meta in catalog.items()
                  if canonical in key]
        if direct:
            longest = max(size for size, _, _ in direct)
            best = [(canon, meta) for size, canon, meta in direct
                    if size == longest]
            if len(best) == 1:
                return {**best[0][1], 'evidence': field}
            # Two equally strong names: the event's single product is unclear.
            continue

        # Reverse / abbreviated match is only safe when ONE map entry
        # contains this long-enough piece. Do not prefer a longer deck
        # over an exact pack match or guess between similar products.
        if len(key) >= 7:
            reverse = [(canonical, meta) for canonical, meta in catalog.items()
                       if key in canonical]
            if len(reverse) == 1:
                return {**reverse[0][1], 'evidence': field}
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


def process_v21_1(raw, public, fetch, *, catalog, now=None, new_limit=15,
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


# v21.3: Short, audited follow-up for already-checked, currently applicable
# events whose official event TITLE is still missing.  The page is visited
# using the ordinary v20 browser only; no CAPTCHA bypass, search API, login,
# or unrelated event URL is ever used.
from datetime import timedelta

TITLE_RECHECK_HOURS = 6
TITLE_END_GRACE_HOURS = 12
TITLE_RECHECK_MAX = 1
TITLE_RECHECK_DEFAULT_PER_RUN = 2
REPORT_COLUMNS = REPORT_COLUMNS + (
    'title_recheck_attempts', 'title_recheck_at', 'title_recheck_status',
)


def title_recheck_candidates(raw, public, *, now=None, limit=TITLE_RECHECK_DEFAULT_PER_RUN):
    """Recheck recently checked, active/recently-ended URLs; new arrivals first.

    Never recheck stale expired pages, missing-date pages, the first-check queue,
    redirect failures or blocked cooldown. One extra attempt at most.
    """
    if limit <= 0:
        return []
    now = v14._utc(now)
    state = raw.get('collector_state', {})
    v14state = state.get('v14', {})
    if v14._cooldown_active(v14state, now):
        return []
    pending = set(v14state.get('pending_new_urls', []))
    raw_index, pub_index = v11.indices(raw, public)
    checks = state.get('v13', {}).get('browser_checks', {})
    attempts = state.get('v21_3', {}).get('title_rechecks', {})
    options = []
    for url, pub in pub_index.items():
        if url in pending or pub.get('event_title') or raw_index[url].get('event_title'):
            continue
        end = v11.parse_datetime(pub.get('application_end_at'))
        start = v11.parse_datetime(pub.get('application_start_at'))
        if not end or not (now - timedelta(hours=TITLE_END_GRACE_HOURS) < end <= now + timedelta(days=7)):
            continue
        if start and now < start:
            continue
        check = checks.get(url, {})
        # v17 is reachable through v19.v18; its parser accepts microseconds.
        when = v19.v18.v17.check_time(check.get('checked_at'))
        if not when or now - when < timedelta(hours=TITLE_RECHECK_HOURS):
            continue
        if check.get('status') == 'browser_redirected':
            continue
        if int(attempts.get(url, {}).get('attempts', 0)) >= TITLE_RECHECK_MAX:
            continue
        options.append((end, -(when.timestamp()), url))
    options.sort()
    return [entry[2] for entry in options[:limit]]


def verified_title(page, url):
    """Only use titles from the exact LivePocket event on an accessible page."""
    if not isinstance(page, dict) or page.get('status') != 'ok':
        return None, ''
    if v12.exact_event_url(page.get('final_url')) != url:
        return None, ''
    value = v14.pick_title(page)
    if value:
        return value, 'v21_3_official_page_title'
    labelled = v20.v15.event_title(page)
    if labelled:
        value = v14.clean_title(labelled)
        if value:
            return value, 'v21_3_official_explicit_event_label'
    return None, ''


def verified_product(page, url):
    if not isinstance(page, dict) or page.get('status') != 'ok' or v12.exact_event_url(page.get('final_url')) != url:
        return None, ''
    # Product names from exact product labels / uniform multi-store tickets
    # ONLY; never infer product name from an event title, group name or catalog.
    text = page.get('text') or ''
    product = v14.extract_product(text) or v20.v15.single_label(text, 'product_name')
    if product:
        return product, 'v21_3_official_explicit_product_label'
    product = v20.uniform_ticket_product(text)
    if product:
        return product, 'v21_3_uniform_multi_store_tickets'
    return None, ''


def process(raw, public, fetch, *, catalog, now=None, new_limit=15,
            background_limit=0, retry_limit=3, verified=None, v19_verified=None,
            title_limit=TITLE_RECHECK_DEFAULT_PER_RUN):
    """v21.1 checks first, then bounded title-specific rechecks on older URLs."""
    now = v14._utc(now)
    snapshot = {item['url']: json.dumps(item, ensure_ascii=False, sort_keys=True)
                for item in public['items']}
    # Selection before the upstream pass prevents fresh discoveries from being
    # rechecked twice in the same job. An overlap with upstream is skipped.
    queued = title_recheck_candidates(raw, public, now=now, limit=title_limit)
    seen = set()

    def record(url):
        seen.add(url)
        return fetch(url)

    raw, public, review, deadlines, sources, content, stats = process_v21_1(
        raw, public, record, catalog=catalog, now=now,
        new_limit=new_limit, background_limit=background_limit,
        retry_limit=retry_limit, verified=verified, v19_verified=v19_verified)
    ri, pi = v11.indices(raw, public)
    state = raw.setdefault('collector_state', {})
    log = state.setdefault('v21_3', {}).setdefault('title_rechecks', {})
    stats.update(title_recheck_planned=len(queued), title_recheck_attempted=0,
                 title_recheck_titles_added=0, title_recheck_products_added=0,
                 title_recheck_blocked=0)
    for url in queued:
        if url in seen or v14._cooldown_active(state.setdefault('v14', {}), now):
            continue
        # An upstream pass may already have obtained the title.
        if pi[url].get('event_title'):
            continue
        try:
            result = fetch(url)
        except Exception:
            result = {'status': 'browser_error'}
        if not isinstance(result, dict):
            result = {'status': 'browser_error'}
        status = str(result.get('status') or 'browser_error')
        if status == 'ok' and v12.exact_event_url(result.get('final_url')) != url:
            status = 'browser_redirected'
        previous = log.get(url, {})
        log[url] = {'attempts': int(previous.get('attempts', 0)) + 1,
                    'checked_at': now.isoformat(), 'status': status}
        stats['title_recheck_attempted'] += 1
        if status == 'ok':
            title, source = verified_title(result, url)
            if title and not (ri[url].get('event_title') or pi[url].get('event_title')):
                for item in (ri[url], pi[url]):
                    item['event_title'] = title
                ri[url].setdefault('field_sources', {})['event_title'] = source
                stats['title_recheck_titles_added'] += 1
            product, source = verified_product(result, url)
            if product and not (ri[url].get('product_name') or pi[url].get('product_name')):
                for item in (ri[url], pi[url]):
                    item['product_name'] = product
                ri[url].setdefault('field_sources', {})['product_name'] = source
                stats['title_recheck_products_added'] += 1
        if status in ('browser_blocked', 'browser_blocked_or_empty'):
            state['v14']['blocked_until'] = (now + timedelta(hours=v14.BLOCK_DELAY_HOURS)).isoformat()
            stats['title_recheck_blocked'] += 1
            break

    # A recovered event name is an event title, NOT automatically the product.
    # Re-evaluate category hints only after a successful page-specific result.
    if stats['title_recheck_titles_added'] or stats['title_recheck_products_added']:
        for item in public['items']:
            inferred = v10.category_of(item)
            if inferred != 'unknown' and item.get('review_category') not in ('onepiece', 'yugioh'):
                item['review_category'] = inferred
        # Reconcile the legacy queue and THEN apply map-specific category hints,
        # because v10.transform rebuilds review_category from basic rules.
        raw, public, new_review, _ = v10.transform(raw, public)
        updated = classify(raw, public, catalog)
        stats['map_matches'] = updated['map_matches']
        stats['map_new_pokemon_hints'] += updated['map_new_pokemon_hints']
        for row in new_review:
            item = pi[row['url']]
            if stores_known(item):
                row['needs_store'] = ''
                row['review_reason'] = ';'.join(
                    r for r in (row.get('review_reason') or '').split(';')
                    if r != 'store_unknown')
            if item.get('pokemon_map_match'):
                row['review_category'] = 'pokemon'
        review = [r for r in new_review if r.get('needs_store') or r.get('needs_product')]
        stats['review_remaining'] = len(review)

    for row in content:
        item, pub = ri[row['url']], pi[row['url']]
        row['event_title'] = v12._safe_csv(pub.get('event_title') or '')
        row['product_name'] = v12._safe_csv(pub.get('product_name') or '')
        row['title_source'] = item.get('field_sources', {}).get('event_title', '')
        row['product_source'] = item.get('field_sources', {}).get('product_name', '')
        row['product_origin'] = item.get('field_sources', {}).get('product_name', '')
        row['missing_details'] = ','.join(missing_details_v21(pub))
        row['map_catalog_match'] = v12._safe_csv(pub.get('pokemon_map_match') or '')
        row['map_catalog_type'] = pub.get('pokemon_map_type') or ''
        row['map_catalog_evidence'] = pub.get('pokemon_map_evidence') or ''
        retry = log.get(row['url'], {})
        row['title_recheck_attempts'] = retry.get('attempts', 0)
        row['title_recheck_at'] = retry.get('checked_at', '')
        row['title_recheck_status'] = retry.get('status', '')
    if any(snapshot.get(i['url']) != json.dumps(i, ensure_ascii=False, sort_keys=True)
           for i in public['items']):
        public['updated_at'] = now.isoformat()
    public['schema_version'] = 21
    return raw, public, review, deadlines, sources, content, stats


def browser_fetcher():
    """Preserve v20 same-URL browser behavior; also read structured event titles.

    No new endpoint, API, login, access-block evasion, or second request.
    """
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout
    except ImportError as exc:
        raise RuntimeError('Playwrightがインストールされていません') from exc
    manager = sync_playwright().start()
    try:
        browser = manager.chromium.launch(headless=True)
        context = browser.new_context(locale='ja-JP', timezone_id='Asia/Tokyo')
    except Exception:
        manager.stop()
        raise

    def fetch(url):
        page = context.new_page()
        try:
            try:
                response = page.goto(url, wait_until='domcontentloaded', timeout=18000)
            except BrowserTimeout:
                return {'status': 'browser_timeout'}
            if response is None:
                return {'status': 'browser_no_response'}
            if response.status in (401, 403, 429):
                return {'status': 'browser_blocked'}
            if response.status >= 400:
                return {'status': 'browser_http_error'}
            if v12.exact_event_url(page.url) != url:
                return {'status': 'browser_redirected'}
            body = ''
            for _ in range(3):
                try:
                    body = page.locator('body').inner_text(timeout=4000)
                except BrowserTimeout:
                    body = ''
                if len(body.strip()) > 80:
                    break
                page.wait_for_timeout(1500)
            if v14.v13.BLOCK_WORDS.search(body) or len(body.strip()) < 40:
                return {'status': 'browser_blocked_or_empty'}
            titles = []
            for selector in ('meta[property="og:title"]', 'meta[name="twitter:title"]'):
                try:
                    value = page.locator(selector).first.get_attribute('content', timeout=800)
                    if value:
                        titles.append(value)
                except Exception:
                    pass
            try:
                titles.extend(page.locator('h1').all_inner_texts(timeout=1200)[:3])
            except Exception:
                pass
            try:
                titles.append(page.title())
            except Exception:
                pass
            # Event-specific JSON-LD only (ignore unrelated product lists,
            # breadcrumbs, other event URLs and global Website metadata).
            try:
                blocks = page.locator('script[type="application/ld+json"]').all_text_contents(timeout=1300)
                titles.extend(structured_event_titles(blocks, url))
            except Exception:
                pass
            if '受付・チケット情報' in body and not v19.ticket_option_stores(body):
                try:
                    tab = page.get_by_text('受付・チケット情報', exact=True).first
                    tab.click(timeout=1500)
                    page.wait_for_timeout(350)
                    if v12.exact_event_url(page.url) != url:
                        return {'status': 'browser_redirected'}
                    additional = page.locator('body').inner_text(timeout=4000)
                    if v19.ticket_option_stores(additional) and additional != body:
                        body += '\n' + additional
                except Exception:
                    pass
            return {'status': 'ok', 'final_url': page.url,
                    'text': body[:30000], 'titles': titles[:12]}
        except BrowserTimeout:
            return {'status': 'browser_timeout'}
        except Exception:
            return {'status': 'browser_error'}
        finally:
            page.close()

    def close():
        try:
            context.close()
            browser.close()
        finally:
            manager.stop()
    return fetch, close


def structured_event_titles(blocks, url):
    """Only a unique Event name from JSON-LD on the EXACT event URL."""
    names = set()
    for source in blocks[:20]:
        if not isinstance(source, str) or len(source) > 200000:
            continue
        try:
            document = json.loads(source)
        except (ValueError, TypeError):
            continue
        stack = [(document, 0)]
        while stack:
            node, depth = stack.pop()
            if depth > 6:
                continue
            if isinstance(node, list):
                stack.extend((child, depth+1) for child in node[:40])
            elif isinstance(node, dict):
                kind = node.get('@type') or ''
                kinds = kind if isinstance(kind, list) else [kind]
                if any(isinstance(t,str) and t.casefold() == 'event' for t in kinds):
                    target = node.get('url')
                    if target and v12.exact_event_url(target) != url:
                        continue
                    value = v14.clean_title(node.get('name'))
                    if value:
                        names.add(value)
                for key in ('@graph','mainEntity','itemListElement'):
                    if key in node:
                        stack.append((node[key], depth+1))
    return list(names) if len(names) == 1 else []


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
    title_limit = v14.safe_limit('LIVEPOCKET_V21_3_TITLE_PER_RUN', 2, 3)
    titles_due = title_recheck_candidates(raw, public, limit=title_limit)
    browser_needed = bool(work['browser_needed'] or titles_due)
    if sys.argv[1] == 'plan':
        print('v21.3 browser plan:', work, 'title_due:', len(titles_due),
              'map catalog products:', len(catalog))
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as fh:
                fh.write('browser_needed=' + ('true' if browser_needed else 'false') + '\n')
        return
    ready = os.getenv('LIVEPOCKET_V21_BROWSER_READY', '')
    if ready == 'false':
        new_limit = background_limit = retry_limit = title_limit = 0
        needed = False
    else:
        needed = ready == 'true' or browser_needed
    if needed:
        fetch, close = browser_fetcher()
    else:
        def fetch(_url):
            raise AssertionError('Unexpected browser fetch')
        close = lambda: None
    try:
        data = process(raw, public, fetch, catalog=catalog,
                       new_limit=new_limit, background_limit=background_limit,
                       retry_limit=retry_limit, verified=verified,
                       v19_verified=v19_verified,
                       title_limit=title_limit)
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
