#!/usr/bin/env python3
"""LivePocket v19.1: one event URL, zero or more explicitly verified stores.

Runs v18's existing browser priorities *once* and examines the SAME browser
responses for a clearly labelled participating-store list. No paid API, no
second HTTP request, no location/name inference and no URL duplication.

Schema: stores: [{"name": "...", "prefecture": "..."}, ...]
The legacy store_name/prefecture fields are left untouched. v7 discards stores
from its public allowlist, so this step re-publishes them from raw every run.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v15 as v15
import livepocket_v18 as v18

RAW_PATH = v14.RAW_PATH
PUBLIC_PATH = v14.PUBLIC_PATH
MANUAL_PATH = Path(os.getenv('LIVEPOCKET_V19_STORES_FILE', 'livepocket_verified_stores.csv'))
REVIEW_PATH = v15.REVIEW_PATH
REPORT_COLUMNS = v18.COLUMNS + ('store_count', 'store_names', 'store_prefectures', 'store_sources')
MANUAL_COLUMNS = ('url', 'store_name', 'prefecture', 'verified', 'source_url')
MAX_STORES = 35
STORE_HEADING = re.compile(
    r'^(?:【\s*)?(?:対象店舗(?:一覧)?|販売店舗(?:一覧)?|実施店舗(?:一覧)?|開催店舗(?:一覧)?|受取店舗(?:一覧)?|'
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


def safe_name(s, *, strict_retail=False):
    """Reject prose, truncation, formula-like values and unconstrained stores."""
    if not isinstance(s, str):
        return None
    s = re.sub(r'[\s\u3000]+', ' ', s).strip(' \u3000「」『』')
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
    piece = LIST_PREFIX.sub('', piece.strip()).strip(' \u3000-—')
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
        return []
    # If several separately labelled lists conflict, do not combine them.
    signatures = {tuple((e['name'], e['prefecture']) for e in g) for g in candidate_groups}
    if len(signatures) > 1:
        return []
    unique = {}
    for item in candidate_groups[0]:
        # Two locations can have the same display name in different regions.
        unique[(item['name'], item['prefecture'])] = item
    return list(unique.values())


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
            if name and pref in (v10.PREFS | {''}):
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
    # If a store already has a confirmed prefecture, don't also duplicate the
    # exact same shop as an unlocated entry. Distinct confirmed prefectures are
    # separate store locations even where names coincide.
    for name, pref in list(entries):
        if not pref and any(n == name and p for n,p in entries):
            entries.pop((name,pref))
    return list(entries.values())[:MAX_STORES]


def apply_stores(raw, public, seen_pages=None, manual=None):
    seen_pages = seen_pages or {}
    manual = manual or {}
    rindex, pindex = v11.indices(raw, public)
    stats = {'store_lists_added': 0, 'multi_store_urls': 0, 'total_linked_stores': 0,
             'stores_from_pages': 0, 'stores_from_discord': 0, 'stores_from_csv': 0}
    for url, r in rindex.items():
        p = pindex[url]
        result = seen_pages.get(url) or {}
        page = []
        if result.get('status') == 'ok' and v12.exact_event_url(result.get('final_url')) == url:
            page = page_stores(result.get('text'))
        # Discord text is safe to attribute only when this message contains
        # exactly ONE distinct LivePocket event URL (not a roundup).
        excerpt = r.get('post_excerpt')
        discord = []
        if isinstance(excerpt, str) and set(DISCORD_URL_RE.findall(excerpt)) == {url}:
            discord = page_stores(excerpt)
        before = r.get('stores') or []
        legacy = r.get('store_name') or p.get('store_name') or ''
        product = r.get('product_name') or p.get('product_name') or ''
        # v5 sometimes copied an item name into the old store_name field.
        # Do not convert that known placeholder into a verified store entry.
        if isinstance(legacy,str) and isinstance(product,str) and product and (
                re.sub(r'\s+', '', legacy.lstrip('* ')).casefold().startswith(
                    re.sub(r'\s+', '', product).casefold())):
            legacy = ''
        merged = merge_stores(before, page + discord, manual.get(url),
                              legacy, r.get('prefecture') or p.get('prefecture') or '')
        if merged:
            r['stores'] = copy.deepcopy(merged)
            p['stores'] = copy.deepcopy(merged)
            if merged != before:
                stats['store_lists_added'] += 1
            if page:
                r.setdefault('field_sources', {})['stores'] = 'v19_livepocket_explicit_store_list'
                stats['stores_from_pages'] += 1
            if discord:
                r.setdefault('field_sources', {})['stores'] = 'v19_discord_single_event_store_list'
                stats['stores_from_discord'] += 1
            if manual.get(url):
                r.setdefault('field_sources', {})['stores'] = 'v19_user_verified_store_csv'
                stats['stores_from_csv'] += 1
        else:
            r.pop('stores', None)
            p.pop('stores', None)
        if len(merged) > 1:
            stats['multi_store_urls'] += 1
        stats['total_linked_stores'] += len(merged)
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
