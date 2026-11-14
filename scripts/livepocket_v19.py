#!/usr/bin/env python3
"""LivePocket v19.1: one event URL, zero or more explicitly verified stores.

Runs v18's existing browser priorities *once* and examines the SAME browser
responses for a clearly labelled participating-store list. No paid API, no
second HTTP request, no location/name inference and no URL duplication.

Schema: stores: [{"name": "...", "prefecture": "..."}, ...]
The primary store_name/prefecture fields and their source markers are updated
with the same page-backed list in raw and public catalogs.
"""
from __future__ import annotations
import livepocket_arrival_policy as arrival_policy
import livepocket_store_policy as store_policy

import copy
import csv
import io
import json
import os
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v15 as v15
import livepocket_v18 as v18
from livepocket_store_name_normalize import normalize as normalize_store_name

RAW_PATH = v14.RAW_PATH
PUBLIC_PATH = v14.PUBLIC_PATH
MANUAL_PATH = Path(os.getenv('LIVEPOCKET_V19_STORES_FILE', 'livepocket_verified_stores.csv'))
REVIEW_PATH = v15.REVIEW_PATH
REPORT_COLUMNS = v18.COLUMNS + ('store_count', 'store_names', 'store_prefectures', 'store_sources')
MANUAL_COLUMNS = ('url', 'store_name', 'prefecture', 'verified', 'source_url')
MAX_STORES = 35
STORE_HEADING = re.compile(
    r'^(?:【\s*)?(?:対象店舗(?:一覧)?|販売店舗(?:一覧)?|(?:抽選販売)?実施店舗(?:一覧)?|開催店舗(?:一覧)?|受取店舗(?:一覧)?|'
    r'参加店舗(?:一覧)?|取扱店舗(?:一覧)?|店舗名|販売店(?:舗)?|お受け取り店舗)(?:\s*】)?\s*(?:[：:]\s*(.*))?\s*$', re.I)
OTHER_HEADING = re.compile(
    r'^(?:【[^】]{2,45}】|(?:応募|申込|抽選|注意事項|受付|開催日|イベント名|対象商品|商品名|'
    r'チケット|営業時間|販売期間|概要|お問い合わせ|住所|アクセス|店舗一覧の注意)[^：:]{0,12}[：:]?)$')
LIST_PREFIX = re.compile(r'^\s*(?:[-*・●◯■]|\d{1,2}[.)．、]|[①-⑳])\s*')
PREF_ORDER = sorted(v10.PREFS, key=len, reverse=True)
PREF_RE = re.compile('|'.join(re.escape(p) for p in PREF_ORDER))
GENERIC_STORE = re.compile(r'(?:^全国.*店舗$|^店舗.*一覧$|^各店舗$|^対象店舗$|^複数店舗$|^取扱店舗$|^実施店舗$|^こちら$|^詳細はこちら$|^別途案内$|^未定$|^全店舗$)')
DANGEROUS = re.compile(r'http[s]?://|[<>\ufffd]|\.{3}|…|[\n\r\t]|^[-+=@]')
DISCORD_URL_RE = re.compile(r'https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}')
RETAIL = re.compile(r'店$|(?:SHOP|STORE|TSUTAYA|HMV|BOOKS|トレカ|古本市場|ふるいち|キデイランド|イトーヨーカドー|晴れる屋|麦わらストア|ジャンプショップ)', re.I)
OVERVIEW_RETAIL = re.compile(
    r'(?:店|ショップ|SHOP|STORE|売場|売り場|トレカコーナー)$|'
    r'店\s*[0-9０-９]+\s*(?:階|[fFＦｆ])$|'
    r'店\s*(?:[0-9０-９]+(?:階|[fFＦｆ])\s*)?(?:TSUTAYA\s*)?レジ$|'
    r'(?:TRADING\s*CARD|トレカ|ショップ)', re.I)
OVERVIEW_PLACEHOLDERS = frozenset((
    '会場', '会場未定', '会場未確認', '店舗', '対象店舗', '各店舗', '各店',
    '販売元', '受取場所', '全国', 'オンライン', '実店舗なし',
))
RETAIL_DRAW_TITLE = re.compile(r'抽選販売|抽選予約|購入権|販売権', re.I)
CARD_GOODS_TITLE = re.compile(
    r'カードゲーム|トレーディングカード|ポケモンカード|ポケカ|ワンピースカード|遊戯王|'
    r'トレカ|拡張パック|ブースターパック|デッキ|\bTCG\b|\bBOX\b', re.I)
TICKET_DATE = r'(?:\d{4}\s*[年/／]\s*)?\d{1,2}\s*[月/／]\s*\d{1,2}\s*日?'
TICKET_PURCHASE_PREFIX = re.compile(
    rf'^{TICKET_DATE}\s*(?:[〜～~–—－-]|から)\s*{TICKET_DATE}\s*購入可能\s*[・･:：]\s*')


def unwrap_store_label(value):
    """Remove paired presentation quotes, preserving brackets inside a name."""
    value = value.strip()
    pairs = {'[': ']', '［': '］', '【': '】', '「': '」', '『': '』'}
    while len(value) >= 2 and pairs.get(value[0]) == value[-1]:
        opening, closing = value[0], value[-1]
        inner = value[1:-1].strip()
        # Separate labels must not be mistaken for one enclosing pair.
        if opening in inner or closing in inner:
            break
        value = inner
    return value


def safe_name(s, *, strict_retail=False):
    """Reject prose, truncation, formula-like values and unconstrained stores."""
    if not isinstance(s, str) or arrival_policy.unknown_shop(s):
        return None
    s = unwrap_store_label(re.sub(r'[\s\u3000]+', ' ', s))
    # A ticket can put a purchase window before the actual branch name.
    s, removed_window = TICKET_PURCHASE_PREFIX.subn('', s, count=1)
    strict_retail = strict_retail or bool(removed_window)
    if not (2 <= len(s) <= 100) or DANGEROUS.search(s) or GENERIC_STORE.search(s) or re.search(r"[。！？!?]|(?:できます|ください|可能です|以下の|上記|ご確認|対象となります)", s):
        return None
    if (re.search(r'[、,，;；]', s) or re.search(r'(?:申込期間|応募締切|販売開始|イベント開催|当選者|会員登録|チケット)', s)):
        return None
    if not re.search(r'[ぁ-んァ-ヶ一-龯A-Za-z]', s):
        return None
    if strict_retail and not RETAIL.search(s):
        return None
    return s


def store_part(piece, *, strict_retail=False):
    """Extract prefecture only when directly attached to THIS store entry."""
    if not isinstance(piece, str):
        return None
    piece = unwrap_store_label(LIST_PREFIX.sub('', piece.strip()).strip(' \u3000-—'))
    prefecture = ''
    # Explicit locality immediately BEFORE the store name.
    m = re.match(r'^(' + '|'.join(map(re.escape, PREF_ORDER)) + r')\s*[：:／/\-ー ]\s*(.+)$', piece)
    if m:
        prefecture, piece = m.group(1), m.group(2)
    else:
        # Explicit prefecture in parentheses immediately AFTER store name.
        m = re.match(r'^(.+?)[\s]*[（(](' + '|'.join(map(re.escape, PREF_ORDER)) + r')[）)]$', piece)
        if m:
            piece, prefecture = m.group(1), m.group(2)
    name = safe_name(piece, strict_retail=strict_retail)
    return {'name': name, 'prefecture': prefecture} if name else None


def split_store_line(line, *, strict_retail=False):
    """Split a labelled shop list, including Japanese full-width slashes (／).

    Do NOT split ASCII slashes: those can be part of a legitimate business name.
    A failed fragment invalidates the whole line instead of keeping partial data.
    """
    s = line.strip()
    # A colon on a bullet may mark a locality; preserve it for store_part().
    parts = re.split(r'\s*[、,，;；／]\s*', s)
    if len(parts) > MAX_STORES or any(not p.strip() for p in parts):
        return []
    result = [store_part(p, strict_retail=strict_retail) for p in parts]
    return result if all(result) else []


def normalize_store_heading(s):
    """Accept headings like 【対象9店舗】 without weakening unlabeled parsing."""
    s = s.strip()
    if s.startswith('【') and s.endswith('】'):
        s = s[1:-1].strip()
    s = re.sub(r'^[①-⑳]\s*', '', s)
    s = re.sub(r'^(対象|販売|実施|開催|受取|参加|取扱)\s*[0-9０-９]+\s*店舗', r'\1店舗', s)
    return s


# Ticket cards can use either 【店舗名】商品 or 店舗名【再販分】商品
# without a separate "対象店舗" heading.
# Count a shop only when the name looks like a retail location AND
# the card has a ticket-status/price marker shortly thereafter.  Two or more
# distinct ticket options are required; a single bracketed mention is not an
# independently verified multi-store list.
TICKET_SHOP_TITLE = re.compile(
    r'^\s*(?:【\s*(?P<bracketed>[^】\r\n]{2,90}店)\s*】|'
    r'(?P<leading>[^【】\r\n]{2,90}店)\s*【再販分】)(?P<product>[^\r\n]*)$')
TICKET_CARD_MARKER = re.compile(r'(?:販売中|販売終了|受付中|受付終了|販売予定|分配不可|￥|¥|予定枚数終了|受付締切)')


def ticket_option_stores(text):
    """Extract distinct shop names from clearly identifiable ticket cards."""
    if not isinstance(text, str) or '受付・チケット情報' not in text:
        return []
    lines = [line.strip() for line in text.splitlines()]
    matches = []
    for idx, line in enumerate(lines):
        m = TICKET_SHOP_TITLE.match(line)
        if not m:
            continue
        name = safe_name(m.group('bracketed') or m.group('leading'), strict_retail=True)
        if not name:
            continue
        following = []
        for nextline in lines[idx+1:idx+11]:
            if TICKET_SHOP_TITLE.match(nextline):
                break
            following.append(nextline)
        if not TICKET_CARD_MARKER.search('\n'.join(following)):
            continue
        matches.append({'name': name, 'prefecture': ''})
        if len(matches) > MAX_STORES:
            return []
    distinct = list({m['name']: m for m in matches}.values())
    return distinct if len(distinct) >= 2 else []


def page_stores(text):
    """Only interpret a contiguous, clearly labelled list of participating stores.

    A single detached mention of another shop somewhere in page body is NOT
    enough to claim that it is an applicable store.
    """
    if not isinstance(text, str):
        return []
    lines = [line.strip() for line in text.splitlines()]
    candidate_groups = []
    for idx, line in enumerate(lines):
        header = STORE_HEADING.fullmatch(normalize_store_heading(line))
        if not header:
            continue
        group = []
        inline = (header.group(1) or '').strip()
        if inline:
            group = split_store_line(inline, strict_retail=False)
        else:
            for raw in lines[idx+1:idx+1+MAX_STORES+2]:
                if not raw or OTHER_HEADING.fullmatch(raw) or STORE_HEADING.fullmatch(normalize_store_heading(raw)):
                    break
                prefixed = bool(LIST_PREFIX.match(raw))
                # A single unbulleted value after label is valid. Multiple
                # unbulleted prose lines are too risky: need retail names.
                # An explicitly labelled multi-store slash/comma list is
                # sufficiently structured even when shop names omit the 店 suffix.
                delimited = any(mark in raw for mark in ('／', '、', '，', ';', '；'))
                entries = split_store_line(raw, strict_retail=not (prefixed or delimited))
                if not entries:
                    break
                group.extend(entries)
                if len(group) > MAX_STORES:
                    group = []
                    break
                # The singular 店舗名 label usually refers to one value.
                if re.search(r'^店舗名', line):
                    break
        if group:
            candidate_groups.append(group)
    if not candidate_groups:
        return ticket_option_stores(text)
    # If several separately labelled lists conflict, do not combine them.
    signatures = {tuple((e['name'], e['prefecture']) for e in g) for g in candidate_groups}
    if len(signatures) > 1:
        return []
    unique = {}
    for item in candidate_groups[0]:
        # Two locations can have the same display name in different regions.
        unique[(item['name'], item['prefecture'])] = item
    return list(unique.values())


def overview_name_key(name):
    """Match named branches using the shared master's normalizer, never fuzzily."""
    return normalize_store_name(unicodedata.normalize('NFKC', str(name or '')))


def overview_retail_draw(observation):
    """Require a goods purchase draw in an event-specific heading."""
    for title, source in zip(observation.get('titles') or [], observation.get('title_sources') or []):
        if source not in ('h1', 'event_heading', 'jsonld', 'event_state') or not isinstance(title, str):
            continue
        title = unicodedata.normalize('NFKC', title)
        if RETAIL_DRAW_TITLE.search(title) and CARD_GOODS_TITLE.search(title):
            return True
    return False


def overview_store(observation, *, allow_explicit=False):
    """Use a named retail venue with an explicit prefecture as a fallback."""
    if observation.get('page_identity') != 'event_confirmed':
        return None
    store = store_part(observation.get('overview_venue'))
    if (not store or not store['prefecture'] or store['name'] in v10.PREFS
            or overview_name_key(store['name']) in OVERVIEW_PLACEHOLDERS):
        return None
    # An unreadable or conflicting explicit list must not become one store.
    if not allow_explicit and any(STORE_HEADING.fullmatch(normalize_store_heading(line))
           for line in (observation.get('text') or '').splitlines()):
        return None
    # A suffix is sufficient for legacy shop labels, but no longer required.
    # Other names need an exact master match (including prefecture), or the
    # same branch as the official seller on an explicitly retail draw page.
    master_match = observation.get('overview_master_prefecture') == store['prefecture']
    seller = store_part(observation.get('overview_seller'))
    seller_match = bool(seller and overview_name_key(seller['name']) == overview_name_key(store['name'])
                        and (not seller['prefecture'] or seller['prefecture'] == store['prefecture'])
                        and overview_retail_draw(observation))
    if not (OVERVIEW_RETAIL.search(store['name']) or master_match or seller_match):
        return None
    return store


def observation_stores(observation):
    """Share page-only location resolution between scheduled and manual fetches."""
    rows = page_stores(observation.get('text'))
    source = 'v19_livepocket_explicit_store_list'
    if not rows:
        name, source = v15.explicit_store(observation.get('text'))
        store = store_part(name) if name else None
        if store:
            rows = [store]
        else:
            venue = overview_store(observation)
            if venue:
                rows, source = [venue], 'v19_livepocket_overview_venue'
    if not rows:
        online = online_store(observation)
        if online:
            rows, source = [online], 'v19_livepocket_online_shop'
    if not rows and observation.get('page_identity') == 'event_confirmed':
        from livepocket_yellow_submarine import page_chain_stores
        rows = page_chain_stores(observation)
        if rows:
            source = 'v19_livepocket_explicit_chain_scope'
    # An explicit branch in the details/tickets can omit its prefecture even
    # when the same branch has a fully labelled venue above. Fill that branch
    # only; never assign one overview region to every shop in a multi-store list.
    venue = overview_store(observation, allow_explicit=True) if rows else None
    if venue:
        for row in rows:
            if (not row.get('prefecture')
                    and overview_name_key(row['name']) == overview_name_key(venue['name'])):
                row['prefecture'] = venue['prefecture']
    return rows, source


def online_store(observation):
    """An explicitly online goods draw uses its named web shop, not a company."""
    if observation.get('page_identity') != 'event_confirmed':
        return None
    venue = re.sub(r'\s*[（(][^（）()]{2,8}[）)]$', '', str(observation.get('overview_venue') or ''))
    if venue not in ('オンライン', 'ECサイト上', 'サイト上', 'オンラインショップ', '通販'):
        return None
    text = str(observation.get('text') or '')
    # Online registration for an in-store pickup is not a mail-order shop.
    if not re.search(r'発送|配送|送料', text) or re.search(r'発送(?:は|を)?(?:行いません|いたしません|しません)|郵送対応は致しません', text):
        return None
    titles = [title for title, source in zip(observation.get('titles') or [], observation.get('title_sources') or [])
              if source in ('h1', 'event_heading', 'jsonld', 'event_state') and isinstance(title, str)]
    if not any(CARD_GOODS_TITLE.search(title) and re.search(r'抽選|購入権', title) for title in titles):
        return None
    names = set()
    for title in titles:
        match = re.match(r'^([^【「\s]{2,50}?(?:通販|オンラインショップ))\s', title)
        if match and safe_name(match.group(1)):
            names.add(match.group(1))
    if len(names) > 1:
        return None
    name = next(iter(names)) if names else safe_name(observation.get('overview_seller'))
    # A corporate seller remains a corporate seller; a title can explicitly
    # identify the consumer-facing online shop instead (e.g. ハレツー通販).
    if not name or re.search(r'株式会社|有限会社|合同会社|事務局|運営会社', name):
        return None
    return {'name': name, 'prefecture': '全国'}


def read_manual(path, known_urls):
    """All-or-nothing validation; multiple verified rows per URL are allowed."""
    if not path.exists():
        return {}
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or any(key not in reader.fieldnames for key in MANUAL_COLUMNS):
            raise ValueError('v19 stores CSV: required columns ' + ', '.join(MANUAL_COLUMNS))
        groups = defaultdict(list)
        all_seen = set()
        for lineno, row in enumerate(reader, 2):
            if not any(isinstance(v, str) and v.strip() for v in row.values()):
                continue
            flag = (row.get('verified') or '').strip().lower()
            if flag not in ('yes', 'no', ''):
                raise ValueError(f'Line {lineno}: verified must be yes/no')
            if flag != 'yes':
                continue
            url = (row.get('url') or '').strip()
            if not v10.valid_url(url) or url not in known_urls:
                raise ValueError(f'Line {lineno}: unknown event URL')
            if (row.get('source_url') or '').strip() != url:
                raise ValueError(f'Line {lineno}: source_url must equal the same event URL')
            name = safe_name((row.get('store_name') or '').strip())
            pref = (row.get('prefecture') or '').strip()
            if not name or (pref and pref not in v10.PREFS):
                raise ValueError(f'Line {lineno}: invalid store name / prefecture')
            key = (url, name)
            if key in all_seen:
                raise ValueError(f'Line {lineno}: duplicate verified store')
            all_seen.add(key)
            groups[url].append({'name': name, 'prefecture': pref})
            if len(groups[url]) > MAX_STORES:
                raise ValueError(f'Line {lineno}: too many verified stores')
        return groups


def merge_stores(existing, page, manual, legacy_name='', legacy_pref=''):
    """Preserve independently established locations, even if names repeat."""
    entries = {}
    for source in (existing, page, manual):
        for s in source or []:
            if not isinstance(s, dict):
                continue
            name = safe_name(s.get('name'))
            pref = s.get('prefecture') or ''
            if name and pref in store_policy.AREAS:
                entries[(name, pref)] = {'name': name, 'prefecture': pref}
    legacy_name = safe_name(legacy_name)
    # Older versions used one chain-level placeholder (e.g. イトーヨーカドー)
    # where the actual event has multiple shop locations.  When an explicitly
    # labelled multi-store list replaces that singleton, do not count the
    # placeholder as an additional participating shop.
    explicit = [s for s in (page or []) + (manual or []) if isinstance(s, dict)]
    if len({(s.get('name'), s.get('prefecture') or '') for s in explicit}) >= 2:
        if len(existing or []) == 1 and isinstance(existing[0], dict):
            old = existing[0]
            old_name, old_pref = old.get('name'), old.get('prefecture') or ''
            if (old_name == legacy_name and not old_pref
                    and not any(s.get('name') == old_name for s in explicit)):
                entries.pop((old_name, ''), None)
    if not entries and legacy_name:
        pref = legacy_pref if legacy_pref in v10.PREFS else ''
        entries[(legacy_name,pref)] = {'name': legacy_name, 'prefecture': pref}
    elif legacy_name:
        # Only enrich the one matching location, not every shop under this URL.
        same = [key for key in entries if key[0] == legacy_name]
        if len(same) == 1 and same[0][1] == '' and legacy_pref in v10.PREFS:
            updated = {}
            for key, value in entries.items():
                if key == same[0]:
                    updated[(legacy_name,legacy_pref)] = {'name': legacy_name, 'prefecture': legacy_pref}
                else:
                    updated[key] = value
            entries = updated
    # Prefer a single exact-store verified prefecture over an unknown entry.
    # Never infer a region for another store, and preserve conflicting verified
    # regions for explicit manual review.
    for verified_store in manual or []:
        if not isinstance(verified_store, dict):
            continue
        name = safe_name(verified_store.get('name'))
        pref = verified_store.get('prefecture') or ''
        if not name or pref not in v10.PREFS:
            continue
        known = {p for n, p in entries if n == name and p}
        if known and known != {pref}:
            continue
        entries.pop((name, ''), None)
        entries[(name, pref)] = {'name': name, 'prefecture': pref}
    # If a store already has a confirmed prefecture, don't also duplicate the
    # exact same shop as an unlocated entry. Distinct confirmed prefectures are
    # separate store locations even where names coincide.
    for name, pref in list(entries):
        if not pref and any(n == name and p for n,p in entries):
            entries.pop((name,pref))
    return list(entries.values())[:MAX_STORES]


def apply_stores(raw, public, seen_pages=None, manual=None):
    """Only merge same-event official page facts and verified manual rows."""
    arrival_policy.clean_placeholders(raw, public)
    seen_pages, manual = seen_pages or {}, manual or {}
    rindex, pindex = v11.indices(raw, public)
    stats = {'store_lists_added': 0, 'multi_store_urls': 0, 'total_linked_stores': 0,
             'stores_from_pages': 0, 'stores_from_discord': 0, 'stores_from_csv': 0}
    for url, r in rindex.items():
        p = pindex[url]
        before = copy.deepcopy(r.get('stores') or [])
        store_policy.sanitize_pair(r, p)
        retained = copy.deepcopy(r.get('stores') or [])
        result = seen_pages.get(url) or {}
        exact_page = result.get('status') == 'ok' and v12.exact_event_url(result.get('final_url')) == url
        page, page_source = observation_stores(result) if exact_page else ([], '')
        # An independently captured official event heading is page evidence too.
        # Never extract a store from a Discord event-title preview.
        origin = str((r.get('field_sources') or {}).get('event_title') or '')
        if not page and not retained and origin.startswith(('v14_livepocket_', 'v21_official_', 'v21_9_official_exact_url_title')):
            heading = re.match(r'^【\s*([^【】]{2,90}?店)\s*】', str(r.get('event_title') or ''))
            shop = store_part(heading.group(1), strict_retail=True) if heading else None
            if shop:
                page = [shop]
                page_source = 'v22_official_title_shop'
        # A newly read page replaces old locations. A failed page preserves only
        # facts already backed by a page or explicit manual verification.
        retained_manual = r.get('store_location_source') == store_policy.MANUAL and not manual.get(url)
        chosen = retained if retained_manual else merge_stores([], page if page else retained, manual.get(url))
        source = store_policy.MANUAL if manual.get(url) or retained_manual else store_policy.PAGE
        store_policy.set_locations(r, p, chosen, source)
        if chosen and not retained_manual and (page or manual.get(url)):
            fields = r.setdefault('field_sources', {})
            source_label = 'v19_user_verified_store_csv' if manual.get(url) else page_source
            for key in ('store_name', 'stores'):
                fields[key] = source_label
            fields.pop('stores_prefectures', None)
            fields.pop('prefecture', None)
            if r.get('prefecture'):
                fields['prefecture'] = source_label
        if chosen != before:
            stats['store_lists_added'] += 1
        if page and not retained_manual:
            stats['stores_from_pages'] += 1
        if manual.get(url):
            stats['stores_from_csv'] += 1
        stats['multi_store_urls'] += int(len(chosen) > 1)
        stats['total_linked_stores'] += len(chosen)
    public['schema_version'] = 19
    raw.setdefault('field_counts', {})['stores_events'] = sum(bool(x.get('stores')) for x in raw['items'])
    return stats


def enrich_reports(raw, public, review, content):
    _, pidx = v11.indices(raw, public)
    for row in review:
        s = pidx[row['url']].get('stores') or []
        if not s:
            continue
        row['needs_store'] = ''
        row['store_name'] = v10.csv_escape(' / '.join(x['name'] for x in s))
        if all(x['prefecture'] for x in s):
            row['needs_prefecture'] = ''
        reasons = set(filter(None, (row.get('review_reason') or '').split(';')))
        reasons.discard('store_unknown')
        if all(x['prefecture'] for x in s):
            reasons.discard('prefecture_unknown')
        row['review_reason'] = ';'.join(sorted(reasons))
    # A multi-store event whose product/title is already known no longer
    # belongs in the missing-store/product manual review queue.
    review[:] = [row for row in review if row.get('needs_store') or row.get('needs_product')]
    for row in content:
        stores = pidx[row['url']].get('stores') or []
        row['store_count'] = len(stores)
        row['store_names'] = v10.csv_escape(' / '.join(s['name'] for s in stores))
        row['store_prefectures'] = v10.csv_escape(' / '.join(s['prefecture'] or '未確認' for s in stores))
        row['store_sources'] = 'v19_page_or_verified' if len(stores) > 1 else ('legacy_or_verified' if stores else '')
    return review, content


def process(raw, public, fetch, *, now=None, new_limit=15, background_limit=0,
            retry_limit=3, verified_rows=None):
    """Same network calls as v18; capture returned page text for store analysis."""
    seen = {}
    def capture(url):
        result = fetch(url)
        if isinstance(result, dict):
            seen[url] = copy.deepcopy(result)
        return result
    raw, public, review, deadlines, sources, content, stats = v18.process(
        raw, public, capture, now=now, new_limit=new_limit,
        background_limit=background_limit, retry_limit=retry_limit)
    urls = {x['url'] for x in raw['items']}
    verified_rows = verified_rows if verified_rows is not None else read_manual(MANUAL_PATH, urls)
    store_stats = apply_stores(raw, public, seen_pages=seen, manual=verified_rows)
    review, content = enrich_reports(raw, public, review, content)
    stats.update(store_stats)
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
        raise SystemExit('Usage: python scripts/livepocket_v19.py plan|process')
    raw, public = v14.read_pair()
    # Fail before any mutation if the operator's verified file is malformed.
    manual = read_manual(MANUAL_PATH, {item['url'] for item in raw['items']})
    new_limit = v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25)
    background_limit = (v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                        if v14.wants_background() else 0)
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    work = v18.plan(raw, public, new_limit=new_limit,
                    background_limit=background_limit, retry_limit=retry_limit)
    if sys.argv[1] == 'plan':
        print('v19 browser plan:', work)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
                f.write(f"browser_needed={'true' if work['browser_needed'] else 'false'}\n")
        return
    ready = os.getenv('LIVEPOCKET_V19_BROWSER_READY')
    if ready == 'false':
        new_limit = background_limit = retry_limit = 0
        work['browser_needed'] = False
    elif ready == 'true':
        work['browser_needed'] = True
    if work['browser_needed']:
        fetch, close = v14.browser_fetcher()
    else:
        def fetch(url):
            raise AssertionError('Unexpected browser access without plan')
        close = lambda: None
    try:
        out = process(raw, public, fetch, new_limit=new_limit,
                      background_limit=background_limit, retry_limit=retry_limit,
                      verified_rows=manual)
    finally:
        close()
    raw, public, review, deadlines, sources, content, stats = out
    for key, value in stats.items():
        print(f'{key}: {value}')
    print('raw_updated:', v11.write_json(RAW_PATH, raw))
    print('public_updated:', v11.write_json(PUBLIC_PATH, public))
    print('review_updated:', v10.write_csv(REVIEW_PATH, review))
    print('deadline_review_updated:', v11.write_csv(v14.REVIEW_PATH, deadlines))
    print('deadline_sources_updated:', v12.write_report(v14.SOURCES_PATH, sources))
    print('content_checks_updated:', write_content(v14.CHECKS_PATH, content))


if __name__ == '__main__':
    main()
