#!/usr/bin/env python3
"""Incremental Discord -> LivePocket event URL collector, stdlib-only.

Keeps previously captured URLs and their metadata. Does not scrape LivePocket
or bypass verification screens. Designed for GitHub Actions.
"""

from __future__ import annotations

import copy
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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


def parse_text(text: str) -> dict[str, dict[str, str | None]]:
    """Associate each URL with only its adjacent location heading and store line."""
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
        # Only a preceding line can be a store. Never use a post title as a store.
        if line.startswith(("🔗", "📣", "🎫", "⚠", "※", "【", "#")):
            store = None
        else:
            store = clean_label(line) if credible_store(line) else None
    return result


def parse_message(message: dict[str, Any]) -> tuple[dict[str, dict[str, str | None]], str]:
    texts = message_texts(message)
    combined = "\n\n".join(texts)  # Preserve all Discord body and embed text (not 500 characters).
    combined_urls = event_urls(combined)
    result = {u: {"store_name": None, "prefecture": None} for u in combined_urls}
    for text in texts:
        for url, details in parse_text(text).items():
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


def merge_message(items: dict[str, dict[str, Any]], message: dict[str, Any], channel_id: str) -> int:
    details_by_url, full_text = parse_message(message)
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
                  fetch=request_messages, sleep=time.sleep) -> dict[str, Any]:
    output = copy.deepcopy(ensure_data_shape(data))
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
                if not backfill and int(message["id"]) <= boundary:
                    continue
                all_new += merge_message(items, message, channel)
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
    print(f"Filled fields: {result['field_counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
