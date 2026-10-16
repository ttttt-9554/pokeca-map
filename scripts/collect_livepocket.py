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

PREFECTURES = set("北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split())

def extract_post_details(content, url):
    """Extract location tied to this exact URL, not another shop in the same post."""
    lines = [line.strip() for line in content.splitlines()]
    matches = [i for i, line in enumerate(lines) if url in URL_RE.findall(line)]
    if not matches:
        return {'store_name': None, 'prefecture': None, 'details_source': None}
    idx = matches[0]
    # A location block starts at the nearest preceding 📍 marker.
    start = next((j for j in range(idx - 1, -1, -1) if lines[j].startswith('📍')), -1)
    if start < 0 or idx - start > 12:
        return {'store_name': None, 'prefecture': None, 'details_source': None}
    region = lines[start].lstrip('📍').strip().split(' ')[0]
    pref = region if region in PREFECTURES else None
    candidates = [line for line in lines[start + 1:idx]
                  if line and not URL_RE.search(line) and not line.startswith(('📍', '🔗', 'http'))]
    name = candidates[-1] if candidates else None
    if name and (name.startswith(('※', '【', '⚠', '抽選', '応募')) or len(name) > 100):
        name = None
    return {'store_name': name, 'prefecture': pref,
            'details_source': 'discord_post' if name or pref else None}

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
                    post_details = extract_post_details('\n'.join(contents), url)
                    results[url] = {
                        'url': url,
                        'discord_message_id': msg['id'],
                        'discord_posted_at': msg.get('timestamp'),
                        'discord_channel_id': CHANNEL,
                        'post_excerpt': (msg.get('content') or '')[:500],
                        'store_name': post_details['store_name'],
                        'prefecture': post_details['prefecture'],
                        'details_source': post_details['details_source'],
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
