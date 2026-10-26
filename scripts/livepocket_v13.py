#!/usr/bin/env python3
"""LivePocket v13: optional no-key browser-based deadline checks.

Loads a SMALL number of public event URLs in ordinary headless Chromium via
Playwright. Does not bypass login, CAPTCHA, access controls or blocks. Extracts
only explicitly labelled yearful application/registration deadlines; ambiguous
or conflicting dates remain unknown. No outside search API, no paid service.

Run AFTER v11 (v12/Brave is deliberately disabled in the free workflow).
The script is scheduled twice daily or manually, not every 10 minutes.
"""
from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import livepocket_v11 as v11
import livepocket_v12 as v12

RAW_PATH = Path(os.getenv('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.getenv('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
REVIEW_PATH = Path(os.getenv('LIVEPOCKET_DEADLINE_REVIEW_FILE', 'livepocket_deadline_review.csv'))
SOURCES_PATH = Path(os.getenv('LIVEPOCKET_DEADLINE_SOURCES_FILE', 'livepocket_deadline_sources.csv'))

LABEL = re.compile(
    r'(?:抽選|先着|事前|チケット|予約|販売)?\s*'
    r'(?:応募|申込|申込み|申し込み|受付|予約|エントリー)'
    r'(?:受付)?\s*(?:期間|締切|期限|終了日時?)', re.I,
)
BLOCK_WORDS = re.compile(
    r'(?i)(?:access denied|just a moment|captcha|robot check|'
    r'セキュリティチェック|アクセスが制限|ボットによるアクセス)'
)


def detail_signup_period(text: str):
    """Prefer explicit signup dates in event details over ticket-sale dates."""
    if not isinstance(text, str):
        return None
    section = re.search(r'(?m)^[ \t]*(?:イベント)?詳細[ \t]*' + chr(36), text)
    if not section:
        return None
    tail = text[section.end():]
    ticket = re.search(r'(?m)^[ \t]*受付[・･]チケット情報[ \t]*' + chr(36), tail)
    if ticket:
        tail = tail[:ticket.start()]
    labels = re.compile(r'応募期間|抽選受付期間|抽選申込期間|申込期間|申込み期間|申し込み期間')
    flat = re.sub(r'\s+', ' ', tail[:12000])
    found = []
    matches = list(labels.finditer(flat))[:30]
    for i, match in enumerate(matches):
        stop = min(len(flat), match.start()+220,
                   matches[i+1].start() if i+1<len(matches) else len(flat))
        candidate = v12.parse_signup_text(flat[match.start():stop])
        if candidate:
            found.append(candidate)
    if not found:
        return None
    ends = {v11.iso(end) for _, end in found}
    starts = {v11.iso(start) for start, _ in found if start}
    if len(ends) != 1 or len(starts) > 1:
        return (None, None)
    return (v11.parse_datetime(next(iter(starts))) if starts else None,
            v11.parse_datetime(next(iter(ends))))

def extract_deadline(text: str):
    """Read only explicit signup statements, never event dates.

    Return (start, end), (None, None) if missing/ambiguous. Every accepted end
    has a year AND a clock time. Multiple different ends => reject all.
    """
    if not isinstance(text, str) or not text.strip():
        return None, None
    preferred = detail_signup_period(text)
    if preferred is not None:
        return preferred
    # LivePocket may render labels and dates in adjacent DOM nodes/newlines.
    flat = re.sub(r'\s+', ' ', text).strip()
    candidates = []
    labels = list(LABEL.finditer(flat))[:60]
    for i, match in enumerate(labels):
        # A second label starts an independent deadline statement. Never let
        # its end date become the first statement's apparent deadline.
        stop = min(match.start() + 420, labels[i + 1].start() if i + 1 < len(labels) else len(flat))
        snippet = flat[match.start():stop]
        parsed = v12.parse_signup_text(snippet)
        if parsed is not None:
            candidates.append(parsed)
    # Support explicit fully-yearful short lines already validated by v11.
    for line in text.splitlines():
        if LABEL.search(line) and len(line) < 500:
            parsed = v11.parse_yearful_text(line)
            if parsed is not None:
                candidates.append(parsed)
    if not candidates:
        return None, None
    ends = {v11.iso(end) for _, end in candidates}
    starts = {v11.iso(start) for start, _ in candidates if start}
    if len(ends) != 1 or len(starts) > 1:
        return None, None
    end = v11.parse_datetime(next(iter(ends)))
    start = v11.parse_datetime(next(iter(starts))) if starts else None
    return start, end


def browser_fetcher():
    """Return callback plus close(). Real browser: no stealth/proxy/evasion."""
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout
    except ImportError as e:
        raise RuntimeError('Playwright is not installed; run: pip install playwright && python -m playwright install chromium') from e
    manager = sync_playwright().start()
    try:
        browser = manager.chromium.launch(headless=True)
        context = browser.new_context(locale='ja-JP', timezone_id='Asia/Tokyo')
    except Exception:
        manager.stop()
        raise

    def fetch(url):
        page = context.new_page()
        try:
            try:
                response = page.goto(url, wait_until='domcontentloaded', timeout=18000)
            except BrowserTimeout:
                return {'status': 'browser_timeout'}
            if response is None:
                return {'status': 'browser_no_response'}
            if response.status in (401, 403, 429):
                return {'status': 'browser_blocked'}
            if response.status >= 400:
                return {'status': 'browser_http_error'}
            if v12.exact_event_url(page.url) != url:
                return {'status': 'browser_redirected'}
            # Wait briefly for normal client-side rendering, not bot evasion.
            for _ in range(3):
                try:
                    body = page.locator('body').inner_text(timeout=4000)
                except BrowserTimeout:
                    body = ''
                if len(body.strip()) > 80:
                    break
                page.wait_for_timeout(1500)
            if BLOCK_WORDS.search(body) or not body or len(body.strip()) < 40:
                return {'status': 'browser_blocked_or_empty'}
            # Avoid exposing/storing whole event text in JSON or diagnostic CSV.
            return {'status': 'ok', 'text': body[:30000], 'final_url': page.url}
        except BrowserTimeout:
            return {'status': 'browser_timeout'}
        except Exception:
            return {'status': 'browser_error'}
        finally:
            page.close()

    def close():
        try:
            context.close()
            browser.close()
        finally:
            manager.stop()

    return fetch, close


def safe_limit(value, default, maximum):
    try:
        return min(max(0, int(value)), maximum)
    except (TypeError, ValueError):
        return default


def update(raw, public, fetch, now=None, per_run=10, retry_days=7):
    """No-network pure processing except supplied fetch() callback."""
    raw = copy.deepcopy(raw)
    public = copy.deepcopy(public)
    rindex, pindex = v11.indices(raw, public)
    now = now or datetime.now(timezone.utc)
    state = raw.setdefault('collector_state', {}).setdefault('v13', {})
    checks = state.setdefault('browser_checks', {})
    stats = {
        'urls': len(rindex), 'already_known': 0, 'browser_attempted': 0,
        'deadlines_added': 0, 'starts_added': 0, 'browser_blocked': 0,
        'browser_errors': 0, 'deadline_missing': 0,
    }
    prioritized = sorted(raw['items'], key=lambda x: x.get('discord_posted_at') or '', reverse=True)
    stats['already_known'] = sum(bool(v11.parse_datetime(i.get('application_end_at') or pindex[i['url']].get('application_end_at'))) for i in prioritized)
    for item in prioritized:
        url = item['url']
        pub = pindex[url]
        current_end = v11.parse_datetime(item.get('application_end_at') or pub.get('application_end_at'))
        if current_end:
            continue
        if stats['browser_attempted'] >= per_run:
            break
        previous = checks.get(url, {})
        last = v11.parse_datetime(previous.get('checked_at'))
        if last and now - last.astimezone(timezone.utc) < timedelta(days=retry_days):
            continue
        stats['browser_attempted'] += 1
        try:
            result = fetch(url)
        except Exception:
            result = {'status': 'browser_error'}
        if not isinstance(result, dict):
            result = {'status': 'browser_error'}
        status = str(result.get('status') or 'browser_error')
        if status == 'ok':
            if v12.exact_event_url(result.get('final_url')) != url:
                status = 'browser_redirected'
            else:
                start, end = extract_deadline(result.get('text'))
                if end is None:
                    status = 'browser_date_missing'
                else:
                    old_start = v11.parse_datetime(item.get('application_start_at') or pub.get('application_start_at'))
                    if old_start and old_start > end:
                        status = 'browser_conflicting_dates'
                    elif old_start and start and start != old_start:
                        status = 'browser_conflicting_dates'
                    else:
                        for dst in (item, pub):
                            dst['application_end_at'] = v11.iso(end)
                            if start and not old_start:
                                dst['application_start_at'] = v11.iso(start)
                        fields = item.setdefault('field_sources', {})
                        fields['application_end_at'] = 'v13_livepocket_rendered_public_page'
                        if start and not old_start:
                            fields['application_start_at'] = 'v13_livepocket_rendered_public_page'
                            stats['starts_added'] += 1
                        stats['deadlines_added'] += 1
                        status = 'browser_deadline_found'
        if status.startswith('browser_blocked'):
            stats['browser_blocked'] += 1
        if status in ('browser_error', 'browser_http_error', 'browser_timeout', 'browser_no_response'):
            stats['browser_errors'] += 1
        checks[url] = {'checked_at': now.isoformat(), 'status': status}
        # If LivePocket blocks automation, do not hit any more URLs this run.
        if status.startswith('browser_blocked'):
            break

    # Regenerate review using the established v11 validation & schema.
    raw, public, pending, v11stats = v11.update(raw, public)
    public['schema_version'] = 13
    stats['deadline_missing'] = v11stats['deadline_missing']
    _, pindex = v11.indices(raw, public)
    rows = []
    for item in prioritized:
        url = item['url']
        pub = pindex[url]
        checkpoint = checks.get(url, {})
        last_status = checkpoint.get('status', 'browser_not_checked')
        status = (last_status if last_status == 'browser_deadline_found' else 'deadline_known') if pub.get('application_end_at') else last_status
        rows.append({
            'url': url,
            'store_name': v12._safe_csv(str(pub.get('store_name') or '')),
            'application_end_at': pub.get('application_end_at') or '',
            'search_status': status,
            'checked_at': checkpoint.get('checked_at') or '',
            'notes': {
                'deadline_known': '締切日時確認済み',
                'browser_deadline_found': 'v13ブラウザで締切日時を新規取得',
                'browser_not_checked': '次のブラウザ確認を待機',
                'browser_blocked': 'アクセス制限。自動取得を中止',
                'browser_blocked_or_empty': 'ページ本文取得不可。自動取得を中止',
                'browser_date_missing': '表示本文に確認可能な応募締切なし',
                'browser_redirected': '別URLへ転送。採用せず',
                'browser_conflicting_dates': '複数の締切や既存値が矛盾。採用せず',
            }.get(status, '未取得（次回確認対象）'),
        })
    return raw, public, pending, rows, stats


def main():
    raw = json.loads(RAW_PATH.read_text(encoding='utf-8'))
    public = json.loads(PUBLIC_PATH.read_text(encoding='utf-8'))
    per_run = safe_limit(os.getenv('LIVEPOCKET_V13_PER_RUN'), 10, 25)
    if per_run:
        fetch, close = browser_fetcher()
    else:
        # Fast normal 10-minute collector pass: no browser, no installation,
        # just maintain the v13 public schema and review files.
        fetch, close = (lambda url: {'status': 'browser_not_checked'}), (lambda: None)
    try:
        updated, visible, pending, rows, stats = update(raw, public, fetch, per_run=per_run)
    finally:
        close()
    print('--- LivePocket v13 free browser deadline check ---')
    for key, value in stats.items():
        print(f'{key}: {value}')
    print('raw_updated:', v11.write_json(RAW_PATH, updated))
    print('public_updated:', v11.write_json(PUBLIC_PATH, visible))
    print('deadline_review_updated:', v11.write_csv(REVIEW_PATH, pending))
    print('source_report_updated:', v12.write_report(SOURCES_PATH, rows))
    print('deadline_review_rows:', len(pending))


if __name__ == '__main__':
    main()
