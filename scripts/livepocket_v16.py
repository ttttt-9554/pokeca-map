#!/usr/bin/env python3
"""LivePocket v16: free, bounded retry of incomplete *recent new* events.

Priority (when background checks are enabled):
  1. v14's newly queued URLs, up to 15 (unchanged)
  2. Recent first-checked NEW URLs still missing details, max 3 (v16)
  3. Regular historical background URLs, max 8 (unchanged)

Each new URL still receives its first content check in the same collection run.
Retries are limited to two per event, >=6 hours apart, <=14 days after
initial detection, and run only on scheduled background/manual runs.
The scraper never guesses fields, follows no different-event redirects,
and retains v14's access-block cooldown.
"""
from __future__ import annotations

import csv
import io
import os
from datetime import timedelta

import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v15 as v15
from livepocket_future_policy import scheduled_future_only, after_cutover

RAW_PATH = v14.RAW_PATH
PUBLIC_PATH = v14.PUBLIC_PATH
CONTENT_COLUMNS = v15.CONTENT_COLUMNS + (
    'missing_details', 'retry_count', 'last_retry_at', 'last_retry_status',
)
RETRY_MAX = 2
RETRY_DELAY_HOURS = 6
RETRY_MAX_AGE_DAYS = 14


def missing_details(pub):
    return [name for name in ('event_title', 'product_name', 'store_name', 'application_end_at')
            if not pub.get(name)]


def due_retries(raw, public, now=None, *, limit=3):
    """Only already checked, still incomplete NEW arrivals; no old mass recheck."""
    if limit <= 0:
        return []
    now = v14._utc(now)
    rindex, pindex = v11.indices(raw, public)
    state = raw.get('collector_state', {})
    v14state = state.get('v14', {})
    if v14._cooldown_active(v14state, now):
        return []
    history = v14state.get('new_url_checks', {})
    pending = set(v14state.get('pending_new_urls', []))
    retries = state.get('v16', {}).get('retry_log', {})
    candidates = []
    for url, first in history.items():
        if url not in rindex or url in pending or not isinstance(first, dict):
            continue
        checked = v11.parse_datetime(first.get('checked_at'))
        detected = v11.parse_datetime(first.get('detected_at'))
        if not checked or not detected:
            continue
        # Scheduled collectors never reopen pre-cutover lotteries with
        # unknown deadlines; manual developer runs retain the old option.
        if scheduled_future_only() and not after_cutover(first.get('detected_at')):
            continue
        age = now - detected.astimezone(now.tzinfo)
        if age < timedelta(0) or age > timedelta(days=RETRY_MAX_AGE_DAYS):
            continue
        if first.get('status') == 'browser_redirected':
            continue
        current = pindex[url]
        deadline = v11.parse_datetime(current.get('application_end_at'))
        if deadline and deadline.astimezone(now.tzinfo) <= now:
            continue  # expired events do not consume the free retry budget
        if not missing_details(current):
            continue
        retry = retries.get(url, {})
        if int(retry.get('attempts', 0)) >= RETRY_MAX:
            continue
        last_time = v11.parse_datetime(retry.get('last_attempt_at')) or checked
        if now - last_time.astimezone(now.tzinfo) < timedelta(hours=RETRY_DELAY_HOURS):
            continue
        candidates.append((detected, url))
    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [url for _, url in candidates[:limit]]


def work_plan(raw, public, *, now=None, new_limit=15, background_limit=8,
              retry_limit=3, run_background=False):
    now = v14._utc(now)
    urgent, background, cooling = v14._select(raw, public, now,
        new_limit=new_limit,
        background_limit=background_limit if run_background else 0)
    retry = due_retries(raw, public, now, limit=retry_limit if run_background else 0)
    return {'browser_needed': bool(urgent or background or retry),
            'new_pending': len(urgent), 'retries_due': len(retry),
            'background_due': len(background), 'blocked_cooldown': cooling}


def _update_retry_fields(raw_item, public_item, result):
    """v14/v15's original conservative extractors on the very same page."""
    url = raw_item['url']
    status = str(result.get('status') or 'browser_error')
    if status != 'ok':
        return status, 0
    if v12.exact_event_url(result.get('final_url')) != url:
        return 'browser_redirected', 0
    if not isinstance(result.get('text'), str):
        return 'browser_date_missing', 0
    before = {k: bool(public_item.get(k)) for k in
              ('event_title', 'product_name', 'store_name', 'application_end_at')}
    dummy = {'titles_added': 0, 'products_added': 0, 'deadlines_added': 0,
             'starts_added': 0, 'date_conflicts': 0}
    v14._update_fields(raw_item, public_item, result, dummy)
    text = result.get('text')
    v15._field_added(raw_item, public_item, 'event_title',
                     v15.event_title(result), 'v16_retry_page_event_title_label')
    v15._field_added(raw_item, public_item, 'product_name',
                     v15.single_label(text, 'product_name'), 'v16_retry_page_product_label')
    store, source = v15.explicit_store(text)
    v15._field_added(raw_item, public_item, 'store_name', store, source)
    added = [key for key in before if not before[key] and public_item.get(key)]
    if dummy['date_conflicts']:
        return 'checked_retry_date_conflict', len(added)
    return 'checked_retry_' + ('_'.join(added) if added else 'no_new_details'), len(added)


def _retry_pass(raw, public, fetch, now, limit=3):
    now = v14._utc(now)
    selected = due_retries(raw, public, now, limit=limit)
    rindex, pindex = v11.indices(raw, public)
    state = raw.setdefault('collector_state', {})
    log = state.setdefault('v16', {}).setdefault('retry_log', {})
    firsts = state.setdefault('v14', {}).setdefault('new_url_checks', {})
    checks = state.setdefault('v13', {}).setdefault('browser_checks', {})
    stats = {'retry_attempted': 0, 'retry_new_fields': 0, 'retry_blocked': 0}
    for url in selected:
        try:
            result = fetch(url)
        except Exception:
            result = {'status': 'browser_error'}
        if not isinstance(result, dict):
            result = {'status': 'browser_error'}
        status, added = _update_retry_fields(rindex[url], pindex[url], result)
        time = now.isoformat()
        prev = log.get(url, {})
        log[url] = {'attempts': int(prev.get('attempts', 0)) + 1,
                    'last_attempt_at': time, 'last_status': status}
        checks[url] = {'checked_at': time, 'status': status}
        firsts[url]['checked_at'] = time
        firsts[url]['status'] = status
        stats['retry_attempted'] += 1
        stats['retry_new_fields'] += added
        if status in ('browser_blocked', 'browser_blocked_or_empty'):
            stats['retry_blocked'] += 1
            state['v14']['blocked_until'] = (now + timedelta(hours=v14.BLOCK_DELAY_HOURS)).isoformat()
            break
    return stats


def process(raw, public, fetch, *, now=None, new_limit=15,
            background_limit=0, retry_limit=3):
    """Always complete first-time NEW checks before optional retries/background."""
    now = v14._utc(now)
    raw, public, *_junk, new_stats = v15.process(raw, public, fetch, now=now,
                                                 new_limit=new_limit, background_limit=0)
    retry_stats = _retry_pass(raw, public, fetch, now, limit=retry_limit if background_limit else 0)
    # Background runs must obey block cooldown triggered during the retry pass.
    actual_background = (background_limit if not
                         v14._cooldown_active(raw.get('collector_state', {}).get('v14', {}), now)
                         else 0)
    raw, public, review, deadline, sources, content, bg_stats = v15.process(
        raw, public, fetch, now=now, new_limit=0, background_limit=actual_background)
    pindex = v11.indices(raw, public)[1]
    log = raw.get('collector_state', {}).get('v16', {}).get('retry_log', {})
    for row in content:
        url = row['url']
        retry = log.get(url, {})
        row['missing_details'] = ','.join(missing_details(pindex[url]))
        row['retry_count'] = retry.get('attempts', 0)
        row['last_retry_at'] = retry.get('last_attempt_at', '')
        row['last_retry_status'] = retry.get('last_status', '')
        if retry:
            status = str(row.get('content_status') or '')
            if status.startswith('checked_retry_'):
                row['notes'] = '新着URLを再確認しました（確認済みの情報は保持）'
            elif status.startswith('browser_') and pindex[url].get('application_end_at'):
                row['notes'] = '再確認時にページ取得不可（以前の締切は保持）'
    public['schema_version'] = 16
    stats = {
        'new_attempted': new_stats.get('urgent_attempted', 0),
        'new_titles_added': new_stats.get('titles_added', 0) + new_stats.get('extra_titles_added', 0),
        'new_products_added': new_stats.get('products_added', 0) + new_stats.get('extra_products_added', 0),
        'new_stores_added': new_stats.get('stores_added', 0),
        **retry_stats,
        'background_attempted': bg_stats.get('background_attempted', 0),
        'unprocessed_new': len(raw.get('collector_state', {}).get('v14', {}).get('pending_new_urls', [])),
        'registered_urls': len(raw.get('items', [])),
        'deadlines_known': sum(bool(i.get('application_end_at')) for i in public['items']),
    }
    return raw, public, review, deadline, sources, content, stats


def write_content_csv(path, rows):
    buf = io.StringIO(newline='')
    writer = csv.DictWriter(buf, fieldnames=CONTENT_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, buf.getvalue(), 'utf-8-sig')


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ('plan', 'process'):
        raise SystemExit('Usage: python scripts/livepocket_v16.py plan|process')
    raw, public = v14.read_pair()
    new_limit = v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25)
    background_limit = (v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                        if v14.wants_background() else 0)
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    if sys.argv[1] == 'plan':
        plan = work_plan(raw, public, new_limit=new_limit,
            background_limit=background_limit, retry_limit=retry_limit,
            run_background=v14.wants_background())
        print('v16 browser plan:', plan)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
                out.write(f"browser_needed={'true' if plan['browser_needed'] else 'false'}\n")
        return
    plan = work_plan(raw, public, new_limit=new_limit,
        background_limit=background_limit, retry_limit=retry_limit,
        run_background=v14.wants_background())
    if plan['browser_needed']:
        fetch, close = v14.browser_fetcher()
    else:
        fetch, close = (lambda u: (_ for _ in ()).throw(AssertionError('Unexpected browser call'))), (lambda: None)
    try:
        result = process(raw, public, fetch, new_limit=new_limit,
                         background_limit=background_limit, retry_limit=retry_limit)
    finally:
        close()
    raw, public, review, deadlines, sources, content, stats = result
    print('--- v16: new-first + bounded retries + background ---')
    for name, val in stats.items():
        print(f'{name}: {val}')
    print('raw_updated:', v11.write_json(v14.RAW_PATH, raw))
    print('public_updated:', v11.write_json(v14.PUBLIC_PATH, public))
    print('review_updated:', v15.v10.write_csv(v15.REVIEW_PATH, review))
    print('deadline_review_updated:', v11.write_csv(v14.REVIEW_PATH, deadlines))
    print('deadline_sources_updated:', v12.write_report(v14.SOURCES_PATH, sources))
    print('content_checks_updated:', write_content_csv(v14.CHECKS_PATH, content))


if __name__ == '__main__':
    main()
