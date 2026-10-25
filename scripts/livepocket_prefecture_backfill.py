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


def select(raw, public, now, limit=8, manual_override_urls=None, offset=0):
    if manual_override_urls is None:
        raise ValueError('Current Supabase manual override URLs are required (fail closed)')
    manual_override_urls = set(manual_override_urls)
    indexed = {x.get("url"): x for x in raw.get("items", [])}
    candidates = []
    for item in public.get("items", []):
        url = item.get("url")
        source = indexed.get(url)
        if not source or url in manual_override_urls or item.get("prefecture") or source.get("prefecture"):
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
    start = max(0, int(offset))
    return candidates[start:start + max(0, min(int(limit), 8))]


def backfill(raw, public, fetch, now=None, limit=8, manual_override_urls=None, offset=0):
    now = now or datetime.now(timezone.utc)
    attempted = changed = 0
    raw_index = {x.get("url"): x for x in raw.get("items", [])}
    public_index = {x.get("url"): x for x in public.get("items", [])}
    for url in select(raw, public, now, limit, manual_override_urls=manual_override_urls, offset=offset):
        try:
            result = fetch(url)
        except Exception:
            result = {"status": "browser_error"}
        attempted += 1
        if not isinstance(result, dict):
            result = {"status": "browser_error"}
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
    parser.add_argument("--offset", type=int, default=0, help="Skip this many eligible events for a rotating review batch")
    parser.add_argument("--manual-overrides-json", type=Path, help="Fresh Supabase URL snapshot; required to prevent overwrite")
    args = parser.parse_args()
    import livepocket_v21 as v21
    from livepocket_v14 import read_pair
    raw, public = read_pair()
    if args.manual_overrides_json is None:
        print("No current Supabase manual-override snapshot: backfill disabled (fail closed)")
        return
    snapshot = json.loads(args.manual_overrides_json.read_text(encoding="utf-8"))
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("urls"), list):
        raise ValueError("Invalid manual override snapshot")
    if not snapshot["urls"]:
        raise ValueError("Empty manual override snapshot: refusing unsafe backfill")
    manual_urls = set(snapshot["urls"])
    candidates = select(raw, public, datetime.now(timezone.utc), args.limit, manual_urls, offset=args.offset)
    print("Eligible events:", len(candidates))
    if not args.apply or not candidates:
        print("Dry run: no pages fetched or data written")
        return
    fetch, close = v21.browser_fetcher()
    try:
        result = backfill(raw, public, fetch, limit=args.limit, manual_override_urls=manual_urls, offset=args.offset)
    finally:
        close()
    print(result)
    if result["updated"]:
        # Produce reviewable files without changing production JSON.
        output = Path("prefecture_backfill_review")
        output.mkdir(exist_ok=True)
        for name, data in (("livepocket_urls.candidate.json", raw),
                           ("livepocket_public.candidate.json", public)):
            (output / name).write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")
        print("Candidate files saved for artifact review; production JSON unchanged")


if __name__ == "__main__":
    main()
