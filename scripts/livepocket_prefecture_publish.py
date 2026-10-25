#!/usr/bin/env python3
"""Publish only verified venue corrections to durable CSV; never touch JSON.

Fail closed if the Supabase exclusion snapshot is absent or if the event/store
no longer matches current public data. Refuse conflicting corrections.
"""
import argparse
import csv
import io
import json
from pathlib import Path

from livepocket_venue_prefecture import PREFECTURES

COLUMNS = ("url", "store_name", "prefecture", "verified", "source_url")


def merge_verified_csv(csv_text, manifest, public, manual_urls):
    if manual_urls is None:
        raise ValueError("Manual override snapshot is required")
    rows = list(csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff"))))
    if any(set(COLUMNS) - set(row) for row in rows):
        raise ValueError("Malformed verified store CSV")
    existing = {(r["url"], r["store_name"]): r for r in rows}
    public_index = {r.get("url"): r for r in public.get("items", [])}
    additions = []
    changes = manifest.get("changes")
    if not isinstance(changes, list) or len(changes) > 3:
        raise ValueError("Invalid or oversized change manifest")
    for candidate in changes:
        url, name, pref = (candidate.get("url"), candidate.get("store_name"),
                           candidate.get("prefecture"))
        if (not isinstance(url, str) or not url.startswith("https://livepocket.jp/e/")
                or not isinstance(name, str) or not isinstance(pref, str)
                or pref not in PREFECTURES or candidate.get("source_url") != url
                or url in manual_urls):
            continue
        current = public_index.get(url)
        if not current or current.get("prefecture"):
            continue
        stores = current.get("stores") or []
        if (len(stores) != 1 or stores[0].get("name") != name
                or stores[0].get("prefecture")):
            continue
        key = (url, name)
        if key in existing:
            if existing[key]["prefecture"] != pref:
                raise ValueError("Conflicting verified store; manual review required")
            continue
        row = {"url": url, "store_name": name, "prefecture": pref,
               "verified": "yes", "source_url": url}
        additions.append(row)
        existing[key] = row
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=COLUMNS, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows + additions)
    return "\ufeff" + output.getvalue(), len(additions)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--manual-overrides-json", type=Path, required=True)
    p.add_argument("--csv", type=Path, default=Path("livepocket_verified_stores.csv"))
    p.add_argument("--public", type=Path, default=Path("livepocket_public.json"))
    p.add_argument("--write", action="store_true")
    args = p.parse_args()
    snapshot = json.loads(args.manual_overrides_json.read_text(encoding="utf-8"))
    if not isinstance(snapshot.get("urls"), list) or not snapshot["urls"]:
        raise ValueError("Missing current Supabase exclusions")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    public = json.loads(args.public.read_text(encoding="utf-8"))
    text, count = merge_verified_csv(args.csv.read_text(encoding="utf-8-sig"),
                                     manifest, public, set(snapshot["urls"]))
    print("Verified new corrections:", count)
    if args.write and count:
        args.csv.write_text(text, encoding="utf-8")
        print("Durable verified store CSV updated; public JSON untouched")


if __name__ == "__main__":
    main()
