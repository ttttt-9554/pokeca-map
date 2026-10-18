#!/usr/bin/env python3
"""LivePocket v21.9: conservative official-page title/product priority + classifier.

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


def candidate_product(item, catalog, *, allow_short_suffix=False):
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
        # URL-adjacent Discord evidence can support a distinctive *suffix*
        # of exactly one registered product. Keep the observed product text;
        # this is a classification hint, not a name substitution.
        if (allow_short_suffix and field == 'product_name'
                and len(key) >= 6 and sum(c.isalpha() for c in key) >= 3):
            suffix = [(canonical, meta) for canonical, meta in catalog.items()
                      if canonical.endswith(key)]
            if len(suffix) == 1:
                return {**suffix[0][1], 'evidence': 'discord_url_pair_unique_suffix'}
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
            src = ri.get(url, {}).get('field_sources') or {}
            paired = str(src.get('product_name') or '').startswith('discord_url_pair:')
            matched = candidate_product(item, catalog, allow_short_suffix=paired)
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
    stats['official_genres_restored'] = restore_official_genres(raw, public)
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
# v21.3 stopped all URLs forever after the first extra check. Instead, use
# a capped backoff tied to that event's last attempt. Legacy v21.3 state
# (attempts, checked_at, status) is reused without migration or data resets.
TITLE_RECHECK_MAX = 4
TITLE_RECHECK_DEFAULT_PER_RUN = 2
TITLE_RECHECK_DELAYS_HOURS = (6, 12, 24)  # after attempt 1, 2 and 3
REPORT_COLUMNS = REPORT_COLUMNS + (
    'title_recheck_attempts', 'title_recheck_at', 'title_recheck_status',
    'title_recheck_reason', 'title_recheck_next_at', 'title_recheck_http_status',
)


def recheck_attempts(entry):
    try:
        return max(0, min(999, int(entry.get('attempts', 0))))
    except (TypeError, ValueError, AttributeError):
        return 0


def retry_wait(attempt_count):
    """Duration AFTER the last retry; attempts >= max have no next attempt."""
    if attempt_count >= TITLE_RECHECK_MAX:
        return None
    return timedelta(hours=TITLE_RECHECK_DELAYS_HOURS[
        min(max(attempt_count, 1) - 1, len(TITLE_RECHECK_DELAYS_HOURS) - 1)
    ])


def retry_ready(record, *, now, checked=None):
    """Honor past v21.3 timestamps; don't refetch the same URL every run."""
    attempts = recheck_attempts(record)
    if attempts >= TITLE_RECHECK_MAX:
        return False
    if attempts == 0:
        return True
    last = v19.v18.v17.check_time(record.get('checked_at'))
    if not last:
        # v21.3 persisted a timestamp; an incomplete old state must not cause
        # immediate rapid loops. Use the v13 browser check as conservative base.
        last = checked
    return bool(last and now >= last + retry_wait(attempts))


def retry_next_at(record, *, end, now, checked=None):
    """Next retry time if in the original event-window and budget."""
    count = recheck_attempts(record)
    if not count or count >= TITLE_RECHECK_MAX:
        return ''
    last = v19.v18.v17.check_time(record.get('checked_at')) or checked
    if not last:
        return ''
    due = last + retry_wait(count)
    # A recheck cannot happen once the application has been closed for 12h.
    if end and due >= end + timedelta(hours=TITLE_END_GRACE_HOURS):
        return ''
    if end and due > now + timedelta(days=7):
        return ''
    return due.astimezone(timezone.utc).isoformat()


def describe_result(page, url, title, product):
    """Short diagnostic codes, never log untrusted page text or private data."""
    status = str(page.get('status') or 'browser_error')
    http = page.get('http_status')
    if status == 'ok':
        if v12.exact_event_url(page.get('final_url')) != url:
            return 'browser_redirected', 'not_original_event_url', ''
        if title:
            return ('title_and_product_found' if product else 'title_found',
                    'official_title_verified', '')
        if product:
            return 'product_only', 'official_product_but_no_title', ''
        return 'ok_no_title', 'no_verifiable_title_on_page', ''
    reasons = {
        'browser_timeout': 'request_timeout',
        'browser_no_response': 'no_http_response',
        'browser_blocked': 'access_limited',
        'browser_blocked_or_empty': 'limited_or_empty_page',
        'browser_redirected': 'not_original_event_url',
        'browser_http_error': 'http_error',
        'browser_error': 'browser_or_network_error',
    }
    try:
        http = str(int(http)) if http is not None else ''
    except (TypeError, ValueError):
        http = ''
    return status, reasons.get(status, 'unrecognized_fetch_status'), http


def title_recheck_candidates(raw, public, *, now=None, limit=TITLE_RECHECK_DEFAULT_PER_RUN):
    """Small bounded retries of incomplete, currently relevant event titles.

    New arrivals remain v20's priority. The original browser check must have
    been >= 6h ago; after any title recheck apply the bounded backoff.
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
        when = v19.v18.v17.check_time(check.get('checked_at'))
        if not when or now - when < timedelta(hours=TITLE_RECHECK_HOURS):
            continue
        if check.get('status') == 'browser_redirected':
            continue
        if not retry_ready(attempts.get(url, {}), now=now, checked=when):
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
    # Only in background/manual cycles; 5-minute new-only runs add NO extra
    # official-page requests. Queue is selected before upstream processing.
    official_queue = official_title_candidates(raw, public, now=now) if background_limit else []
    seen = set()
    observations = {}

    def record(url):
        seen.add(url)
        result = fetch(url)
        if isinstance(result, dict):
            observations[url] = result
        return result

    raw, public, review, deadlines, sources, content, stats = process_v21_1(
        raw, public, record, catalog=catalog, now=now,
        new_limit=new_limit, background_limit=background_limit,
        retry_limit=retry_limit, verified=verified, v19_verified=v19_verified)
    ri, pi = v11.indices(raw, public)
    state = raw.setdefault('collector_state', {})
    log = state.setdefault('v21_3', {}).setdefault('title_rechecks', {})
    stats.update(title_recheck_planned=len(queued), title_recheck_attempted=0,
                 title_recheck_retried=0, title_recheck_titles_added=0,
                 title_recheck_products_added=0, title_recheck_blocked=0,
                 title_recheck_ok_no_title=0, title_recheck_fetch_errors=0)
    for url in queued:
        if url in seen or v14._cooldown_active(state.setdefault('v14', {}), now):
            continue
        if pi[url].get('event_title'):
            continue
        try:
            result = record(url)
        except Exception:
            result = {'status': 'browser_error'}
        if not isinstance(result, dict):
            result = {'status': 'browser_error'}
        title, title_source = verified_title(result, url)
        product, product_source = verified_product(result, url)
        status, reason, http_status = describe_result(result, url, title, product)
        previous = log.get(url, {})
        previous_attempts = recheck_attempts(previous)
        log[url] = {'attempts': previous_attempts + 1,
                    'checked_at': now.isoformat(), 'status': status,
                    'reason': reason, 'http_status': http_status}
        stats['title_recheck_attempted'] += 1
        if previous_attempts:
            stats['title_recheck_retried'] += 1
        if status == 'ok_no_title':
            stats['title_recheck_ok_no_title'] += 1
        if status not in ('ok_no_title', 'title_found', 'title_and_product_found', 'product_only'):
            stats['title_recheck_fetch_errors'] += 1
        if status in ('title_found', 'title_and_product_found') and title:
            if not (ri[url].get('event_title') or pi[url].get('event_title')):
                for item in (ri[url], pi[url]):
                    item['event_title'] = title
                ri[url].setdefault('field_sources', {})['event_title'] = title_source
                stats['title_recheck_titles_added'] += 1
        if status in ('title_and_product_found', 'title_found', 'product_only') and product:
            if not (ri[url].get('product_name') or pi[url].get('product_name')):
                for item in (ri[url], pi[url]):
                    item['product_name'] = product
                ri[url].setdefault('field_sources', {})['product_name'] = product_source
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

    # Official-title checks follow upstream new/retry/background work.
    stats.update(official_title_planned=len(official_queue),
                 official_title_attempted=0, official_titles_upgraded=0,
                 official_products_added=0, official_genres_confirmed=0,
                 official_title_conflicts=0, official_fetch_blocked=0)
    official_state = state.setdefault('v21_9', {}).setdefault('official_checks', {})
    for url in official_queue:
        if url in seen or v14._cooldown_active(state.setdefault('v14', {}), now):
            continue
        try:
            page_result = record(url)
        except Exception:
            page_result = {'status':'browser_error'}
            observations[url] = page_result
        status = str(page_result.get('status') or 'browser_error')
        entry = official_state.get(url, {})
        official_state[url] = {
            'attempts': recheck_attempts(entry) + 1,
            'checked_at': now.isoformat(), 'status': status,
            'http_status': page_result.get('http_status') or '',
        }
        stats['official_title_attempted'] += 1
        if status in ('browser_blocked', 'browser_blocked_or_empty'):
            state.setdefault('v14', {})['blocked_until'] = (
                now + timedelta(hours=v14.BLOCK_DELAY_HOURS)).isoformat()
            stats['official_fetch_blocked'] += 1
            break

    # Apply exact-URL official facts from this run's already-fetched pages.
    # v10/v20 may have set an old category based on Discord excerpts. The
    # official genre deliberately wins only when explicitly present in title.
    for url, page_result in observations.items():
        if url not in ri:
            continue
        outcome = apply_official_observation(ri[url], pi[url], page_result)
        if outcome['title_changed']:
            stats['official_titles_upgraded'] += 1
        if outcome['product_changed']:
            stats['official_products_added'] += 1
        if outcome['genre']:
            stats['official_genres_confirmed'] += 1
        if outcome['conflict']:
            stats['official_title_conflicts'] += 1
        record_state = official_state.setdefault(url, {})
        record_state.update(status=page_result.get('status') or 'browser_error',
                            checked_at=now.isoformat(),
                            title_observed=outcome['title'],
                            genre=outcome['genre'],
                            product_origin=ri[url].get('field_sources', {}).get('product_name', ''),
                            title_origin=ri[url].get('field_sources', {}).get('event_title', ''),
                            conflict=bool(outcome['conflict']))

    stats['official_genres_restored'] += restore_official_genres(raw, public)
    for row in review:
        pub = pi[row['url']]
        cat = pub.get('review_category') or ''
        row['review_category'] = cat
        if pub.get('event_title') or pub.get('product_name'):
            row['needs_product'] = ''
            row['review_reason'] = ';'.join(
                term for term in (row.get('review_reason') or '').split(';')
                if term != 'product_or_event_unknown')
    review[:] = [row for row in review if row.get('needs_store') or row.get('needs_product')]
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
        observed = official_state.get(row['url'], {})
        row['official_page_status'] = observed.get('status', '')
        row['official_title_observed'] = v12._safe_csv(observed.get('title_observed') or '')
        row['official_genre'] = observed.get('genre', '')
        row['official_title_source'] = observed.get('title_origin', '')
        row['official_product_source'] = observed.get('product_origin', '')
        row['official_page_checked_at'] = observed.get('checked_at', '')
        row['official_title_conflict'] = 'yes' if observed.get('conflict') else ''
        retry = log.get(row['url'], {})
        row['title_recheck_attempts'] = recheck_attempts(retry)
        row['title_recheck_at'] = retry.get('checked_at', '')
        row['title_recheck_status'] = retry.get('status', '')
        row['title_recheck_reason'] = retry.get('reason', '')
        row['title_recheck_http_status'] = retry.get('http_status', '')
        browser_check = state.get('v13', {}).get('browser_checks', {}).get(row['url'], {})
        checked = v19.v18.v17.check_time(browser_check.get('checked_at'))
        row['title_recheck_next_at'] = ('' if pub.get('event_title') else
            retry_next_at(retry, end=v11.parse_datetime(pub.get('application_end_at')),
                          now=now, checked=checked))

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
                return {'status': 'browser_blocked', 'http_status': response.status}
            if response.status >= 400:
                return {'status': 'browser_http_error', 'http_status': response.status}
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




# v21.9: An OFFICIAL title is stronger than a URL-paired Discord shorthand.
# Browser access stays on the exact original LivePocket event URL; CAPTCHA,
# login, robot checks and redirected pages are never bypassed.
OFFICIAL_TITLE_CHECK_PER_RUN = 2
OFFICIAL_TITLE_RETRY_MAX = 3
OFFICIAL_TITLE_CHECK_WAIT = timedelta(hours=6)
OFFICIAL_TITLE_GRACE = timedelta(hours=12)
OFFICIAL_GENRE_PATTERNS = {
    'onepiece': re.compile(r'ONE\s*PIECE\s*(?:カードゲーム|CARD\s*GAME)|ワンピース\s*カード', re.I),
    'pokemon': re.compile(r'ポケモンカード(?:ゲーム)?|ポケカ|POK[EÉ]MON\s*(?:TCG|CARD)', re.I),
    'yugioh': re.compile(r'遊戯王|YU[\s-]?GI[\s-]?OH', re.I),
}
OFFICIAL_COLUMNS = (
    'official_page_status', 'official_title_observed', 'official_genre',
    'official_title_source', 'official_product_source', 'official_page_checked_at',
    'official_title_conflict',
)
REPORT_COLUMNS = REPORT_COLUMNS + OFFICIAL_COLUMNS


def official_genre(title):
    """Explicit TCG named IN the exact-URL official event title only."""
    if not isinstance(title, str) or not title:
        return ''
    genres = [genre for genre, rx in OFFICIAL_GENRE_PATTERNS.items() if rx.search(title)]
    return genres[0] if len(genres) == 1 else ''


def official_quoted_product(title):
    """Use a product explicitly quoted after an identifiable TCG brand.

    This never treats a generic event name / timetable as a product. A
    ONE PIECE branded official event '...「EXブースター ...」抽選販売受付'
    can specify a distinct product; a plain 'Heroines Edition' cannot.
    """
    genre = official_genre(title)
    if not genre:
        return None
    # Only a single bracketed / quoted product name is unambiguous.
    chunks = re.findall(r'『([^』]{6,110})』|「([^」]{6,110})」', title)
    if len(chunks) != 1:
        return None
    value = next(part for part in chunks[0] if part).strip()
    if re.search(r'(?:\.\.\.|…|https?://|整理券|参加条件|購入方法|応募期間)', value, re.I):
        return None
    if not re.search(r'ブースター|拡張パック|強化拡張|スターター|デッキ|\bEB[-－]?\d{2}\b|\bBOX\b', value, re.I):
        return None
    return v20.v15.clean_value(value, 'product_name')


def title_is_provisional(raw_item):
    source = str((raw_item.get('field_sources') or {}).get('event_title') or '')
    return source.startswith(('discord_url_title:', 'discord_url_pair:', 'discord_embed:'))


def product_is_provisional(raw_item):
    source = str((raw_item.get('field_sources') or {}).get('product_name') or '')
    return source.startswith(('discord_url_pair:', 'discord_embed:'))



def restore_official_genres(raw, public):
    """Keep an exact-URL official TCG category on later browser-free runs.

    Upstream v10 recomputes categories using source_preview (often the text
    of a multi-event Discord roundup). It must not undo a verified title.
    """
    raw_index, pub_index = v11.indices(raw, public)
    changed = 0
    for url, pub in pub_index.items():
        source = str(raw_index[url].get('field_sources', {}).get('event_title') or '')
        title = pub.get('official_event_title') or ''
        if source != 'v21_9_official_exact_url_title' or title != pub.get('event_title'):
            continue
        genre = official_genre(title)
        if not genre:
            continue
        if pub.get('review_category') != genre:
            changed += 1
        pub['review_category'] = genre
        pub['official_genre'] = genre
        if genre != 'pokemon':
            for key in ('pokemon_map_match', 'pokemon_map_type', 'pokemon_map_evidence'):
                pub.pop(key, None)
    return changed

def official_title_candidates(raw, public, *, now=None, limit=OFFICIAL_TITLE_CHECK_PER_RUN):
    """Retry only time-relevant events with provisional Discord titles.

    Never queue older events on the 5-minute new-only run; the caller runs
    these ONLY in the manual or twice-daily background window.  Respect
    v13 checks and v21.9 cooldown to avoid hitting the same page repeatedly.
    """
    now = v14._utc(now)
    if limit < 1:
        return []
    rindex, pindex = v11.indices(raw, public)
    state = raw.get('collector_state', {})
    if v14._cooldown_active(state.get('v14', {}), now):
        return []
    pending = set(state.get('v14', {}).get('pending_new_urls', []))
    checks = state.get('v13', {}).get('browser_checks', {})
    prior = state.get('v21_9', {}).get('official_checks', {})
    options = []
    for url, ritem in rindex.items():
        pub = pindex[url]
        if url in pending or not pub.get('event_title') or not title_is_provisional(ritem):
            continue
        deadline = v11.parse_datetime(pub.get('application_end_at'))
        if not deadline or not (now - OFFICIAL_TITLE_GRACE < deadline < now + timedelta(days=7)):
            continue
        record = prior.get(url, {})
        if recheck_attempts(record) >= OFFICIAL_TITLE_RETRY_MAX:
            continue
        last = (v19.v18.v17.check_time(record.get('checked_at')) or
                v19.v18.v17.check_time(checks.get(url, {}).get('checked_at')))
        if last and now - last < OFFICIAL_TITLE_CHECK_WAIT:
            continue
        options.append((deadline, url))
    options.sort()
    return [u for _,u in options[:limit]]


def apply_official_observation(raw_item, pub_item, page):
    """Reconcile facts from ONE successfully fetched official event page.

    Never overwrite verified/manual event data, only short Discord fields.
    Event genre is authoritative only when explicit in official title.
    """
    url = raw_item['url']
    title, _ = verified_title(page, url)
    if not title:
        return {'title': '', 'product': '', 'genre': '', 'title_changed': False,
                'product_changed': False, 'conflict': False}
    genre = official_genre(title)
    product, product_source = verified_product(page, url)
    if not product:
        product = official_quoted_product(title)
        product_source = 'v21_9_official_title_quoted_tcg_product' if product else ''
    title_changed = product_changed = conflict = False
    old_title = raw_item.get('event_title') or pub_item.get('event_title') or ''
    if not old_title or title_is_provisional(raw_item):
        if old_title != title:
            for obj in (raw_item, pub_item):
                obj['event_title'] = title
            title_changed = True
        # Even when a short Discord text happens to equal the verified
        # official title, upgrade its provenance so category stays stable.
        raw_item.setdefault('field_sources', {})['event_title'] = 'v21_9_official_exact_url_title'
    elif old_title != title:
        conflict = True
    old_product = raw_item.get('product_name') or pub_item.get('product_name') or ''
    if product and (not old_product or product_is_provisional(raw_item)):
        if old_product != product:
            for obj in (raw_item, pub_item):
                obj['product_name'] = product
            product_changed = True
        raw_item.setdefault('field_sources', {})['product_name'] = product_source
    elif product and old_product != product:
        conflict = True
    if genre:
        # Source-preview text may describe another product in the same multi-
        # URL Discord post. Ignore it ONLY after an exact official title.
        pub_item['review_category'] = genre
        pub_item['official_genre'] = genre
        if genre != 'pokemon':
            for key in ('pokemon_map_match','pokemon_map_type','pokemon_map_evidence'):
                pub_item.pop(key, None)
    pub_item['official_event_title'] = title
    return {'title': title, 'product': product or '', 'genre': genre,
            'title_changed': title_changed, 'product_changed': product_changed,
            'conflict': conflict}


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
    official_due = (official_title_candidates(raw, public) if background_limit else [])
    browser_needed = bool(work['browser_needed'] or titles_due or official_due)
    if sys.argv[1] == 'plan':
        print('v21.9 browser plan:', work, 'title_due:', len(titles_due),
              'official_due:', len(official_due), 'map catalog products:', len(catalog))
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
