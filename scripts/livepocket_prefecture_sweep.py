#!/usr/bin/env python3
"""One-time bounded sweep of currently open, unlocated single-store events.

Outputs a review manifest only. Never changes the public catalog or CSV.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from livepocket_prefecture_backfill import select
from livepocket_venue_prefecture import fill_one


def sweep(raw, public, fetch, excluded, *, now=None, max_events=100):
    now = now or datetime.now(timezone.utc)
    candidates = select(raw, public, now, limit=8, manual_override_urls=excluded)
    # select() is deliberately capped at eight for daily runs. For a one-time
    # sweep, gather all eligible candidates using a bounded rotating window.
    indexed = {x.get("url"): x for x in raw.get("items", [])}
    selected = []
    for row in public.get("items", []):
        url = row.get("url")
        source = indexed.get(url)
        if not source or url in excluded or row.get("prefecture") or source.get("prefecture"):
            continue
        stores = row.get("stores") or source.get("stores") or []
        if len(stores) != 1 or not isinstance(stores[0], dict) or not stores[0].get("name") or stores[0].get("prefecture"):
            continue
        if row.get("manual_page_unavailable") or source.get("manual_page_unavailable"):
            continue
        end = row.get("application_end_at") or source.get("application_end_at")
        if not isinstance(end, str):
            continue
        try:
            date = datetime.fromisoformat(end.replace("Z", "+00:00"))
        except ValueError:
            continue
        if date.tzinfo is None or date.astimezone(timezone.utc) <= now:
            continue
        selected.append(url)
    selected = selected[:max(0, min(max_events, 100))]
    public_index = {x.get("url"): x for x in public.get("items", [])}
    results = []
    attempted = 0
    for url in selected:
        try:
            result = fetch(url)
        except Exception:
            result = {"status": "fetch_error"}
        attempted += 1
        if not isinstance(result, dict):
            continue
        if result.get("status", "").startswith("browser_blocked"):
            break
        if result.get("status") != "ok" or result.get("final_url") != url:
            continue
        a, b = indexed[url], public_index[url]
        if fill_one(a, b, result.get("text")):
            store = b["stores"][0]
            results.append({"url": url, "store_name": store["name"],
                            "prefecture": store["prefecture"], "source_url": url})
    return {"changes": results}, {"eligible": len(selected), "attempted": attempted, "verified": len(results)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manual-overrides-json", type=Path, required=True)
    parser.add_argument("--max-events", type=int, default=100)
    args = parser.parse_args()
    from livepocket_v14 import read_pair
    from livepocket_v21 import browser_fetcher
    snapshot = json.loads(args.manual_overrides_json.read_text(encoding="utf-8"))
    if not isinstance(snapshot.get("urls"), list) or not snapshot["urls"]:
        raise ValueError("Missing current manual override snapshot")
    raw, public = read_pair()
    fetch, close = browser_fetcher()
    try:
        manifest, stats = sweep(raw, public, fetch, set(snapshot["urls"]), max_events=args.max_events)
    finally:
        close()
    out = Path("prefecture_backfill_review")
    out.mkdir(exist_ok=True)
    (out / "verified_changes.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print("Sweep totals:", stats)
    print("Production JSON unchanged")


if __name__ == "__main__":
    main()
