#!/usr/bin/env python3
"""Conservative LivePocket prefecture fallback from the private store master.

The collector is allowed to consult ONLY a service-role RPC containing unique
store-name/prefecture pairs. Manual edits, existing regions and conflicts win.
No fuzzy matching; no personal accounts, identities or results are accessed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

from livepocket_prefecture_manual_snapshot import (
    PROJECT_HOST, canonical_event_url
)
from livepocket_venue_prefecture import PREFECTURES
from livepocket_store_name_normalize import normalize

RPC_NAME = "lottery_store_unique_regions_v1"
STORE_COLUMNS = {"store_name", "prefecture", "stores", "stores_override"}
SOURCE_NAME = "store_master_unique_exact_name_v21_146"
# A bare shop label such as "豊橋店" or "池袋店" may refer to many chains.
MIN_SPECIFIC_NAME_LENGTH = 6
GENERIC_STORE_NAMES = frozenset((
    "tsutaya", "ゲオ", "イオン", "イトーヨーカドー",
    "ワンダーグー", "wondergoo", "古本市場", "ブックオフ",
    "ヨドバシカメラ", "ビックカメラ", "ポケモンセンター",
    "ポケモンセンターオンライン", "イエローサブマリン店",
))


def is_specific(name):
    return (isinstance(name, str)
            and len(name) >= MIN_SPECIFIC_NAME_LENGTH
            and name not in GENERIC_STORE_NAMES)


def check_base(base):
    parsed = urllib.parse.urlsplit(str(base).strip())
    if (parsed.scheme != "https" or parsed.netloc != PROJECT_HOST
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Unexpected Supabase project address")
    return "https://" + PROJECT_HOST


def headers_for(key):
    if not isinstance(key, str) or not key:
        raise ValueError("Service-role secret unavailable")
    headers = {"apikey": key, "Accept": "application/json"}
    # Legacy JWTs need Authorization; opaque sb_secret_ keys do not.
    if key.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + key
    return headers


def read_json(request, opener=urllib.request.urlopen):
    try:
        with opener(request, timeout=20) as response:
            if response.status != 200:
                raise RuntimeError("Supabase lookup was not successful")
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        # Never log authorization tokens, private response bodies or URLs.
        raise RuntimeError("Supabase lookup HTTP " + str(exc.code)) from None
    return data


def fetch_regions(base, key, opener=urllib.request.urlopen):
    host = check_base(base)
    headers = dict(headers_for(key), **{"Content-Type": "application/json"})
    request = urllib.request.Request(
        host + "/rest/v1/rpc/" + RPC_NAME,
        data=b"{}", method="POST", headers=headers
    )
    data = read_json(request, opener)
    if not isinstance(data, list) or len(data) > 30000:
        raise ValueError("Store master lookup response malformed")
    names = {}
    conflicts = set()
    for row in data:
        if not isinstance(row, dict):
            raise ValueError("Malformed store master entry")
        name, pref = row.get("norm_name"), row.get("prefecture")
        if (not isinstance(name, str) or not isinstance(pref, str)
                or len(name) < MIN_SPECIFIC_NAME_LENGTH
                or len(name) > 200 or pref not in PREFECTURES):
            raise ValueError("Invalid unique store master entry")
        if name in names and names[name] != pref:
            conflicts.add(name)
        names[name] = pref
    return {name: pref for name, pref in names.items()
            if name not in conflicts and is_specific(name)}


MANUAL_SELECTS = {
    "livepocket_location_overrides": "event_url",
    "lottery_card_overrides": "event_url,edited_fields,review_complete",
    "livepocket_event_overrides": "event_url,resolution",
}


def fetch_manual_locations(base, key, opener=urllib.request.urlopen):
    host = check_base(base)
    headers = headers_for(key)
    protected = set()
    for table, fields in MANUAL_SELECTS.items():
        offset = 0
        while True:
            query = urllib.parse.urlencode({
                "select": fields, "limit": "1000",
                "offset": str(offset), "order": "event_url.asc"
            })
            request = urllib.request.Request(
                host + "/rest/v1/" + table + "?" + query, headers=headers
            )
            rows = read_json(request, opener)
            if not isinstance(rows, list) or any(not isinstance(x, dict) for x in rows):
                raise ValueError("Manual override snapshot malformed")
            for row in rows:
                url = canonical_event_url(row.get("event_url"))
                if not url:
                    continue
                if table == "livepocket_location_overrides":
                    protected.add(url)
                elif table == "lottery_card_overrides":
                    edited_fields = row.get("edited_fields")
                    if (not isinstance(edited_fields, list)
                            or any(not isinstance(x, str) for x in edited_fields)
                            or row.get("review_complete") is True
                            or bool(STORE_COLUMNS.intersection(edited_fields))):
                        protected.add(url)
                elif row.get("resolution") != "title":
                    protected.add(url)
            if len(rows) < 1000:
                break
            offset += 1000
            if offset > 100000:
                raise RuntimeError("Manual override pagination limit exceeded")
    return protected


def store_names(row):
    shops = row.get("stores")
    if not isinstance(shops, list) or not shops:
        return {normalize(row.get("store_name"))} if row.get("store_name") else set()
    if not all(isinstance(x, dict) and isinstance(x.get("name"), str)
               for x in shops):
        return None
    keys = [normalize(x["name"]) for x in shops]
    if not all(keys) or len(set(keys)) != len(keys):
        return None
    return set(keys)


def valid_store_rows(row):
    """List only original fields, never invent a venue that was not recorded."""
    stores = row.get("stores")
    if not isinstance(stores, list) or not stores:
        return []
    return stores


def apply_one(raw_row, public_row, region_by_name):
    """Only add absent, nonconflicting prefectures to matching exact venues."""
    names_raw, names_public = store_names(raw_row), store_names(public_row)
    if names_raw is None or names_public is None:
        return 0
    # A stale or unrelated store list cannot be used as evidence for this URL.
    if names_raw and names_public and names_raw != names_public:
        return 0
    event_names = names_raw or names_public
    if not event_names:
        return 0

    all_stores = valid_store_rows(raw_row) + valid_store_rows(public_row)
    is_multistore = any(
        isinstance(row.get("stores"), list) and len(row["stores"]) > 1
        for row in (raw_row, public_row)
    )
    counts = 0
    for key in sorted(event_names):
        pref = region_by_name.get(key) if is_specific(key) else None
        if pref not in PREFECTURES:
            continue
        # This name may have been verified for a different prefecture in one
        # representation. Treat that as a conflict; never rewrite or enrich it.
        explicit = {s.get("prefecture") for s in all_stores
                    if normalize(s.get("name")) == key and s.get("prefecture")}
        if not is_multistore:
            explicit.update(row.get("prefecture") for row in (raw_row, public_row)
                            if row.get("prefecture"))
        if explicit and explicit != {pref}:
            continue

        changed = False
        for row in (raw_row, public_row):
            stores_changed = parent_changed = False
            for store in valid_store_rows(row):
                if normalize(store.get("name")) != key or store.get("prefecture"):
                    continue
                store["prefecture"] = pref
                stores_changed = True
            if not is_multistore and not row.get("prefecture"):
                legacy_name = normalize(row.get("store_name"))
                if not legacy_name or legacy_name == key:
                    row["prefecture"] = pref
                    parent_changed = True
            if stores_changed or parent_changed:
                changed = True
                # Mark ONLY fields filled by this fallback, not previously
                # confirmed prefectures or unchanged manual observations.
                sources = row.setdefault("field_sources", {})
                if isinstance(sources, dict):
                    if stores_changed:
                        sources.setdefault("stores_prefectures", SOURCE_NAME)
                    if parent_changed:
                        sources.setdefault("prefecture", SOURCE_NAME)
        if changed:
            counts += 1
    return counts


def apply_master(raw, public, region_by_name, protected_urls=()):
    if not isinstance(raw, dict) or not isinstance(public, dict):
        raise ValueError("Expected paired catalog objects")
    if not isinstance(raw.get("items"), list) or not isinstance(public.get("items"), list):
        raise ValueError("Expected paired catalog item lists")
    protection = set(protected_urls)
    raw_index = {item.get("url"): item for item in raw["items"] if isinstance(item, dict)}
    pub_index = {item.get("url"): item for item in public["items"] if isinstance(item, dict)}
    stores_filled = events_updated = 0
    for url, public_row in pub_index.items():
        if not isinstance(url, str) or canonical_event_url(url) != url or url in protection:
            continue
        raw_row = raw_index.get(url)
        if not isinstance(raw_row, dict):
            continue
        filled = apply_one(raw_row, public_row, region_by_name)
        if filled:
            stores_filled += filled
            events_updated += 1
    if events_updated:
        # Current public catalog is a rendered view of the source. Raw is
        # updated too so future collector passes retain known regions.
        public["updated_at"] = datetime.now(timezone.utc).isoformat()
    return {"events": events_updated, "stores": stores_filled}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, default=Path("livepocket_urls.json"))
    parser.add_argument("--public", type=Path, default=Path("livepocket_public.json"))
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    base = os.environ.get("SUPABASE_URL", "")
    secret = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not secret:
        raise SystemExit("Store master lookup unavailable (no backend credentials)")
    # Fail closed: both private metadata and admin corrections must be readable.
    regions = fetch_regions(base, secret)
    manual_urls = fetch_manual_locations(base, secret)
    raw = json.loads(args.raw.read_text(encoding="utf-8"))
    public = json.loads(args.public.read_text(encoding="utf-8"))
    stats = apply_master(raw, public, regions, manual_urls)
    print("Master-backed regions:", len(regions),
          "protected events:", len(manual_urls),
          "safe region additions:", stats["stores"],
          "events:", stats["events"])
    if args.write and stats["events"]:
        from livepocket_v11 import write_json
        write_json(args.raw, raw)
        write_json(args.public, public)


if __name__ == "__main__":
    main()
