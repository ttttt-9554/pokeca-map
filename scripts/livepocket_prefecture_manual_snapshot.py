#!/usr/bin/env python3
"""Fetch URL-only manual override exclusion snapshot from Supabase (fail closed).

Requires a private GitHub Actions secret; never prints keys, rows or URLs.
"""
import json
import urllib.error
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def fetch_manual_urls(base_url, service_key, opener=urllib.request.urlopen):
    if not base_url.startswith("https://") or not service_key:
        raise ValueError("Secure Supabase URL and service key are required")
    parsed = urllib.parse.urlsplit(base_url.strip())
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/"):
        raise ValueError("Invalid Supabase project URL")
    base = base_url.strip().rstrip("/")
    print("Supabase host matches expected project:", parsed.hostname == "aypcmtlaaygmiexboypk.supabase.co")
    print("Supabase key format:", "legacy JWT" if service_key.startswith("eyJ") else "secret key" if service_key.startswith("sb_secret_") else "unexpected")

    urls = set()
    offset = 0
    while True:
        query = urllib.parse.urlencode({
            "select": "event_url",
            "limit": "1000",
            "offset": str(offset),
            "order": "event_url.asc",
        })
        req = urllib.request.Request(
            base + "/rest/v1/lottery_card_overrides?" + query,
            headers={
                "apikey": service_key,
                "Authorization": "Bearer " + service_key,
                "Accept": "application/json",
            },
        )
        try:
            with opener(req, timeout=20) as response:
                if response.status != 200:
                    raise RuntimeError("Supabase manual-override request failed")
                rows = json.load(response)
        except urllib.error.HTTPError as exc:
            print("Supabase HTTP status:", exc.code)
            print("Supabase response content type:", exc.headers.get("Content-Type", "unknown"))
            # Only emit an allowlisted diagnostic code, never response body or credentials.
            try:
                payload = json.loads(exc.read(4096).decode("utf-8", "replace"))
                code = payload.get("code") if isinstance(payload, dict) else None
                allowed = {"42501", "PGRST301", "PGRST302", "PGRST303", "PGRST116", "invalid_api_key", "bad_jwt"}
                print("Supabase safe error code:", code if code in allowed else "unclassified")
            except (ValueError, UnicodeError):
                print("Supabase safe error code: unavailable")
            print("Supabase request rejected; response body intentionally hidden")
            raise RuntimeError("Supabase authentication or access policy rejected request") from None
        if not isinstance(rows, list):
            raise ValueError("Unexpected Supabase response")
        for row in rows:
            url = row.get("event_url") if isinstance(row, dict) else None
            if not isinstance(url, str) or not url.startswith("https://livepocket.jp/e/"):
                continue
            urls.add(url)
        if len(rows) < 1000:
            break
        offset += 1000
        if offset > 100000:
            raise RuntimeError("Supabase manual-override pagination limit exceeded")
    return sorted(urls)


def main():
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    base = os.getenv("SUPABASE_URL", "")
    if not key or not base:
        raise SystemExit("Missing Supabase secret: review-only backfill is disabled")
    urls = fetch_manual_urls(base, key)
    if not urls:
        raise SystemExit("No manual override records returned; refusing unsafe backfill")
    output = Path("prefecture_manual_overrides.json")
    output.write_text(json.dumps({"urls": urls}, ensure_ascii=False), encoding="utf-8")
    output.chmod(0o600)
    print("Manual override exclusion snapshot created; URL list is not logged")


if __name__ == "__main__":
    main()
