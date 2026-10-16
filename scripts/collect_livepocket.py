"""Read Discord channel history and extract LivePocket URLs (no site scraping)."""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOKEN = os.environ.get('DISCORD_BOT_TOKEN', '').strip()
CHANNEL = os.environ.get('DISCORD_CHANNEL_ID', '1551580466266644552').strip()
BACKFILL = os.environ.get('BACKFILL', 'false').lower() == 'true'
MAX_PAGES = int(os.environ.get('MAX_PAGES', '200' if BACKFILL else '15'))
URL_RE = re.compile(r'https?://(?:www\.)?livepocket\.jp/e/[a-zA-Z0-9_-]+', re.I)
API = 'https://discord.com/api/v10'

def request_messages(before=None):
    params = {'limit': '100'}
    if before: params['before'] = before
    url = f'{API}/channels/{CHANNEL}/messages?{urllib.parse.urlencode(params)}'
    for attempt in range(6):
        req = urllib.request.Request(url, headers={'Authorization': f'Bot {TOKEN}', 'User-Agent': 'PokecaMapLivePocketCollector/1.0'})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode('utf-8', errors='replace')
            if exc.code == 429:
                try: wait = float(json.loads(body).get('retry_after', 2))
                except (ValueError, TypeError): wait = 2
                time.sleep(min(max(wait, 1), 60)); continue
            if exc.code in (401, 403, 404):
                raise RuntimeError(f'Discord API {exc.code}: Bot token or channel permissions/ID need checking') from exc
            if exc.code >= 500 and attempt < 5:
                time.sleep(2 ** attempt); continue
            raise RuntimeError(f'Discord API error {exc.code}: {body[:300]}') from exc
    raise RuntimeError('Discord rate limit retry exceeded')

def main():
    if not TOKEN: raise RuntimeError('DISCORD_BOT_TOKEN is not configured in GitHub Actions Secrets')
    if not CHANNEL.isdecimal(): raise RuntimeError('Invalid DISCORD_CHANNEL_ID')
    cutoff = datetime.now(timezone.utc) - timedelta(hours=30)
    before = None
    results = {}
    total = 0
    pages = 0
    while pages < MAX_PAGES:
        messages = request_messages(before)
        if not messages: break
        pages += 1
        for msg in messages:
            total += 1
            contents = [msg.get('content') or '']
            for embed in msg.get('embeds') or []:
                contents += [str(embed.get(k) or '') for k in ('url','title','description')]
                for field in embed.get('fields') or []:
                    contents += [str(field.get('value') or '')]
            found = set(URL_RE.findall('\n'.join(contents)))
            for url in found:
                url = url.rstrip('.,)）】]')
                if url not in results:
                    results[url] = {
                        'url': url,
                        'discord_message_id': msg['id'],
                        'discord_posted_at': msg.get('timestamp'),
                        'discord_channel_id': CHANNEL,
                        'post_excerpt': (msg.get('content') or '')[:500],
                        'store_name': None,
                        'prefecture': None,
                        'product_name': None,
                        'application_period': None,
                        'sales_period': None,
                        'extraction_status': 'page_not_checked'
                    }
        before = messages[-1]['id']
        oldest = datetime.fromisoformat(messages[-1]['timestamp'].replace('Z', '+00:00'))
        if not BACKFILL and oldest < cutoff: break
        if len(messages) < 100: break
        time.sleep(0.25)
    Path('output').mkdir(exist_ok=True)
    dest = Path('output/livepocket_urls.json')
    dest.write_text(json.dumps({
        'collected_at': datetime.now(timezone.utc).isoformat(),
        'mode': 'backfill' if BACKFILL else 'recent_30_hours',
        'pages_scanned': pages,
        'messages_scanned': total,
        'unique_livepocket_urls': len(results),
        'items': sorted(results.values(), key=lambda x: x['discord_posted_at'] or '', reverse=True)
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Scanned {total} messages ({pages} pages); found {len(results)} LivePocket URLs. Output: {dest}')
    if BACKFILL and pages >= MAX_PAGES:
        print('NOTE: Reached MAX_PAGES; older posts may remain. Increase MAX_PAGES if needed.')

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)
