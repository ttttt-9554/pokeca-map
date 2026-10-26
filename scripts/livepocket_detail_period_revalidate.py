#!/usr/bin/env python3
"""Fail closed if any newly written deadline gained a manual override.

Compare working files to HEAD before publishing, using a freshly fetched
Supabase exclusion snapshot. Never print the private URL list.
"""
import json
import subprocess
from pathlib import Path


def changed_urls(before, after):
    old = {x["url"]: x for x in before.get("items", [])}
    result = set()
    for item in after.get("items", []):
        url = item.get("url")
        previous = old.get(url)
        if previous and any(item.get(k) != previous.get(k)
                            for k in ("application_start_at", "application_end_at")):
            # This workflow may only fill two previously absent date fields.
            if (previous.get("application_start_at")
                    or previous.get("application_end_at")
                    or not item.get("application_start_at")
                    or not item.get("application_end_at")):
                raise RuntimeError("Unsafe date modification detected")
            result.add(url)
    return result


def main():
    snapshot = json.loads(Path("prefecture_manual_overrides.json").read_text(encoding="utf-8"))
    urls = snapshot.get("urls")
    if not isinstance(urls, list) or not urls:
        raise ValueError("Current manual exclusions are unavailable")
    changed = set()
    changes_by_file = []
    for filename in ("livepocket_public.json", "livepocket_urls.json"):
        before = json.loads(subprocess.check_output(["git", "show", "HEAD:" + filename]))
        after = json.loads(Path(filename).read_text(encoding="utf-8"))
        file_changes = changed_urls(before, after)
        changes_by_file.append(file_changes)
        changed.update(file_changes)
    if len(changes_by_file) != 2 or changes_by_file[0] != changes_by_file[1]:
        raise RuntimeError('Raw and public catalogs must have identical date updates')
    if len(changed) > 5:
        raise RuntimeError('Batch update exceeded five events')
    blocked = changed.intersection(urls)
    if blocked:
        raise RuntimeError("A manually edited event changed during verification; aborting publication")
    print("Fresh override exclusion check passed; changed event count:", len(changed))


if __name__ == "__main__":
    main()
