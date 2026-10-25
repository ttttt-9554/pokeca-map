#!/usr/bin/env python3
"""Bounded, explicit LivePocket venue backfill. Opt-in, never part of 5-min collector.

Reads the existing raw/public JSON pair. Checks only still-open, single-store
events with no prefecture, and never touches records with manually verified
locations. Writes only after successful evidence-based changes.
"""
from __future__ import annotations
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from livepocket_venue_prefecture import fill_one


def select(raw, public, now, limit=8):
    indexed = {x.get("url"): x for x in raw.get("items", [])}
    candidates = []
    for item in public.get("items", []):
        url = item.get("url")
        source = indexed.get(url)
        if not source or item.get("prefecture") or source.get("prefecture"):
            continue
        stores = item.get("stores") or source.get("stores") or []
        if len(stores) != 1 or not stores[0].get("name") or stores[0].get("prefecture"):
            continue
        if item.get("manual_page_unavailable") or source.get("manual_page_unavailable"):
            continue
        end = item.get("application_end_at") or source.get("application_end_at")
        if not end:
            continue  # unknown deadlines require separate manual review
        try:
            dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
            if dt.tzinfo is None or dt.astimezone(timezone.utc) <= now:
                continue
        except (ValueError, TypeError):
            continue
        candidates.append(url)
    return candidates[:max(0, min(int(limit), 8))]


def backfill(raw, public, fetch, now=None, limit=8):
    now = now or datetime.now(timezone.utc)
    attempted = changed = 0
    raw_index = {x.get("url"): x for x in raw.get("items", [])}
    public_index = {x.get("url"): x for x in public.get("items", [])}
    for url in select(raw, public, now, limit):
        result = fetch(url)
        attempted += 1
        if result.get("status") != "ok" or result.get("final_url") != url:
            if result.get("status", "").startswith("browser_blocked"):
                break
            continue
        changed += int(fill_one(raw_index[url], public_index[url], result.get("text")))
    return {"attempted": attempted, "updated": changed}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write verified changes")
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()
    import livepocket_v21 as v21
    from livepocket_v14 import read_pair
    from livepocket_v11 import write_json
    raw, public = read_pair()
    candidates = select(raw, public, datetime.now(timezone.utc), args.limit)
    print("Eligible events:", len(candidates))
    if not args.apply or not candidates:
        print("Dry run: no pages fetched or data written")
        return
    fetch, close = v21.browser_fetcher()
    try:
        result = backfill(raw, public, fetch, limit=args.limit)
    finally:
        close()
    print(result)
    if result["updated"]:
        write_json(Path("livepocket_urls.json"), raw)
        write_json(Path("livepocket_public.json"), public)


if __name__ == "__main__":
    main()
