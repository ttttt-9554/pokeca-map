#!/usr/bin/env python3
"""LivePocket v21.21: safe diagnostic for unrecovered visible event headings.

Reads existing map catalog CSVs; no API, no new event fetch. v20 remains
responsible for browsing, deadlines, all stores, new-arrival prioritization.
The catalog is a classifier, NEVER a source of invented ticket product names.
"""
from __future__ import annotations

import csv
import io
import html
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
# Some LivePocket verification pages return HTTP 200 and a body longer than
# v13's 40-character threshold.  These are NOT usable event pages.  Do not
# bypass the verification; accurately classify it and preserve prior fields.
ROBOT_VERIFICATION = re.compile(
    r"(?:verify\s+that\s+you(?:'|’)?re\s+not\s+a\s+robot|"
    r"verify\s+that\s+you\s+are\s+not\s+a\s+robot|"
    r"javascript\s+is\s+disabled[\s\S]{0,250}(?:robot|reload\s+the\s+page)|"
    r"requires\s+javascript[\s\S]{0,120}reload\s+the\s+page|"
    r"(?:just\s+a\s+moment|checking\s+your\s+browser|attention\s+required)"
    r"[\s\S]{0,240}(?:cloudflare|security\s+check|verify|challenge)|"
    r"(?:cloudflare|security\s+challenge)[\s\S]{0,240}"
    r"(?:checking\s+your\s+browser|verify\s+(?:you|that)|captcha))",
    re.I,
)


def normalize_verification_page(page):
    """Downgrade HTTP 200 robot challenge to a blocked status, not a title.

    Works both for the v21.9.x browser and for upstream v20's shared result.
    Never stores the challenge text or attempts to defeat it.
    """
    if not isinstance(page, dict) or page.get('status') != 'ok':
        return page
    text = str(page.get('text') or '')
    titles = ' '.join(str(t) for t in (page.get('titles') or []) if isinstance(t, str))
    if ROBOT_VERIFICATION.search(text) or ROBOT_VERIFICATION.search(titles):
        return {'status': 'browser_blocked_or_empty',
                'gate_reason': 'robot_verification_page',
                'http_status': page.get('http_status') or ''}
    return page


# v21.16: challenge recognition never bypasses an access gate. A successful
# navigation is NOT evidence that a real event page was loaded. These conservative
# event-specific body markers identify some valid pages; other pages remain
# "unconfirmed" rather than being treated as verified event names.
EVENT_BODY_MARKERS = (
    '受付・チケット情報', 'チケット販売情報', 'チケット販売受付',
    'イベント詳細', 'イベント概要', '受付期間',
)
EVENT_TICKET_MARKERS = ('チケット', '受付', '申し込み', '申込み', '購入', '抽選')
EVENT_HEADING_ORIGINS = ('h1', 'event_heading', 'body_label', 'jsonld', 'event_state')


def confirm_event_page(page, url):
    """Return a finite provenance code; do not trust HTTP 200 alone.

    A page with no identifiable event content is quarantined, not labelled
    blocked, as access gates and loading shells can look similar. All checks
    are local to the single already-requested, exact event URL.
    """
    if not isinstance(page, dict) or page.get('status') != 'ok':
        return 'not_ok'
    if v12.exact_event_url(page.get('final_url')) != url:
        return 'wrong_event_url'
    body = page.get('text') if isinstance(page.get('text'), str) else ''
    titles = page.get('titles') if isinstance(page.get('titles'), list) else []
    sources = page.get('title_sources') if isinstance(page.get('title_sources'), list) else []
    if ROBOT_VERIFICATION.search(body) or any(
            isinstance(t, str) and ROBOT_VERIFICATION.search(t) for t in titles[:12]):
        return 'access_challenge'
    # Source labels come from local DOM selectors, not the remote page text.
    # A site navigation h1 alone is not proof of an event: require a clean,
    # event-specific title or explicit body evidence alongside ticket context.
    valid_header = any(
        source in EVENT_HEADING_ORIGINS and isinstance(title, str) and
        clean_livepocket_event_title(title, source)[0]
        for title, source in zip(titles[:12], sources[:12])
    )
    event_body = any(marker in body for marker in EVENT_BODY_MARKERS)
    ticket_body = any(marker in body for marker in EVENT_TICKET_MARKERS)
    if (event_body and ticket_body) or (valid_header and ticket_body):
        return 'event_confirmed'
    return 'event_unconfirmed'


def quarantine_unconfirmed_event(page, url):
    """Do not let a loading shell overwrite verified official event facts.

    The candidate counters remain available for debugging. Retain the
    original HTTP success code separately in page_identity, but mark the
    extraction result non-OK so every existing upstream extractor is guarded.
    """
    if not isinstance(page, dict) or page.get('status') != 'ok':
        return page
    identity = confirm_event_page(page, url)
    output = dict(page)
    output['page_identity'] = identity
    if identity == 'access_challenge':
        output['status'] = 'browser_blocked_or_empty'
        output['gate_reason'] = 'robot_verification_page'
    elif identity == 'event_unconfirmed':
        output['status'] = 'browser_unverified_page'
        output['gate_reason'] = 'event_page_unconfirmed'
    elif identity == 'wrong_event_url':
        output['status'] = 'browser_redirected'
    return output


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



# v21.14: SAFE title diagnostics. Never persist rejected candidate strings,
# document contents, user data, arbitrary markup, or exception messages.
TITLE_SOURCE_CODES = ('og', 'twitter', 'h1', 'event_heading', 'document',
                      'jsonld', 'event_state', 'body_label', 'unknown')
SITE_ONLY_TITLE = re.compile(
    r'^(?:(?:LivePocket(?:-Ticket)?|ライブポケット)(?:\s*[\-|｜:：]\s*'
    r'(?:チケット|イベント|Ticket(?:s)?|イベント・チケット販売))*|'
    r'チケット|イベント情報|イベント詳細|お申し込み|ログイン|受付)$', re.I)


def _title_candidates(page):
    """Bound untrusted result size; only raw data is used transiently."""
    vals = page.get('titles')
    vals = vals[:12] if isinstance(vals, list) else []
    sources = page.get('title_sources')
    sources = sources if isinstance(sources, list) and len(sources) == len(vals) else []
    candidates = []
    for i, v in enumerate(vals):
        if not isinstance(v, str) or not v.strip():
            continue
        origin = sources[i] if i < len(sources) else 'unknown'
        if origin not in TITLE_SOURCE_CODES:
            origin = 'unknown'
        candidates.append((v[:300], origin))
    label = v20.v15.event_title(page)
    if isinstance(label, str) and label.strip():
        candidates.append((label[:300], 'body_label'))
    return candidates


def _site_common_title(value):
    normalized = unicodedata.normalize('NFKC', value).strip()
    return bool(SITE_ONLY_TITLE.fullmatch(normalized))


def title_diagnostic_details(page, url):
    """Classify missing titles without weakening the existing validation.

    The filter and final title selection are the original verified_title();
    codes/counts are finite and never contain candidate values."""
    result = {'reason': '', 'candidate_count': 0, 'valid_candidate_count': 0,
              'detail': '', 'candidate_sources': '', 'title_detected': False,
              'rejection_codes': '', 'meta_template_cleaned': 0, 'heading_seen': 0,
              'recovery_probe': ''}
    if isinstance(page, dict):
        probe = page.get('title_recovery_probe')
        # Whitelist only our own finite diagnostic values, never remote text.
        if probe in ('invalid_page', 'missing_inputs', 'invalid_sources',
                     'event_tabs_missing', 'event_tabs_ambiguous',
                     'heading_area_empty', 'truncated_prefix_missing',
                     'heading_recovered', 'multiple_matching_headings',
                     'possible_wrapped_heading', 'prefix_not_at_heading_start',
                     'heading_prefix_mismatch'):
            result['recovery_probe'] = probe
    if not isinstance(page, dict):
        result['reason'] = 'invalid_fetch_result'
        return result
    status = str(page.get('status') or 'browser_error')
    if status != 'ok':
        if status in ('browser_blocked', 'browser_blocked_or_empty'):
            result['reason'] = 'access_blocked'
        elif status == 'browser_unverified_page':
            result['reason'] = 'event_page_unconfirmed'
            result['detail'] = 'event_body_not_verified'
        else:
            # Never export page-controlled or unexpected status text.
            result['reason'] = 'fetch_failed'
        # Even unconfirmed/blocked pages may have misleading <title> strings;
        # retain only bounded counters generated by the safe normalizer.
        seen = page.get('title_candidates_seen')
        result['candidate_count'] = min(20, max(0, seen)) if isinstance(seen, int) else 0
        filters = str(page.get('title_filter_counts') or '')
        result['rejection_codes'] = filters[:150] if re.fullmatch(r'[a-z0-9_:;]+', filters) else ''
        return result
    if v12.exact_event_url(page.get('final_url')) != url:
        result['reason'] = 'wrong_event_url'
        return result
    candidates = _title_candidates(page)
    source_counts = {origin: 0 for origin in TITLE_SOURCE_CODES}
    filtered = set()
    for value, origin in candidates:
        source_counts[origin] += 1
        try:
            safe = v14.clean_title(value)
        except (ValueError, TypeError):
            safe = None
        if safe:
            filtered.add(safe)
    result['candidate_count'] = (page.get('title_candidates_seen')
                                 if isinstance(page.get('title_candidates_seen'), int)
                                 else len(candidates))
    result['valid_candidate_count'] = len(filtered)
    result['rejection_codes'] = str(page.get('title_filter_counts') or '')[:150]
    result['meta_template_cleaned'] = max(0, int(page.get('title_template_cleaned') or 0))
    result['heading_seen'] = max(0, int(page.get('title_heading_seen') or 0))
    # Canonical codes and non-negative integers ONLY. No untrusted text.
    result['candidate_sources'] = (str(page.get('title_source_counts') or '')[:200] or ';'.join(
        f'{key}:{source_counts[key]}' for key in TITLE_SOURCE_CODES
        if source_counts[key] > 0))
    found, _ = verified_title(page, url)
    if found:
        result['reason'] = 'official_title_detected'
        result['title_detected'] = True
    elif not result['candidate_count']:
        result['reason'] = 'no_title_candidates'
        result['detail'] = 'no_source_candidates'
    else:
        result['reason'] = 'title_candidates_rejected'
        if not candidates and page.get('title_filter_counts'):
            result['detail'] = 'filtered_all_candidates'
        elif all(_site_common_title(value) for value, _ in candidates):
            result['detail'] = 'site_common_only'
        elif not filtered:
            result['detail'] = 'filtered_all_candidates'
        elif len(filtered) > 1:
            result['detail'] = 'multiple_valid_unresolved'
        else:
            result['detail'] = 'valid_candidate_not_selected'
    return result


def title_observation_reason(page, url):
    """v21.13 compatibility: (reason, number, verified title or empty)."""
    result = title_diagnostic_details(page, url)
    value = verified_title(page, url)[0] if result['title_detected'] else ''
    return result['reason'], result['candidate_count'], value or ''



# v21.15: Support the OFFICIAL page-title template used by LivePocket event
# pages, without accepting incomplete, marketing or unrelated site titles.
# A suffix is stripped only if it fully matches an expected LivePocket format.
LP_META_TEMPLATE = re.compile(
    r'\s*のチケット情報(?:・予約・購入・販売)?\s*[|｜]\s*'
    r'(?:LivePocket(?:-Ticket-?)?(?:\s*[（(]ライブポケット[）)])?|'
    r'ライヴポケット)\s*$', re.I)
LP_EXPLICIT_LABEL = re.compile(r'^(?:イベント名|イベントタイトル)\s*[：:]\s*(.{5,160})$')
LP_LABEL_ONLY = re.compile(r'^(?:イベント名|イベントタイトル)\s*[：:]?\s*$')
LP_GENERIC_TITLE = re.compile(
    r'^(?:チケット情報|イベント詳細|イベント概要|開催概要|申し込み|お申し込み|'
    r'チケットの購入|チケット予約・購入|チケット購入・予約・販売|'
    r'新着イベント|すべてのイベント|イベントを探す|検索結果|LivePocket(?:-Ticket-?)?)$', re.I)
TITLE_FILTER_CODES = ('truncated', 'truncated_tail', 'truncated_inner',
                      'replacement_char', 'site_generic', 'unsafe_phrase',
                      'length', 'invalid', 'other')


def event_name_from_labelled_body(text):
    """Only a literal event-name label; never infer name from ticket/body prose."""
    if not isinstance(text, str):
        return None
    lines = [re.sub(r'\s+', ' ', x).strip() for x in text.splitlines()[:160]]
    names = set()
    for i, value in enumerate(lines):
        match = LP_EXPLICIT_LABEL.fullmatch(value)
        if match:
            item = v14.clean_title(match.group(1))
        elif LP_LABEL_ONLY.fullmatch(value) and i + 1 < len(lines):
            item = v14.clean_title(lines[i + 1])
        else:
            continue
        if item and not LP_GENERIC_TITLE.fullmatch(item) and not _site_common_title(item):
            names.add(item)
    return next(iter(names)) if len(names) == 1 else None


def truncation_type(value, source):
    """Finite reason: genuine ellipsis at tail, embedded, or replacement char.

    Only an exact official metadata template can be peeled for this diagnostic.
    The resulting event name is still NEVER completed by guessing.
    """
    if not isinstance(value, str):
        return ''
    text = html.unescape(value).strip()
    if '\ufffd' in text:
        return 'replacement_char'
    if source in ('og', 'twitter', 'document'):
        text = LP_META_TEMPLATE.sub('', text).strip()
    if text.endswith(('...', '…')):
        return 'truncated_tail'
    if '...' in text or '…' in text:
        return 'truncated_inner'
    return ''


def clean_livepocket_event_title(value, source):
    """Return (clean name, diagnostic code, stripped-template flag).

    Every name is still validated by the existing v14 filter. The metadata
    template removal never repairs a truncated or uncertain event name.
    """
    if not isinstance(value, str):
        return None, 'invalid', False
    text = html.unescape(value).strip()
    if re.search(r'(?:\.\.\.|…|\ufffd)', text):
        return None, 'truncated', False
    stripped = False
    if source in ('og', 'twitter', 'document'):
        amended = LP_META_TEMPLATE.sub('', text).strip()
        stripped = amended != text
        text = amended
    if LP_GENERIC_TITLE.fullmatch(text) or _site_common_title(text):
        return None, 'site_generic', stripped
    if len(re.sub(r'\s+', ' ', text)) < 5 or len(re.sub(r'\s+', ' ', text)) > 160:
        return None, 'length', stripped
    safe = v14.clean_title(text)
    if not safe:
        return None, 'unsafe_phrase', stripped
    if LP_GENERIC_TITLE.fullmatch(safe) or _site_common_title(safe):
        return None, 'site_generic', stripped
    return safe, '', stripped



# v21.19: LivePocket's visible event heading can be styled text (not an H1).
# Some page metadata ends in an ellipsis even while the full heading is visible.
# Recover ONLY when the SAME already-loaded exact-URL page has:
#  - a truncated official metadata prefix,
#  - a unique full visible line closely preceding the known event tabs, and
#  - that line begins with the exact metadata prefix (after whitespace/NFKC).
# Do not guess the omitted ending or collect headings from unrelated paragraphs.
def inspect_visible_event_title(page):
    """Return (verified title or None, SAFE finite failure code).

    Diagnostic categories never contain a title, event text, or URL. Do not
    expand the acceptance criteria until live runs explain what is missing.
    """
    if not isinstance(page, dict):
        return None, 'invalid_page'
    body = page.get('text')
    raw = page.get('titles')
    origins = page.get('title_sources')
    if not isinstance(body, str) or not isinstance(raw, list) or not isinstance(origins, list):
        return None, 'missing_inputs'
    if len(raw) != len(origins):
        return None, 'invalid_sources'

    # Only rendered page text from the SAME requested event URL. Never use
    # unrelated recommendations or ticket details below the navigation tabs.
    lines = [re.sub(r'\s+', ' ', html.unescape(x)).strip()
             for x in body[:25000].splitlines()[:220]]
    lines = [x for x in lines if x]
    overview_indexes = []
    for i, line in enumerate(lines):
        if re.fullmatch(r'概要\s+詳細\s+受付・チケット情報\s+お問い合わせ', line):
            overview_indexes.append(i)
            continue
        if line != '概要':
            continue
        tail = lines[i:i+9]
        if ('詳細' in tail and '受付・チケット情報' in tail and
                'お問い合わせ' in tail and
                tail.index('詳細') < tail.index('受付・チケット情報')
                < tail.index('お問い合わせ')):
            overview_indexes.append(i)
    if not overview_indexes:
        return None, 'event_tabs_missing'
    if len(overview_indexes) != 1:
        return None, 'event_tabs_ambiguous'
    nav = overview_indexes[0]
    nearby = lines[max(0,nav-12):nav]
    if not nearby:
        return None, 'heading_area_empty'

    def canonical(value):
        return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).casefold()

    prefixes = set()
    for value, origin in zip(raw[:12], origins[:12]):
        if origin not in ('og', 'document', 'twitter') or not isinstance(value, str):
            continue
        text = LP_META_TEMPLATE.sub('', html.unescape(value).strip()).strip()
        if not text.endswith(('…', '...')) or '\ufffd' in text:
            continue
        prefix = text[:-3].rstrip() if text.endswith('...') else text[:-1].rstrip()
        key = canonical(prefix)
        if 12 <= len(key) <= 155 and not LP_GENERIC_TITLE.fullmatch(prefix):
            prefixes.add(key)
    if not prefixes:
        return None, 'truncated_prefix_missing'

    complete = set()
    for candidate in nearby:
        key = canonical(candidate)
        if any(len(key) > len(prefix) and key.startswith(prefix)
               for prefix in prefixes):
            accepted = v14.clean_title(candidate)
            if accepted and not LP_GENERIC_TITLE.fullmatch(accepted) and \
                    not _site_common_title(accepted):
                complete.add(accepted)
    if len(complete) == 1:
        return next(iter(complete)), 'heading_recovered'
    if len(complete) > 1:
        return None, 'multiple_matching_headings'

    # Diagnostic ONLY: a visual title can be split into multiple DOM lines,
    # but concatenating them can also make unrelated controls look like titles.
    # Never accept these joined strings as official event names automatically.
    if any(len(canonical(a + b)) > len(prefix) and
           canonical(a + b).startswith(prefix)
           for a, b in zip(nearby, nearby[1:]) for prefix in prefixes):
        return None, 'possible_wrapped_heading'
    # Look for a non-leading prefix on a single line (decorative front label).
    if any(prefix in canonical(line) for prefix in prefixes for line in nearby):
        return None, 'prefix_not_at_heading_start'
    return None, 'heading_prefix_mismatch'


def recover_visible_event_title(page):
    """Backward-compatible: return only a uniquely verified visible title."""
    value, _probe = inspect_visible_event_title(page)
    return value


def normalize_event_title_observation(page, url):
    """Normalize candidates before legacy v14/15/20 see this same fetch.

    No additional network requests, and no raw rejected candidates in the
    returned diagnostics or persistent files. Already accepted names remain
    plain titles, keeping existing official-title provenance rules intact.
    """
    if not isinstance(page, dict) or page.get('status') != 'ok' or \
            v12.exact_event_url(page.get('final_url')) != url:
        return page
    result = dict(page)
    raw = page.get('titles')
    raw = raw[:16] if isinstance(raw, list) else []
    sources = page.get('title_sources')
    sources = sources if isinstance(sources, list) and len(sources) == len(raw) else []
    entries = [(v, sources[i] if i < len(sources) and sources[i] in TITLE_SOURCE_CODES
                else 'unknown') for i, v in enumerate(raw)]
    name = event_name_from_labelled_body(page.get('text'))
    if name:
        entries.append((name, 'body_label'))
    # Visible title must agree with a truncated official metadata prefix.
    matched_heading, title_probe = inspect_visible_event_title(page)
    result['title_recovery_probe'] = title_probe
    if matched_heading:
        entries.append((matched_heading, 'event_heading'))
    filtered = {key: 0 for key in TITLE_FILTER_CODES}
    source_counts = {key: 0 for key in TITLE_SOURCE_CODES}
    accepted = []
    template_fixed = 0
    for text, source in entries:
        source_counts[source] += 1
        candidate, code, fixed = clean_livepocket_event_title(text, source)
        if fixed and candidate:
            template_fixed += 1
        if candidate and candidate not in (x[0] for x in accepted):
            accepted.append((candidate, source))
        elif code:
            filtered[code] += 1
            if code == 'truncated':
                subtype = truncation_type(text, source)
                if subtype:
                    filtered[subtype] += 1
    # Prefer event-specific visible headings and explicit labels, then JSON-LD,
    # then site metadata. Do NOT promote arbitrary ticket names or body snippets.
    priority = {'event_heading':0, 'h1':1, 'body_label':2, 'event_state':3,
                'jsonld':4, 'og':5, 'twitter':6, 'document':7, 'unknown':8}
    accepted.sort(key=lambda pair: priority[pair[1]])
    result['titles'] = [v for v, _ in accepted[:12]]
    result['title_sources'] = [v for _, v in accepted[:12]]
    result['title_candidates_seen'] = len(entries)
    result['title_source_counts'] = ';'.join(
        f'{k}:{source_counts[k]}' for k in TITLE_SOURCE_CODES if source_counts[k])
    result['title_filter_counts'] = ';'.join(
        f'{k}:{filtered[k]}' for k in TITLE_FILTER_CODES if filtered[k])
    result['title_template_cleaned'] = template_fixed
    result['title_heading_seen'] = sum(source_counts.get(k, 0) for k in ('h1','event_heading','body_label','jsonld','event_state'))
    return result

# A GitHub-committed, URL-scoped official screenshot/page verification list.
# Only a developer who can commit files to this repository can approve a row.
# The CSV is public: NEVER put secrets or personal account details in it.
MANUAL_TITLES_PATH = Path(os.environ.get('LIVEPOCKET_VERIFIED_TITLES_FILE',
                                         'livepocket_verified_titles.csv'))
MANUAL_TITLE_SOURCE = 'v21_13_verified_manual_exact_url'


def read_verified_titles(path=MANUAL_TITLES_PATH):
    path = Path(path)
    if not path.is_file():
        return {}  # optional registry, backward-compatible installation
    entries = {}
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        required = {'url', 'event_title', 'evidence', 'approved'}
        if not reader.fieldnames or not required <= set(reader.fieldnames):
            raise ValueError('Verified event title CSV requires: url,event_title,evidence,approved')
        for n, row in enumerate(reader, start=2):
            if (row.get('approved') or '').strip().lower() != 'yes':
                continue
            original_url = (row.get('url') or '').strip()
            url = v12.exact_event_url(original_url)
            if not url or url != original_url:
                raise ValueError(f'Invalid exact LivePocket URL in verified titles row {n}')
            evidence = (row.get('evidence') or '').strip()
            if evidence not in ('official_page_viewed', 'official_screenshot_viewed'):
                raise ValueError(f'Unverified evidence in titles row {n}')
            candidate = (row.get('event_title') or '').strip()
            title = v14.clean_title(candidate)
            if not title or title != candidate:
                raise ValueError(f'Invalid or noncanonical event title in row {n}')
            if url in entries and entries[url] != title:
                raise ValueError(f'Conflicting manually verified titles for {url}')
            entries[url] = title
    return entries


def apply_verified_titles(raw, public, registry):
    ri, pi = v11.indices(raw, public)
    result = {'manual_verified_titles_applied': 0,
              'manual_verified_titles_updated': 0,
              'manual_verified_title_conflicts': 0}
    for url, title in registry.items():
        if url not in ri:
            continue
        item, pub = ri[url], pi[url]
        existing = item.get('event_title') or pub.get('event_title') or ''
        source = str((item.get('field_sources') or {}).get('event_title') or '')
        # Do not overwrite *another* already verified source silently.
        if existing and existing != title and source not in (
                '', MANUAL_TITLE_SOURCE) and not title_is_provisional(item):
            result['manual_verified_title_conflicts'] += 1
            continue
        if existing != title:
            result['manual_verified_titles_updated'] += 1
        for entry in (item, pub):
            entry['event_title'] = title
        item.setdefault('field_sources', {})['event_title'] = MANUAL_TITLE_SOURCE
        pub['official_event_title'] = title
        genre = official_genre(title)
        if genre:
            pub['review_category'] = genre
            pub['official_genre'] = genre
            if genre != 'pokemon':
                for key in ('pokemon_map_match','pokemon_map_type','pokemon_map_evidence'):
                    pub.pop(key, None)
        # This is an event TITLE registry; do not guess or replace product name.
        result['manual_verified_titles_applied'] += 1
    return result


# v21.13 developer-only background selection. It is enabled ONLY by the
# workflow's explicit manual input, never by the regular 5-minute Cron.
# The ordinary v14/v15/v20 extractors remain responsible for writing facts.
MANUAL_RECHECK_LIMIT = 12
MANUAL_MIN_REPEAT = timedelta(hours=2)


def manual_recheck_candidates(raw, public, *, now=None, limit=MANUAL_RECHECK_LIMIT):
    """Oldest/never-checked, incomplete, still-applicable URLs; bounded/rotating.

    No URL currently queued as *new* is chosen again. A hard global bot-block
    cooldown always wins. Manual mode bypasses the historical 7-day wait but
    NEVER the global block cooldown or a 2-hour per-URL repeat guard.
    """
    now = v14._utc(now)
    limit = max(0, min(int(limit), MANUAL_RECHECK_LIMIT))
    ri, pi = v11.indices(raw, public)
    state = raw.get('collector_state', {})
    v14state = state.get('v14', {})
    if not limit or v14._cooldown_active(v14state, now):
        return []
    pending = set(v14state.get('pending_new_urls', []))
    browser_checks = state.get('v13', {}).get('browser_checks', {})
    # Events already due in the normal retry channel are handled separately.
    # Manual mode disables that separate retry pass to keep its total at 12.
    selected = []
    for url, item in ri.items():
        if url in pending:
            continue
        event = pi[url]
        deadline = v11.parse_datetime(event.get('application_end_at'))
        if deadline and deadline.astimezone(timezone.utc) <= now:
            continue
        check = browser_checks.get(url, {})
        if not isinstance(check, dict) or check.get('status') == 'browser_redirected':
            continue
        last = v19.v18.v17.check_time(check.get('checked_at'))
        if check.get('checked_at') and not last:
            continue  # malformed check timestamps are quarantined
        if last and (last > now or now - last < MANUAL_MIN_REPEAT):
            continue
        # Non-working, repeated official checks must also respect the guard.
        official = state.get('v21_9', {}).get('official_checks', {}).get(url, {})
        official_last = v19.v18.v17.check_time(official.get('checked_at'))
        if official.get('checked_at') and not official_last:
            continue
        if official_last and (official_last > now or now - official_last < MANUAL_MIN_REPEAT):
            continue
        missing = missing_details_v21(event)
        event_title = event.get('event_title') or item.get('event_title') or ''
        # Title recovery has priority over general freshness. Only exact-URL
        # human-verified or official-page names count as confirmed.
        source = str((item.get('field_sources') or {}).get('event_title') or '')
        confirmed = bool(event.get('official_event_title')) and source in (
            'v21_9_official_exact_url_title', 'v21_13_verified_manual_exact_url')
        if not event_title:
            tier = 0  # no event name
        elif title_is_provisional(item) and not confirmed:
            tier = 1  # short Discord event name
        elif missing:
            tier = 2  # other incomplete page
        else:
            tier = 3  # mostly complete event
        selected.append((tier, last is not None,
                         last or datetime.min.replace(tzinfo=timezone.utc), url))
    selected.sort()
    return [url for *_, url in selected[:limit]]


@contextmanager
def use_manual_background(urls):
    """Replace v18's *historical selector* only during a single call.

    v18._use_selector() delegates to v18.select; wrap only that function,
    keeping the new-priority branch and global cooldown intact. The original
    selector is restored even if an upstream extractor raises an exception.
    """
    if not urls:
        yield
        return
    original = v19.v18.select
    def _manual_select(raw, public, now, *, new_limit=15, background_limit=0, retry_days=7):
        urgent, _, cooling = original(raw, public, now, new_limit=new_limit,
                                      background_limit=0, retry_days=retry_days)
        if cooling or background_limit <= 0:
            return urgent, [], cooling
        valid = {item.get('url') for item in raw.get('items', [])}
        historical = [u for u in urls if u in valid and u not in urgent]
        return urgent, historical[:background_limit], False
    v19.v18.select = _manual_select
    try:
        yield
    finally:
        v19.v18.select = original


# v21.20: Public, URL-scoped initial discovery timestamp for the NEW badge.
# This is collected from the persisted first-seen v14 ledger, NOT from a
# Discord post date, last manual recheck, page fetch, or event modification.
def publish_first_detected_at(raw, public, *, now=None):
    now = v14._utc(now)
    state = raw.get('collector_state') if isinstance(raw, dict) else None
    v14_state = state.get('v14') if isinstance(state, dict) else None
    ledger = v14_state.get('new_url_checks') if isinstance(v14_state, dict) else None
    if not isinstance(ledger, dict):
        return 0
    added = 0
    for item in public.get('items', []):
        if not isinstance(item, dict) or not isinstance(item.get('url'), str):
            continue
        record = ledger.get(item['url'])
        value = record.get('detected_at') if isinstance(record, dict) else None
        if not isinstance(value, str) or not value:
            continue
        try:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            continue
        if parsed.tzinfo is None or parsed.utcoffset() is None or parsed > now:
            continue
        if item.get('first_detected_at') != value:
            item['first_detected_at'] = value
            added += 1
    return added


# Discord URL-paired event names are unverified shorthand, never the public
# authoritative event heading. Keep the raw provenance for exact-URL official
# verification, but mark it in public data so UI can omit the provisional name.
def mark_provisional_discord_event_titles(raw, public):
    index = {i.get('url'): i for i in raw.get('items', [])
             if isinstance(i, dict) and isinstance(i.get('url'), str)}
    updated = 0
    for item in public.get('items', []):
        if not isinstance(item, dict):
            continue
        record = index.get(item.get('url'), {})
        source = str((record.get('field_sources') or {}).get('event_title') or '')
        provisional = (bool(item.get('event_title')) and
                       source.startswith(('discord_url_title:', 'discord_url_pair:',
                                          'discord_embed:')) and
                       item.get('official_event_title') != item.get('event_title'))
        if provisional and item.get('event_title_provisional') is not True:
            item['event_title_provisional'] = True
            updated += 1
        elif not provisional and 'event_title_provisional' in item:
            item.pop('event_title_provisional', None)
            updated += 1
    return updated


def process(raw, public, fetch, *, catalog, now=None, new_limit=15,
            background_limit=0, retry_limit=3, verified=None, v19_verified=None,
            title_limit=TITLE_RECHECK_DEFAULT_PER_RUN,
            manual_recheck=False, manual_limit=MANUAL_RECHECK_LIMIT,
            verified_titles=None):
    """v21.13: title-priority checks, URL-scoped results and verified titles."""
    now = v14._utc(now)
    snapshot = {item['url']: json.dumps(item, ensure_ascii=False, sort_keys=True)
                for item in public['items']}
    before_items = {item['url']: json.loads(json.dumps(item, ensure_ascii=False))
                    for item in public['items']}
    manual_urls = (manual_recheck_candidates(raw, public, now=now, limit=manual_limit)
                   if manual_recheck else [])
    # Selection before the upstream pass prevents fresh discoveries from being
    # rechecked twice in the same job. An overlap with upstream is skipped.
    queued = (title_recheck_candidates(raw, public, now=now, limit=title_limit)
              if not manual_recheck else [])
    # Only in background/manual cycles; 5-minute new-only runs add NO extra
    # official-page requests. Queue is selected before upstream processing.
    official_queue, official_reasons, _ = (
        official_title_diagnostics(raw, public, now=now, limit=0 if manual_recheck else OFFICIAL_TITLE_CHECK_PER_RUN)
        if background_limit else ([], {'background_not_enabled': len(raw.get('items', []))}, {}))
    seen = set()
    observations = {}

    def record(url):
        seen.add(url)
        result = normalize_verification_page(fetch(url))
        result = normalize_event_title_observation(result, url)
        result = quarantine_unconfirmed_event(result, url)
        if isinstance(result, dict):
            observations[url] = result
        return result

    with use_manual_background(manual_urls if manual_recheck else []):
        raw, public, review, deadlines, sources, content, stats = process_v21_1(
            raw, public, record, catalog=catalog, now=now,
            new_limit=new_limit, background_limit=background_limit,
            retry_limit=0 if manual_recheck else retry_limit,
            verified=verified, v19_verified=v19_verified)
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
    stats['official_title_eligibility'] = json.dumps(official_reasons, ensure_ascii=False, sort_keys=True)
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
        page_status = page_result.get('status') or 'browser_error'
        if page_status == 'ok' and not outcome['title']:
            page_status = 'ok_no_title'
        page_reason = (page_result.get('gate_reason') or
                       ('official_title_verified' if outcome['title'] else
                        'no_verifiable_title_on_page' if page_status == 'ok_no_title' else
                        'fetch_' + str(page_status)))
        record_state.update(status=page_status, reason=page_reason,
                            http_status=page_result.get('http_status') or '',
                            checked_at=now.isoformat(),
                            title_observed=outcome['title'],
                            genre=outcome['genre'],
                            product_origin=ri[url].get('field_sources', {}).get('product_name', ''),
                            title_origin=ri[url].get('field_sources', {}).get('event_title', ''),
                            conflict=bool(outcome['conflict']))

    stats['official_genres_restored'] += restore_official_genres(raw, public)
    stats.update(apply_verified_titles(raw, public, verified_titles or {}))
    title_state = state.setdefault('v21_13', {}).setdefault('title_diagnostics', {})
    for url, page_result in observations.items():
        diagnosis = title_diagnostic_details(page_result, url)
        title_state[url] = {'checked_at': now.isoformat(), **diagnosis}
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

    _, _, final_official_detail = official_title_diagnostics(raw, public, now=now)
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
        reason, next_at = final_official_detail.get(row['url'], ('', ''))
        row['official_title_queue_reason'] = reason
        row['official_title_next_eligible_at'] = next_at
        row['official_title_attempts'] = recheck_attempts(observed)
        row['official_page_status'] = observed.get('status', '')
        row['official_page_reason'] = observed.get('reason', '')
        row['official_page_http_status'] = observed.get('http_status', '')
        row['official_title_observed'] = v12._safe_csv(observed.get('title_observed') or '')
        row['official_genre'] = observed.get('genre', '')
        row['official_title_source'] = observed.get('title_origin', '')
        row['official_product_source'] = observed.get('product_origin', '')
        row['official_page_checked_at'] = observed.get('checked_at', '')
        row['official_title_conflict'] = 'yes' if observed.get('conflict') else ''
        retry = log.get(row['url'], {})
        row['title_recheck_attempts'] = recheck_attempts(retry)
        row['title_recheck_at'] = retry.get('checked_at', '')
        diag = title_state.get(row['url'], {})
        row['title_diagnostic_reason'] = diag.get('reason', '')
        row['title_diagnostic_candidates'] = diag.get('candidate_count', '')
        row['title_diagnostic_checked_at'] = diag.get('checked_at', '')
        row['title_diagnostic_title_detected'] = 'yes' if diag.get('title_detected') else ''
        row['title_diagnostic_detail'] = diag.get('detail', '')
        row['title_diagnostic_sources'] = diag.get('candidate_sources', '')
        row['title_diagnostic_valid_candidates'] = diag.get('valid_candidate_count', '')
        row['title_diagnostic_rejection_codes'] = diag.get('rejection_codes', '')
        row['title_diagnostic_meta_template_cleaned'] = diag.get('meta_template_cleaned', '')
        row['title_diagnostic_heading_seen'] = diag.get('heading_seen', '')
        row['title_diagnostic_recovery_probe'] = diag.get('recovery_probe', '')
        row['title_page_identity'] = (observations.get(row['url'], {}).get('page_identity')
                                      or 'not_checked')
        row['title_recheck_status'] = retry.get('status', '')
        row['title_recheck_reason'] = retry.get('reason', '')
        row['title_recheck_http_status'] = retry.get('http_status', '')
        browser_check = state.get('v13', {}).get('browser_checks', {}).get(row['url'], {})
        checked = v19.v18.v17.check_time(browser_check.get('checked_at'))
        row['title_recheck_next_at'] = ('' if pub.get('event_title') else
            retry_next_at(retry, end=v11.parse_datetime(pub.get('application_end_at')),
                          now=now, checked=checked))

    # These numbers describe ONLY URLs actually visited as part of manual
    # background work. Whole-dataset normalizations (e.g. 208 store records)
    # must never be advertised as 208 verified page updates.
    if manual_recheck:
        visited = [url for url in manual_urls if url in observations]
        successful = [url for url in visited if
                      observations[url].get('status') == 'ok' and
                      v12.exact_event_url(observations[url].get('final_url')) == url]
        blocked = sum(observations[u].get('status') in
                      ('browser_blocked','browser_blocked_or_empty') for u in visited)
        stats.update(manual_selected=len(manual_urls),
                     manual_attempted=len(visited),
                     manual_success=len(successful), manual_blocked=blocked)
        reasons = [title_state.get(u, {}).get('reason') for u in visited]
        stats['manual_title_detected'] = reasons.count('official_title_detected')
        stats['manual_title_no_candidates'] = reasons.count('no_title_candidates')
        stats['manual_title_rejected'] = reasons.count('title_candidates_rejected')
        stats['manual_title_access_blocked'] = reasons.count('access_blocked')
        stats['manual_title_other_failure'] = len(visited) - sum((
            stats['manual_title_detected'], stats['manual_title_no_candidates'],
            stats['manual_title_rejected'], stats['manual_title_access_blocked']))
        details = [title_state.get(u, {}).get('detail') for u in visited]
        stats['manual_title_site_common'] = details.count('site_common_only')
        stats['manual_title_filtered_all'] = details.count('filtered_all_candidates')
        stats['manual_title_multiple_unresolved'] = details.count('multiple_valid_unresolved')
        stats['manual_title_valid_unselected'] = details.count('valid_candidate_not_selected')
        stats['manual_title_meta_template_cleaned'] = sum(bool(title_state.get(u, {}).get('meta_template_cleaned')) for u in visited)
        stats['manual_title_heading_seen'] = sum(bool(title_state.get(u, {}).get('heading_seen')) for u in visited)
        stats['manual_title_dom_candidates'] = sum(
            bool(re.search(r'(?:^|;)(?:h1|event_heading):[1-9]',
                           str(title_state.get(u, {}).get('candidate_sources') or '')))
            for u in visited)
        stats['manual_title_state_candidates'] = sum(
            bool(re.search(r'(?:^|;)event_state:[1-9]',
                           str(title_state.get(u, {}).get('candidate_sources') or '')))
            for u in visited)
        stats['manual_title_truncated'] = sum('truncated:' in str(title_state.get(u, {}).get('rejection_codes') or '') for u in visited)
        stats['manual_page_unconfirmed'] = sum(
            observations[u].get('page_identity') == 'event_unconfirmed' for u in visited)
        stats['manual_page_event_confirmed'] = sum(
            observations[u].get('page_identity') == 'event_confirmed' for u in visited)
        stats['manual_title_truncated_tail'] = sum(
            'truncated_tail:' in str(title_state.get(u, {}).get('rejection_codes') or '') for u in visited)
        stats['manual_title_truncated_inner'] = sum(
            'truncated_inner:' in str(title_state.get(u, {}).get('rejection_codes') or '') for u in visited)
        stats['manual_title_replacement_char'] = sum(
            'replacement_char:' in str(title_state.get(u, {}).get('rejection_codes') or '') for u in visited)
        groups = {
            'manual_title_updated': ('event_title',),
            'manual_product_updated': ('product_name',),
            'manual_deadline_updated': ('application_start_at', 'application_end_at'),
            'manual_store_updated': ('store_name', 'prefecture', 'stores'),
            'manual_genre_updated': ('review_category',),
        }
        def page_supported_change(url, metric, keys):
            if not any(before_items[url].get(k) != pi[url].get(k) for k in keys):
                return False
            result = observations[url]
            fields = ri[url].get('field_sources') or {}
            if metric == 'manual_store_updated':
                # Only label store changes as page-derived if the same event
                # actually contained an explicit store. Whole-catalog legacy
                # store-list normalization is NOT evidence of a page update.
                text = result.get('text') or ''
                return bool(v19.page_stores(text) or v20.v15.explicit_store(text)[0])
            if metric == 'manual_genre_updated':
                return bool(pi[url].get('official_event_title'))
            if metric == 'manual_title_updated':
                return str(fields.get('event_title') or '').startswith(
                    ('v14_', 'v15_', 'v16_', 'v21_'))
            if metric == 'manual_product_updated':
                return str(fields.get('product_name') or '').startswith(
                    ('v14_', 'v15_', 'v16_', 'v20_', 'v21_'))
            if metric == 'manual_deadline_updated':
                return any(str(fields.get(key) or '').startswith(
                    ('v14_', 'v15_', 'v16_', 'v21_')) for key in keys)
            return False
        for metric, keys in groups.items():
            stats[metric] = sum(page_supported_change(u, metric, keys)
                                for u in successful)
    
    stats['first_detection_times_published'] = publish_first_detected_at(
        raw, public, now=now)
    stats['provisional_discord_titles_marked'] = mark_provisional_discord_event_titles(raw, public)
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
            if (v14.v13.BLOCK_WORDS.search(body) or ROBOT_VERIFICATION.search(body)
                    or len(body.strip()) < 40):
                return {'status': 'browser_blocked_or_empty',
                        'gate_reason': 'robot_verification_page' if ROBOT_VERIFICATION.search(body)
                        else 'blocked_or_empty'}
            titles, title_sources = [], []
            def add_title(value, source):
                if isinstance(value, str) and value.strip() and len(titles) < 12:
                    titles.append(value[:300])
                    title_sources.append(source)
            for selector, origin in (
                ('meta[property="og:title"]', 'og'),
                ('meta[name="twitter:title"]', 'twitter')):
                try:
                    add_title(page.locator(selector).first.get_attribute('content', timeout=800), origin)
                except Exception:
                    pass
            try:
                for value in page.locator('h1').all_inner_texts(timeout=1200)[:3]:
                    add_title(value, 'h1')
            except Exception:
                pass
            # Page layouts sometimes place the hero title in a styled DIV/P
            # or ARIA heading instead of H1. Limit to event-specific selectors;
            # do not mine all headings or guess from product/ticket cards.
            try:
                event_heads = page.locator(
                    '[data-testid="event-title"], [data-testid="eventTitle"], '
                    '[class~="event-title"], [class*="eventTitle"], '
                    '[class*="EventTitle"], [class*="event_title"], '
                    '[id="event-title"], [id="eventTitle"], [id="event_name"], '
                    '[data-testid="event_name"], [data-qa="event-title"], '
                    '[class*="eventName"], [class*="EventName"], '
                    '[class*="event-name"], [class*="event_name"], '
                    'main [role="heading"][aria-level="1"], '
                    '[itemscope][itemtype*="schema.org/Event"] [itemprop="name"]'
                ).all_inner_texts(timeout=1500)
                for value in event_heads[:6]:
                    if isinstance(value, str) and len(value.strip()) <= 200:
                        add_title(value, 'event_heading')
            except Exception:
                pass
            try:
                add_title(page.title(), 'document')
            except Exception:
                pass
            # Event JSON-LD names remain restricted by the existing exact-URL
            # event-only selector; unrelated product and website schemas ignored.
            try:
                blocks = page.locator('script[type="application/ld+json"]').all_text_contents(timeout=1300)
                for value in structured_event_titles(blocks, url):
                    add_title(value, 'jsonld')
            except Exception:
                pass
            # First-party, server-embedded page state from THIS SAME event URL.
            # No API/second request, page script execution, or access-control bypass.
            # Only explicit event objects are searched, never recommendations or
            # arbitrary product titles. The raw page-state JSON is never saved.
            try:
                state_blocks = page.locator('script#__NEXT_DATA__').all_text_contents(timeout=1300)
                for value in structured_page_state_event_titles(state_blocks, url):
                    add_title(value, 'event_state')
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
                    'text': body[:30000], 'titles': titles,
                    'title_sources': title_sources}
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


# v21.17: Next.js server-provided page state can contain the complete event
# title even when og:title / document.title intentionally end in ellipsis.
# Search ONLY the primary event object under pageProps, NOT related events,
# ticket products, arbitrary embedded JavaScript, or client-wide stores.
PAGE_STATE_EVENT_KEYS = (
    'event', 'eventInfo', 'eventDetail', 'eventDetails', 'eventData',
    'event_info', 'event_detail', 'event_data',
)
PAGE_STATE_TITLE_KEYS = ('eventTitle', 'event_title', 'eventName', 'event_name')
PAGE_STATE_URL_KEYS = ('url', 'eventUrl', 'event_url', 'eventPageUrl', 'event_page_url')


def structured_page_state_event_titles(blocks, url):
    """Unique, explicit event name from the primary exact-URL page state.

    A matching page URL is already checked by browser_fetcher. If an event
    record additionally supplies its own URL, that must match too. Never
    derive an event name from a description, ticket, organizer, or product.
    """
    titles = set()
    for source in (blocks[:2] if isinstance(blocks, list) else []):
        if not isinstance(source, str) or len(source) > 500000:
            continue
        try:
            root = json.loads(source)
        except (TypeError, ValueError):
            continue
        if not isinstance(root, dict):
            continue
        props = root.get('props')
        page_props = props.get('pageProps') if isinstance(props, dict) else None
        if not isinstance(page_props, dict):
            continue
        # No recursive search: related/promoted events can coexist in state.
        # `data.event` is an explicitly named primary-event envelope often
        # used by server-side page props, not an arbitrary search of `data`.
        primary_nodes = [page_props.get(key) for key in PAGE_STATE_EVENT_KEYS]
        nested = page_props.get('data')
        if isinstance(nested, dict):
            primary_nodes.extend(nested.get(key) for key in PAGE_STATE_EVENT_KEYS)
        for node in primary_nodes:
            if not isinstance(node, dict):
                continue
            embedded_urls = [node.get(k) for k in PAGE_STATE_URL_KEYS
                             if isinstance(node.get(k), str) and node.get(k).strip()]
            if embedded_urls and any(v12.exact_event_url(u) != url for u in embedded_urls):
                continue
            # An ordinary `title` / `name` is only accepted inside an explicit
            # primary event object (never at the pageProps root).
            candidates = [node.get(k) for k in (*PAGE_STATE_TITLE_KEYS, 'title', 'name')]
            for value in candidates:
                if isinstance(value, str):
                    valid = v14.clean_title(value)
                    if valid and not LP_GENERIC_TITLE.fullmatch(valid) and not _site_common_title(valid):
                        titles.add(valid)
    return list(titles) if len(titles) == 1 else []




# v21.9: An OFFICIAL title is stronger than a URL-paired Discord shorthand.
# Browser access stays on the exact original LivePocket event URL; CAPTCHA,
# login, robot checks and redirected pages are never bypassed.
OFFICIAL_TITLE_CHECK_PER_RUN = 2
OFFICIAL_TITLE_RETRY_MAX = 3
OFFICIAL_TITLE_CHECK_WAIT = timedelta(hours=6)
# First official-title attempt is more urgent for event names supplied as
# provisional Discord shorthand. Subsequent attempts use the longer backoff.
OFFICIAL_TITLE_INITIAL_WAIT = timedelta(hours=2)
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
    'official_title_queue_reason', 'official_title_next_eligible_at',
    'official_title_attempts',
    'official_page_reason', 'official_page_http_status',
)
REPORT_COLUMNS = REPORT_COLUMNS + OFFICIAL_COLUMNS + (
    'title_diagnostic_reason', 'title_diagnostic_candidates',
    'title_diagnostic_checked_at', 'title_diagnostic_title_detected',
    'title_diagnostic_detail', 'title_diagnostic_sources',
    'title_diagnostic_valid_candidates',
    'title_diagnostic_rejection_codes', 'title_diagnostic_meta_template_cleaned',
    'title_diagnostic_heading_seen', 'title_diagnostic_recovery_probe',
    'title_page_identity',
)


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
    # Discord's event summary is a provisional product source as well. It
    # must never outrank a product explicitly quoted in an exact-URL official
    # event title (or a verified product label from that same page).
    return source.startswith(('discord_url_pair:', 'discord_embed:', 'discord_post:'))



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
        if source not in ('v21_9_official_exact_url_title', MANUAL_TITLE_SOURCE) or title != pub.get('event_title'):
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

def _official_title_status(url, ritem, pub, *, state, now):
    """Explain official-title eligibility without touching the network.

    An initial 2-hour wait applies only to unverified Discord titles. A
    subsequent official check waits 6 hours; three checks are the maximum.
    Returned timestamps are UTC ISO-8601 and may be displayed in the report.
    """
    if not pub.get('event_title'):
        return 'no_event_title', ''
    if not title_is_provisional(ritem):
        return 'nonprovisional_title', ''
    if url in set(state.get('v14', {}).get('pending_new_urls', [])):
        return 'new_queue_has_priority', ''
    deadline = v11.parse_datetime(pub.get('application_end_at'))
    if not deadline:
        return 'no_confirmed_deadline', ''
    if not (now - OFFICIAL_TITLE_GRACE < deadline < now + timedelta(days=7)):
        return 'outside_application_window', ''
    record = state.get('v21_9', {}).get('official_checks', {}).get(url, {})
    attempts = recheck_attempts(record)
    if attempts >= OFFICIAL_TITLE_RETRY_MAX:
        return 'official_check_limit_reached', ''
    checks = state.get('v13', {}).get('browser_checks', {})
    checked_at = v19.v18.v17.check_time(checks.get(url, {}).get('checked_at'))
    official_at = v19.v18.v17.check_time(record.get('checked_at'))
    if official_at:
        due = official_at + OFFICIAL_TITLE_CHECK_WAIT
        # A previous official check is the authority for the retry cooldown,
        # even if the generic browser checked the same URL afterwards.
        if now < due:
            return 'waiting_official_retry', due.astimezone(timezone.utc).isoformat()
    elif checked_at:
        due = checked_at + OFFICIAL_TITLE_INITIAL_WAIT
        if now < due:
            return 'waiting_initial_page_gap', due.astimezone(timezone.utc).isoformat()
    return 'eligible', ''


def official_title_diagnostics(raw, public, *, now=None, limit=OFFICIAL_TITLE_CHECK_PER_RUN):
    """Return queue, human-auditable summary and per-URL reasons."""
    now = v14._utc(now)
    rindex, pindex = v11.indices(raw, public)
    state = raw.get('collector_state', {})
    from collections import Counter
    counts = Counter()
    details = {}
    options = []
    cooldown = v14._cooldown_active(state.get('v14', {}), now)
    for url, ritem in rindex.items():
        pub = pindex[url]
        reason, due_at = _official_title_status(url, ritem, pub, state=state, now=now)
        if cooldown and reason == 'eligible':
            reason = 'global_access_cooldown'
        details[url] = (reason, due_at)
        counts[reason] += 1
        if reason == 'eligible':
            options.append((v11.parse_datetime(pub.get('application_end_at')), url))
    options.sort()
    result = [url for _, url in options[:max(0,limit)]]
    for _, url in options[max(0,limit):]:
        details[url] = ('queued_after_limit', '')
    return result, dict(counts), details


def official_title_candidates(raw, public, *, now=None, limit=OFFICIAL_TITLE_CHECK_PER_RUN):
    """Select up to two urgent provisional Discord titles, with safe cooldowns."""
    return official_title_diagnostics(raw, public, now=now, limit=limit)[0]


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
    manual_recheck = os.getenv('LIVEPOCKET_DEVELOPER_RECHECK') == 'true'
    if manual_recheck:
        # The button deliberately requests a full 12 historical URLs. The
        # standard 5-minute schedule never receives this environment flag.
        background_limit = MANUAL_RECHECK_LIMIT
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    verified_titles = read_verified_titles()
    manual_urls = manual_recheck_candidates(raw, public) if manual_recheck else []
    with use_store_aware_missing(), use_manual_background(manual_urls if manual_recheck else []):
        work = v19.v18.plan(raw, public, new_limit=new_limit,
                           background_limit=background_limit,
                           retry_limit=0 if manual_recheck else retry_limit)
    title_limit = v14.safe_limit('LIVEPOCKET_V21_3_TITLE_PER_RUN', 2, 3)
    titles_due = [] if manual_recheck else title_recheck_candidates(raw, public, limit=title_limit)
    official_due, official_counts, _ = (
        official_title_diagnostics(raw, public, limit=0 if manual_recheck else OFFICIAL_TITLE_CHECK_PER_RUN)
        if background_limit else ([], {'background_not_enabled': len(raw.get('items', []))}, {}))
    browser_needed = bool(work['browser_needed'] or titles_due or official_due)
    if sys.argv[1] == 'plan':
        print('v21.16 browser plan:', work, 'manual_selected:', len(manual_urls), 'title_due:', len(titles_due),
              'official_due:', len(official_due), 'official_reasons:', official_counts,
              'official_urls:', [u.rsplit('/', 1)[-1] for u in official_due],
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
                       title_limit=title_limit,
                       manual_recheck=manual_recheck,
                       manual_limit=MANUAL_RECHECK_LIMIT,
                       verified_titles=verified_titles)
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
