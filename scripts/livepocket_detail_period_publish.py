#!/usr/bin/env python3
"""Synchronize an explicitly verified LivePocket application period.

Never overwrite existing dates or administrator overrides. Read-only by
default; --write updates only two fields for an exact event URL.
"""
import argparse
import json
from pathlib import Path
from livepocket_v13 import extract_deadline
from livepocket_v12 import exact_event_url
from livepocket_v11 import iso


def apply(public, url, text, exclusions):
    if exclusions is None:
        raise ValueError("Current manual exclusions are required")
    if exact_event_url(url) != url or url in exclusions:
        return 0
    start, end = extract_deadline(text)
    if not start or not end or start > end:
        return 0
    matches = [x for x in public.get("items", []) if x.get("url") == url]
    if len(matches) != 1:
        return 0
    row = matches[0]
    if row.get("application_start_at") or row.get("application_end_at"):
        return 0
    row["application_start_at"] = iso(start)
    row["application_end_at"] = iso(end)
    return 1


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--manual-overrides-json", type=Path, required=True)
    p.add_argument("--write", action="store_true")
    args = p.parse_args()
    snapshot = json.loads(args.manual_overrides_json.read_text(encoding="utf-8"))
    if not isinstance(snapshot.get("urls"), list):
        raise ValueError("Missing Supabase manual exclusions")
    from livepocket_v21 import browser_fetcher
    fetch, close = browser_fetcher()
    try:
        response = fetch(args.url)
    finally:
        close()
    if response.get("status") != "ok" or exact_event_url(response.get("final_url")) != args.url:
        raise ValueError("Event page could not be verified")
    path = Path("livepocket_public.json")
    public = json.loads(path.read_text(encoding="utf-8"))
    count = apply(public, args.url, response.get("text") or "", set(snapshot["urls"]))
    print("Exact-event application periods verified:", count)
    if args.write and count:
        path.write_text(json.dumps(public, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        print("Public catalog date fields updated")


if __name__ == "__main__":
    main()
