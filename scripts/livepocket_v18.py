#!/usr/bin/env python3
"""LivePocket v18: fresh-first historical checks with timezone-safe audit times.

Preserves v17's NEW first -> six-hour new retry -> background ordering.
For historical checks, never recheck a known page while any historical page
has not been checked. Once the first-pass queue is empty, retry incomplete
historical pages no more than once per seven days. No paid APIs used.

The v14 selector is temporarily scoped for calls to v17 rather than editing
any of the already-deployed v14-v17 files; the original is restored afterward.
"""
from __future__ import annotations

import csv
import io
import os
from contextlib import contextmanager
from datetime import timedelta, timezone

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v15 as v15
import livepocket_v16 as v16
import livepocket_v17 as v17

HISTORICAL_WAIT_DAYS = 7
COLUMNS = v17.RETRY_COLUMNS + ('historical_state', 'historical_next_check_at')


def historical_class(raw, public, url, now=None):
    """Classify one URL using persisted checked_at, never Discord posting time."""
    now = v14._utc(now)
    _, pindex = v11.indices(raw, public)
    if url not in pindex:
        raise ValueError('Unknown event URL')
    state = raw.get('collector_state', {})
    v14state = state.get('v14', {})
    if url in v14state.get('pending_new_urls', []):
        return 'new_pending', ''
    if url in v14state.get('new_url_checks', {}):
        return 'new_priority', ''
    pub = pindex[url]
    deadline = v11.parse_datetime(pub.get('application_end_at'))
    if deadline and deadline.astimezone(timezone.utc) <= now:
        return 'application_closed', ''
    record = state.get('v13', {}).get('browser_checks', {}).get(url, {})
    if not isinstance(record, dict):
        return 'invalid_check_record', ''
    if record.get('status') == 'browser_redirected':
        return 'redirected', ''
    stamp = record.get('checked_at')
    if not stamp:
        return 'not_checked', ''
    checked = v17.check_time(stamp)
    if not checked:
        # Keep malformed timestamps out of the fresh pool; otherwise the same
        # checked URL can be selected in every scheduled run.
        return 'invalid_check_time', ''
    if checked > now:
        return 'future_check_time', ''
    if not v16.missing_details(pub):
        return 'complete', ''
    next_at = checked + timedelta(days=HISTORICAL_WAIT_DAYS)
    return ('recheck_ready' if next_at <= now else 'recheck_waiting',
            v11.iso(next_at))


def select(raw, public, now, *, new_limit=15, background_limit=0, retry_days=7):
    """Drop-in v14 selector. Unchecked historical URLs ALWAYS precede rechecks."""
    now = v14._utc(now)
    rindex, pindex = v11.indices(raw, public)
    state = raw.setdefault('collector_state', {}).setdefault('v14', {})
    if v14._cooldown_active(state, now):
        return [], [], True
    pending = [url for url in state.get('pending_new_urls', []) if url in rindex]
    pending.sort(key=lambda u: (rindex[u].get('discord_posted_at') or '', u), reverse=True)
    urgent = pending[:max(0, new_limit)]
    if background_limit <= 0:
        return urgent, [], False
    history = set(state.get('new_url_checks', {})) | set(pending)
    # Stable newest-first order; no information lost from the other versions.
    ordered = sorted(rindex, key=lambda u: (rindex[u].get('discord_posted_at') or '', u), reverse=True)
    unvisited, rechecks = [], []
    for url in ordered:
        if url in history:
            continue  # New events have their own bounded 6-hour retry queue.
        event = pindex[url]
        deadline = v11.parse_datetime(event.get('application_end_at'))
        if deadline and deadline.astimezone(timezone.utc) <= now:
            continue
        entry = raw.get('collector_state', {}).get('v13', {}).get('browser_checks', {}).get(url, {})
        if not isinstance(entry, dict) or entry.get('status') == 'browser_redirected':
            continue
        stamp = entry.get('checked_at')
        if not stamp:
            unvisited.append(url)
            continue
        checked = v17.check_time(stamp)
        if (checked and checked <= now - timedelta(days=max(HISTORICAL_WAIT_DAYS, retry_days))
                and v16.missing_details(event)):
            rechecks.append(url)
        # Already-checked malformed dates are quarantined, not requeued every time.
    return urgent, (unvisited + rechecks)[:background_limit], False


@contextmanager
def _use_selector():
    """v15/v17 share v14._select; switch it only during one synchronous call."""
    original = v14._select
    v14._select = select
    try:
        yield
    finally:
        v14._select = original


def progress(raw, public, now=None):
    summary = {'historical_unchecked': 0, 'historical_checked': 0,
               'historical_recheck_waiting': 0, 'historical_recheck_ready': 0,
               'historical_skipped': 0, 'new_queue': 0}
    for item in raw['items']:
        status, _ = historical_class(raw, public, item['url'], now)
        if status == 'not_checked':
            summary['historical_unchecked'] += 1
        elif status in ('new_pending', 'new_priority'):
            summary['new_queue'] += 1
        elif status in ('recheck_waiting', 'recheck_ready'):
            summary['historical_checked'] += 1
            summary['historical_recheck_'+status.split('_')[1]] += 1
        elif status == 'complete':
            summary['historical_checked'] += 1
        else:
            summary['historical_skipped'] += 1
    return summary


def plan(raw, public, *, now=None, new_limit=15, background_limit=0, retry_limit=3):
    with _use_selector():
        result = v17.plan(raw, public, now=now, new_limit=new_limit,
                          background_limit=background_limit, retry_limit=retry_limit)
    result.update(progress(raw, public, now))
    return result


def process(raw, public, fetch, *, now=None, new_limit=15,
            background_limit=0, retry_limit=3):
    with _use_selector():
        raw, public, review, deadlines, sources, content, stats = v17.process(
            raw, public, fetch, now=now, new_limit=new_limit,
            background_limit=background_limit, retry_limit=retry_limit)
    for row in content:
        state, eta = historical_class(raw, public, row['url'], now)
        row['historical_state'] = state
        row['historical_next_check_at'] = eta
    public['schema_version'] = 18
    stats.update(progress(raw, public, now))
    return raw, public, review, deadlines, sources, content, stats


def write_content_csv(path, rows):
    buf = io.StringIO(newline='')
    writer = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, buf.getvalue(), 'utf-8-sig')


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ('plan', 'process'):
        raise SystemExit('Usage: python scripts/livepocket_v18.py plan|process')
    raw, public = v14.read_pair()
    new_limit = v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25)
    background_limit = (v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                        if v14.wants_background() else 0)
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    work = plan(raw, public, new_limit=new_limit,
                background_limit=background_limit, retry_limit=retry_limit)
    if sys.argv[1] == 'plan':
        print('v18 browser plan:', work)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
                f.write(f"browser_needed={'true' if work['browser_needed'] else 'false'}\n")
        return
    ready = os.getenv('LIVEPOCKET_V18_BROWSER_READY')
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
                      background_limit=background_limit, retry_limit=retry_limit)
    finally:
        close()
    raw, public, review, deadlines, sources, content, stats = out
    print('--- v18: new -> due retries -> never-checked historical -> 7-day rechecks ---')
    for key, value in stats.items():
        print(f'{key}: {value}')
    print('raw_updated:', v11.write_json(v14.RAW_PATH, raw))
    print('public_updated:', v11.write_json(v14.PUBLIC_PATH, public))
    print('review_updated:', v10.write_csv(v15.REVIEW_PATH, review))
    print('deadline_review_updated:', v11.write_csv(v14.REVIEW_PATH, deadlines))
    print('deadline_sources_updated:', v12.write_report(v14.SOURCES_PATH, sources))
    print('content_checks_updated:', write_content_csv(v14.CHECKS_PATH, content))


if __name__ == '__main__':
    main()
