#!/usr/bin/env python3
"""LivePocket v12: optional exact-URL search snippet deadline verification.

Read-only public search API; no LivePocket scraping, browser evasion, or guessing
of an event's application deadline from its event date/post date.
Runs after v11. Search requires optional BRAVE_SEARCH_API_KEY secret.
"""
from __future__ import annotations

import copy
import csv
import html
import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import livepocket_v11 as v11

RAW_PATH = Path(os.getenv('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.getenv('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
REVIEW_PATH = Path(os.getenv('LIVEPOCKET_DEADLINE_REVIEW_FILE', 'livepocket_deadline_review.csv'))
SOURCES_PATH = Path(os.getenv('LIVEPOCKET_DEADLINE_SOURCES_FILE', 'livepocket_deadline_sources.csv'))
BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
REPORT_COLUMNS = ('url', 'store_name', 'application_end_at', 'search_status', 'checked_at', 'notes')

# Date tokens MUST have a year somewhere in the SAME explicit signup range,
# and the END must contain a clock time. Never infer the year from collected_at.
DATE_TOKEN = re.compile(
    r'(?<!\d)(?:(20\d{2})\s*(?:年|/|-|\.))?'
    r'(\d{1,2})\s*(?:月|/|-|\.)\s*(\d{1,2})\s*日?'
    r'\s*(?:[\(（][^\)）]{1,6}[\)）])?\s*'
    r'(?:(\d{1,2})\s*(?:[:：]|時)\s*(\d{2})\s*分?|'
    r'(\d{1,2})\s*時)?'
)
RANGE_MARK = re.compile(r'[〜～~–—]|(?:\s+から\s*)|(?:\s+to\s+)', re.I)
RANGE_LABEL = re.compile(
    r'(?:事前予約|予約|抽選|エントリー|チケット)?'
    r'(?:応募|申込|お申込|申し込み|申込み|受付|販売受付|予約申込)'
    r'(?:受付)?期間', re.I
)
END_LABEL = re.compile(r'(?:申込|申込み|申し込み|応募|受付|予約|エントリー)(?:の)?(?:締切|期限|終了日時?)')
OTHER_LABEL = re.compile(r'(?:抽選結果|当選発表|開催日時?|イベント開催|販売期間|販売日|当選者販売|お支払い期限)')
TRUNCATED_IN_BETWEEN = re.compile(r'(?:\.{3,}|…|\\u2026)')


def exact_event_url(value):
    """Allow query/tracking suffix only, never wrong hostname/path/scheme."""
    if not isinstance(value, str):
        return None
    try:
        p = urllib.parse.urlsplit(value.strip())
    except ValueError:
        return None
    if p.scheme != 'https' or p.hostname not in ('livepocket.jp', 'www.livepocket.jp') or p.username or p.password or p.port not in (None, 443):
        return None
    canonical = 'https://livepocket.jp' + p.path
    if not v11.valid_url(canonical):
        return None
    return canonical


def _date(m, year):
    """Return (datetime or None, contains_time)."""
    y = m.group(1) or year
    if not y:
        return None, False
    hour = m.group(4) or m.group(6)
    minute = m.group(5) or ('00' if m.group(6) else None)
    timed = hour is not None
    dt = v11._dt(y, m.group(2), m.group(3), hour or '0', minute or '0')
    return dt, timed


def parse_signup_text(source):
    """Parse one self-contained signup statement. Return (start, end), else None.

    Examples: "＜予約申込期間＞ 2026年5月4日(月)～5月9日(土)23:59"
    A date-only end or an unlabelled event date is NOT a deadline.
    """
    if not isinstance(source, str) or not source.strip() or len(source) > 6000:
        return None
    normalized = html.unescape(re.sub(r'<[^>]{0,250}>', ' ', source))
    normalized = re.sub(r'[\r\n\t]+', ' ', normalized)
    normalized = re.sub(r'\s+', ' ', normalized)
    candidate_ranges = []
    for match in RANGE_LABEL.finditer(normalized):
        tail = normalized[match.end():match.end()+320]
        next_label = OTHER_LABEL.search(tail)
        if next_label:
            tail = tail[:next_label.start()]
        dates = list(DATE_TOKEN.finditer(tail))
        if len(dates) < 2:
            continue
        first, second = dates[:2]
        between = tail[first.end():second.start()]
        if not RANGE_MARK.search(between) or TRUNCATED_IN_BETWEEN.search(between):
            continue
        # Require a year printed on at least the first date, or an explicitly
        # yearful second date; do not derive it from the calendar or post date.
        year = first.group(1) or second.group(1)
        if not year:
            continue
        if first.group(1) and second.group(1) and first.group(1) != second.group(1):
            # Cross-year range allowed only when BOTH years explicitly printed.
            pass
        start, start_timed = _date(first, first.group(1) or year)
        end, end_timed = _date(second, second.group(1) or year)
        if start and end and end_timed and start <= end:
            # If same-year inference would cross years, reject (could be Jan next year).
            if not second.group(1) and (end.month, end.day) < (start.month, start.day):
                continue
            candidate_ranges.append((start if start_timed else None, end))
    for match in END_LABEL.finditer(normalized):
        tail = normalized[match.end():match.end()+90]
        date_match = DATE_TOKEN.search(tail)
        if not date_match or not date_match.group(1):
            continue
        end, timed = _date(date_match, None)
        if end and timed:
            candidate_ranges.append((None, end))
    if not candidate_ranges:
        return None
    # Two statements with conflicting end times must not be reconciled by guess.
    ends = {v11.iso(end) for _, end in candidate_ranges}
    if len(ends) != 1:
        return None
    starts = {v11.iso(start) for start, _ in candidate_ranges if start}
    if len(starts) > 1:
        return None
    if starts:
        return v11.parse_datetime(next(iter(starts))), candidate_ranges[0][1]
    return None, candidate_ranges[0][1]


def parse_search_results(reply, expected_url):
    """Only exact LivePocket URL hits and standalone snippet contexts qualify.

    Multiple conflicting or ambiguous dates -> no update.
    """
    if not isinstance(reply, dict):
        return None, 'invalid_response'
    hits = (reply.get('web') or {}).get('results') or []
    if not isinstance(hits, list):
        return None, 'invalid_response'
    matches = 0
    dates = []
    for hit in hits:
        if not isinstance(hit, dict) or exact_event_url(hit.get('url')) != expected_url:
            continue
        matches += 1
        snippets = [hit.get('description'), *(hit.get('extra_snippets') or [])]
        for snippet in snippets:
            candidate = parse_signup_text(snippet)
            if candidate:
                dates.append(candidate)
    if not matches:
        return None, 'exact_url_not_found'
    if not dates:
        return None, 'deadline_not_found'
    if len({v11.iso(end) for start, end in dates}) > 1:
        return None, 'conflicting_search_dates'
    starts = {v11.iso(start) for start, _ in dates if start}
    if len(starts) > 1:
        return None, 'conflicting_search_dates'
    return ((v11.parse_datetime(next(iter(starts))) if starts else None), dates[0][1]), 'verified_search_snippet'


def fetch_brave(api_key, event_url):
    q = urllib.parse.urlencode({
        'q': '"' + event_url + '"',
        'count': '10', 'country': 'JP', 'search_lang': 'ja',
        'extra_snippets': 'true',
    })
    request = urllib.request.Request(BRAVE_ENDPOINT + '?' + q, headers={
        'X-Subscription-Token': api_key, 'Accept': 'application/json',
        'User-Agent': 'LivePocketDeadlineChecker/12.0',
    })
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError('Brave HTTP ' + str(exc.code)) from None
    except (TimeoutError, OSError, ValueError) as exc:
        raise RuntimeError('Brave API network/JSON error') from exc


def limit(name, default, maximum):
    try:
        return min(max(0, int(os.getenv(name, str(default)))), maximum)
    except (TypeError, ValueError):
        return default


def _safe_csv(s):
    if isinstance(s, str) and s.startswith(('=', '+', '-', '@', '\r', '\n', '\t')):
        return "'" + s
    return s


def update(raw, public, api_key='', *, search=fetch_brave, now=None,
           run_max=None, day_max=None, retry_days=4):
    """Return (raw, public, v11 review rows, source report rows, stats).

    Exactly matching URLs, no overwriting verified dates, all-or-nothing
    validation before any caller file writes. Only successful search results
    may add dates, never title/event-date or multi-URL roundups.
    """
    raw = copy.deepcopy(raw)
    public = copy.deepcopy(public)
    rindex, pindex = v11.indices(raw, public)
    now = now or datetime.now(timezone.utc)
    current_day = now.strftime('%Y-%m-%d')
    state = raw.setdefault('collector_state', {}).setdefault('v12', {})
    checks = state.setdefault('search_checks', {})
    quota = state.setdefault('brave_daily', {})
    if quota.get('date') != current_day:
        quota.clear()
        quota.update({'date': current_day, 'used': 0})
    max_per_run = limit('LIVEPOCKET_V12_BRAVE_PER_RUN', 3, 20) if run_max is None else run_max
    max_per_day = limit('LIVEPOCKET_V12_BRAVE_DAILY_MAX', 15, 100) if day_max is None else day_max
    stats = dict(urls=len(rindex), already_dated=0, searches=0,
                 deadlines_added=0, starts_added=0, exact_url_hits=0,
                 no_key=not bool(api_key), api_errors=0, conflicts=0,
                 deadlines_missing=0)
    # most recent posted events first to prioritize actionable deadlines
    prioritized = sorted(raw['items'], key=lambda x: x.get('discord_posted_at') or '', reverse=True)
    for item in prioritized:
        url = item['url']
        pub = pindex[url]
        present = item.get('application_end_at') or pub.get('application_end_at')
        if present:
            stats['already_dated'] += 1
            continue
        if not api_key or stats['searches'] >= max_per_run or quota['used'] >= max_per_day:
            continue
        previous = checks.get(url, {})
        checked_at = v11.parse_datetime(previous.get('checked_at'))
        if checked_at and now < checked_at.astimezone(timezone.utc) + timedelta(days=retry_days):
            continue
        quota['used'] += 1  # BEFORE the request; persist on later successful run.
        stats['searches'] += 1
        try:
            result = search(api_key, url)
        except Exception as e:
            # A throttled/invalid API key should not mark dozens of events failed.
            checks[url] = {'checked_at': now.isoformat(), 'status': 'search_error'}
            stats['api_errors'] += 1
            print('v12: search stopped for this run:', str(e)[:120])
            break
        parsed, status = parse_search_results(result, url)
        if status != 'exact_url_not_found':
            stats['exact_url_hits'] += 1
        if parsed:
            start, end = parsed
            existing_start = v11.parse_datetime(item.get('application_start_at') or pub.get('application_start_at'))
            existing_end = v11.parse_datetime(item.get('application_end_at') or pub.get('application_end_at'))
            invalid_start = bool(item.get('application_start_at') or pub.get('application_start_at')) and not existing_start
            if (invalid_start or (existing_start and (existing_start > end or (start and start != existing_start)))
                    or (existing_end and existing_end != end)):
                status = 'conflict_with_existing'
                stats['conflicts'] += 1
            else:
                # Check both indexes and never overwrite manually verified dates.
                item['application_end_at'] = v11.iso(end)
                pub['application_end_at'] = v11.iso(end)
                item.setdefault('field_sources', {})['application_end_at'] = 'v12_brave_exact_url_snippet'
                stats['deadlines_added'] += 1
                if start and not existing_start:
                    item['application_start_at'] = v11.iso(start)
                    pub['application_start_at'] = v11.iso(start)
                    item['field_sources']['application_start_at'] = 'v12_brave_exact_url_snippet'
                    stats['starts_added'] += 1
        checks[url] = {'checked_at': now.isoformat(), 'status': status}
    # Regenerate the existing review CSV after v12 additions (v11 runs first).
    raw, public, pending, v11stats = v11.update(raw, public)
    _, pindex = v11.indices(raw, public)
    public['schema_version'] = 12
    raw.setdefault('field_counts', {})['application_end_at'] = sum(bool(x.get('application_end_at')) for x in raw['items'])
    stats['deadlines_missing'] = v11stats['deadline_missing']
    report = []
    for item in prioritized:
        url = item['url']
        pub = pindex[url]
        entry = checks.get(url, {})
        status = ('deadline_known' if pub.get('application_end_at') else
                  entry.get('status', 'api_key_missing' if not api_key else 'not_checked'))
        report.append({
            'url': url, 'store_name': _safe_csv(str(pub.get('store_name') or '')),
            'application_end_at': pub.get('application_end_at') or '',
            'search_status': status,
            'checked_at': entry.get('checked_at') or '',
            'notes': ('確認済みの締切を保持' if status == 'deadline_known' else
                      '検索APIキーが未設定' if status == 'api_key_missing' else
                      '完全な申込締切日時を確認できず' if status == 'deadline_not_found' else ''),
        })
    return raw, public, pending, report, stats


def write_report(path, rows):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=REPORT_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, out.getvalue(), 'utf-8-sig')


def main():
    raw = json.loads(RAW_PATH.read_text(encoding='utf-8'))
    public = json.loads(PUBLIC_PATH.read_text(encoding='utf-8'))
    updated, visible, pending, report, stats = update(
        raw, public, api_key=os.getenv('BRAVE_SEARCH_API_KEY', '').strip())
    print('--- LivePocket v12 deadline evidence ---')
    for name, value in stats.items():
        print(f'{name}: {value}')
    # Files written only after entire update succeeds.
    print('raw_updated:', v11.write_json(RAW_PATH, updated))
    print('public_updated:', v11.write_json(PUBLIC_PATH, visible))
    print('deadline_review_updated:', v11.write_csv(REVIEW_PATH, pending))
    print('source_report_updated:', write_report(SOURCES_PATH, report))
    print('deadline_review_rows:', len(pending))


if __name__ == '__main__':
    main()
