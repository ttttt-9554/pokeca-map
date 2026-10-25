#!/usr/bin/env python3
"""Safely synchronize verified exact-store regions into the public catalog.

No external page scraping, no guesses, no overwriting known regions. A fresh
Supabase exclusion snapshot is mandatory. The verified CSV remains the source
of truth for the ordinary collector.
"""
import argparse
import csv
import json
from pathlib import Path
from livepocket_venue_prefecture import PREFECTURES


def apply(public, verified_rows, excluded):
    if excluded is None:
        raise ValueError("Manual override exclusions required")
    index = {x.get("url"): x for x in public.get("items", [])}
    changed = []
    seen = set()
    for row in verified_rows:
        if row.get("verified") != "yes":
            continue
        url, name, pref = row.get("url"), row.get("store_name"), row.get("prefecture")
        if (not url or not name or pref not in PREFECTURES
                or row.get("source_url") != url or url in excluded):
            continue
        key = (url, name)
        if key in seen:
            raise ValueError("Duplicate verified URL/store entry")
        seen.add(key)
        item = index.get(url)
        if not item or item.get("prefecture"):
            continue
        stores = item.get("stores") or []
        if (len(stores) != 1 or stores[0].get("name") != name
                or stores[0].get("prefecture")):
            continue
        stores[0]["prefecture"] = pref
        changed.append({"url": url, "prefecture": pref})
    return changed


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manual-overrides-json", type=Path, required=True)
    p.add_argument("--write", action="store_true")
    args = p.parse_args()
    snapshot = json.loads(args.manual_overrides_json.read_text(encoding="utf-8"))
    if not isinstance(snapshot.get("urls"), list) or not snapshot["urls"]:
        raise ValueError("Missing manual override exclusion snapshot")
    public_path = Path("livepocket_public.json")
    public = json.loads(public_path.read_text(encoding="utf-8"))
    with Path("livepocket_verified_stores.csv").open(encoding="utf-8-sig", newline="") as f:
        verified = list(csv.DictReader(f))
    changed = apply(public, verified, set(snapshot["urls"]))
    print("Verified public locations ready:", len(changed))
    if args.write and changed:
        from livepocket_v11 import write_json
        write_json(public_path, public)
        print("Updated public location fields only")


if __name__ == "__main__":
    main()
