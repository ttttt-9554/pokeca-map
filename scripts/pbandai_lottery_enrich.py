"""Read Premium Bandai's public lottery panel after normal browser rendering."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / 'scripts/online_shop_lottery_enrich.mjs'


def candidates():
    result = subprocess.run(['node', str(COLLECTOR), 'plan-bandai'], cwd=ROOT,
                            text=True, capture_output=True, check=True, timeout=15)
    return json.loads(result.stdout)


def browser_pages(items):
    from playwright.sync_api import sync_playwright, TimeoutError, Error
    output = []
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        context = browser.new_context(locale='ja-JP', timezone_id='Asia/Tokyo')
        try:
            for item in items:
                page = context.new_page()
                row = {'url': item['url'], 'html': '', 'blocked': False}
                try:
                    response = page.goto(item['source'], wait_until='domcontentloaded', timeout=30000)
                    if response and response.status in (401, 403, 429):
                        row['blocked'] = True
                    else:
                        # Some responses initially contain only the site's JS loader.
                        # Let the normal page load; do not interact with verification.
                        page.wait_for_selector('h1.pb24-item-main__title', state='visible', timeout=30000)
                        page.wait_for_selector('dl.pb24-item-main__lotterycart--data', state='visible', timeout=15000)
                        if page.url == item['source']:
                            html = page.content()
                            if len(html.encode('utf-8')) <= 2_000_000:
                                row['html'] = html
                except TimeoutError:
                    try:
                        text = page.locator('body').inner_text(timeout=3000)[:1000] if page.locator('body').count() else ''
                    except Error:
                        text = ''
                    row['blocked'] = bool(re.search(r'Access\s+Denied|verify (?:that )?you are human|アクセスが制限|ロボットではありません', text, re.I))
                except Error:
                    pass
                finally:
                    page.close()
                output.append(row)
                print('Premium Bandai public lottery panel:', 'ready' if row['html'] else 'access denied' if row['blocked'] else 'unavailable')
                if row['blocked']:
                    break
        finally:
            context.close()
            browser.close()
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('plan', 'run'))
    args = parser.parse_args()
    items = candidates()
    if args.mode == 'plan':
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write('browser_needed=' + ('true' if items else 'false') + '\n')
        print('Pending Premium Bandai lotteries:', len(items))
    elif items:
        pages = browser_pages(items)
        subprocess.run(['node', str(COLLECTOR), 'apply-bandai'], cwd=ROOT,
                       input=json.dumps(pages), text=True, check=True, timeout=30)


if __name__ == '__main__':
    main()
