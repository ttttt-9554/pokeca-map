#!/usr/bin/env python3
"""LivePocket v21.7: incremental Discord collector and safe URL-product pairing.

Keeps previously captured URLs and their metadata. Does not scrape LivePocket
or bypass verification screens. Designed for GitHub Actions.
"""

from __future__ import annotations

import copy
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
from functools import lru_cache
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_PATH = Path(os.environ.get("LIVEPOCKET_DATA_FILE", "livepocket_urls.json"))
BASE_URL = "https://discord.com/api/v10"
EVENT_RE = re.compile(
    r"https?://(?:www\.)?livepocket\.jp/e/([a-zA-Z0-9_-]{4,64})(?![a-zA-Z0-9_-])",
    re.I,
)
PREF_RE = re.compile(r"^📍\s*(.+?)\s*$")
PREF_NAMES = (
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
)
PREF_SET = set(PREF_NAMES)
MOJIBAKE_RE = re.compile(r"[\u0400-\u052F„�]|(?:Ôľ|„Ä|гАР)")
PRODUCT_LIKE_RE = re.compile(
    r"(ポケモンカード|ポケカ商品|ワンピースカード|ONE\s*PIECEカード|"
    r"落選者専用|\d+月(?:中旬|下旬)?再販|\d+/\d+\(.+?\)発売|"
    r"発売\s*ポケカ|応募受付|抽選販売|通販「.*\.\.\.)",
    re.I,
)
# v21.5: URL-specific product labels from later Discord posts.
# Only explicit labels also supported by the local discovery-map product CSVs
# are trusted. Generic abbreviations such as "30th" or "ストーム" are excluded.
CATALOG_FILES = (
    Path(os.environ.get('POKEMON_PACKS_FILE', 'pokemon_packs.csv')),
    Path(os.environ.get('POKEMON_DECKS_FILE', 'pokemon_decks.csv')),
)
CATALOG_NAME_COLUMNS = ('パック名', '商品名', 'デッキ名', 'name', 'product_name')
PRODUCT_PREFIX = re.compile(r'^(?:商品名|対象商品|対象パック|対象デッキ|商品|ポケカ)\s*[：:]\s*')
LABEL_CLEAN = re.compile(r'[\s\u3000・･&＆/／\\|:：;；、。，．!！?？()（）\[\]【】「」『」"\'\-_+＋~〜～=]')


def product_norm(value: str) -> str:
    return LABEL_CLEAN.sub('', unicodedata.normalize('NFKC', value).casefold())


def load_product_catalog(paths=CATALOG_FILES) -> dict[str, set[str]]:
    """Map normalized product names to their literal display names; no API."""
    names: dict[str, set[str]] = {}
    for path in paths:
        if not Path(path).is_file():
            continue
        try:
            body = Path(path).read_text(encoding='utf-8-sig')
        except UnicodeDecodeError:
            body = Path(path).read_text(encoding='cp932')
        reader = csv.DictReader(body.splitlines())
        column = next((h for h in (reader.fieldnames or [])
                       if h.strip() in CATALOG_NAME_COLUMNS), None)
        if not column:
            continue
        for record in reader:
            label = (record.get(column) or '').strip()
            key = product_norm(label)
            if label and 5 <= len(key) <= 170 and '...' not in key and '…' not in key:
                names.setdefault(key, set()).add(label)
    return names


@lru_cache(maxsize=1)
def _cached_product_catalog() -> dict[str, set[str]]:
    return load_product_catalog()


def adjacent_catalog_label(text: str, catalog: dict[str, set[str]]) -> str | None:
    """Only accept a title actually written in Discord and supported by catalog.

    The catalog never expands shorthand into a guessed official product name.
    """
    s = text.strip()
    # Safe presentational markup used in Discord product lists.
    s = re.sub(r'^(?:\s*[•●\-*]\s+|\s*[🎴📦]\s*)+', '', s).strip()
    if s.startswith('**') and s.endswith('**') and len(s) > 4:
        s = s[2:-2].strip()
    s = PRODUCT_PREFIX.sub('', s).strip().lstrip('・●•*').strip()
    if not (5 <= len(s) <= 130) or '...' in s or '…' in s or EVENT_RE.search(s):
        return None
    if s.startswith(('※','【','📍','🔗','■','⚠','🎫','#')):
        return None
    key = product_norm(s)
    if len(key) < 5 or not any(c.isalpha() for c in key):
        return None
    if key in catalog:
        return s
    # Unique, distinctive suffix. Do not replace it with longer catalog text.
    if len(key) >= 6 and len({name for title, labels in catalog.items()
                             if title.endswith(key) for name in labels}) == 1:
        return s
    return None


def _single_url_line(line: str) -> str | None:
    """Accept ONLY one bare, angle-bracketed or unambiguous Markdown link."""
    line = line.strip()
    bare = line.strip('<>')
    if EVENT_RE.fullmatch(bare):
        return event_urls(bare)[0]
    md = re.fullmatch(r'\[([^\]\n]{1,48})\]\((https?://[^\s)]+)\)', line)
    if md and EVENT_RE.fullmatch(md.group(2)):
        return event_urls(md.group(2))[0]
    return None


def discord_url_product_pairs(content: str, catalog: dict[str, set[str]]) -> dict[str, str]:
    """Map products to URL lines; do not apply labels across URL boundaries.

    Valid evidence:
      - Catalog-supported product line immediately before a bare/Markdown URL.
      - Explicit '商品名: PRODUCT URL' on one line, with exactly one URL.
    """
    lines = content.splitlines()
    candidates: dict[str, str] = {}
    ambiguous: set[str] = set()
    for i, raw in enumerate(lines):
        line = raw.strip()
        urls = event_urls(line)
        if len(urls) != 1:
            continue
        url = urls[0]
        label = None
        only_url = _single_url_line(line)
        if only_url == url and i:
            label = adjacent_catalog_label(lines[i-1], catalog)
        elif not only_url:
            # One-line form MUST explicitly identify the product field.
            match = EVENT_RE.search(line)
            if match:
                prefix = line[:match.start()].strip().rstrip('｜|→-— ').strip()
                suffix = line[match.end():].strip()
                if not suffix and re.match(r'^(?:[•●\-*]\s*)?(?:商品名|対象商品|対象パック|対象デッキ)\s*[：:]', prefix):
                    label = adjacent_catalog_label(prefix, catalog)
        if label:
            if url in candidates and product_norm(candidates[url]) != product_norm(label):
                ambiguous.add(url)
            else:
                candidates[url] = label
    return {url: label for url, label in candidates.items() if url not in ambiguous}


def message_url_product_pairs(message: dict[str, Any], catalog: dict[str, set[str]]) -> dict[str, str]:
    """Read content and EACH embed independently; never cross-pair embeds.

    Discord embeds are accepted only when their own URL identifies one event
    and their own title is an unambiguous catalog-backed product label.
    """
    results: dict[str, str] = {}
    conflicting: set[str] = set()

    def merge(pairs: dict[str, str]) -> None:
        for url, label in pairs.items():
            if url in results and product_norm(results[url]) != product_norm(label):
                conflicting.add(url)
            else:
                results[url] = label

    content = message.get('content')
    if isinstance(content, str):
        merge(discord_url_product_pairs(content, catalog))
    for embed in message.get('embeds') or []:
        if not isinstance(embed, dict):
            continue
        url = _single_url_line(str(embed.get('url') or ''))
        title = embed.get('title')
        if url and isinstance(title, str):
            label = adjacent_catalog_label(title, catalog)
            if label:
                merge({url: label})
        # An embed description is a separate block; never combine its product
        # text with a URL found only in the message body or another embed.
        if isinstance(embed.get('description'), str):
            merge(discord_url_product_pairs(embed['description'], catalog))
        for field in embed.get('fields') or []:
            if isinstance(field, dict) and isinstance(field.get('value'), str):
                merge(discord_url_product_pairs(field['value'], catalog))
    return {url: label for url, label in results.items() if url not in conflicting}


def apply_url_product_pair(item: dict[str, Any], url: str, label: str,
                           message: dict[str, Any], channel: str) -> tuple[int, int]:
    """Fill only missing names and keep originals/verified values untouched."""
    old = item.get('product_name')
    if old:
        return (0, int(product_norm(old) != product_norm(label)))
    message_id = str(message.get('id') or '')
    if (item.get('discord_message_id') == message_id
            and product_norm(item.get('store_name') or '') == product_norm(label)):
        item['store_name'] = None
    item['product_name'] = label
    item.setdefault('field_sources', {})['product_name'] = 'discord_url_pair:' + message_id
    item['discord_product_source_message_id'] = message_id
    item['discord_product_source_channel_id'] = channel
    item['discord_product_source_posted_at'] = message.get('timestamp') or ''
    item['extraction_status'] = 'parsed'
    item['details_source'] = item.get('details_source') or 'discord_url_pair'
    return (1, 0)


def enrich_paired_post(items: dict[str, dict[str, Any]], message: dict[str, Any],
                       channel: str, catalog: dict[str, set[str]]) -> tuple[int, int]:
    """Backward-compatible per-message enrichment, used by earlier integrations."""
    added = conflicts = 0
    for url, label in message_url_product_pairs(message, catalog).items():
        item = items.get(url)
        if item is None:
            continue
        count, clash = apply_url_product_pair(item, url, label, message, channel)
        added += count
        conflicts += clash
    return added, conflicts


def enrich_paired_batch(items: dict[str, dict[str, Any]], candidates: dict[str, list],
                        ) -> tuple[int, int, int]:
    """Reject conflicting *recent posts* for the same URL before writing data.

    This avoids picking an arbitrary name depending on Discord API message
    order. Conflicting URLs stay unchanged and are counted for manual review.
    """
    added = existing_conflicts = ambiguous = 0
    for url, observations in candidates.items():
        if url not in items or not observations:
            continue
        labels = {product_norm(label) for label, _message, _channel in observations}
        if len(labels) != 1:
            ambiguous += 1
            continue
        # Prefer the most recent source when identical labels were posted more
        # than once. Preserve original discovery provenance of the event.
        label, message, channel = max(observations, key=lambda x: int(str(x[1].get('id') or 0)))
        n, c = apply_url_product_pair(items[url], url, label, message, channel)
        added += n
        existing_conflicts += c
    return added, existing_conflicts, ambiguous


FIELD_PATTERNS = {
    "product_name": re.compile(r"^(?:商品名|対象商品)\s*[：:]\s*(.+)$"),
    "application_period": re.compile(r"^(?:応募期間|抽選受付期間|申込期間)\s*[：:]\s*(.+)$"),
    "sales_period": re.compile(r"^(?:販売期間|購入期間|販売日)\s*[：:]\s*(.+)$"),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def event_urls(text: str) -> list[str]:
    return list(dict.fromkeys(f"https://livepocket.jp/e/{m.group(1)}" for m in EVENT_RE.finditer(text)))


def clean_label(text: str | None) -> str | None:
    if not text:
        return None
    s = re.sub(r"\s+", " ", text).strip().strip("-–—・ ")
    return s or None


def credible_store(label: str | None) -> bool:
    s = clean_label(label)
    if not s or not 2 <= len(s) <= 90:
        return False
    if "..." in s or "…" in s or MOJIBAKE_RE.search(s) or PRODUCT_LIKE_RE.search(s):
        return False
    if any(mark in s for mark in ("http://", "https://", "livepocket.jp", "📍")):
        return False
    if s.startswith(("🔗", "📣", "🎫", "⚠️", "※", "【")):
        return False
    if any(p in s for p in ("まとめ", "都道府県不明", "チケット販売情報", "開催スケジュール")):
        return False
    return True


def message_texts(message: dict[str, Any]) -> list[str]:
    """Group Discord content and individual embeds to avoid cross-embed mixing."""
    parts = []
    if message.get("content"):
        parts.append(str(message["content"]))
    for embed in message.get("embeds", []):
        fields = []
        for key in ("title", "description", "url"):
            if embed.get(key):
                fields.append(str(embed[key]))
        for field in embed.get("fields", []):
            if field.get("name"):
                fields.append(str(field["name"]))
            if field.get("value"):
                fields.append(str(field["value"]))
        if fields:
            parts.append("\n".join(fields))
    return parts


def parse_text(text: str, catalog: dict[str, set[str]] | None = None) -> dict[str, dict[str, str | None]]:
    """Associate each URL with only its adjacent location heading and store line."""
    catalog = load_product_catalog() if catalog is None else catalog
    result: dict[str, dict[str, str | None]] = {}
    prefecture: str | None = None
    store: str | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip().strip("<> ")
        if not line:
            continue
        m = PREF_RE.match(line)
        if m:
            prefecture = m.group(1).strip() if m.group(1).strip() in PREF_SET else None
            store = None
            continue
        urls = event_urls(line)
        if urls:
            for url in urls:
                current = result.setdefault(url, {"store_name": None, "prefecture": None})
                if prefecture:
                    current["prefecture"] = prefecture
                if credible_store(store):
                    current["store_name"] = clean_label(store)
            continue
        # An adjacent catalog-backed product label must NOT replace a store
        # heading. Preserve it for the next URL under the same store.
        if adjacent_catalog_label(line, _cached_product_catalog()):
            continue
        # Do not mistake a Discord product label (or a short, explicit
        # shorthand) for the shop. Keep the shop heading across product lines.
        if (adjacent_catalog_label(line, catalog) or product_norm(line) in {'30th', 'ストーム', 'メガブ'}
                or re.search(r'Heroines\s*Edition|世界最強の戦士|ART\s*WORK\s*COLLECTION', line, re.I)):
            continue
        # Only a preceding line can be a store. Never use a post title as a store.
        if line.startswith(("🔗", "📣", "🎫", "⚠", "※", "【", "#")):
            store = None
        else:
            store = clean_label(line) if credible_store(line) else None
    return result


def parse_message(message: dict[str, Any], catalog: dict[str, set[str]] | None = None) -> tuple[dict[str, dict[str, str | None]], str]:
    catalog = load_product_catalog() if catalog is None else catalog
    texts = message_texts(message)
    combined = "\n\n".join(texts)  # Preserve all Discord body and embed text (not 500 characters).
    combined_urls = event_urls(combined)
    result = {u: {"store_name": None, "prefecture": None} for u in combined_urls}
    for text in texts:
        for url, details in parse_text(text, catalog=catalog).items():
            if url not in result:
                continue
            for key, value in details.items():
                if value and not result[url][key]:
                    result[url][key] = value

    # These labeled fields can safely be attributed only if the post has one event URL.
    if len(result) == 1:
        only_url = next(iter(result))
        for line in combined.splitlines():
            s = line.strip()
            for field, regex in FIELD_PATTERNS.items():
                m = regex.match(s)
                if m and m.group(1).strip() and "..." not in m.group(1):
                    result[only_url][field] = m.group(1).strip()
    return result, combined


def default_item(url: str, message: dict[str, Any], channel_id: str, combined: str) -> dict[str, Any]:
    return {
        "url": url,
        "discord_message_id": str(message.get("id", "")),
        "discord_posted_at": message.get("timestamp"),
        "discord_channel_id": channel_id,
        "post_excerpt": combined,
        "store_name": None,
        "prefecture": None,
        "details_source": None,
        "product_name": None,
        "application_period": None,
        "sales_period": None,
        "extraction_status": "no_structured_details",
    }


def merge_message(items: dict[str, dict[str, Any]], message: dict[str, Any], channel_id: str,
                  catalog: dict[str, set[str]] | None = None) -> int:
    details_by_url, full_text = parse_message(message, catalog=catalog)
    new_count = 0
    for url, details in details_by_url.items():
        if url not in items:
            items[url] = default_item(url, message, channel_id, full_text)
            new_count += 1
        item = items[url]
        # Keep original provenance and first discovery; do not lose enriched fields.
        if not item.get("discord_message_id"):
            item["discord_message_id"] = str(message.get("id", ""))
            item["discord_posted_at"] = message.get("timestamp")
            item["discord_channel_id"] = channel_id
        # Only update full post text if this is the original linked Discord message.
        if str(item.get("discord_message_id")) == str(message.get("id")):
            item["post_excerpt"] = full_text
        for key, value in details.items():
            if value and (not item.get(key) or (key == "store_name" and not credible_store(item[key]))):
                if key == "store_name" and item.get(key) and not credible_store(item[key]):
                    item.setdefault("store_name_original", item[key])
                item[key] = value
        if any(item.get(k) for k in ("store_name", "prefecture", "product_name", "application_period", "sales_period")):
            item["extraction_status"] = "parsed"
            if any(details.get(k) for k in ("store_name", "prefecture", "product_name", "application_period", "sales_period")):
                item["details_source"] = item.get("details_source") or "discord_post"
    return new_count


def mark_suspect_legacy(items: dict[str, dict[str, Any]]) -> int:
    flagged = 0
    for item in items.values():
        store = item.get("store_name")
        if store and not credible_store(store):
            item.setdefault("store_name_original", store)
            item["store_name"] = None
            flags = item.setdefault("quality_flags", [])
            if "suspect_store_name" not in flags:
                flags.append("suspect_store_name")
            if not any(item.get(k) for k in ("prefecture", "product_name", "application_period", "sales_period")):
                item["details_source"] = None
                item["extraction_status"] = "no_structured_details"
            flagged += 1
    return flagged


def request_messages(token: str, channel_id: str, before: str | None = None) -> list[dict[str, Any]]:
    params = {"limit": "100"}
    if before:
        params["before"] = before
    url = f"{BASE_URL}/channels/{channel_id}/messages?{urllib.parse.urlencode(params)}"
    for attempt in range(6):
        request = urllib.request.Request(url, headers={
            "Authorization": f"Bot {token}",
            "User-Agent": "LivePocketURLCollector/2.0",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
                if not isinstance(result, list):
                    raise ValueError("Expected a Discord message array")
                remaining = response.headers.get("X-RateLimit-Remaining")
                reset_after = response.headers.get("X-RateLimit-Reset-After")
                if remaining == "0" and reset_after:
                    time.sleep(min(float(reset_after), 90))
                return result
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise RuntimeError(f"Discord HTTP {error.code}: verify bot token and channel permissions") from error
            if error.code == 429 and attempt < 5:
                try:
                    delay = float(json.loads(error.read().decode("utf-8")).get("retry_after", 2))
                except (ValueError, KeyError):
                    delay = 2.0
                time.sleep(min(delay, 120))
                continue
            if error.code >= 500 and attempt < 5:
                time.sleep(min(2 ** attempt, 20))
                continue
            raise
        except (TimeoutError, urllib.error.URLError):
            if attempt == 5:
                raise
            time.sleep(min(2 ** attempt, 20))
    raise RuntimeError("Discord request failed after retries")


def ensure_data_shape(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("Data file must be a JSON object with an items array")
    return data


def run_collector(data: dict[str, Any], channels: list[str], token: str, backfill: bool = False,
                  fetch=request_messages, sleep=time.sleep,
                  catalog: dict[str, set[str]] | None = None) -> dict[str, Any]:
    output = copy.deepcopy(ensure_data_shape(data))
    catalog = load_product_catalog() if catalog is None else catalog
    items = {entry["url"]: entry for entry in output["items"] if isinstance(entry, dict) and entry.get("url")}
    # Preserve entries; never overwrite with a filtered-only snapshot.
    original_count = len(items)
    flagged = mark_suspect_legacy(items)
    state = output.setdefault("collector_state", {})
    checkpoint = state.setdefault("last_seen_message_ids", {})
    # Bootstrap checkpoints from the previously uploaded 311 items.
    previous_for_channel: dict[str, int] = {}
    for entry in items.values():
        cid = str(entry.get("discord_channel_id") or "")
        mid = str(entry.get("discord_message_id") or "")
        if mid.isdigit():
            previous_for_channel[cid] = max(previous_for_channel.get(cid, 0), int(mid))
    for channel in channels:
        if channel not in checkpoint and previous_for_channel.get(channel):
            checkpoint[channel] = str(previous_for_channel[channel])

    pages_scanned = 0
    messages_scanned = 0
    all_new = 0
    product_pairs_added = 0
    product_pairs_conflicts = 0
    pair_candidates: dict[str, list] = {}
    for channel in channels:
        boundary = int(checkpoint.get(channel) or 0)
        newest_id: int | None = None
        before = None
        max_pages = 100 if backfill else 20
        completed = False
        for page in range(max_pages):
            messages = fetch(token, channel, before)
            pages_scanned += 1
            messages_scanned += len(messages)
            if not messages:
                completed = True
                break
            ids = [int(str(m["id"])) for m in messages]
            if newest_id is None:
                newest_id = max(ids)
            for message in messages:
                # v21.5: Always re-evaluate the newest 100 messages so that a
                # later annotated Discord post is usable even when the URL was
                # first registered in an earlier post/checkpoint.
                is_new = backfill or int(message["id"]) > boundary
                if is_new:
                    all_new += merge_message(items, message, channel, catalog=catalog)
                # For old messages, only read the FIRST returned page. For
                # backfill, every page is explicitly requested by the owner.
                if is_new or page == 0:
                    for url, label in message_url_product_pairs(message, catalog).items():
                        if url in items:
                            pair_candidates.setdefault(url, []).append((label, message, channel))
            if not backfill and boundary and min(ids) <= boundary:
                completed = True
                break
            if len(messages) < 100:
                completed = True
                break
            before = str(min(ids))
            sleep(0.3)
        if not completed:
            # Fail before writing JSON/checkpoint. The next run can retry safely.
            raise RuntimeError(f"History limit reached in channel {channel}; no checkpoint was saved")
        if newest_id is not None:
            checkpoint[channel] = str(max(newest_id, boundary))

    product_pairs_added, product_pairs_conflicts, ambiguous_pairs = enrich_paired_batch(
        items, pair_candidates,
    )
    output["items"] = list(items.values())
    output["collected_at"] = now_iso()
    output["mode"] = "backfill" if backfill else "incremental"
    output["pages_scanned"] = pages_scanned
    output["messages_scanned"] = messages_scanned
    output["unique_livepocket_urls"] = len(items)
    output["field_counts"] = {
        field: sum(bool(x.get(field)) for x in items.values())
        for field in ("store_name", "prefecture", "product_name", "application_period", "sales_period")
    }
    output["enrichment_counts"] = dict(Counter(x.get("extraction_status") or "unknown" for x in items.values()))
    output["collector_state"]["last_run"] = {
        "checked_at": output["collected_at"],
        "new_urls": all_new,
        "original_urls": original_count,
        "suspect_legacy_store_names": flagged,
        "discord_url_pairs_added": product_pairs_added,
        "discord_url_pairs_conflicts": product_pairs_conflicts,
        "discord_url_pairs_ambiguous_skipped": ambiguous_pairs,
    }
    return output


def main() -> int:
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    raw_channels = os.environ.get("DISCORD_CHANNEL_IDS") or os.environ.get("DISCORD_CHANNEL_ID", "")
    channels = list(dict.fromkeys(re.findall(r"\d{15,22}", raw_channels)))
    backfill = os.environ.get("BACKFILL", "false").lower() in ("true", "1", "yes")
    if not token:
        raise SystemExit("DISCORD_BOT_TOKEN secret is not configured")
    if not channels:
        raise SystemExit("DISCORD_CHANNEL_IDS (or DISCORD_CHANNEL_ID) secret is not configured")
    if not DATA_PATH.is_file():
        raise SystemExit(f"Missing seed data: {DATA_PATH} (do not start without 311 URL backup)")
    with DATA_PATH.open("r", encoding="utf-8") as file:
        data = json.load(file)
    result = run_collector(data, channels, token, backfill=backfill)
    # No commit when there are no new messages and nothing was enriched.
    # Comparing actual data/checkpoints prevents needless timestamp-only commits.
    old_checkpoints = data.get("collector_state", {}).get("last_seen_message_ids", {})
    changed = (
        result["items"] != data["items"]
        or result["collector_state"]["last_seen_message_ids"] != old_checkpoints
    )
    if changed:
        temporary = DATA_PATH.with_suffix(DATA_PATH.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8") as file:
            json.dump(result, file, ensure_ascii=False, indent=2)
            file.write("\n")
        temporary.replace(DATA_PATH)
    else:
        print("No data or checkpoint changes; JSON not rewritten")
    print("--- Collect result ---")
    print(f"Discord messages checked: {result['messages_scanned']}")
    print(f"Unique event URLs: {result['unique_livepocket_urls']}")
    print(f"New URLs added: {result['collector_state']['last_run']['new_urls']}")
    print(f"Discord URL-paired product names added: {result['collector_state']['last_run']['discord_url_pairs_added']}")
    print(f"Discord URL-paired conflicts preserved: {result['collector_state']['last_run']['discord_url_pairs_conflicts']}")
    print(f"Discord URL-paired ambiguous URLs skipped: {result['collector_state']['last_run']['discord_url_pairs_ambiguous_skipped']}")
    print(f"Filled fields: {result['field_counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
