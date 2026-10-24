#!/usr/bin/env python3
"""Monitor explicitly configured public product pages for sale-status transitions.

No login, checkout, waiting-room bypass, or anti-bot evasion is attempted.
First observations establish a baseline without generating alerts.
This script uses only the Python standard library.
"""
from __future__ import annotations

import json
import os
import re
import sys
import ipaddress
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "guerrilla_sale_targets.json"
STATE = ROOT / "guerrilla_sale_state.json"
FEED = ROOT / "guerrilla_sale_feed.json"
MAX_TARGETS = 20
MAX_BYTES = 1_000_000
TIMEOUT_SECONDS = 12


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden_depth = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() in ("script", "style", "noscript", "svg"):
            self.hidden_depth += 1

    def handle_endtag(self, tag):
        if tag.lower() in ("script", "style", "noscript", "svg"):
            self.hidden_depth = max(0, self.hidden_depth - 1)

    def handle_data(self, data):
        if self.hidden_depth == 0:
            self.parts.append(data)


def safe_https_url(url):
    try:
        parsed = urlsplit(str(url))
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme != "https" or not host or parsed.username or parsed.password:
            return False
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            return False
        try:
            ip = ipaddress.ip_address(host)
            return ip.is_global
        except ValueError:
            return "." in host
    except (ValueError, TypeError):
        return False


def text_markers(value):
    if not isinstance(value, list):
        return []
    return [str(x).strip().casefold() for x in value if isinstance(x, str) and x.strip()][:20]


def fetch_page(url):
    req = Request(url, headers={
        "User-Agent": "TorecaRadarSaleMonitor/1.0 (+public-page-status-check)",
        "Accept": "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
    })
    with urlopen(req, timeout=TIMEOUT_SECONDS) as res:
        if not safe_https_url(res.geturl()):
            raise ValueError("Unsafe redirect")
        ctype = res.headers.get("Content-Type", "").lower()
        if "html" not in ctype and "text/plain" not in ctype:
            raise ValueError("Not an HTML/text page")
        charset = res.headers.get_content_charset() or "utf-8"
        raw = res.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Page too large")
        html = raw.decode(charset, errors="replace")
    parser = TextOnly()
    parser.feed(html)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).casefold()


def detect(target):
    url = target.get("url", "")
    if not safe_https_url(url):
        return "unknown", "URLがHTTPSの公開ページではありません"
    available = text_markers(target.get("available_text"))
    unavailable = text_markers(target.get("unavailable_text"))
    if not available or not unavailable:
        return "unknown", "販売中・販売終了の両方の判定語が必要です"
    try:
        text = fetch_page(url)
        required = text_markers(target.get("required_text"))
        if required and not all(x in text for x in required):
            return "unknown", "商品を特定する文字が見つかりません"
        # Refuse ambiguous evidence: a generic add-to-cart button may coexist
        # with an out-of-stock message or hidden storefront templates.
        positives = [x for x in available if x in text]
        negatives = [x for x in unavailable if x in text]
        if positives and not negatives:
            return "available", ""
        if negatives and not positives:
            return "unavailable", ""
        if positives and negatives:
            return "unknown", "販売中・売り切れの表示が両方あります"
        return "unknown", "判定語が見つかりません"
    except (HTTPError, URLError, TimeoutError, ValueError, UnicodeError) as err:
        # Do not log complete server error bodies or credentials.
        if isinstance(err, HTTPError):
            return "unknown", f"HTTP {err.code}"
        return "unknown", type(err).__name__
    except Exception as err:
        return "unknown", type(err).__name__


def load_json(path, default):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except (OSError, ValueError):
        return default


def write_json_if_changed(path, obj):
    contents = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    try:
        if path.read_text(encoding="utf-8") == contents:
            return
    except OSError:
        pass
    path.write_text(contents, encoding="utf-8")


def post_discord(target):
    hook = os.environ.get("GUERRILLA_DISCORD_WEBHOOK_URL", "").strip()
    if not hook:
        return False
    if not (hook.startswith("https://discord.com/api/webhooks/") or
            hook.startswith("https://discordapp.com/api/webhooks/")):
        print("Webhook URL format is invalid", file=sys.stderr)
        return False
    payload = {
        "content": "⚡ **ゲリラ販売を検知**\n"
                   f"店舗：{str(target.get('shop', ''))[:80]}\n"
                   f"商品：{str(target.get('product', ''))[:120]}\n"
                   f"確認先：{target['url']}\n"
                   "※販売ページの表示を検知した速報です。購入可能・在庫確保を保証しません。",
        "allowed_mentions": {"parse": []},
    }
    try:
        req = Request(hook, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json", "User-Agent": "TorecaRadar/1.0"},
                      method="POST")
        with urlopen(req, timeout=10) as res:
            return 200 <= res.status < 300
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        print(f"Discord notification failed: {type(exc).__name__}", file=sys.stderr)
        return False


def main():
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="seconds").replace("+00:00", "Z")
    config = load_json(CONFIG, {"targets": []})
    targets = config.get("targets", [])
    if not isinstance(targets, list):
        targets = []
    state = load_json(STATE, {"targets": {}, "events": []})
    records = state.get("targets", {})
    if not isinstance(records, dict):
        records = {}
    events = state.get("events", [])
    if not isinstance(events, list):
        events = []
    active = []
    seen = set()
    for target in targets[:MAX_TARGETS]:
        if not isinstance(target, dict) or target.get("enabled") is not True:
            continue
        key = str(target.get("id", ""))
        if not re.fullmatch(r"[a-zA-Z0-9_-]{2,64}", key) or key in seen:
            continue
        seen.add(key)
        active.append(target)

    items = []
    for target in active:
        key = target["id"]
        old = records.get(key, {})
        if not isinstance(old, dict):
            old = {}
        observation, reason = detect(target)
        confirmed = old.get("confirmed_status", "unknown")
        prev_alert = old.get("last_alert_at", "")
        last_alert = prev_alert
        if observation in ("available", "unavailable"):
            # Only an observed unavailable -> available transition creates an
            # alert; first scans and transient errors never trigger one.
            is_new_sale = confirmed == "unavailable" and observation == "available"
            try:
                prev_dt = datetime.fromisoformat(prev_alert.replace("Z", "+00:00"))
                recent = now - prev_dt < timedelta(minutes=max(15, int(target.get("cooldown_minutes", 60))))
            except (ValueError, TypeError, OverflowError):
                recent = False
            if is_new_sale and not recent:
                event = {"id": f"{key}-{int(now.timestamp())}", "target_id": key,
                         "shop": str(target.get("shop", ""))[:80],
                         "product": str(target.get("product", ""))[:120],
                         "url": target.get("url", ""), "detected_at": now_iso}
                events.insert(0, event)
                post_discord(target)
                last_alert = now_iso
                print(f"Sale transition detected: {key}")
            confirmed = observation
        records[key] = {
            "confirmed_status": confirmed,
            "status": observation,
            "last_error": reason,
            "checked_hour": now.strftime("%Y-%m-%dT%H:00:00Z"),
            "last_alert_at": last_alert,
        }
        items.append({
            "id": key, "shop": str(target.get("shop", ""))[:80],
            "product": str(target.get("product", ""))[:120],
            "url": target.get("url", "") if safe_https_url(target.get("url")) else "",
            "status": observation, "reason": reason,
            "checked_at": now.strftime("%Y-%m-%dT%H:00:00Z"),
        })
        print(f"Checked {key}: {observation}")

    events = [e for e in events if isinstance(e, dict)][:50]
    # State is checked back into the repository to suppress duplicates across runs.
    write_json_if_changed(STATE, {"schema_version": 1, "targets": records, "events": events})
    write_json_if_changed(FEED, {
        "schema_version": 1,
        "monitored_count": len(active),
        "items": items,
        "events": events,
    })


if __name__ == "__main__":
    main()
