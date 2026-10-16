#!/usr/bin/env python3
"""LivePocket v8: source-traceable Discord embed / optional search enrichment.

Never fetches LivePocket event pages. Only exact-URL-matched Discord embeds
and optional search API results may fill missing fields. No invented dates or
shop names. Existing nonempty values are never overwritten.

Requires only Python 3.12 stdlib. Optional Brave Search API needs a secret.
"""
from __future__ import annotations

import copy
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA_FILE = Path(os.environ.get('LIVEPOCKET_DATA_FILE', 'livepocket_urls.json'))
DISCORD_BASE = 'https://discord.com/api/v10'
BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'
URL_RE = re.compile(r'^/e/[A-Za-z0-9_-]{4,64}$')
DATE_RE = re.compile(r'\d{1,4}[年/.-]\d{1,2}')
RANGE_RE = re.compile(r'(?:〜|～|~|から|まで|–|—|\s[-－]\s)')
PREF_NAMES = {
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県',
    '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県',
    '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県',
    '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県',
    '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
    '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
}
PRODUCT_MATCHERS = (
    re.compile(r'プレミアムデッキセット\s*エーフィ\s*[・＆&/]\s*ブラッキー', re.I),
    re.compile(r'遊戯王\s*ART\s*WORK\s*COLLECTION', re.I),
    re.compile(r'30th\s*CELEBRATION', re.I),
    re.compile(r'ストームエメラルダ'),
    re.compile(r'メガシンフォニア'),
    re.compile(r'エーフィ\s*[・＆&/]\s*ブラッキー'),
    re.compile(r'世界最強の戦士'),
    re.compile(r'Heroines\s*Edition', re.I),
)
SHOP_RE = re.compile(
    r'(?:店舗|店|SHOP|STORE|TSUTAYA|PAO|ホビーステーション|キデイランド|'
    r'竜星|トレカ|カードショップ|ふるいち|古本市場|ブックエース|'
    r'書店|GIRAFULL|フルコンプ|麦わらストア)', re.I
)
BAD_LABEL_RE = re.compile(r'(?:livepocket\.jp|https?://|[„�]|гАР|Ôľ|\.\.\.|…)', re.I)


def clean(value, limit=180):
    if not isinstance(value, str):
        return None
    value = re.sub(r'<[^>]*>', '', value)
    value = html.unescape(value)
    value = re.sub(r'\s+', ' ', value).strip(' \t\r\n・|')
    if not value or len(value) > limit or BAD_LABEL_RE.search(value):
        return None
    return value


def canonical_url(value):
    """Return an event URL only if URL host and path match precisely."""
    if not isinstance(value, str):
        return None
    try:
        p = urllib.parse.urlsplit(value.strip('<> '))
    except ValueError:
        return None
    if p.scheme not in ('http', 'https') or (p.hostname or '').lower() not in (
        'livepocket.jp', 'www.livepocket.jp'
    ) or not URL_RE.fullmatch(p.path):
        return None
    return 'https://livepocket.jp' + p.path


def valid_title(value):
    value = clean(value)
    if not value or len(value) < 5:
        return None
    value = re.sub(r'\s*[-|｜]\s*LivePocket(?:-Ticket-?|株式会社)?\s*$', '', value, flags=re.I).strip()
    if len(value) < 5 or re.fullmatch(r'(?:LivePocket(?:-Ticket-?)?|イベント情報|チケット販売(?:情報)?)', value, re.I):
        return None
    return value


def product_from_title(title):
    if not title:
        return None
    for expression in PRODUCT_MATCHERS:
        m = expression.search(title)
        if m:
            return m.group(0).strip()
    return None


def credible_shop(value):
    s = clean(value, 90)
    if not s or not SHOP_RE.search(s):
        return None
    if product_from_title(s) or 'チケット販売情報' in s or 'まとめ' in s:
        return None
    return s


def period(value):
    s = clean(value, 120)
    if not s or len(DATE_RE.findall(s)) < 2 or not RANGE_RE.search(s):
        return None
    return s


def discord_candidates(embed):
    """Extract a candidate ONLY when this embed has its own event URL.

    Do not attach message-level content or an embed without an exact URL to
    all other links in a multi-URL Discord roundup.
    """
    if not isinstance(embed, dict):
        return None, {}
    url = canonical_url(embed.get('url'))
    if not url:
        return None, {}
    candidate = {}
    title = valid_title(embed.get('title'))
    if title:
        candidate['event_title'] = title
        product = product_from_title(title)
        if product:
            candidate['product_name'] = product
    for field in embed.get('fields') or []:
        if not isinstance(field, dict):
            continue
        key = clean(field.get('name'), 70)
        val = field.get('value')
        if not key:
            continue
        if key in ('商品名', '対象商品', '販売商品'):
            value = clean(val, 110)
            if value and not value.startswith(('http', '※')):
                candidate['product_name'] = value
        elif key in ('店舗名', '開催店舗', '販売店舗'):
            value = credible_shop(val)
            if value:
                candidate['store_name'] = value
        elif key in ('都道府県', '開催都道府県'):
            value = clean(val, 10)
            if value in PREF_NAMES:
                candidate['prefecture'] = value
        elif key in ('応募期間', '抽選受付期間', '申込期間', '受付期間'):
            value = period(val)
            if value:
                candidate['application_period'] = value
    return url, candidate


def apply_candidates(items_by_url, candidates, provenance, stats):
    for url, fields in candidates.items():
        item = items_by_url.get(url)
        if item is None:
            continue
        for key, value in fields.items():
            if not value or item.get(key):
                continue
            item[key] = value
            item.setdefault('field_sources', {})[key] = provenance
            stats[key] = stats.get(key, 0) + 1


class RemoteIssue(Exception):
    def __init__(self, provider, status):
        super().__init__(f'{provider}: HTTP {status}')
        self.provider = provider
        self.status = status


def _json_get(url, headers):
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def fetch_discord(token, channel, message):
    url = f'{DISCORD_BASE}/channels/{channel}/messages/{message}'
    for attempt in range(3):
        try:
            return _json_get(url, {
                'Authorization': f'Bot {token}',
                'User-Agent': 'LivePocketMetadataCollector/8.0',
                'Accept': 'application/json',
            })
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 2:
                try:
                    retry = float(json.loads(exc.read().decode()).get('retry_after', 2))
                except (ValueError, TypeError, OSError):
                    retry = 2.0
                time.sleep(min(max(1.0, retry), 20.0))
                continue
            raise RemoteIssue('Discord', exc.code) from None
        except (OSError, TimeoutError) as exc:
            if attempt == 2:
                raise RemoteIssue('Discord', 'network') from exc
            time.sleep(1.0 + attempt)
    raise RemoteIssue('Discord', 'unavailable')


def brave_search(key, event_url):
    query = urllib.parse.urlencode({
        'q': f'"{event_url}"', 'count': 5, 'country': 'JP', 'search_lang': 'ja',
    })
    try:
        return _json_get(BRAVE_URL + '?' + query, {
            'X-Subscription-Token': key, 'Accept': 'application/json',
            'User-Agent': 'LivePocketMetadataCollector/8.0',
        })
    except urllib.error.HTTPError as exc:
        raise RemoteIssue('Brave', exc.code) from None
    except (OSError, TimeoutError) as exc:
        raise RemoteIssue('Brave', 'network') from exc


def search_candidates(reply, expected_url):
    """Use only a search result whose own URL is the exact LivePocket URL."""
    results = (reply.get('web') or {}).get('results') or [] if isinstance(reply, dict) else []
    for hit in results:
        if not isinstance(hit, dict) or canonical_url(hit.get('url')) != expected_url:
            continue
        title = valid_title(hit.get('title'))
        if not title:
            continue
        fields = {'event_title': title}
        product = product_from_title(title)
        if product:
            fields['product_name'] = product
        return fields
    return {}


def safe_limit(name, default, ceiling):
    try:
        return max(0, min(int(os.environ.get(name, str(default))), ceiling))
    except ValueError:
        return default


def update(data, token='', brave_key='', fetch=fetch_discord, search=brave_search, now=None):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('JSON object with items list required')
    out = copy.deepcopy(data)
    for item in out['items']:
        if not isinstance(item, dict) or not canonical_url(item.get('url')):
            raise ValueError('Invalid item URL')
    by_url = {x['url']: x for x in out['items']}
    if len(by_url) != len(out['items']):
        raise ValueError('Duplicate URL detected; will not modify data')
    now = now or datetime.now(timezone.utc)
    today = now.strftime('%Y-%m-%d')
    timestamp = now.isoformat()
    state = out.setdefault('collector_state', {}).setdefault('v8', {})
    message_checks = state.setdefault('checked_discord_messages', {})
    search_checks = state.setdefault('checked_search_urls', {})
    stats = {'discord_messages_checked': 0, 'brave_searches': 0,
             'event_title': 0, 'product_name': 0, 'store_name': 0,
             'prefecture': 0, 'application_period': 0}

    # Prefer newest messages (newer events are more actionable).
    message_groups = {}
    for item in out['items']:
        mid = str(item.get('discord_message_id') or '')
        cid = str(item.get('discord_channel_id') or '')
        if mid.isdigit() and cid.isdigit():
            message_groups.setdefault((cid, mid), set()).add(item['url'])
    groups = sorted(message_groups.items(), key=lambda pair: int(pair[0][1]), reverse=True)
    if token:
        for (cid, mid), associated_urls in groups:
            if stats['discord_messages_checked'] >= safe_limit('LIVEPOCKET_V8_DISCORD_MAX', 10, 40):
                break
            if mid in message_checks:
                continue
            try:
                msg = fetch(token, cid, mid)
            except RemoteIssue as err:
                print(f'v8: {err}; stopping Discord lookups for this run')
                break
            if not isinstance(msg, dict) or str(msg.get('id')) != mid:
                # Don't trust a mismatched response; try again another run.
                print('v8: Discord response did not match requested message ID')
                break
            found = {}
            for embed in msg.get('embeds') or []:
                event_url, fields = discord_candidates(embed)
                if event_url and event_url in associated_urls:
                    found.setdefault(event_url, {}).update(fields)
            apply_candidates(by_url, found, 'discord_embed:' + mid, stats)
            message_checks[mid] = timestamp
            stats['discord_messages_checked'] += 1

    # Optional search API. Cap all paid search requests per UTC day, across runs.
    if brave_key:
        quota = state.setdefault('brave_daily', {})
        if quota.get('date') != today:
            quota.clear()
            quota.update({'date': today, 'used': 0})
        daily_limit = safe_limit('LIVEPOCKET_V8_BRAVE_DAILY_MAX', 15, 200)
        run_limit = safe_limit('LIVEPOCKET_V8_BRAVE_PER_RUN', 3, 20)
        prioritized = sorted(out['items'], key=lambda x: x.get('discord_posted_at') or '', reverse=True)
        for item in prioritized:
            if stats['brave_searches'] >= run_limit or quota['used'] >= daily_limit:
                break
            url = item['url']
            if url in search_checks or (item.get('event_title') and item.get('product_name')):
                continue
            # Record the request before it is issued, so retries cannot incur unbounded cost.
            quota['used'] += 1
            stats['brave_searches'] += 1
            try:
                reply = search(brave_key, url)
            except RemoteIssue as err:
                print(f'v8: {err}; stopping Brave lookups for this run')
                break
            fields = search_candidates(reply, url)
            apply_candidates(by_url, {url: fields}, 'brave_exact_url:' + url, stats)
            search_checks[url] = timestamp

    out['field_counts'] = {
        **out.get('field_counts', {}),
        **{k: sum(bool(x.get(k)) for x in out['items']) for k in (
            'store_name', 'prefecture', 'product_name', 'event_title',
            'application_period', 'sales_period')},
    }
    return out, stats


def write_if_changed(path, data):
    payload = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    if path.is_file() and path.read_text(encoding='utf-8') == payload:
        return False
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(payload, encoding='utf-8')
    tmp.replace(path)
    return True


def main():
    source = json.loads(DATA_FILE.read_text(encoding='utf-8'))
    out, stats = update(source,
        token=os.environ.get('DISCORD_BOT_TOKEN', '').strip(),
        brave_key=os.environ.get('BRAVE_SEARCH_API_KEY', '').strip())
    changed = write_if_changed(DATA_FILE, out)
    print('--- LivePocket v8 result ---')
    for k, v in stats.items():
        print(f'{k}: {v}')
    print(f'data_updated: {changed}')
    print(f'url_count: {len(out["items"])}')
    print(f'field_counts: {out["field_counts"]}')


if __name__ == '__main__':
    main()
