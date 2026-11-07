"""Collect public CustomForm lottery metadata using the normal browser."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

from livepocket_master_prefecture import apply_one, fetch_regions

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'other_lottery_public.json'


def supported(url):
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and parsed.netloc == 'customform.jp'
                and bool(re.fullmatch(r'/form/input/\d{1,10}/?', parsed.path))
                and (not parsed.query or bool(re.fullmatch(r'key=[a-zA-Z0-9_-]{8,64}', parsed.query)))
                and not parsed.fragment)
    except ValueError:
        return False


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result if result.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


def candidates(catalog, now):
    # Discord collection preserves item metadata, but rebuilds the catalog's
    # top-level counters on every run. Keep host backoff on the affected item.
    cooldowns = [catalog.get('customform_retry_after')] + [
        item.get('customform_retry_after') for item in catalog.get('items', [])
        if supported(item.get('url'))]
    if any(value and value > now for value in map(timestamp, cooldowns)):
        return []
    output = []
    for item in catalog.get('items', []):
        posted = timestamp(item.get('discord_posted_at')) or timestamp(item.get('first_detected_at'))
        checked = timestamp(item.get('customform_checked_at'))
        if (supported(item.get('url')) and not item.get('customform_verified_at')
                and posted and posted >= now - timedelta(days=7)
                and (not checked or checked <= now - timedelta(days=1))):
            output.append(item)
    return sorted(output, key=lambda row: row.get('discord_posted_at', ''), reverse=True)[:3]


def parse_page(html, url):
    result = subprocess.run(
        ['node', str(ROOT / 'scripts/customform_lottery_parse.mjs')],
        input=json.dumps({'html': html, 'url': url}), text=True,
        capture_output=True, check=True, timeout=15, cwd=ROOT
    )
    return json.loads(result.stdout)


def browser_pages(items):
    from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout, Error as BrowserError
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        context = browser.new_context()
        try:
            for item in items:
                page = context.new_page()
                try:
                    page.goto(item['url'], wait_until='domcontentloaded', timeout=25000)
                    page.wait_for_selector('h1', state='visible', timeout=25000)
                    page.wait_for_selector(r'[wire\:snapshot]', state='attached', timeout=5000)
                    html = page.content()
                    yield item, html if page.url == item['url'] and len(html.encode()) <= 2_000_000 else '', False
                except BrowserTimeout:
                    blocked = bool(page.locator('script[src*="awswaf.com"]').count())
                    yield item, '', blocked
                    if blocked:
                        break
                except BrowserError:
                    # Keep successful earlier pages and retry ordinary network
                    # failures later without logging page data or credentials.
                    yield item, '', False
                finally:
                    page.close()
        finally:
            context.close()
            browser.close()


def apply_fields(item, fields, regions, now):
    if not all(fields.get(name) for name in ('event_title', 'application_start_at', 'application_end_at')):
        return False
    apply_one(fields, fields, regions)
    if fields.get('stores'):
        fields['prefecture'] = fields['stores'][0].get('prefecture', '')
    product_type = fields.pop('product_type', None)
    item.update(fields)
    item.update(official_event_title=fields['event_title'], event_title_provisional=False,
                external_url_unverified=False, customform_verified_at=now.isoformat())
    if product_type:
        item['pokemon_map_type'] = product_type
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('plan', 'run', 'regions'))
    args = parser.parse_args()
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    now = datetime.now(timezone.utc)
    items = candidates(catalog, now)
    if args.mode == 'plan':
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write('browser_needed=' + ('true' if items else 'false') + '\n')
        print('Pending CustomForm lotteries:', len(items))
        return
    region_items = [item for item in catalog.get('items', [])
                    if item.get('customform_verified_at') and isinstance(item.get('stores'), list)
                    and any(not store.get('prefecture') for store in item['stores'])]
    if not items and not region_items:
        return
    regions = {}
    if os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SERVICE_ROLE_KEY'):
        try:
            regions = fetch_regions(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
        except (RuntimeError, ValueError, OSError):
            print('CustomForm store regions will be retried from the store master.')
    changes = 0
    for item in region_items:
        changes += apply_one(item, item, regions)
        if item['stores'][0].get('prefecture') and not item.get('prefecture'):
            item['prefecture'] = item['stores'][0]['prefecture']
    if args.mode == 'regions':
        if changes:
            temp = CATALOG.with_suffix('.tmp')
            temp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            temp.replace(CATALOG)
        print('CustomForm store regions filled:', changes)
        return
    verified = 0
    for item, html, blocked in browser_pages(items):
        item['customform_checked_at'] = now.isoformat()
        if html:
            verified += apply_fields(item, parse_page(html, item['url']), regions, now)
        if blocked:
            item['customform_retry_after'] = (now + timedelta(days=1)).isoformat()
    temp = CATALOG.with_suffix('.tmp')
    temp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(CATALOG)
    print('CustomForm lotteries verified:', verified)


if __name__ == '__main__':
    main()
