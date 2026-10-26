#!/usr/bin/env python3
"""Fetch public-event IDs with any administrator edit from Supabase.

Protect card, store/location, and page-status corrections. Every source must
be readable; otherwise refuse the backfill rather than guessing. The snapshot
is private to GitHub Actions and private URLs are never logged.
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_HOST = "aypcmtlaaygmiexboypk.supabase.co"
MANUAL_TABLES = (
    "lottery_card_overrides",
    "livepocket_location_overrides",
    "livepocket_event_overrides",
)
EVENT_PATH = re.compile(r"/e/[A-Za-z0-9_-]{4,64}/?\Z")


def canonical_event_url(value):
    """Normalize edited official URLs to the canonical catalog identifier."""
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
        return None
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return None
    if (parts.scheme != "https"
            or parts.netloc not in ("livepocket.jp", "www.livepocket.jp")
            or not EVENT_PATH.fullmatch(parts.path)):
        return None
    return "https://livepocket.jp" + parts.path.rstrip("/")


def fetch_manual_urls(base_url, service_key, opener=urllib.request.urlopen):
    if not isinstance(base_url, str) or not service_key:
        raise ValueError("Secure Supabase URL and service key are required")
    parsed = urllib.parse.urlsplit(base_url.strip())
    if (parsed.scheme != "https" or parsed.netloc != PROJECT_HOST
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Unexpected Supabase project URL")
    base = "https://" + PROJECT_HOST
    headers = {"apikey": service_key, "Accept": "application/json"}
    # New sb_secret_ keys are opaque, not JWTs. Do not send them as bearer JWTs.
    if service_key.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + service_key
    urls = set()
    for table in MANUAL_TABLES:
        offset = 0
        while True:
            query = urllib.parse.urlencode({
                "select": "event_url",
                "limit": "1000",
                "offset": str(offset),
                "order": "event_url.asc",
            })
            req = urllib.request.Request(
                base + "/rest/v1/" + table + "?" + query, headers=headers)
            try:
                with opener(req, timeout=20) as response:
                    if response.status != 200:
                        raise RuntimeError("Supabase exclusion request failed")
                    rows = json.load(response)
            except urllib.error.HTTPError as exc:
                # Never display the body, identifiers, or secret in CI logs.
                print("Supabase exclusion HTTP status:", exc.code)
                raise RuntimeError("Supabase exclusion request rejected") from None
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError("Unexpected Supabase exclusion response")
            for row in rows:
                canonical = canonical_event_url(row.get("event_url"))
                if canonical:
                    urls.add(canonical)
            if len(rows) < 1000:
                break
            offset += 1000
            if offset > 100000:
                raise RuntimeError("Supabase exclusion pagination limit exceeded")
    return sorted(urls)


def main():
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    base = os.getenv("SUPABASE_URL", "")
    if not key or not base:
        raise SystemExit("Missing Supabase secret; backfill disabled")
    urls = fetch_manual_urls(base, key)
    if not urls:
        raise SystemExit("No manual override records; refusing unsafe backfill")
    output = Path("prefecture_manual_overrides.json")
    output.write_text(json.dumps({"urls": urls}, ensure_ascii=False), encoding="utf-8")
    output.chmod(0o600)
    print("Administrator exclusions fetched from all three sources; URLs hidden")


if __name__ == "__main__":
    main()
