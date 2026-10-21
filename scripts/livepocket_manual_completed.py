#!/usr/bin/env python3
"""Read publicly readable, URL-only manual LivePocket corrections from Supabase.

For developer-triggered review only. Uses the SAME publishable configuration
already shipped to browsers in app.js; no service key or admin identity.
Never stores credentials or fetches arbitrary user-provided URLs.
"""
from __future__ import annotations
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from functools import lru_cache

ROOT = Path(__file__).resolve().parents[1]
OVERRIDE_FIELDS = {
    "livepocket_event_overrides": "event_url,resolution",
    "livepocket_location_overrides": "event_url",
}
URL_PATTERN = re.compile(r"^https://livepocket[.]jp/e/[A-Za-z0-9_-]{3,64}/?$")


def _client_config(path: Path = ROOT / "app.js") -> tuple[str, str]:
    source = path.read_text(encoding="utf-8")
    def constant(name: str) -> str:
        m = re.search(r"const\s+" + name + r"\s*=\s*'([^']+)'", source)
        if not m:
            raise RuntimeError("Public Supabase config is missing")
        return m.group(1)
    endpoint, key = constant("SUPABASE_URL"), constant("SUPABASE_KEY")
    if not re.fullmatch(r"https://[a-z0-9-]+[.]supabase[.]co", endpoint):
        raise RuntimeError("Unexpected public Supabase host")
    if not key.startswith(("sb_publishable_", "eyJ")):
        raise RuntimeError("Unsupported public Supabase key")
    return endpoint, key


def _read_rows(endpoint: str, key: str, table: str, fields: str) -> list[dict]:
    query = urllib.parse.urlencode({"select": fields, "limit": "1000"})
    request = urllib.request.Request(
        endpoint + "/rest/v1/" + table + "?" + query,
        headers={"apikey": key, "Accept": "application/json",
                 "User-Agent": "PokecaMapManualReview/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.load(response)
    except Exception as err:
        # Never print a public key or user data into CI logs.
        raise RuntimeError("Manual completion sync failed (" +
                           type(err).__name__ + ")") from None
    if not isinstance(payload, list) or len(payload) >= 1000:
        raise RuntimeError("Manual completion sync incomplete; check pagination")
    return [row for row in payload if isinstance(row, dict)]


@lru_cache(maxsize=1)
def read_manual_completed() -> tuple[set[str], set[str], set[str]]:
    """Returns fully resolved event URLs and manually corrected location URLs.

    Location-only repairs count as complete when the event already has a
    verified name and deadline; otherwise title/deadline still need checking.
    Fail rather than silently repeating finished reviews if cloud is down.
    """
    endpoint, key = _client_config()
    titles = _read_rows(endpoint, key, "livepocket_event_overrides",
                        OVERRIDE_FIELDS["livepocket_event_overrides"])
    locations = _read_rows(endpoint, key, "livepocket_location_overrides",
                           OVERRIDE_FIELDS["livepocket_location_overrides"])
    resolved_title = {row["event_url"] for row in titles
                      if row.get("resolution") == "title"
                      and URL_PATTERN.fullmatch(str(row.get("event_url", "")))}
    removed = {row["event_url"] for row in titles
               if row.get("resolution") == "unavailable"
               and URL_PATTERN.fullmatch(str(row.get("event_url", "")))}
    corrected_locations = {row["event_url"] for row in locations
                           if URL_PATTERN.fullmatch(str(row.get("event_url", "")))}
    print("Manual completions synced: verified titles", len(resolved_title),
          "removed pages", len(removed), "location fixes", len(corrected_locations))
    return resolved_title, removed, corrected_locations
