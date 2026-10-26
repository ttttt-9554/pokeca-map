#!/usr/bin/env python3
"""Bounded verification of missing LivePocket application periods.

Uses public event URLs only. Refuses existing dates and private manual
overrides. Failures do not create dates. Public JSON is written only when
--write is specified.
"""
import argparse
import json
from pathlib import Path
from livepocket_v11 import iso
from livepocket_v12 import exact_event_url
from livepocket_v13 import extract_deadline


def candidates(public, excluded, limit=5, offset=0):
    if excluded is None:
        raise ValueError("Current manual exclusion snapshot required")
    items = []
    for row in public.get("items", []):
        url = row.get("url")
        if (not isinstance(url, str) or exact_event_url(url) != url
                or url in excluded or row.get("application_start_at")
                or row.get("application_end_at")):
            continue
        items.append(url)
    items = sorted(set(items))
    if not items:
        return []
    start = max(0, offset) % len(items)
    return (items[start:] + items[:start])[:max(0, min(limit, 8))]


def apply(public, url, body, excluded):
    if excluded is None or url in excluded:
        return False
    start, end = extract_deadline(body)
    if not start or not end or start > end:
        return False
    matches = [x for x in public.get("items", []) if x.get("url") == url]
    if len(matches) != 1:
        return False
    row = matches[0]
    if row.get("application_start_at") or row.get("application_end_at"):
        return False
    row["application_start_at"] = iso(start)
    row["application_end_at"] = iso(end)
    return True


def run(public, excluded, fetch, limit=5, offset=0):
    urls = candidates(public, excluded, limit, offset)
    stats = {"selected": len(urls), "checked": 0, "updated": 0,
             "unavailable": 0, "no_verified_period": 0}
    for url in urls:
        try:
            result = fetch(url)
        except Exception:
            result = {"status": "fetch_error"}
        stats["checked"] += 1
        if (not isinstance(result, dict) or result.get("status") != "ok"
                or exact_event_url(result.get("final_url")) != url):
            stats["unavailable"] += 1
            continue
        if apply(public, url, result.get("text") or "", excluded):
            stats["updated"] += 1
        else:
            stats["no_verified_period"] += 1
    return stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manual-overrides-json", type=Path, required=True)
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--offset", type=int, default=0)
    p.add_argument("--write", action="store_true")
    args = p.parse_args()
    snapshot = json.loads(args.manual_overrides_json.read_text(encoding="utf-8"))
    if not isinstance(snapshot.get("urls"), list) or not snapshot["urls"]:
        raise ValueError("Missing manual override snapshot")
    path = Path("livepocket_public.json")
    public = json.loads(path.read_text(encoding="utf-8"))
    from livepocket_v21 import browser_fetcher
    fetch, close = browser_fetcher()
    try:
        stats = run(public, set(snapshot["urls"]), fetch, args.limit, args.offset)
    finally:
        close()
    print("Missing period batch:", stats)
    if args.write and stats["updated"]:
        path.write_text(json.dumps(public, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        print("Verified periods written to public catalog")


if __name__ == "__main__":
    main()
