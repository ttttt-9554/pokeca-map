#!/usr/bin/env python3
"""LivePocket v15: enrich newly checked event pages without paid search.

Retains v14's proven snapshot/prepare/priority-queue/browser routines.
In the same browser check, read clearly labelled event/product/store values,
never guess values or overwrite confirmed data, and rebuild review reports.

Install next to livepocket_v10.py .. livepocket_v14.py.
Usage: python scripts/livepocket_v15.py process
"""
from __future__ import annotations

import copy
import csv
import io
import os
import re
from pathlib import Path

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14

RAW_PATH = v14.RAW_PATH
PUBLIC_PATH = v14.PUBLIC_PATH
DEADLINE_REVIEW_PATH = v14.REVIEW_PATH
DEADLINE_SOURCE_PATH = v14.SOURCES_PATH
CONTENT_PATH = v14.CHECKS_PATH
REVIEW_PATH = Path(os.getenv('LIVEPOCKET_REVIEW_FILE', 'livepocket_review_queue.csv'))

# Accept *labelled* values only. No free-form store/product guessing.
LABELS = {
    'event_title': (r'イベント名|公演名|催事名|抽選販売名|イベントタイトル', 160),
    'product_name': (r'対象商品名|対象商品|販売商品名|販売商品|商品名|抽選対象商品', 110),
    'store_name': (r'販売店舗名|開催店舗名|受取店舗名|対象店舗名|実施店舗名|店舗名|'
                   r'販売店舗|開催店舗|受取店舗|対象店舗|実施店舗|販売店', 110),
}
LABEL_PATTERN = {
    key: re.compile(r'^(?:' + expr + r')\s*(?:[：:]\s*(.*))?$', re.I)
    for key, (expr, _) in LABELS.items()
}
VENUE_RE = re.compile(r'^(?:開催場所|会場名|会場)\s*[：:]\s*(.+)$')
UNSAFE_TEXT = re.compile(r'(?:https?://|[\uFFFD]|\.\.\.|…|^[-+=@\t]|^\s*※|\n|\r)', re.I)
GENERIC = re.compile(r'^(?:未定|不明|なし|無し|複数店舗|各店舗|対象店舗|店舗|商品|イベント|チケット|販売|抽選|申込|受付中)$')
BAD_STORE = re.compile(r'(?:申込|申し込み|応募|受付|購入|確認|ご案内|について|注意事項|本イベント|^LivePocket$|^東京都$)')
BAD_PRODUCT = re.compile(r'(?:ご案内|注意事項|について|購入方法|申込方法|応募方法|お一人様|につき|^LivePocket$)')
OTHER_LABEL = re.compile(
    r'^(?:申込期間|応募期間|抽選期間|開催日|場所|商品名|対象商品|販売商品|店舗名|販売店舗|会場|イベント名|タイトル|注意事項|住所|チケット|受付期間|販売期間|販売日時|主催者|チケット販売|お知らせ|応募締切|お申し込み|販売数)(?:$|[：:])'
)
CONTENT_COLUMNS = v14.CONTENT_COLUMNS + ('store_source', 'title_source', 'product_source')


def clean_value(value, field):
    if not isinstance(value, str):
        return None
    value = value.strip(' \u3000\t「」『』')
    value = re.sub(r'[ \t\u3000]+', ' ', value).strip()
    limit = LABELS[field][1]
    if not (2 <= len(value) <= limit) or UNSAFE_TEXT.search(value) or GENERIC.fullmatch(value) or OTHER_LABEL.match(value):
        return None
    if re.search(r'[、,，;；]|(?:その他|など|ほかの商品|他の商品)', value) and field == 'product_name':
        return None
    if field == 'store_name':
        if BAD_STORE.search(value) or re.search(r'(?:\d{4}年|20\d{2}[-/]|\d{1,2}月\d{1,2}日)', value):
            return None
        if not re.search(r'[一-龯ぁ-んァ-ンA-Za-z]', value):
            return None
    if field == 'product_name' and BAD_PRODUCT.search(value):
        return None
    return v10.clean_text(value, limit)


def _candidate_lines(text, field):
    """Accept `商品名：X` and `商品名` newline `X`, never detached blurbs."""
    if not isinstance(text, str):
        return []
    pattern = LABEL_PATTERN[field]
    lines = [line.strip() for line in text.splitlines()]
    result = []
    for i, line in enumerate(lines):
        match = pattern.fullmatch(line)
        if not match:
            continue
        supplied = match.group(1)
        if supplied is None or not supplied.strip():
            # Must be an isolated label and the very next line is the value.
            if i + 1 >= len(lines):
                continue
            supplied = lines[i + 1]
            if not supplied or OTHER_LABEL.match(supplied):
                continue
        value = clean_value(supplied, field)
        if value:
            result.append(value)
    return result


def single_label(text, field):
    """Multiple DIFFERENT explicit candidates are ambiguous; add nothing."""
    choices = set(_candidate_lines(text, field))
    return next(iter(choices)) if len(choices) == 1 else None


def explicit_store(text):
    value = single_label(text, 'store_name')
    if value:
        return value, 'v15_page_store_label'
    if not isinstance(text, str):
        return None, None
    # '会場' is often an unrelated theater. Only a clear retail shop is a store.
    choices = set()
    for line in text.splitlines():
        match = VENUE_RE.fullmatch(line.strip())
        if match:
            venue = clean_value(match.group(1), 'store_name')
            if venue and re.search(r'(?:店|ショップ|SHOP|STORE)\s*$', venue, re.I):
                choices.add(venue)
    if len(choices) == 1:
        return next(iter(choices)), 'v15_page_explicit_retail_venue'
    return None, None


def event_title(result):
    # A clearly labelled title takes precedence over site chrome. v14 already
    # handles clean OG/h1 titles, so use this only if none was found upstream.
    return single_label(result.get('text'), 'event_title')


def _field_added(raw_item, public_item, key, value, origin):
    if not value or raw_item.get(key) or public_item.get(key):
        return False
    raw_item[key] = value
    public_item[key] = value
    raw_item.setdefault('field_sources', {})[key] = origin
    return True


def _append_status(old, added):
    if not added:
        return old
    if old == 'checked_no_new_details':
        return 'checked_' + '_'.join(added)
    if old.startswith('checked_'):
        suffix = old[len('checked_'):]
        parts = suffix.split('_')
        for field in added:
            if field not in parts:
                parts.append(field)
        return 'checked_' + '_'.join(parts)
    return old


def _notes(priority, status, deadline):
    if priority == 'new_pending':
        return '新着URL：ページ内容確認待ち'
    if status.startswith('browser_'):
        if status == 'browser_deadline_found':
            return '以前のページ確認で取得した締切を保持'
        if deadline:
            return 'ページを確認できませんでした（既知の締切は保持）'
        return 'ページを確認できず、締切は未確認'
    return ''


def process(raw, public, fetch, *, now=None, new_limit=15, background_limit=0):
    """Uses v14 to check deadlines then enriches safely from the SAME pages."""
    seen = {}

    def recorded_fetch(url):
        result = fetch(url)
        if isinstance(result, dict):
            seen[url] = copy.deepcopy(result)
        return result

    raw, public, _, _, _, stats = v14.process(
        raw, public, recorded_fetch, now=now,
        new_limit=new_limit, background_limit=background_limit,
    )
    rindex, pindex = v11.indices(raw, public)
    state = raw.setdefault('collector_state', {}).setdefault('v14', {})
    history = state.setdefault('new_url_checks', {})
    checks = raw.setdefault('collector_state', {}).setdefault('v13', {}).setdefault('browser_checks', {})
    stats.update({'stores_added': 0, 'extra_products_added': 0,
                  'extra_titles_added': 0, 'enrichment_ambiguous': 0})

    for url, result in seen.items():
        if result.get('status') != 'ok' or v12.exact_event_url(result.get('final_url')) != url:
            continue
        raw_item, pub_item = rindex[url], pindex[url]
        added = []
        title = event_title(result)
        if _field_added(raw_item, pub_item, 'event_title', title, 'v15_page_event_title_label'):
            stats['extra_titles_added'] += 1
            added.append('title')
        product = single_label(result.get('text'), 'product_name')
        if _field_added(raw_item, pub_item, 'product_name', product, 'v15_page_product_label'):
            stats['extra_products_added'] += 1
            added.append('product')
        store, origin = explicit_store(result.get('text'))
        if _field_added(raw_item, pub_item, 'store_name', store, origin):
            stats['stores_added'] += 1
            added.append('store')
        for field in ('event_title', 'product_name', 'store_name'):
            if len(set(_candidate_lines(result.get('text'), field))) > 1:
                stats['enrichment_ambiguous'] += 1
        if added:
            old = checks.get(url, {}).get('status', '')
            updated = _append_status(old, added)
            if url in checks:
                checks[url]['status'] = updated
            if url in history and history[url].get('checked_at'):
                history[url]['status'] = updated

    # Rebuild review/category from the final enriched values (not from stale v10).
    raw, public, review_rows, review_stats = v10.transform(raw, public)
    raw, public, deadline_rows, deadline_stats = v11.update(raw, public)
    public['schema_version'] = 15
    rindex, pindex = v11.indices(raw, public)
    stats['review_remaining'] = review_stats['review_rows']
    stats['deadline_missing'] = deadline_stats['deadline_missing']
    content_rows = []
    source_rows = []
    pending = set(state.get('pending_new_urls', []))
    for item in sorted(raw['items'], key=lambda i: i.get('discord_posted_at') or '', reverse=True):
        url = item['url']
        pub = pindex[url]
        check = checks.get(url, {})
        recent = history.get(url, {})
        priority = ('new_pending' if url in pending else
                    'new_checked' if url in history else 'background')
        status = (recent.get('status') if recent.get('checked_at')
                  else 'new_pending' if priority == 'new_pending'
                  else check.get('status') or 'not_checked')
        deadline = pub.get('application_end_at') or ''
        content_rows.append({
            'url': url, 'store_name': v12._safe_csv(str(pub.get('store_name') or '')),
            'discord_posted_at': pub.get('discord_posted_at') or '',
            'priority': priority, 'detected_at': recent.get('detected_at') or '',
            'checked_at': check.get('checked_at') or '',
            'content_status': status,
            'event_title': v12._safe_csv(str(pub.get('event_title') or '')),
            'product_name': v12._safe_csv(str(pub.get('product_name') or '')),
            'application_end_at': deadline,
            'notes': _notes(priority, status, deadline),
            'store_source': item.get('field_sources', {}).get('store_name', ''),
            'title_source': item.get('field_sources', {}).get('event_title', ''),
            'product_source': item.get('field_sources', {}).get('product_name', ''),
        })
        if v11.parse_datetime(deadline):
            source_status = ('browser_deadline_found' if status and (
                'deadline' in str(status) and status.startswith('checked_'))
                else 'deadline_known')
        else:
            source_status = ('browser_not_checked' if status in ('not_checked', 'new_pending')
                             else str(status))
        source_rows.append({
            'url': url,
            'store_name': v12._safe_csv(str(pub.get('store_name') or '')),
            'application_end_at': deadline,
            'search_status': source_status,
            'checked_at': check.get('checked_at') or '',
            'notes': 'v15新着優先チェック' if priority.startswith('new_') else '',
        })
    return raw, public, review_rows, deadline_rows, source_rows, content_rows, stats


def write_content_csv(path, rows):
    buff = io.StringIO(newline='')
    writer = csv.DictWriter(buff, fieldnames=CONTENT_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, buff.getvalue(), 'utf-8-sig')


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] != 'process':
        raise SystemExit('Usage: python scripts/livepocket_v15.py process')
    raw, public = v14.read_pair()
    plan = v14.work_plan(raw, public)
    if plan['browser_needed']:
        fetch, close = v14.browser_fetcher()
    else:
        fetch = lambda url: (_ for _ in ()).throw(AssertionError('Unexpected browser call'))
        close = lambda: None
    try:
        result = process(
            raw, public, fetch,
            new_limit=v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25),
            background_limit=(v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                              if v14.wants_background() else 0),
        )
    finally:
        close()
    raw, public, review_rows, deadline_rows, source_rows, content_rows, stats = result
    print('--- v15: New event details, free browser ---')
    for name, value in stats.items():
        print(f'{name}: {value}')
    print('raw_updated:', v11.write_json(RAW_PATH, raw))
    print('public_updated:', v11.write_json(PUBLIC_PATH, public))
    print('review_queue_updated:', v10.write_csv(REVIEW_PATH, review_rows))
    print('deadline_review_updated:', v11.write_csv(DEADLINE_REVIEW_PATH, deadline_rows))
    print('deadline_sources_updated:', v12.write_report(DEADLINE_SOURCE_PATH, source_rows))
    print('content_checks_updated:', write_content_csv(CONTENT_PATH, content_rows))


if __name__ == '__main__':
    main()
