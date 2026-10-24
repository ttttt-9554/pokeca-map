#!/usr/bin/env python3
"""Read-only smoke probe for the two developer-beta retail monitors.

Fetches robots.txt and only the first catalog page for each allowlisted site.
No Supabase access, no state writes, no notifications, no product-detail requests.
"""
from __future__ import annotations
import json
import sys
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guerrilla_sale_monitor as monitor

def redirect_location(site, url):
    """Return a same-site redirect target for diagnostics without following it."""
    try:
        opener = build_opener(monitor.NoRedirect())
        opener.open(Request(url, headers={"User-Agent": monitor.UA, "Accept": "text/html"}), timeout=12)
        return ""
    except HTTPError as exc:
        if 300 <= exc.code < 400:
            return exc.headers.get("Location", "")[:500]
        return ""
    except Exception:
        return ""

def probe(site):
    client = monitor.StoreClient()
    url = monitor.catalog_url(site, 1)
    try:
        html = client.get(url, site)
        rows, total, next_links = monitor.parse_catalog(html, site, url)
        statuses = Counter(row.get("status", "unknown") for row in rows)
        sample = [
            {"product": row.get("product", "")[:120], "status": row.get("status"), "url": row.get("url")}
            for row in rows[:3]
        ]
        return {
            "site": site,
            "status": "ok",
            "catalog_url": url,
            "products_found": len(rows),
            "reported_total": total,
            "next_links": len(next_links),
            "statuses": dict(statuses),
            "sample": sample,
        }
    except monitor.CheckError as exc:
        return {"site": site, "status": "blocked_or_unverified", "reason": exc.code, "catalog_url": url, "redirect_location": redirect_location(site, url) if exc.code == "redirect_blocked" else ""}
    except Exception as exc:
        return {"site": site, "status": "probe_error", "reason": type(exc).__name__, "catalog_url": url}

def main():
    results = [probe(site) for site in ("pokemon", "amenity")]
    print("GUERRILLA_SALE_PROBE_BEGIN")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print("GUERRILLA_SALE_PROBE_END")
    # This is diagnostics, not a deployment gate. A retailer may temporarily
    # block automation; the monitor itself must fail closed in that case.
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
