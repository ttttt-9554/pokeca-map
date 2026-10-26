#!/usr/bin/env python3
"""Refuse unsafe LivePocket application-period JSON changes before publishing.

A fresh Supabase administrator-exclusion snapshot is required. Compare the two
working catalogs to HEAD; never allow unrelated changes or stale deadlines.
"""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from livepocket_v11 import parse_datetime

DATE_KEYS = ("application_start_at", "application_end_at")


def _index(data):
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise RuntimeError("Malformed event catalog")
    by_url = {}
    for row in data["items"]:
        if not isinstance(row, dict) or not isinstance(row.get("url"), str):
            raise RuntimeError("Malformed event row")
        if row["url"] in by_url:
            raise RuntimeError("Duplicate event URL")
        by_url[row["url"]] = row
    return by_url


def changed_urls(before, after, now=None):
    """Only a new verified end and optional verified start may change."""
    old, current = _index(before), _index(after)
    if old.keys() != current.keys():
        raise RuntimeError("Event URLs unexpectedly changed")
    if ({k:v for k,v in before.items() if k != "items"}
            != {k:v for k,v in after.items() if k != "items"}):
        raise RuntimeError("Catalog metadata unexpectedly changed")
    now = now or datetime.now(timezone.utc)
    changed = set()
    for url, previous in old.items():
        row = current[url]
        if ({k:v for k,v in previous.items() if k not in DATE_KEYS}
                != {k:v for k,v in row.items() if k not in DATE_KEYS}):
            raise RuntimeError("Non-date fields unexpectedly changed")
        if any(row.get(k) != previous.get(k) for k in DATE_KEYS):
            if any(previous.get(k) for k in DATE_KEYS):
                raise RuntimeError("Existing date would be overwritten")
            # An explicit deadline needs no inferred start, but a start
            # without a verified deadline is never safe to publish.
            start_text = row.get("application_start_at")
            end_text = row.get("application_end_at")
            if (not isinstance(end_text, str) or not end_text
                    or (start_text is not None and
                        (not isinstance(start_text, str) or not start_text))):
                raise RuntimeError("Missing or malformed application deadline")
            start = parse_datetime(start_text) if start_text else None
            end = parse_datetime(end_text)
            if not end or (start_text and not start) or (start and start > end) or end <= now:
                raise RuntimeError("Invalid or expired deadline")
            changed.add(url)
    return changed


def matching_date_changes(changes_by_file, values_by_file):
    return (len(changes_by_file) == 2 and changes_by_file[0] == changes_by_file[1]
            and values_by_file[0] == values_by_file[1])


def main():
    snapshot = json.loads(Path("prefecture_manual_overrides.json").read_text(encoding="utf-8"))
    urls = snapshot.get("urls")
    if (not isinstance(urls, list) or not urls
            or any(not isinstance(url, str) for url in urls)):
        raise ValueError("Current administrator exclusions unavailable")
    changed = set()
    changes_by_file, values_by_file = [], []
    for filename in ("livepocket_public.json", "livepocket_urls.json"):
        before = json.loads(subprocess.check_output(["git", "show", "HEAD:" + filename]))
        after = json.loads(Path(filename).read_text(encoding="utf-8"))
        file_changes = changed_urls(before, after)
        changes_by_file.append(file_changes)
        index = _index(after)
        values_by_file.append({
            url: (index[url].get("application_start_at"), index[url]["application_end_at"])
            for url in file_changes
        })
        changed.update(file_changes)
    if not matching_date_changes(changes_by_file, values_by_file):
        raise RuntimeError("Raw and public date updates differ")
    if len(changed) > 5:
        raise RuntimeError("Batch exceeded five updated events")
    if changed.intersection(urls):
        raise RuntimeError("Administrator edit conflicts with an event update")
    print("Fresh administrator exclusions passed; changed events:", len(changed))


if __name__ == "__main__":
    main()
