#!/usr/bin/env python3
"""Optional LivePocket public-event HTML enrichment. Python stdlib only.

Does not bypass verification pages, login, Cloudflare, or access restrictions.
All existing JSON entries/fields are preserved and missing values alone are filled.
"""
from __future__ import annotations

import copy
import email.utils
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

DATA_PATH = Path(os.getenv("LIVEPOCKET_DATA_FILE", "livepocket_urls.json"))
USER_AGENT = "LivePocket-Event-Metadata-Collector/3.0 (+non-commercial; respects access restrictions)"
EVENT_RE = re.compile(r"https://(?:www\.)?livepocket\.jp/e/[a-zA-Z0-9_-]{4,64}\Z")
MAX_PAGE_BYTES = 2_000_000
MAX_PER_RUN = max(1, min(int(os.getenv("LIVEPOCKET_MAX_PER_RUN", "8")), 20))
REQUEST_GAP = max(1.5, float(os.getenv("LIVEPOCKET_REQUEST_GAP", "2.5")))

DATE_HINT_RE = re.compile(r"(?:20\d{2}[年/.-]|\d{1,2}\s*月\s*\d{1,2}|\d{1,2}/\d{1,2}|\d{1,2}:\d{2})")
STOP_LABEL_RE = re.compile(
    r"^(?:会場|時間|開催日|販売元|概要|詳細|応募方法|注意事項|応募条件|抽選結果|結果発表|当選発表|"
    r"入場方法|対象商品|商品名|販売商品|商品販売期間|店頭購入期間|購入期間|販売期間|"
    r"抽選エントリー期間|エントリー期間|抽選受付期間|応募期間|申し込み期間|申込期間|"
    r"販売受付期間|受付期間|このイベント|チケット情報|お問い合わせ|個数制限|商品販売日)"
)
LABEL_GROUPS = {
    "product_name": [
        ["対象商品", "商品名", "販売商品", "対象製品", "販売対象商品"],
    ],
    "application_period": [
        ["販売受付期間"],
        ["抽選エントリー期間", "抽選受付期間", "申込受付期間", "応募受付期間", "エントリー期間"],
        ["応募期間", "申込期間", "申し込み期間", "受付期間"],
    ],
    "sales_period": [
        ["商品販売期間", "店頭購入期間", "店頭販売期間", "商品購入期間"],
        ["販売期間", "購入期間", "受取期間", "商品販売日"],
    ],
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def normalize_line(value: str) -> str:
    s = unicodedata.normalize("NFKC", html.unescape(value))
    return re.sub(r"\s+", " ", s).strip()


class VisibleHTML(HTMLParser):
    BLOCKS = {"article", "aside", "blockquote", "br", "dd", "div", "dt", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "p", "section", "table", "td", "th", "tr", "ul"}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chunks: list[str] = []
        self.title: list[str] = []
        self.og_title: str | None = None
        self.blocked_tags: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        at = dict(attrs)
        if tag in ("script", "style", "noscript", "svg", "template"):
            self.blocked_tags.append(tag)
        elif tag == "title" and not self.blocked_tags:
            self.in_title = True
        elif tag == "meta":
            key = (at.get("property") or at.get("name") or "").lower()
            if key == "og:title" and at.get("content"):
                self.og_title = at["content"]
        if tag in self.BLOCKS:
            self.chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self.blocked_tags and tag == self.blocked_tags[-1]:
            self.blocked_tags.pop()
        if tag == "title":
            self.in_title = False
        if tag in self.BLOCKS:
            self.chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if self.blocked_tags:
            return
        if self.in_title:
            self.title.append(data)
        else:
            self.chunks.append(data)

    def lines(self) -> list[str]:
        text = "".join(self.chunks)
        return [s for raw in text.splitlines() if (s := normalize_line(raw))]


def label_re(label: str) -> re.Pattern[str]:
    """Match an actual label, not prose like '販売期間中は'."""
    return re.compile(r"^[〖【\[\(〈《≪\s\-–—]*" + re.escape(label) +
                      r"(?:[〗】\]\)〉》≫]|[:：]|\s|$)\s*[〗】\]\)〉》≫:：\-–—]*\s*(.*)$", re.I)


def labeled_value(lines: list[str], labels: list[str], product: bool) -> str | None:
    patterns = [label_re(s) for s in labels]
    for i, line in enumerate(lines):
        for pattern in patterns:
            match = pattern.match(line)
            if not match:
                continue
            first = normalize_line(match.group(1))
            # Reject headings accidentally followed by body prose, such as '販売期間中は...'.
            candidates: list[str] = [first] if first else []
            for ahead in lines[i + 1:i + (6 if product else 5)]:
                section_text = ahead.lstrip("〖〗【】[]()〈〉《》≪≫・ -–—:")
                if STOP_LABEL_RE.match(section_text) or ahead.startswith(("※", "注意", "注:", "よくある")):
                    break
                if product:
                    if len(ahead) > 180 or ahead.startswith(("http", "¥", "￥", "価格", "販売価格")):
                        break
                    if DATE_HINT_RE.search(ahead) and not any(word in ahead for word in ("BOX", "パック", "カード")):
                        break
                    candidates.append(ahead)
                    if len(candidates) >= 3:
                        break
                else:
                    # Dates sometimes span 2 lines: 2026年... \n 〜2026年...
                    if DATE_HINT_RE.search(ahead) and len(ahead) < 180:
                        candidates.append(ahead)
                        if len(candidates) >= 2:
                            break
                    else:
                        break
            if not candidates:
                continue
            value = normalize_line(" ".join(candidates))
            value = value.strip(" ・-–—:：")
            if not value or len(value) > 380:
                continue
            if not product and not DATE_HINT_RE.search(value):
                continue
            if product:
                if len(value) < 3 or any(x in value for x in ("ログイン", "このイベントに関するお問い合わせ")):
                    continue
                # When a heading labels product(s), don't include paragraphs/disclaimers.
            return value
    return None


def parse_html_page(html_body: str) -> dict[str, str]:
    parser = VisibleHTML()
    parser.feed(html_body)
    lines = parser.lines()
    title = normalize_line(parser.og_title or "".join(parser.title))
    title = re.sub(r"\s*(?:のチケット情報\s*[|｜-]|[|｜]\s*LivePocket).*$", "", title).strip()
    out: dict[str, str] = {}
    if title and len(title) <= 220 and not re.search(r"(Cloudflare|Just a moment|Access Denied|認証が必要)", title, re.I):
        out["event_title"] = title
    for field, priorities in LABEL_GROUPS.items():
        for labels in priorities:
            value = labeled_value(lines, labels, field == "product_name")
            if value:
                out[field] = value
                break
    return out


class PageFetchError(Exception):
    def __init__(self, status: str, retry_hours: int = 24):
        self.status = status
        self.retry_hours = retry_hours
        super().__init__(status)


def fetch_page(url: str) -> str:
    if not EVENT_RE.fullmatch(url):
        raise PageFetchError("invalid_event_url", 24 * 30)
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ja-JP,ja;q=0.9",
    })
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            dest = urllib.parse.urlsplit(response.geturl())
            source_path = urllib.parse.urlsplit(url).path.rstrip("/")
            if dest.scheme != "https" or dest.hostname not in ("livepocket.jp", "www.livepocket.jp"):
                raise PageFetchError("unsafe_redirect", 24 * 30)
            if dest.path.rstrip("/") != source_path:
                raise PageFetchError("redirected_from_event", 24 * 7)
            if "text/html" not in (response.headers.get("Content-Type") or "").lower():
                raise PageFetchError("not_html", 24 * 7)
            payload = response.read(MAX_PAGE_BYTES + 1)
            if len(payload) > MAX_PAGE_BYTES:
                raise PageFetchError("oversized_page", 24 * 7)
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                body = payload.decode(charset, errors="replace")
            except LookupError:
                body = payload.decode("utf-8", errors="replace")
            patterns = ("cf-challenge", "_cf_chl", "just a moment", "verify you are human",
                        "access denied", "bot verification")
            if any(w in body.lower() for w in patterns):
                raise PageFetchError("verification_required", 24)
            return body
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise PageFetchError(f"http_{error.code}_blocked", 24) from error
        if error.code == 429:
            retry_after = error.headers.get("Retry-After", "")
            try:
                hours = max(1, min(72, (int(retry_after) + 3599) // 3600))
            except ValueError:
                try:
                    hours = max(1, min(72, int((email.utils.parsedate_to_datetime(retry_after) - utc_now()).total_seconds() / 3600 + 1)))
                except (TypeError, ValueError):
                    hours = 24
            raise PageFetchError("rate_limited", hours) from error
        if error.code == 404:
            raise PageFetchError("http_404", 24 * 14) from error
        raise PageFetchError(f"http_{error.code}", 24) from error
    except (urllib.error.URLError, TimeoutError):
        raise PageFetchError("network_error", 6)


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def enrich_data(data: dict, fetch=fetch_page, sleep=time.sleep, now=None) -> tuple[dict, dict]:
    """Injectable fetch/sleep/clock for offline regression testing."""
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("Expected JSON object with items array")
    current = now or utc_now()
    output = copy.deepcopy(data)
    items = output["items"]
    st = output.setdefault("collector_state", {}).setdefault("livepocket_page_enrichment", {})
    blocked = parse_iso(st.get("blocked_until"))
    stats = {"attempted": 0, "enriched": 0, "blocked": 0, "errors": 0, "total": len(items)}
    if blocked and current < blocked:
        stats["paused_until"] = iso(blocked)
        return output, stats

    candidates = []
    for item in items:
        if not isinstance(item, dict) or not EVENT_RE.fullmatch(str(item.get("url") or "")):
            continue
        check = item.get("livepocket_page_check") or {}
        if check.get("status") == "invalid_event_url":
            continue
        next_check = parse_iso(check.get("next_retry_at"))
        if next_check and next_check > current:
            continue
        # New items are prioritized, then old retryable items by last attempt.
        has_check = bool(check.get("checked_at"))
        candidates.append((has_check, str(check.get("checked_at") or ""), item))
    candidates.sort(key=lambda x: (x[0], x[1]))
    for _, _, item in candidates[:MAX_PER_RUN]:
        if stats["attempted"]:
            sleep(REQUEST_GAP)
        stats["attempted"] += 1
        try:
            body = fetch(item["url"])
            if not isinstance(body, str):
                raise PageFetchError("non_html_response", 24)
            extracted = parse_html_page(body)
            status = "success" if extracted else "no_fields"
            delay = 24 * (7 if extracted else 2)
            new_fields = []
            for name, val in extracted.items():
                if val and not item.get(name):
                    item[name] = val
                    new_fields.append(name)
            if new_fields:
                item.setdefault("field_sources", {}).update({name: "livepocket_event_page" for name in new_fields})
                if status == "success":
                    item["extraction_status"] = "parsed"
                stats["enriched"] += 1
        except PageFetchError as error:
            status, delay = error.status, error.retry_hours
            stats["errors"] += 1
            if status in ("http_401_blocked", "http_403_blocked", "verification_required", "rate_limited"):
                stats["blocked"] += 1
                st["blocked_until"] = iso(current + timedelta(hours=delay))
        except Exception as error:
            # A bug on one page must never delete the accumulated database.
            status, delay = "parse_error", 6
            stats["errors"] += 1
            print(f"Page parse failed for {item['url']}: {type(error).__name__}", file=sys.stderr)
        item["livepocket_page_check"] = {
            "status": status,
            "checked_at": iso(current),
            "next_retry_at": iso(current + timedelta(hours=delay)),
        }
        if stats["blocked"]:
            break

    if stats["attempted"]:
        output["field_counts"] = {
            field: sum(bool(i.get(field)) for i in items if isinstance(i, dict))
            for field in ("store_name", "prefecture", "product_name", "application_period", "sales_period", "event_title")
        }
        output["enrichment_counts"] = dict(Counter(i.get("extraction_status") or "unknown" for i in items if isinstance(i, dict)))
    return output, stats


def main() -> int:
    if os.getenv("LIVEPOCKET_PAGE_FETCH", "true").lower() in ("0", "false", "no"):
        print("LivePocket page fetch disabled")
        return 0
    if not DATA_PATH.exists():
        print(f"Data file missing: {DATA_PATH}", file=sys.stderr)
        return 1
    with DATA_PATH.open(encoding="utf-8") as f:
        old = json.load(f)
    new, stats = enrich_data(old)
    if new != old:
        tmp = DATA_PATH.with_name(DATA_PATH.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(new, f, indent=2, ensure_ascii=False)
            f.write("\n")
        tmp.replace(DATA_PATH)
    print("--- LivePocket Page Enrichment ---")
    for key, value in stats.items():
        print(f"{key}: {value}")
    print("Existing URL rows preserved:", len(new["items"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
