#!/usr/bin/env python3
"""LivePocket v11: evidence-based, JST-aware application deadlines.

Runs AFTER v10; only exports complete year+time deadlines. Never infer an
application deadline from the Discord post timestamp or an event's date.
The optional verified deadlines CSV is strictly validated before any writes.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import os
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

RAW_PATH = Path(os.environ.get('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.environ.get('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
REVIEW_PATH = Path(os.environ.get('LIVEPOCKET_DEADLINE_REVIEW_FILE', 'livepocket_deadline_review.csv'))
VERIFIED_PATH = Path(os.environ.get('LIVEPOCKET_VERIFIED_DEADLINES_FILE', 'livepocket_verified_deadlines.csv'))
URL_RE = re.compile(r'https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}\Z')
URLS_IN_TEXT = re.compile(r'https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}')
JST = timezone(timedelta(hours=9))
DATETIME = re.compile(
    r'(?<!\d)(20\d{2})\s*(?:/|-|年)\s*(\d{1,2})\s*(?:/|-|月)\s*(\d{1,2})\s*日?'
    r'\s*(?:\([^)]{1,4}\)|（[^）]{1,4}）)?\s*'
    r'(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)'
)
PERIOD_WORD = re.compile(r'申込期間|申し込み期間|応募期間|抽選受付期間|抽選申込期間|受付期間|受付日時')
DEADLINE_WORD = re.compile(r'申込締切|申込期限|応募締切|応募期限|受付締切|受付終了(?:日時)?')
RANGE_SEP = re.compile(r'(?:\s*[〜～~－–—]\s*|\s+to\s+|\s+から\s+)', re.I)
REVIEW_FIELDS = ('url', 'store_name', 'product_name', 'application_period',
                 'discord_posted_at', 'review_priority', 'review_reason')
INPUT_FIELDS = ('url', 'verified', 'source_url', 'application_start_at', 'application_end_at')


def valid_url(value):
    return isinstance(value, str) and bool(URL_RE.fullmatch(value))


def _dt(year, month, day, hour, minute):
    try:
        y, m, d, h, n = map(int, (year, month, day, hour, minute))
        if not 2020 <= y <= 2100:
            return None
        return datetime(y, m, d, h, n, tzinfo=JST)
    except ValueError:
        return None


def iso(dt):
    return dt.astimezone(JST).isoformat(timespec='seconds')


def parse_datetime(value):
    """CSV/input values: unambiguous YYYY-MM-DD HH:MM (JST) or ISO with zone.

    Never accept bare dates, unknown years, or timezone-naive ISO T notation.
    """
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    m = DATETIME.fullmatch(value)
    if m:
        return _dt(*m.groups())
    if not re.fullmatch(r'20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})', value):
        return None
    try:
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if d.tzinfo is None or not 2020 <= d.year <= 2100:
            return None
        return d.astimezone(JST)
    except ValueError:
        return None


def parse_yearful_text(text):
    """Only a fully dated start+end range or explicitly named single deadline.

    Do not infer a deadline from publication dates, lottery result dates,
    event dates, or a generic date in the text.
    """
    if not isinstance(text, str) or len(text) > 2500:
        return None
    text = text.replace('\r', '')
    candidates = []
    for line in text.splitlines():
        if len(line) > 500:
            continue
        if PERIOD_WORD.search(line):
            dates = list(DATETIME.finditer(line))
            if len(dates) == 2 and RANGE_SEP.search(line[dates[0].end():dates[1].start()]):
                start = _dt(*dates[0].groups())
                end = _dt(*dates[1].groups())
                if start and end and start <= end:
                    candidates.append((start, end))
        elif DEADLINE_WORD.search(line):
            dates = list(DATETIME.finditer(line))
            if len(dates) == 1:
                end = _dt(*dates[0].groups())
                if end:
                    candidates.append((None, end))
    if not candidates:
        return None
    # Multiple contradicting deadline statements => do not choose one.
    if len({(a.isoformat() if a else None, b.isoformat()) for a, b in candidates}) > 1:
        return None
    return candidates[0]


def verified_rows(reader, event_urls):
    """Reject ANY malformed verified row, even when later rows are valid."""
    if not reader.fieldnames or any(c not in reader.fieldnames for c in INPUT_FIELDS):
        raise ValueError('Verified deadline CSV header is missing a required column')
    accepted = {}
    for number, row in enumerate(reader, start=2):
        if None in row:
            raise ValueError(f'CSV line {number}: too many columns')
        if not any(str(v or '').strip() for v in row.values()):
            continue
        flag = str(row.get('verified') or '').strip().lower()
        if flag not in ('', 'no', 'yes'):
            raise ValueError(f'CSV line {number}: verified must be yes or no')
        if flag != 'yes':
            continue
        url = str(row.get('url') or '').strip()
        src = str(row.get('source_url') or '').strip()
        if not valid_url(url) or url not in event_urls or src != url:
            raise ValueError(f'CSV line {number}: event URL or source_url is invalid')
        if url in accepted:
            raise ValueError(f'CSV line {number}: duplicate event URL')
        start = parse_datetime(row.get('application_start_at'))
        end = parse_datetime(row.get('application_end_at'))
        if not end:
            raise ValueError(f'CSV line {number}: valid, yearful application_end_at is required')
        if str(row.get('application_start_at') or '').strip() and not start:
            raise ValueError(f'CSV line {number}: invalid application_start_at')
        if start and start > end:
            raise ValueError(f'CSV line {number}: start later than deadline')
        accepted[url] = (start, end)
    return accepted


def indices(raw, public):
    if (not isinstance(raw, dict) or not isinstance(raw.get('items'), list)
            or not isinstance(public, dict) or not isinstance(public.get('items'), list)):
        raise ValueError('Invalid JSON structures')
    indexes = []
    for data in (raw, public):
        idx = {}
        for item in data['items']:
            if not isinstance(item, dict) or not valid_url(item.get('url')):
                raise ValueError('Invalid event URL')
            if item['url'] in idx:
                raise ValueError('Duplicate event URL')
            idx[item['url']] = item
        indexes.append(idx)
    if indexes[0].keys() != indexes[1].keys():
        raise ValueError('Raw/public URL mismatch')
    return indexes


def update(raw, public, verified=None):
    """Pure: never mutate input. Raise before writing anything on conflict."""
    raw = copy.deepcopy(raw)
    public = copy.deepcopy(public)
    source, dest = indices(raw, public)
    verified = verified or {}
    if any(url not in source for url in verified):
        raise ValueError('Verified URL not found')
    stats = Counter(urls=len(source), verified_rows=len(verified),
                    deadline_added=0, starts_added=0, full_periods_parsed=0,
                    exact_url_post_dates=0, deadline_missing=0)

    for url, item in source.items():
        pub = dest[url]
        # Existing fully verified dates take precedence over all later sources.
        existing_start = parse_datetime(item.get('application_start_at') or pub.get('application_start_at'))
        existing_end = parse_datetime(item.get('application_end_at') or pub.get('application_end_at'))
        # Existing non-empty unparseable value is not safe to overwrite.
        invalid_start = bool(item.get('application_start_at') or pub.get('application_start_at')) and not existing_start
        invalid_end = bool(item.get('application_end_at') or pub.get('application_end_at')) and not existing_end
        candidates = []
        if url in verified:
            candidates.append(('v11_verified_deadline_csv', verified[url], True))
        period_text = str(item.get('application_period') or pub.get('application_period') or '')
        period = parse_yearful_text(period_text) or parse_yearful_text('応募期間: ' + period_text)
        if period:
            candidates.append(('v11_full_year_period', period, False))
        # A Discord roundup commonly contains 5-30 URLs. NEVER use a date in
        # its body to fill every event. Require one unique URL AND no conflicts.
        body = item.get('post_excerpt')
        if isinstance(body, str) and len(set(URLS_IN_TEXT.findall(body))) == 1 and url in URLS_IN_TEXT.findall(body):
            post_period = parse_yearful_text(body)
            if post_period:
                candidates.append(('v11_single_url_discord_post', post_period, False))

        for origin, (start, end), manual in candidates:
            if invalid_end or invalid_start:
                if manual:
                    raise ValueError(f'Invalid existing date prevents verified update: {url}')
                continue
            if existing_start and existing_start > end:
                if manual:
                    raise ValueError(f'Verified deadline is before existing start: {url}')
                continue
            if existing_end and existing_end != end:
                if manual:
                    raise ValueError(f'Verified deadline conflicts with existing data: {url}')
                continue
            if start and existing_start and existing_start != start:
                if manual:
                    raise ValueError(f'Verified start conflicts with existing data: {url}')
                continue
            if not existing_end:
                existing_end = end
                item['application_end_at'] = iso(end)
                pub['application_end_at'] = iso(end)
                item.setdefault('field_sources', {})['application_end_at'] = origin
                stats['deadline_added'] += 1
                if origin == 'v11_full_year_period': stats['full_periods_parsed'] += 1
                if origin == 'v11_single_url_discord_post': stats['exact_url_post_dates'] += 1
            if not existing_start and start:
                existing_start = start
                item['application_start_at'] = iso(start)
                pub['application_start_at'] = iso(start)
                item.setdefault('field_sources', {})['application_start_at'] = origin
                stats['starts_added'] += 1
            # If user manually confirms one field, no need to modify original period.
            if manual:
                pub['detail_provenance'] = pub.get('detail_provenance') or 'user_verified_csv'

        # If any end date remains, honor existing regardless of start existence.
        if not existing_end:
            stats['deadline_missing'] += 1

    raw.setdefault('field_counts', {})['application_end_at'] = sum(bool(i.get('application_end_at')) for i in raw['items'])
    raw['field_counts']['application_start_at'] = sum(bool(i.get('application_start_at')) for i in raw['items'])
    public['unique_livepocket_urls'] = len(dest)
    public['schema_version'] = 11

    pending = []
    for item in public['items']:
        if parse_datetime(item.get('application_end_at')):
            continue
        priority = 'high' if item.get('application_period') else ('medium' if item.get('store_name') or item.get('product_name') else 'low')
        row = {
            'url': item['url'], 'store_name': item.get('store_name') or '',
            'product_name': item.get('product_name') or '',
            'application_period': item.get('application_period') or '',
            'discord_posted_at': item.get('discord_posted_at') or '',
            'review_priority': priority,
            'review_reason': 'year_missing_or_unverified' if item.get('application_period') else 'deadline_not_found',
        }
        for key, value in row.items():
            # Spreadsheet formula injection protection for text from posts.
            if isinstance(value, str) and value.startswith(('=', '+', '-', '@', '\t', '\r', '\n')):
                row[key] = "'" + value
        pending.append(row)
    pending.sort(key=lambda a: a['discord_posted_at'], reverse=True)
    pending.sort(key=lambda a: {'high': 0, 'medium': 1, 'low': 2}[a['review_priority']])
    return raw, public, pending, dict(stats)


def atomic_write(path, payload, encoding):
    if path.exists() and path.read_text(encoding=encoding) == payload:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(payload, encoding=encoding)
    tmp.replace(path)
    return True


def write_json(path, data):
    return atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def write_csv(path, rows):
    buff = io.StringIO(newline='')
    writer = csv.DictWriter(buff, fieldnames=REVIEW_FIELDS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return atomic_write(path, buff.getvalue(), 'utf-8-sig')


def main():
    raw = json.loads(RAW_PATH.read_text(encoding='utf-8'))
    public = json.loads(PUBLIC_PATH.read_text(encoding='utf-8'))
    source, _ = indices(raw, public)
    checked = {}
    if VERIFIED_PATH.exists():
        with VERIFIED_PATH.open(encoding='utf-8-sig', newline='') as file:
            checked = verified_rows(csv.DictReader(file), source)
    raw, public, pending, stats = update(raw, public, checked)
    print('--- LivePocket v11 deadline summary ---')
    for key, value in stats.items():
        print(f'{key}: {value}')
    print(f'raw_updated: {write_json(RAW_PATH, raw)}')
    print(f'public_updated: {write_json(PUBLIC_PATH, public)}')
    print(f'deadline_review_updated: {write_csv(REVIEW_PATH, pending)}')
    print(f'deadline_review_rows: {len(pending)}')


if __name__ == '__main__':
    main()
