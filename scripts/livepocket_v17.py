#!/usr/bin/env python3
"""LivePocket v17: check due *new-URL retries* on each collector run.

Priorities: first-time NEW URLs -> due new-URL retries -> historical checks
(only on existing twice-daily/manual background schedule).

Keeps v16's six-hour spacing, maximum two retries, 14-day age window,
expired/redirected skips, URL equality, access-block cooldown, and conservative
field extraction. This module intentionally does not bypass site restrictions.
"""
from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timedelta, timezone

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v15 as v15
import livepocket_v16 as v16

RETRY_COLUMNS = v16.CONTENT_COLUMNS + ('next_retry_at', 'retry_state')


def check_time(value):
    """GitHub/Discord check metadata may contain fractional ISO seconds.

    Only use this for *our own audit timestamps*, not for application deadlines:
    those continue to use v11's strict user-facing validation.
    """
    dt = v11.parse_datetime(value)
    if dt:
        return dt
    if not isinstance(value, str) or not value.startswith('20'):
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None or not 2020 <= dt.year <= 2100:
        return None
    return dt.astimezone(timezone.utc)


def due_retries(raw, public, now=None, *, limit=3):
    """v16 eligibility with fractional-second metadata correctly accepted."""
    if limit <= 0:
        return []
    now = v14._utc(now)
    raw_index, public_index = v11.indices(raw, public)
    state = raw.get('collector_state', {})
    v14state = state.get('v14', {})
    if v14._cooldown_active(v14state, now):
        return []
    history = v14state.get('new_url_checks', {})
    pending = set(v14state.get('pending_new_urls', []))
    retries = state.get('v16', {}).get('retry_log', {})
    choices = []
    for url, first in history.items():
        if url not in raw_index or url in pending or not isinstance(first, dict):
            continue
        checked = check_time(first.get('checked_at'))
        detected = check_time(first.get('detected_at'))
        if not checked or not detected or first.get('status') == 'browser_redirected':
            continue
        age = now - detected.astimezone(now.tzinfo)
        if age < timedelta(0) or age > timedelta(days=v16.RETRY_MAX_AGE_DAYS):
            continue
        event = public_index[url]
        deadline = v11.parse_datetime(event.get('application_end_at'))
        if deadline and deadline.astimezone(now.tzinfo) < now:
            continue
        if not v16.missing_details(event):
            continue
        log = retries.get(url, {})
        if int(log.get('attempts', 0)) >= v16.RETRY_MAX:
            continue
        last = check_time(log.get('last_attempt_at')) or checked
        if now - last.astimezone(now.tzinfo) < timedelta(hours=v16.RETRY_DELAY_HOURS):
            continue
        choices.append((detected, url))
    choices.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [url for _, url in choices[:limit]]


def retry_pass(raw, public, fetch, now=None, *, limit=3):
    """Retry only due events; stop on genuine blocking; keep 2-attempt cap."""
    now = v14._utc(now)
    selected = due_retries(raw, public, now, limit=limit)
    raw_index, public_index = v11.indices(raw, public)
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
        status, added = v16._update_retry_fields(raw_index[url], public_index[url], result)
        time = now.isoformat()
        previous = log.get(url, {})
        log[url] = {'attempts': int(previous.get('attempts', 0)) + 1,
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


def retry_schedule(raw, public, url, now=None):
    """Explain exactly why/when a checked NEW event can be retried."""
    now = v14._utc(now)
    _, pindex = v11.indices(raw, public)
    if url not in pindex:
        raise ValueError('Unknown event URL')
    state = raw.get('collector_state', {})
    v14state = state.get('v14', {})
    checked = v14state.get('new_url_checks', {}).get(url)
    if not isinstance(checked, dict):
        return '', 'historical'
    if url in v14state.get('pending_new_urls', []) or not checked.get('checked_at'):
        return '', 'new_pending'
    if checked.get('status') == 'browser_redirected':
        return '', 'redirected'
    detected = check_time(checked.get('detected_at'))
    initial_checked = check_time(checked.get('checked_at'))
    if not detected or not initial_checked:
        return '', 'invalid_check_time'
    age = now - detected.astimezone(now.tzinfo)
    if age < timedelta(0) or age > timedelta(days=v16.RETRY_MAX_AGE_DAYS):
        return '', 'too_old'
    current = pindex[url]
    end = v11.parse_datetime(current.get('application_end_at'))
    if end and end.astimezone(now.tzinfo) < now:
        return '', 'application_closed'
    if not v16.missing_details(current):
        return '', 'complete'
    record = state.get('v16', {}).get('retry_log', {}).get(url, {})
    attempts = int(record.get('attempts', 0))
    if attempts >= v16.RETRY_MAX:
        return '', 'max_retries'
    last = check_time(record.get('last_attempt_at')) or initial_checked
    eligible = last.astimezone(now.tzinfo) + timedelta(hours=v16.RETRY_DELAY_HOURS)
    expires = detected.astimezone(now.tzinfo) + timedelta(days=v16.RETRY_MAX_AGE_DAYS)
    if eligible > expires:
        return '', 'too_old'
    if end and eligible >= end.astimezone(now.tzinfo):
        return '', 'application_closed'
    if v14._cooldown_active(v14state, now):
        # Preserve the due timestamp to explain why the retry is held.
        return v11.iso(eligible), 'cooldown'
    return v11.iso(eligible), ('due' if eligible <= now else 'waiting')


def plan(raw, public, *, now=None, new_limit=15, background_limit=0, retry_limit=3):
    """Retries are considered on EVERY run, even without background scans."""
    now = v14._utc(now)
    urgent, background, cooldown = v14._select(raw, public, now,
        new_limit=new_limit, background_limit=background_limit)
    retries = due_retries(raw, public, now, limit=retry_limit)
    return {
        'browser_needed': bool(urgent or retries or background),
        'new_due': len(urgent), 'retries_due': len(retries),
        'historical_due': len(background), 'blocked_cooldown': cooldown,
    }


def process(raw, public, fetch, *, now=None, new_limit=15,
            background_limit=0, retry_limit=3):
    """Never scan older URLs before first-time NEW and due retries."""
    now = v14._utc(now)
    raw, public, *_unused, new_stats = v15.process(
        raw, public, fetch, now=now, new_limit=new_limit, background_limit=0)
    retry_stats = retry_pass(raw, public, fetch, now, limit=retry_limit)
    background = (background_limit if not v14._cooldown_active(
        raw.get('collector_state', {}).get('v14', {}), now) else 0)
    raw, public, review, deadline, sources, content, bg_stats = v15.process(
        raw, public, fetch, now=now, new_limit=0, background_limit=background)
    _, pindex = v11.indices(raw, public)
    log = raw.get('collector_state', {}).get('v16', {}).get('retry_log', {})
    for row in content:
        url = row['url']
        pub = pindex[url]
        attempts = log.get(url, {})
        row['missing_details'] = ','.join(v16.missing_details(pub))
        row['retry_count'] = attempts.get('attempts', 0)
        row['last_retry_at'] = attempts.get('last_attempt_at', '')
        row['last_retry_status'] = attempts.get('last_status', '')
        row['next_retry_at'], row['retry_state'] = retry_schedule(raw, public, url, now)
        status = str(row.get('content_status') or '')
        if attempts:
            if status.startswith('checked_retry_'):
                row['notes'] = '新着URLを再確認しました（確認済みの情報は保持）'
            elif status.startswith('browser_') and pub.get('application_end_at'):
                row['notes'] = '再確認時にページ取得不可（以前の締切は保持）'
    public['schema_version'] = 17
    return raw, public, review, deadline, sources, content, {
        'new_attempted': new_stats.get('urgent_attempted', 0),
        'new_titles_added': new_stats.get('titles_added', 0) + new_stats.get('extra_titles_added', 0),
        'new_products_added': new_stats.get('products_added', 0) + new_stats.get('extra_products_added', 0),
        'new_stores_added': new_stats.get('stores_added', 0),
        **retry_stats,
        'historical_attempted': bg_stats.get('background_attempted', 0),
        'unprocessed_new': len(raw.get('collector_state', {}).get('v14', {}).get('pending_new_urls', [])),
        'registered_urls': len(raw.get('items', [])),
        'deadlines_known': sum(bool(i.get('application_end_at')) for i in public['items']),
        'retries_due_after_run': len(due_retries(raw, public, now, limit=10000)),
    }


def write_content_csv(path, rows):
    buff = io.StringIO(newline='')
    writer = csv.DictWriter(buff, fieldnames=RETRY_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, buff.getvalue(), 'utf-8-sig')


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ('plan', 'process'):
        raise SystemExit('Usage: python scripts/livepocket_v17.py plan|process')
    raw, public = v14.read_pair()
    new_limit = v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25)
    background_limit = (v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                        if v14.wants_background() else 0)
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    if sys.argv[1] == 'plan':
        result = plan(raw, public, new_limit=new_limit,
                      background_limit=background_limit, retry_limit=retry_limit)
        print('v17 browser plan:', result)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
                out.write(f"browser_needed={'true' if result['browser_needed'] else 'false'}\n")
        return
    result = plan(raw, public, new_limit=new_limit,
                  background_limit=background_limit, retry_limit=retry_limit)
    # The plan step controls browser installation. A retry becoming due while
    # Chromium is installing should be deferred, never recorded as an error.
    prepared = os.getenv('LIVEPOCKET_V17_BROWSER_READY')
    if prepared == 'false':
        new_limit = background_limit = retry_limit = 0
        result['browser_needed'] = False
    elif prepared == 'true':
        result['browser_needed'] = True
    if result['browser_needed']:
        fetch, close = v14.browser_fetcher()
    else:
        def fetch(url):
            raise AssertionError('Browser fetch was not planned')
        close = lambda: None
    try:
        raw, public, review, deadlines, sources, content, stats = process(
            raw, public, fetch, new_limit=new_limit,
            background_limit=background_limit, retry_limit=retry_limit)
    finally:
        close()
    print('--- v17: new first, due retries every collector run ---')
    for key, val in stats.items():
        print(f'{key}: {val}')
    print('raw_updated:', v11.write_json(v14.RAW_PATH, raw))
    print('public_updated:', v11.write_json(v14.PUBLIC_PATH, public))
    print('review_updated:', v10.write_csv(v15.REVIEW_PATH, review))
    print('deadline_review_updated:', v11.write_csv(v14.REVIEW_PATH, deadlines))
    print('deadline_sources_updated:', v12.write_report(v14.SOURCES_PATH, sources))
    print('content_checks_updated:', write_content_csv(v14.CHECKS_PATH, content))


if __name__ == '__main__':
    main()
