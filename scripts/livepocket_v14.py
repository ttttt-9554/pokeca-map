#!/usr/bin/env python3
"""LivePocket v14: check newly discovered Discord event URLs FIRST, for free.

Modes (in a single GitHub Actions job):
  snapshot  - record the tracked URL set BEFORE the Discord collector runs
  prepare   - diff that snapshot with the collector output; persist urgent queue
  process   - check urgent URLs now, and older ones only on background runs

No CAPTCHA, login, access-control or rate-limit bypass. Unconfirmed dates are
never used for expiry. Upstream v10, v11, v12 and v13 modules stay unchanged.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v13 as v13

RAW_PATH = Path(os.getenv('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
PUBLIC_PATH = Path(os.getenv('LIVEPOCKET_PUBLIC_FILE', 'livepocket_public.json'))
SNAPSHOT_PATH = Path(os.getenv('LIVEPOCKET_V14_SNAPSHOT', '.livepocket_v14_before.json'))
REVIEW_PATH = Path(os.getenv('LIVEPOCKET_DEADLINE_REVIEW_FILE', 'livepocket_deadline_review.csv'))
SOURCES_PATH = Path(os.getenv('LIVEPOCKET_DEADLINE_SOURCES_FILE', 'livepocket_deadline_sources.csv'))
CHECKS_PATH = Path(os.getenv('LIVEPOCKET_CONTENT_CHECKS_FILE', 'livepocket_content_checks.csv'))
CONTENT_COLUMNS = (
    'url', 'store_name', 'discord_posted_at', 'priority', 'detected_at',
    'checked_at', 'content_status', 'event_title', 'product_name',
    'application_end_at', 'notes'
)
TITLE_BAD = re.compile(
    r'(?i)(?:captcha|access denied|just a moment|403 forbidden|robot check|'
    r'アクセスが制限|チケット購入・予約・販売|^livepocket(?:-ticket-)?$)'
)
TITLE_END = re.compile(r'\s*[-–—|｜]\s*(?:LivePocket(?:-Ticket-)?|ライヴポケット).*$' , re.I)
PRODUCT_LINE = re.compile(r'^(?:対象商品|商品名)\s*[：:]\s*(.{2,130})$')
BLOCK_DELAY_HOURS = 6


def _utc(now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError('now must include timezone')
    return now.astimezone(timezone.utc)


def read_pair():
    return json.loads(RAW_PATH.read_text(encoding='utf-8')), json.loads(PUBLIC_PATH.read_text(encoding='utf-8'))


def event_urls(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('items'), list):
        raise ValueError('Invalid event JSON')
    urls = [i.get('url') for i in raw['items'] if isinstance(i, dict)]
    if len(urls) != len(raw['items']) or any(not v11.valid_url(u) for u in urls) or len(set(urls)) != len(urls):
        raise ValueError('Invalid or duplicated LivePocket URLs')
    return set(urls)


def snapshot_urls(raw):
    return {'urls': sorted(event_urls(raw))}


def _checkpoint(state):
    return state.setdefault('collector_state', {}).setdefault('v14', {})


def prepare(raw, public, snapshot, now=None):
    """No network. Persist the diff so overloads are retried on later runs."""
    raw = copy.deepcopy(raw)
    v11.indices(raw, public)
    current = event_urls(raw)
    previous = snapshot.get('urls') if isinstance(snapshot, dict) else None
    if not isinstance(previous, list) or any(not v11.valid_url(u) for u in previous) or len(previous) != len(set(previous)):
        raise ValueError('Invalid or missing before-collection snapshot')
    if not set(previous).issubset(current):
        raise ValueError('Existing URLs disappeared from collector output; refusing queue update')
    now = _utc(now)
    state = _checkpoint(raw)
    history = state.setdefault('new_url_checks', {})
    pending = state.setdefault('pending_new_urls', [])
    if not isinstance(pending, list) or not isinstance(history, dict):
        raise ValueError('Invalid v14 queue state')
    added = current - set(previous)
    for item in sorted(raw['items'], key=lambda x: (x.get('discord_posted_at') or '', x['url'])):
        url = item['url']
        if url in added and url not in history:
            history[url] = {'detected_at': now.isoformat(), 'status': 'queued'}
            pending.append(url)
    # Clean old queue entries only when an actual first check was recorded.
    state['pending_new_urls'] = [u for u in dict.fromkeys(pending)
                                      if u in current and not history.get(u, {}).get('checked_at')]
    return raw, {'new_detected': len(added), 'pending_new': len(state['pending_new_urls'])}


def _cooldown_active(state, now):
    until = v11.parse_datetime(state.get('blocked_until'))
    return bool(until and _utc(now) < until.astimezone(timezone.utc))


def _select(raw, public, now, *, new_limit=15, background_limit=0, retry_days=7):
    rindex, pindex = v11.indices(raw, public)
    state = _checkpoint(raw)
    if _cooldown_active(state, now):
        return [], [], True
    checks = raw.setdefault('collector_state', {}).setdefault('v13', {}).setdefault('browser_checks', {})
    pending = [u for u in state.get('pending_new_urls', []) if u in rindex]
    pending.sort(key=lambda u: (rindex[u].get('discord_posted_at') or '', u), reverse=True)
    urgent = pending[:new_limit]
    background = []
    if background_limit:
        for item in sorted(raw['items'], key=lambda i: (i.get('discord_posted_at') or ''), reverse=True):
            u = item['url']
            if u in pending:
                continue  # A queued NEW URL must never be scanned as historical.
            # Do not scan already checked pages repeatedly within the cooldown.
            check = checks.get(u, {})
            last = v11.parse_datetime(check.get('checked_at'))
            if last and _utc(now) - last.astimezone(timezone.utc) < timedelta(days=retry_days):
                continue
            pub = pindex[u]
            if v11.parse_datetime(item.get('application_end_at') or pub.get('application_end_at')) and (pub.get('event_title') or item.get('event_title')):
                continue
            background.append(u)
            if len(background) >= background_limit:
                break
    return urgent, background, False


def clean_title(value):
    if not isinstance(value, str):
        return None
    s = re.sub(r'\s+', ' ', value).strip()
    s = TITLE_END.sub('', s).strip()
    if (len(s) < 5 or len(s) > 160 or TITLE_BAD.search(s)
        or re.search(r'http[s]?://|[\ufffd„]|(?:\.\.\.|…)', s, re.I)
        or s in ('イベント', 'イベント情報', 'チケット', 'チケット情報', '受付中')):
        return None
    return v10.clean_text(s, 160)


def extract_product(text):
    """Only accept exactly one non-truncated explicitly labelled product."""
    if not isinstance(text, str):
        return None
    candidates = set()
    for line in text.splitlines():
        match = PRODUCT_LINE.fullmatch(line.strip())
        if not match:
            continue
        name = v10.clean_text(match.group(1).strip(), 110)
        if name and not re.search(r'[、,，;；]|(?:その他|など|ほかの商品)', name):
            candidates.add(name)
    return next(iter(candidates)) if len(candidates) == 1 else None


def pick_title(result):
    for candidate in result.get('titles') or []:
        title = clean_title(candidate)
        if title:
            return title
    return None


def browser_fetcher():
    """Read rendered public pages with a normal browser; don't evade blocks."""
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout
    except ImportError as ex:
        raise RuntimeError('Playwright is not installed') from ex
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
            body = ''
            for _ in range(3):
                try:
                    body = page.locator('body').inner_text(timeout=4000)
                except BrowserTimeout:
                    body = ''
                if len(body.strip()) > 80:
                    break
                page.wait_for_timeout(1500)
            if v13.BLOCK_WORDS.search(body) or len(body.strip()) < 40:
                return {'status': 'browser_blocked_or_empty'}
            titles = []
            try:
                og = page.locator('meta[property="og:title"]').first.get_attribute('content', timeout=800)
                if og:
                    titles.append(og)
            except Exception:
                pass
            try:
                titles.extend(page.locator('h1').all_inner_texts(timeout=1200)[:3])
            except Exception:
                pass
            try:
                titles.append(page.title())
            except Exception:
                pass
            return {'status': 'ok', 'final_url': page.url, 'text': body[:30000], 'titles': titles}
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


def _update_fields(item, pub, result, stats):
    """Merge only confirmed, non-conflicting page-specific details."""
    if v12.exact_event_url(result.get('final_url')) != item['url']:
        return 'browser_redirected'
    text = result.get('text')
    if not isinstance(text, str):
        return 'browser_date_missing'
    fields = item.setdefault('field_sources', {})
    found = []
    title = pick_title(result)
    if title and not (item.get('event_title') or pub.get('event_title')):
        item['event_title'] = title
        pub['event_title'] = title
        fields['event_title'] = 'v14_livepocket_page_title'
        stats['titles_added'] += 1
        found.append('title')
    product = extract_product(text)
    if product and not (item.get('product_name') or pub.get('product_name')):
        item['product_name'] = product
        pub['product_name'] = product
        fields['product_name'] = 'v14_livepocket_explicit_product_label'
        stats['products_added'] += 1
        found.append('product')
    start, end = v13.extract_deadline(text)
    if end:
        old_start = v11.parse_datetime(item.get('application_start_at') or pub.get('application_start_at'))
        old_end = v11.parse_datetime(item.get('application_end_at') or pub.get('application_end_at'))
        if (old_end and old_end != end) or (old_start and (old_start > end or (start and old_start != start))):
            stats['date_conflicts'] += 1
            # Do not destroy trustworthy titles/products just because dates conflict.
            found.append('date_conflict')
        else:
            if not old_end:
                for dst in (item, pub):
                    dst['application_end_at'] = v11.iso(end)
                fields['application_end_at'] = 'v14_livepocket_rendered_public_page'
                stats['deadlines_added'] += 1
                found.append('deadline')
            if start and not old_start:
                for dst in (item, pub):
                    dst['application_start_at'] = v11.iso(start)
                fields['application_start_at'] = 'v14_livepocket_rendered_public_page'
                stats['starts_added'] += 1
    cat = v10.category_of(pub)
    if cat != 'unknown':
        pub['review_category'] = cat
    return 'checked_' + ('_'.join(found) if found else 'no_new_details')


def process(raw, public, fetch, *, now=None, new_limit=15, background_limit=0):
    """Perform selected checks only; `fetch` injects mock network for tests."""
    raw = copy.deepcopy(raw)
    public = copy.deepcopy(public)
    now = _utc(now)
    rindex, pindex = v11.indices(raw, public)
    state = _checkpoint(raw)
    history = state.setdefault('new_url_checks', {})
    checks = raw.setdefault('collector_state', {}).setdefault('v13', {}).setdefault('browser_checks', {})
    urgent, background, cooling = _select(raw, public, now, new_limit=new_limit, background_limit=background_limit)
    stats = {'urgent_pending_at_start': len(state.get('pending_new_urls', [])),
             'urgent_attempted': 0, 'background_attempted': 0,
             'titles_added': 0, 'products_added': 0, 'deadlines_added': 0,
             'starts_added': 0, 'date_conflicts': 0, 'blocked': 0,
             'cooldown_active': bool(cooling)}
    for url in urgent + background:
        is_urgent = url in urgent
        try:
            result = fetch(url)
        except Exception:
            result = {'status': 'browser_error'}
        if not isinstance(result, dict):
            result = {'status': 'browser_error'}
        status = str(result.get('status') or 'browser_error')
        if status == 'ok':
            status = _update_fields(rindex[url], pindex[url], result, stats)
        stamp = now.isoformat()
        checks[url] = {'checked_at': stamp, 'status': status}
        if is_urgent:
            stats['urgent_attempted'] += 1
            entry = history.setdefault(url, {'detected_at': stamp})
            entry.update({'checked_at': stamp, 'status': status})
            state['pending_new_urls'] = [u for u in state['pending_new_urls'] if u != url]
        else:
            stats['background_attempted'] += 1
        if status in ('browser_blocked', 'browser_blocked_or_empty'):
            stats['blocked'] += 1
            state['blocked_until'] = (now + timedelta(hours=BLOCK_DELAY_HOURS)).isoformat()
            break

    # Use v11's existing strict raw/public reconciliation & missing-date list.
    raw, public, pending_deadlines, v11stats = v11.update(raw, public)
    public['schema_version'] = 14
    rindex, pindex = v11.indices(raw, public)
    stats['urgent_remaining'] = len(state.get('pending_new_urls', []))
    stats['deadline_missing'] = v11stats['deadline_missing']
    checked_rows = []
    source_rows = []
    for item in sorted(raw['items'], key=lambda i: i.get('discord_posted_at') or '', reverse=True):
        url = item['url']
        pub = pindex[url]
        check = checks.get(url, {})
        history_item = history.get(url, {})
        priority = ('new_pending' if url in state.get('pending_new_urls', [])
                    else 'new_checked' if url in history else 'background')
        status = (history_item.get('status') if history_item.get('checked_at')
                  else 'new_pending' if priority == 'new_pending'
                  else check.get('status') or 'not_checked')
        checked_rows.append({
            'url': url,
            'store_name': v12._safe_csv(str(pub.get('store_name') or '')),
            'discord_posted_at': pub.get('discord_posted_at') or '',
            'priority': priority,
            'detected_at': history_item.get('detected_at') or '',
            'checked_at': check.get('checked_at') or '',
            'content_status': status,
            'event_title': v12._safe_csv(str(pub.get('event_title') or '')),
            'product_name': v12._safe_csv(str(pub.get('product_name') or '')),
            'application_end_at': pub.get('application_end_at') or '',
            'notes': '要確認：新着URLのページ確認待ち' if priority == 'new_pending' else (
                'ブラウザで取得不可。締切不明のまま' if str(status).startswith('browser_') else ''),
        })
        source_status = ('browser_deadline_found' if status and 'deadline' in str(status)
                         else 'deadline_known' if v11.parse_datetime(pub.get('application_end_at'))
                         else 'browser_not_checked' if status in ('not_checked', 'new_pending')
                         else str(status))
        source_rows.append({
            'url': url, 'store_name': v12._safe_csv(str(pub.get('store_name') or '')),
            'application_end_at': pub.get('application_end_at') or '',
            'search_status': source_status,
            'checked_at': check.get('checked_at') or '',
            'notes': 'v14新着優先チェック' if priority.startswith('new_') else '',
        })
    return raw, public, pending_deadlines, source_rows, checked_rows, stats


def write_content_csv(path, rows):
    buff = io.StringIO(newline='')
    writer = csv.DictWriter(buff, fieldnames=CONTENT_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, buff.getvalue(), 'utf-8-sig')


def safe_limit(name, default, maximum):
    return v13.safe_limit(os.getenv(name), default, maximum)


def wants_background():
    return os.getenv('LIVEPOCKET_V14_RUN_BACKGROUND', 'false').lower() in ('true', '1', 'yes')


def work_plan(raw, public, now=None):
    urgent, background, cooling = _select(
        copy.deepcopy(raw), public, _utc(now),
        new_limit=safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25),
        background_limit=safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12) if wants_background() else 0,
    )
    return {'browser_needed': bool(urgent or background),
            'urgent_selected': len(urgent), 'background_selected': len(background),
            'blocked_cooldown': cooling}


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ('snapshot', 'prepare', 'process'):
        raise SystemExit('Usage: python scripts/livepocket_v14.py snapshot|prepare|process')
    mode = sys.argv[1]
    if mode == 'snapshot':
        snap = snapshot_urls(json.loads(RAW_PATH.read_text(encoding='utf-8')))
        SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT_PATH.write_text(json.dumps(snap, ensure_ascii=False), encoding='utf-8')
        print('Before Discord collect:', len(snap['urls']), 'URLs')
        return
    raw, public = read_pair()
    if mode == 'prepare':
        if not SNAPSHOT_PATH.is_file():
            raise SystemExit('Missing BEFORE collection URL snapshot: aborting (do not reclassify old URLs as new)')
        snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding='utf-8'))
        raw, stats = prepare(raw, public, snapshot)
        print('v14 new URL detection:', stats)
        print('raw queue updated:', v11.write_json(RAW_PATH, raw))
        plan = work_plan(raw, public)
        print('v14 plan:', plan)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
                out.write(f"browser_needed={'true' if plan['browser_needed'] else 'false'}\n")
                out.write(f"new_pending={stats['pending_new']}\n")
        return
    plan = work_plan(raw, public)
    if plan['browser_needed']:
        fetch, close = browser_fetcher()
    else:
        fetch, close = (lambda u: (_ for _ in ()).throw(AssertionError('Unexpected browser call'))), (lambda: None)
    try:
        raw, public, deadline_rows, source_rows, content_rows, stats = process(
            raw, public, fetch,
            new_limit=safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25),
            background_limit=safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12) if wants_background() else 0,
        )
    finally:
        close()
    print('--- v14 NEW URL PRIORITY check ---')
    for name, value in stats.items():
        print(f'{name}: {value}')
    print('raw_updated:', v11.write_json(RAW_PATH, raw))
    print('public_updated:', v11.write_json(PUBLIC_PATH, public))
    print('deadline_review_updated:', v11.write_csv(REVIEW_PATH, deadline_rows))
    print('deadline_sources_updated:', v12.write_report(SOURCES_PATH, source_rows))
    print('content_checks_updated:', write_content_csv(CHECKS_PATH, content_rows))


if __name__ == '__main__':
    main()
