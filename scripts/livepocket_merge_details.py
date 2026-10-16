#!/usr/bin/env python3
"""Merge independently verified event details without removing or guessing fields.

This module deliberately DOES NOT scrape LivePocket, bypass verification, or
confuse lottery ticket受付 with retail product販売.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

DATA_PATH = Path(os.getenv('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
DETAILS_PATH = Path(os.getenv('LIVEPOCKET_DETAILS_FILE', 'livepocket_event_details.json'))
ALLOWED_FIELDS = {
    'event_title', 'event_date', 'event_start_date', 'event_end_date',
    'venue_name', 'venue_address', 'opening_hours', 'registration_type',
    'application_period', 'application_start_at', 'application_end_at',
    'lottery_result_period', 'lottery_result_start_date', 'lottery_result_end_date',
    'ticket_name', 'ticket_price_yen', 'ticket_application_limit',
    'product_name', 'sales_period', 'store_name', 'prefecture',
}
EVENT_URL = re.compile(r'https://(?:www\.)?livepocket\.jp/e/[a-zA-Z0-9_-]{4,64}$')


def validate_details(entries):
    if not isinstance(entries, list):
        raise ValueError('Details file must have an entries array')
    urls = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('Every entry must be an object')
        url = entry.get('url')
        if not isinstance(url, str) or not EVENT_URL.fullmatch(url):
            raise ValueError(f'Invalid event URL: {url!r}')
        if url in urls:
            raise ValueError(f'Duplicate details URL: {url}')
        urls.add(url)
        fields = entry.get('fields')
        if not isinstance(fields, dict) or not fields:
            raise ValueError(f'No details fields: {url}')
        if not (isinstance(entry.get('source'), str) and entry['source'].strip()):
            raise ValueError(f'Missing evidence source: {url}')
        for field, value in fields.items():
            if field not in ALLOWED_FIELDS:
                raise ValueError(f'Unknown field {field!r} for {url}')
            if value is not None and not isinstance(value, (str, int, float)):
                raise ValueError(f'Unsupported field type: {field}')
            if isinstance(value, str) and not value.strip():
                raise ValueError(f'Blank field: {field}')
    return entries


def merge_verified(data, entry_list):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('Existing JSON needs an items array')
    entries = validate_details(entry_list)
    out = copy.deepcopy(data)
    indexed = {item.get('url'): item for item in out['items'] if isinstance(item, dict)}
    stats = {'existing_urls': len(indexed), 'details_entries': len(entries),
             'matched': 0, 'new_fields': 0, 'conflicts_preserved': 0, 'missing_url': 0}
    for entry in entries:
        item = indexed.get(entry['url'])
        if item is None:
            stats['missing_url'] += 1
            continue
        stats['matched'] += 1
        for field, new_value in entry['fields'].items():
            if new_value is None:
                continue
            original = item.get(field)
            if original not in (None, ''):
                if original != new_value:
                    stats['conflicts_preserved'] += 1
                    print(f'Conflict preserved: {entry["url"]} {field}', file=sys.stderr)
                continue
            item[field] = new_value
            item.setdefault('field_sources', {})[field] = entry['source']
            stats['new_fields'] += 1
    out['field_counts'] = {
        field: sum(item.get(field) not in (None, '') for item in out['items'] if isinstance(item, dict))
        for field in ('store_name', 'prefecture', 'event_title', 'event_date',
                      'product_name', 'application_period', 'sales_period',
                      'lottery_result_period')
    }
    return out, stats


def main():
    if not DATA_PATH.is_file():
        print(f'Missing data file: {DATA_PATH}', file=sys.stderr)
        return 1
    if not DETAILS_PATH.is_file():
        print(f'Missing details file: {DETAILS_PATH}', file=sys.stderr)
        return 1
    with DATA_PATH.open(encoding='utf-8') as f:
        old = json.load(f)
    with DETAILS_PATH.open(encoding='utf-8') as f:
        verified = json.load(f)
    out, stats = merge_verified(old, verified.get('entries'))
    if out != old:
        temp = DATA_PATH.with_name(DATA_PATH.name + '.tmp')
        with temp.open('w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write('\n')
        temp.replace(DATA_PATH)
    for k, v in stats.items():
        print(f'{k}: {v}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
