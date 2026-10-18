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
from datetime import datetime, timezone
from pathlib import Path

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
    payload = report(raw_log, safe_previous(output), run_id=args.run_id,
                     run_number=args.run_number, event_name=args.event,
                     review_batch=args.review_batch, timestamp=now, differences=changed)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('LivePocket public summary created; mode:', payload['last_run']['mode'],
          '; page_check_attempts:', payload['last_run']['page_check_attempts'])


if __name__ == '__main__':
    main()
