#!/usr/bin/env python3
"""Conservative LivePocket venue-prefecture enrichment (no guesses)."""
import re

PREFECTURES = tuple("""北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県""".split())
PREF_RE = "|".join(map(re.escape, sorted(PREFECTURES, key=len, reverse=True)))
VENUE_RE = re.compile(r"^会場\\s*[：:]?\\s*(.+?)\\s*[（(](" + PREF_RE + r")[）)]\\s*$")


def venue_prefecture(text, store):
    """Match exact venue name and explicit prefecture; reject conflicts."""
    if not isinstance(text, str) or not isinstance(store, str):
        return ""
    name = re.sub(r"\\s+", "", store)
    if len(name) < 3:
        return ""
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    matched = set()
    for i, line in enumerate(lines):
        if line == "会場" and i + 1 < len(lines):
            line = "会場 " + lines[i + 1]
        m = VENUE_RE.fullmatch(line)
        if m and re.sub(r"\\s+", "", m.group(1)) == name:
            matched.add(m.group(2))
    return next(iter(matched)) if len(matched) == 1 else ""


def fill_one(raw_item, public_item, page_text):
    """Mutate only absent single-store location fields."""
    if not isinstance(raw_item, dict) or not isinstance(public_item, dict):
        return False
    if raw_item.get("url") != public_item.get("url"):
        return False
    stores = public_item.get("stores") or raw_item.get("stores") or []
    if len(stores) != 1 or not isinstance(stores[0], dict):
        return False
    name = stores[0].get("name")
    if not name or any(x.get("prefecture") for x in (raw_item, public_item, stores[0])):
        return False
    pref = venue_prefecture(page_text, name)
    if not pref:
        return False
    for item in (raw_item, public_item):
        item["prefecture"] = pref
        rows = item.get("stores")
        if isinstance(rows, list) and len(rows) == 1 and rows[0].get("name") == name:
            rows[0]["prefecture"] = pref
    raw_item.setdefault("field_sources", {})["prefecture"] = "livepocket_exact_venue"
    return True
