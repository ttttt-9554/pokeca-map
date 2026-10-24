#!/usr/bin/env python3
"""Create a privacy-safe, aggregated LivePocket process summary for GitHub Pages.

No raw Discord content, GitHub tokens, store names, event URLs or exception
stack traces are emitted. The most recent developer-manual report is retained
when scheduled runs subsequently overwrite the latest-run information.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

import livepocket_v21 as v21
from livepocket_manual_completed import read_manual_completed, read_review_completed

ALLOWED_METRICS = (
    'registered_urls', 'deadlines_known', 'deadline_missing',
    'new_attempted', 'new_titles_added', 'new_products_added',
    'new_stores_added', 'historical_attempted', 'retry_attempted',
    'retry_new_fields', 'retry_blocked', 'title_recheck_attempted',
    'title_recheck_titles_added', 'title_recheck_products_added',
    'title_recheck_blocked', 'title_recheck_ok_no_title',
    'official_title_planned', 'official_title_attempted',
    'official_titles_upgraded', 'official_products_added',
    'official_genres_confirmed', 'official_fetch_blocked',
    'stores_from_pages', 'stores_from_discord', 'store_lists_added',
    'ticket_products_added', 'verified_products_added',
    'verified_prefectures_added', 'multi_store_urls',
    'map_matches', 'map_conflicts_skipped',
    'manual_selected', 'manual_attempted', 'manual_success', 'manual_blocked',
    'manual_title_updated', 'manual_product_updated',
    'manual_deadline_updated', 'manual_store_updated', 'manual_genre_updated',
    'manual_title_detected', 'manual_title_no_candidates',
    'manual_title_rejected', 'manual_title_access_blocked', 'manual_title_other_failure',
    'manual_title_site_common', 'manual_title_filtered_all',
    'manual_title_multiple_unresolved', 'manual_title_valid_unselected',
    'manual_title_meta_template_cleaned', 'manual_title_heading_seen',
    'manual_title_dom_candidates', 'manual_title_state_candidates',
    'manual_title_truncated',
    'manual_page_unconfirmed', 'manual_page_event_confirmed',
    # Mutually exclusive failure classifications for manual page visits.
    'manual_fail_timeout', 'manual_fail_no_response',
    'manual_fail_http_error', 'manual_fail_redirected',
    'manual_fail_page_unconfirmed', 'manual_fail_access_blocked',
    'manual_fail_browser_error', 'manual_fail_other',
    'manual_title_truncated_tail', 'manual_title_truncated_inner',
    'manual_title_replacement_char',
    'manual_verified_titles_applied', 'manual_verified_titles_updated',
    'manual_verified_title_conflicts',
)
METRIC_LINE = re.compile(r'^([a-z][a-z0-9_]*)\s*:\s*([0-9]+)\s*$', re.MULTILINE)


def parse_metrics(log: str) -> dict[str, int]:
    """Read the numeric k: v lines printed by livepocket_v21.py process."""
    allowed = set(ALLOWED_METRICS)
    return {key: int(value) for key, value in METRIC_LINE.findall(log) if key in allowed}


def _events(obj: object) -> dict[str, dict]:
    records = obj.get('items', []) if isinstance(obj, dict) else obj
    if not isinstance(records, list):
        return {}
    return {i['url']: i for i in records if isinstance(i, dict) and isinstance(i.get('url'), str)}


def field_differences(before: object, after: object) -> dict[str, int]:
    """Count existing URLs whose *public fields* changed during v21 processing.

    New URLs are not considered an existing-event recheck; each counter counts
    changed event records, not the number of fields/shops inside an event.
    """
    old = _events(before)
    new = _events(after)
    groups = {
        'title_updated': ('event_title',),
        'product_updated': ('product_name',),
        'deadline_updated': ('application_start_at','application_end_at'),
        'store_updated': ('store_name','prefecture','stores'),
        'genre_updated': ('review_category',),
    }
    result = Counter({name: 0 for name in groups})
    for url in old.keys() & new.keys():
        for name, fields in groups.items():
            if any(old[url].get(k) != new[url].get(k) for k in fields):
                result[name] += 1
    result['new_urls'] = len(new.keys() - old.keys())
    return dict(result)



# v21.18: server-side new-URL totals. Unlike Discord message timestamps,
# v14's first-seen checkpoint records when an event URL entered the app.
# The checkpoint is keyed by canonical URL: edits/rechecks never add a URL.
JST = ZoneInfo('Asia/Tokyo')


def daily_new_lotteries(raw: object, *, now: datetime | None = None) -> dict | None:
    """Privacy-safe daily counts from v14's persisted initial-detection ledger.

    Do not backfill old URLs from Discord timestamps: historical posts, duplicate
    sightings and manual checks would give misleading 'new today' numbers.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list):
        return None
    state = raw.get('collector_state')
    v14 = state.get('v14') if isinstance(state, dict) else None
    history = v14.get('new_url_checks') if isinstance(v14, dict) else None
    if not isinstance(history, dict):
        return None  # no trusted initial-detection ledger yet
    now = (now or datetime.now(timezone.utc))
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('now must include a timezone')
    current = {item['url'] for item in raw['items']
               if isinstance(item, dict) and isinstance(item.get('url'), str)}
    days = Counter()
    for url, record in history.items():
        if url not in current or not isinstance(record, dict):
            continue
        value = record.get('detected_at')
        if not isinstance(value, str) or not value:
            continue
        try:
            recorded = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            continue
        if recorded.tzinfo is None or recorded.utcoffset() is None or recorded > now:
            continue
        days[recorded.astimezone(JST).date()] += 1
    today = now.astimezone(JST).date()
    yesterday = today - timedelta(days=1)
    return {
        'date_jst': today.isoformat(),
        'today': days[today],
        'yesterday': days[yesterday],
        'last_7_days': sum(days[today - timedelta(days=i)] for i in range(7)),
        'registered_total': len(current),
        'tracked_since_jst': min(days).isoformat() if days else None,
        'as_of': now.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'source': 'v14_first_detected_urls',
    }


def load_daily_new_lotteries(path: Path, *, now: datetime | None = None) -> dict | None:
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeError):
        return None
    return daily_new_lotteries(raw, now=now)

def current_manual_review_progress(raw_path: Path, *, now: datetime | None = None,
                                   include_items: bool = False) -> dict:
    """Current queue status using exactly the same selector as developer recheck.

    No event URLs or Supabase records are published. A broken snapshot or
    unavailable cloud read must NEVER halt ordinary Discord collection.
    """
    try:
        raw = json.loads(raw_path.read_text(encoding='utf-8'))
        public = json.loads(v21.PUBLIC_PATH.read_text(encoding='utf-8'))
        titles, removed, locations = read_manual_completed()
        counts = v21.manual_recheck_candidates(
            raw, public, now=now, limit=v21.MANUAL_RECHECK_LIMIT,
            completed_titles=titles, removed_pages=removed,
            completed_locations=locations,
            completed_reviews=read_review_completed(),
            summary=True, include_items=include_items)
        counts.update(
            status='ok', source='v21_65_manual_selector',
            as_of=(now or datetime.now(timezone.utc)).astimezone(timezone.utc)
                .isoformat(timespec='seconds').replace('+00:00','Z')
        )
        return counts
    except (OSError, ValueError, TypeError, KeyError, RuntimeError) as error:
        # Avoid printing any credentials, URL, raw payload, or personal data.
        print('LivePocket review progress unavailable:', type(error).__name__)
        return {'status':'unavailable'}


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, ValueError):
        return {'items': []}


def safe_previous(path: Path) -> dict:
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
        if isinstance(raw, dict) and raw.get('schema_version') == 1:
            return raw
    except (OSError, json.JSONDecodeError, UnicodeError):
        pass
    return {}


def report(log: str, previous: dict, *, run_id: str, run_number: str,
           event_name: str, review_batch: str, timestamp: str,
           differences: dict[str, int] | None = None) -> dict:
    metrics = parse_metrics(log)
    manual = event_name == 'workflow_dispatch' and review_batch == '12'
    mode = 'developer_manual' if manual else 'automatic'
    result = {
        'run_id': str(run_id)[:32],
        'run_number': str(run_number)[:32],
        'completed_process_at': timestamp,
        'mode': mode,
        'stats': metrics,
        'updates': differences if differences is not None else {},
    }
    # "attempts" can be more than the number of distinct URLs. Do not claim
    # that this is the number of unique checked events.
    attempt_keys = ('new_attempted','historical_attempted','retry_attempted',
                    'title_recheck_attempted','official_title_attempted')
    result['page_check_attempts'] = sum(metrics.get(k, 0) for k in attempt_keys)
    result['manual_page_check_attempts'] = metrics.get('manual_attempted', 0)
    # Checkpoint recorded after Python process; separate from overall GitHub job success.
    payload = {'schema_version': 1, 'last_run': result}
    old_manual = previous.get('last_manual')
    if manual:
        payload['last_manual'] = result
    elif isinstance(old_manual, dict) and str(old_manual.get('run_id', '')).isdigit():
        payload['last_manual'] = old_manual
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--log', required=True)
    parser.add_argument('--output', default='livepocket_check_summary.json')
    parser.add_argument('--before-public')
    parser.add_argument('--after-public')
    parser.add_argument('--raw-data', default='livepocket_urls.json')
    parser.add_argument('--run-id', default=os.environ.get('GITHUB_RUN_ID', '0'))
    parser.add_argument('--run-number', default=os.environ.get('GITHUB_RUN_NUMBER', '0'))
    parser.add_argument('--event', default=os.environ.get('GITHUB_EVENT_NAME', 'unknown'))
    parser.add_argument('--review-batch', default=os.environ.get('REVIEW_BATCH', '8'))
    args = parser.parse_args()
    output = Path(args.output)
    raw_log = Path(args.log).read_text(encoding='utf-8', errors='replace')
    now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    changed = field_differences(read_json(Path(args.before_public)),
                               read_json(Path(args.after_public))) if args.before_public and args.after_public else {}
    previous = safe_previous(output)
    payload = report(raw_log, previous, run_id=args.run_id,
                     run_number=args.run_number, event_name=args.event,
                     review_batch=args.review_batch, timestamp=now, differences=changed)
    # Aggregate only: no event URL or Discord contents are exposed on Pages.
    daily = load_daily_new_lotteries(Path(args.raw_data))
    if daily is not None:
        payload['daily_additions'] = daily
    else:
        payload['daily_additions'] = {'status': 'unavailable'}
    # Current queue status is separate from the historical last-manual stats.
    # Collect on every run; never silently show stale queue figures as current.
    full_review = current_manual_review_progress(Path(args.raw_data), include_items=True)
    review_rows = full_review.pop('items', None)
    payload['review_progress'] = full_review
    if isinstance(review_rows, list):
        # Public event URLs only; no user profiles, private notes or raw Discord.
        Path('livepocket_unresolved_review.json').write_text(
            json.dumps({
                'schema_version': 1,
                'source': 'v21_97_manual_review_queue',
                'as_of': full_review.get('as_of'),
                'total': full_review.get('unresolved'),
                'items': review_rows,
            }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Automatic scans may run frequently: publish when the daily totals OR
    # review queue categories change. Manual results always get published.
    previous_progress = previous.get('review_progress')
    progress_fields = ('status','source','total','ready','retry_wait',
                       'completed','expired','removed','new_pending',
                       'quarantined','access_cooldown','next_batch_size',
                       'unresolved','missing_title','missing_store',
                       'missing_deadline','next_retry_at')
    unchanged_progress = (isinstance(previous_progress, dict) and
        all(payload['review_progress'].get(key) == previous_progress.get(key)
            for key in progress_fields))
    previous_daily = previous.get('daily_additions')
    comparable = ('date_jst', 'today', 'yesterday', 'last_7_days',
                  'registered_total', 'tracked_since_jst', 'source')
    is_manual = args.event == 'workflow_dispatch' and args.review_batch == '12'
    if (not is_manual and unchanged_progress and isinstance(daily, dict)
            and isinstance(previous_daily, dict)
            and all(daily.get(key) == previous_daily.get(key)
                    for key in comparable)):
        print('LivePocket daily additions unchanged; summary retained')
        return
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('LivePocket public summary created; mode:', payload['last_run']['mode'],
          '; page_check_attempts:', payload['last_run']['page_check_attempts'])


if __name__ == '__main__':
    main()
