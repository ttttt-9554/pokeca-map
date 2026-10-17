#!/usr/bin/env python3
"""LivePocket v20: uniform ticket-item product + URL-scoped checked shop regions.

Uses v19.2's existing browser requests exactly once (no paid API or extra page
fetching), preserving new-arrival priority, 6-hour retries, seven-day checks.
A ticket product is accepted only if ALL independently identified shop tickets
carry the same explicitly printed product. CSV overrides require verified=yes
and exact event/store matching; unknown locations are not guessed.
"""
from __future__ import annotations

import copy
import csv
import io
import os
import re
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

import livepocket_v10 as v10
import livepocket_v11 as v11
import livepocket_v12 as v12
import livepocket_v14 as v14
import livepocket_v15 as v15
import livepocket_v16 as v16
import livepocket_v19 as v19

RAW_PATH = v14.RAW_PATH
PUBLIC_PATH = v14.PUBLIC_PATH
MANUAL_PATH = Path(os.getenv('LIVEPOCKET_V20_VERIFIED_FILE', 'livepocket_v20_verified.csv'))
INPUT_COLUMNS = ('url', 'kind', 'store_name', 'prefecture', 'product_name', 'source_url', 'verified')
REPORT_COLUMNS = v19.REPORT_COLUMNS + ('product_origin', 'prefectures_known', 'prefectures_missing')
ITEM_START = re.compile(r'ポケモンカードゲーム|ONE\s*PIECE\s*カードゲーム|ワンピースカードゲーム|遊戯王(?:OCG)?|デュエル・マスターズ|マジック：ザ・ギャザリング', re.I)
ITEM_SPECIFIC = re.compile(r'拡張パック|強化拡張|デッキ|BOX|ボックス|ブースター|30th\s*CELEBRATION|スターター|構築済|パック', re.I)
TICKET_NOISE = re.compile(r'^(?:販売中|受付中|販売終了|受付終了|分配不可|販売予定|購入する|申込する|¥|￥|※|この受付|お一人様|ログイン|注意事項|抽選申込期間)')


def normal_text(s):
    return re.sub(r'\s+', ' ', s).strip()


def ticket_product_candidates(text):
    """Return product per shop ticket, or [] on incomplete/unstructured pages.

    Requires the ticket tab and a status/price marker. A standalone shop list
    never proves what product every participating shop sells.
    """
    if not isinstance(text, str) or '受付・チケット情報' not in text:
        return []
    lines = [s.strip() for s in text.splitlines()]
    result = []
    for i, line in enumerate(lines):
        title = v19.TICKET_SHOP_TITLE.match(line)
        if not title or not v19.safe_name(title.group(1), strict_retail=True):
            continue
        segment = [line.split('】', 1)[1].strip()]
        for line2 in lines[i + 1:i + 11]:
            if v19.TICKET_SHOP_TITLE.match(line2):
                break
            segment.append(line2)
        if not v19.TICKET_CARD_MARKER.search('\n'.join(segment)):
            continue
        item = None
        for j, piece in enumerate(segment):
            m = ITEM_START.search(piece)
            if not m:
                continue
            value = piece[m.start():].strip()
            # Multi-line ticket subtitles: e.g. 「ポケモンカードゲーム」
            # immediately followed by 「MEGA 拡張パック 30th CELEBRATION」.
            if j + 1 < len(segment):
                following = segment[j+1].strip()
                if (following and not TICKET_NOISE.search(following)
                        and len(following) <= 90 and not ITEM_START.search(following)
                        and not re.match(r'^[【\[]', following)
                        and (not ITEM_SPECIFIC.search(value) or following.startswith(('MEGA', '拡張パック', '強化拡張パック', 'プレミアム')))):
                    value = value + ' ' + following
            value = normal_text(value)
            value = v15.clean_value(value, 'product_name')
            if value and ITEM_SPECIFIC.search(value):
                item = value
            break
        result.append((title.group(1), item))
        if len(result) > v19.MAX_STORES:
            return []
    # Products are valid only when at least two *different* shop tickets exist.
    if len({name for name, _ in result}) < 2:
        return []
    return result


def uniform_ticket_product(text):
    tickets = ticket_product_candidates(text)
    if not tickets or any(not value for _, value in tickets):
        return None
    products = {v for _, v in tickets}
    return next(iter(products)) if len(products) == 1 else None


def read_verified(path, known_urls):
    """Strict, atomic verification of manual corrections, event scoped."""
    if not path.exists():
        return {'products': {}, 'prefectures': {}}
    result = {'products': {}, 'prefectures': defaultdict(dict)}
    seen = set()
    with path.open(encoding='utf-8-sig', newline='') as fh:
        rows = csv.DictReader(fh)
        if not rows.fieldnames or any(k not in rows.fieldnames for k in INPUT_COLUMNS):
            raise ValueError('v20 verification file missing columns: ' + ', '.join(INPUT_COLUMNS))
        for n, row in enumerate(rows, 2):
            if None in row:
                raise ValueError(f'v20 line {n}: extra column')
            if not any((v or '').strip() for v in row.values()):
                continue
            flag = (row.get('verified') or '').strip().lower()
            if flag not in ('yes', 'no', ''):
                raise ValueError(f'v20 line {n}: verified must be yes/no')
            if flag != 'yes':
                continue
            url = (row.get('url') or '').strip()
            kind = (row.get('kind') or '').strip()
            name = (row.get('store_name') or '').strip()
            pref = (row.get('prefecture') or '').strip()
            product = (row.get('product_name') or '').strip()
            source = (row.get('source_url') or '').strip()
            if not v10.valid_url(url) or url not in known_urls:
                raise ValueError(f'v20 line {n}: URL not in collected events')
            if not source.startswith('https://') or not urlparse(source).hostname:
                raise ValueError(f'v20 line {n}: invalid source URL')
            if kind == 'product':
                if name or pref or not product or not v15.clean_value(product, 'product_name') or source != url:
                    raise ValueError(f'v20 line {n}: invalid product verification')
                key = (url, kind)
                if key in seen:
                    raise ValueError(f'v20 line {n}: duplicate product verification')
                result['products'][url] = v15.clean_value(product, 'product_name')
            elif kind == 'store_prefecture':
                if not v19.safe_name(name) or pref not in v10.PREFS or product:
                    raise ValueError(f'v20 line {n}: invalid store prefecture')
                # Source must be supplied and HTTPS; each row records its
                # provenance, allowing other shop chains in future updates.
                key = (url, kind, name)
                if key in seen:
                    raise ValueError(f'v20 line {n}: duplicate store name')
                result['prefectures'][url][name] = pref
            else:
                raise ValueError(f'v20 line {n}: unknown kind')
            seen.add(key)
    return result


def checked_page_product(item, page_result):
    if (not isinstance(page_result, dict) or page_result.get('status') != 'ok'
            or v12.exact_event_url(page_result.get('final_url')) != item['url']):
        return None
    return uniform_ticket_product(page_result.get('text'))


def apply_verified(raw, public, pages, verified):
    rindex, pindex = v11.indices(raw, public)
    stats = {'ticket_products_added': 0, 'verified_products_added': 0,
             'verified_prefectures_added': 0, 'multi_store_events': 0,
             'product_conflicts_retained': 0}
    for url, item in rindex.items():
        pub = pindex[url]
        # Use exact-URL page text, never a different event or a rounded-up post.
        found = checked_page_product(item, pages.get(url))
        source = 'v20_uniform_multi_shop_tickets'
        # Screenshot-confirmed manual product takes priority *only if missing*.
        if url in verified['products']:
            found = verified['products'][url]
            source = 'v20_user_verified_event_product'
        current = item.get('product_name') or pub.get('product_name')
        if found:
            if current:
                if normal_text(current) != normal_text(found):
                    stats['product_conflicts_retained'] += 1
            else:
                item['product_name'] = found
                pub['product_name'] = found
                item.setdefault('field_sources', {})['product_name'] = source
                stats['verified_products_added' if source.startswith('v20_user_') else 'ticket_products_added'] += 1

        stores = pub.get('stores') or item.get('stores') or []
        checked = verified['prefectures'].get(url, {})
        present_names = {s.get('name') for s in stores if isinstance(s, dict)}
        if set(checked) - present_names:
            raise ValueError(f'v20: verified shop name not in this event: {url}')
        changed = False
        for store in stores:
            name = store.get('name')
            if name not in checked:
                continue
            old = store.get('prefecture') or ''
            if old and old != checked[name]:
                raise ValueError(f'v20: prefecture conflicts with event store: {url} {name}')
            if not old:
                store['prefecture'] = checked[name]
                stats['verified_prefectures_added'] += 1
                changed = True
        if changed:
            item['stores'] = copy.deepcopy(stores)
            pub['stores'] = copy.deepcopy(stores)
            item.setdefault('field_sources', {})['stores_prefectures'] = 'v20_official_store_url_scoped'
        if len(stores) > 1:
            stats['multi_store_events'] += 1
    return stats


def process(raw, public, fetch, *, now=None, new_limit=15, background_limit=0,
            retry_limit=3, verified=None, v19_verified=None):
    seen = {}
    def record(url):
        result = fetch(url)
        if isinstance(result, dict):
            seen[url] = copy.deepcopy(result)
        return result
    # Calls only the v19->v18 network path once, preserving all priorities.
    raw, public, review, deadlines, sources, content, stats = v19.process(
        raw, public, record, now=now, new_limit=new_limit,
        background_limit=background_limit, retry_limit=retry_limit,
        verified_rows=v19_verified)
    added = apply_verified(raw, public, seen, verified or {'products': {}, 'prefectures': {}})
    stats.update(added)
    # v19 produced review reports before v20 enrichment; rebuild them now.
    raw, public, review, review_stats = v10.transform(raw, public)
    raw, public, deadlines, deadline_stats = v11.update(raw, public)
    review, content = v19.enrich_reports(raw, public, review, content)
    ridx, pidx = v11.indices(raw, public)
    for row in content:
        item = pidx[row['url']]
        shops = item.get('stores') or []
        row['product_name'] = v12._safe_csv(item.get('product_name') or '')
        row['missing_details'] = ','.join(v16.missing_details(item))
        row['product_origin'] = ridx[row['url']].get('field_sources', {}).get('product_name', '')
        row['prefectures_known'] = sum(bool(s.get('prefecture')) for s in shops)
        row['prefectures_missing'] = sum(not bool(s.get('prefecture')) for s in shops)
        row['store_count'] = len(shops)
        row['store_prefectures'] = v12._safe_csv(' / '.join(s.get('prefecture') or '未確認' for s in shops))
    public['schema_version'] = 20
    stats['review_remaining'] = review_stats['review_rows']
    stats['deadline_missing'] = deadline_stats['deadline_missing']
    return raw, public, review, deadlines, sources, content, stats



def browser_fetcher():
    """One standard Chromium visit; optionally activate ticket tab on same URL.

    No login, challenge evasion, alternative services, or paid APIs. The
    original page text is retained so application dates remain available.
    """
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout
    except ImportError as exc:
        raise RuntimeError('Playwright is not installed') from exc
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
            if v14.v13.BLOCK_WORDS.search(body) or len(body.strip()) < 40:
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
            if '受付・チケット情報' in body and not v19.ticket_option_stores(body):
                # Ticket lists can be hidden in another on-page tab. Only try
                # an ordinary visible tab click for the same event, at most once.
                try:
                    tab = page.get_by_text('受付・チケット情報', exact=True).first
                    tab.click(timeout=1500)
                    page.wait_for_timeout(350)
                    if v12.exact_event_url(page.url) != url:
                        return {'status': 'browser_redirected'}
                    ticket_body = page.locator('body').inner_text(timeout=4000)
                    if v19.ticket_option_stores(ticket_body) and ticket_body != body:
                        body += '\n' + ticket_body
                except BrowserTimeout:
                    pass
                except Exception:
                    # Clicking an inaccessible tab is optional, not a reason
                    # to discard already-visible dates or product labels.
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

def write_content(path, rows):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=REPORT_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return v11.atomic_write(path, output.getvalue(), 'utf-8-sig')


def main():
    import sys
    if len(sys.argv) != 2 or sys.argv[1] not in ('plan', 'process'):
        raise SystemExit('Usage: python scripts/livepocket_v20.py plan|process')
    raw, public = v14.read_pair()
    known = {i['url'] for i in raw['items']}
    verified = read_verified(MANUAL_PATH, known)
    v19_verified = v19.read_manual(v19.MANUAL_PATH, known)
    new_limit = v14.safe_limit('LIVEPOCKET_V14_NEW_PER_RUN', 15, 25)
    background_limit = (v14.safe_limit('LIVEPOCKET_V14_BACKGROUND_PER_RUN', 8, 12)
                        if v14.wants_background() else 0)
    retry_limit = v14.safe_limit('LIVEPOCKET_V16_RETRY_PER_RUN', 3, 5)
    if sys.argv[1] == 'plan':
        work = v19.v18.plan(raw, public, new_limit=new_limit,
                            background_limit=background_limit, retry_limit=retry_limit)
        print('v20 free browser plan:', work)
        if os.getenv('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as fh:
                fh.write('browser_needed=' + ('true' if work['browser_needed'] else 'false') + '\n')
        return
    ready = os.getenv('LIVEPOCKET_V20_BROWSER_READY')
    if ready == 'false':
        new_limit = background_limit = retry_limit = 0
        needed = False
    else:
        work = v19.v18.plan(raw, public, new_limit=new_limit,
                            background_limit=background_limit, retry_limit=retry_limit)
        needed = ready == 'true' or work['browser_needed']
    if needed:
        fetch, close = browser_fetcher()
    else:
        def fetch(_url):
            raise AssertionError('Unexpected browser fetch')
        close = lambda: None
    try:
        result = process(raw, public, fetch, new_limit=new_limit,
                         background_limit=background_limit, retry_limit=retry_limit,
                         verified=verified, v19_verified=v19_verified)
    finally:
        close()
    raw, public, review, deadlines, sources, content, stats = result
    for k, v in stats.items():
        print(f'{k}: {v}')
    print('raw_updated:', v11.write_json(RAW_PATH, raw))
    print('public_updated:', v11.write_json(PUBLIC_PATH, public))
    print('review_updated:', v10.write_csv(v15.REVIEW_PATH, review))
    print('deadline_review_updated:', v11.write_csv(v14.REVIEW_PATH, deadlines))
    print('deadline_sources_updated:', v12.write_report(v14.SOURCES_PATH, sources))
    print('content_checks_updated:', write_content(v14.CHECKS_PATH, content))


if __name__ == '__main__':
    main()
