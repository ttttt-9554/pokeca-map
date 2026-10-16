#!/usr/bin/env python3
"""Fill missing LivePocket product labels and explicitly stated application periods
from *existing Discord post text*, without requesting LivePocket webpages.

Conservative by design: a URL must be directly adjacent to a recognizable product
label, or an application-period line must immediately follow the URL.
Never rewrite independently verified values. Python 3.12 stdlib only.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

DATA_PATH = Path(os.environ.get("LIVEPOCKET_DATA_FILE", "livepocket_urls.json"))
URL_RE = re.compile(r"https?://(?:www\.)?livepocket\.jp/e/([A-Za-z0-9_-]{4,64})(?![A-Za-z0-9_-])", re.I)
# Intentionally narrow product identifiers seen in the actual Discord feed.
PRODUCT_RE = re.compile(
    r"(?:30th\s*CELEBRATION|エーフィ\s*[＆&・/]\s*ブラッキー|"
    r"プレミアムデッキセット|ストームエメラルダ|メガシンフォニア|"
    r"世界最強の戦士|Heroines\s*Edition|"
    r"遊戯王\s*ART\s*WORK\s*COLLECTION)",
    re.I,
)
# Unambiguous full start/end time only. Text is saved verbatim; year not guessed.
PERIOD_RE = re.compile(
    r"^(?:受付(?:期間)?|応募(?:受付)?期間|抽選受付期間|申込期間)\s*[：:]\s*"
    r"(.{4,120})$"
)
RANGE_RE = re.compile(r"(?:〜|～|~|－|–|—|から|～)")
DAY_RE = re.compile(r"(?:\d{1,2}/\d{1,2}|\d{1,2}月\d{1,2}日)")
TIME_RE = re.compile(r"\d{1,2}\s*[:：]\s*\d{2}")
BULLET_RE = re.compile(r"^\s*(?:[・●•]|\*)\s*(.+?)\s*$")


def urls_in(line: str) -> list[str]:
    return list(dict.fromkeys(f"https://livepocket.jp/e/{m.group(1)}" for m in URL_RE.finditer(line)))


def product_label(line: str) -> str | None:
    """Recognize a product-labelled line, never a truncated preview."""
    s = line.strip().strip(' \t')
    s = re.sub(r"^[・●•*]\s*", "", s).strip()
    if not (2 <= len(s) <= 100) or '...' in s or '…' in s or 'http' in s:
        return None
    if not PRODUCT_RE.search(s):
        return None
    if s.startswith(("📍", "※", "🔗", "■", "【")):
        return None
    # Keep the name as the source calls it; only remove explicitly workflow-related
    # final suffixes that are not part of the name.
    s = re.sub(r"\s*(?:\d+次抽選|再販)\s*$", "", s)
    return s.strip() or None


def period_text(line: str) -> str | None:
    m = PERIOD_RE.match(line.strip())
    if not m:
        return None
    s = m.group(1).strip().rstrip('。')
    if '...' in s or '…' in s or not RANGE_RE.search(s):
        return None
    if len(DAY_RE.findall(s)) < 2 or len(TIME_RE.findall(s)) < 2:
        return None
    return s


def parse_post(text: str) -> dict[str, dict[str, str]]:
    """Return direct adjacency evidence, no cross-block inference."""
    found: dict[str, dict[str, str]] = {}
    pending_product: str | None = None
    previous_url: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            pending_product = None
            previous_url = None
            continue
        matches = urls_in(line)
        if matches:
            # If a URL is followed by another URL, do not transfer the first one's
            # product label to the following URL: conservative one-to-one matching.
            if pending_product and len(matches) == 1:
                found.setdefault(matches[0], {})['product_name'] = pending_product
            previous_url = matches[0] if len(matches) == 1 else None
            pending_product = None
            continue
        if previous_url:
            period = period_text(line)
            if period:
                found.setdefault(previous_url, {})['application_period'] = period
            previous_url = None
        pending_product = product_label(line)
    return found


def enrich(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('Expected JSON with an items array')
    out = copy.deepcopy(data)
    index = {i.get('url'): i for i in out['items'] if isinstance(i, dict) and i.get('url')}
    posts: dict[str, tuple[str, str]] = {}
    for item in out['items']:
        if not isinstance(item, dict):
            continue
        message_id = str(item.get('discord_message_id') or '')
        body = item.get('post_excerpt')
        if message_id and isinstance(body, str) and body.strip():
            # Use the longest available copy of the original post (not another post).
            if message_id not in posts or len(body) > len(posts[message_id][1]):
                posts[message_id] = (message_id, body)
    stats = {'posts_examined': len(posts), 'urls_preserved': len(out['items']),
             'product_names_added': 0, 'application_periods_added': 0, 'conflicts_preserved': 0}
    for msg_id, body in posts.values():
        candidates = parse_post(body)
        for url, fields in candidates.items():
            item = index.get(url)
            if not item:
                continue
            # Keep direct provenance: the target URL must have been in this exact post.
            if str(item.get('discord_message_id') or '') != msg_id:
                continue
            for field, value in fields.items():
                original = item.get(field)
                if original not in (None, ''):
                    if original != value:
                        stats['conflicts_preserved'] += 1
                    continue
                item[field] = value
                item.setdefault('field_sources', {})[field] = 'discord_post:' + msg_id
                stats['product_names_added' if field == 'product_name' else 'application_periods_added'] += 1
    if stats['product_names_added'] or stats['application_periods_added']:
        out['field_counts'] = {
            **out.get('field_counts', {}),
            **{field: sum(item.get(field) not in ('', None) for item in out['items']
                           if isinstance(item, dict))
               for field in ('product_name', 'application_period')},
        }
    return out, stats


def main() -> int:
    if not DATA_PATH.is_file():
        print(f'Missing data file: {DATA_PATH}', file=sys.stderr)
        return 1
    with DATA_PATH.open(encoding='utf-8') as f:
        data = json.load(f)
    updated, stats = enrich(data)
    if updated != data:
        tmp = DATA_PATH.with_suffix(DATA_PATH.suffix + '.tmp')
        with tmp.open('w', encoding='utf-8') as f:
            json.dump(updated, f, ensure_ascii=False, indent=2)
            f.write('\n')
        tmp.replace(DATA_PATH)
    else:
        print('No new supported details; JSON unchanged')
    for key, val in stats.items():
        print(f'{key}: {val}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
