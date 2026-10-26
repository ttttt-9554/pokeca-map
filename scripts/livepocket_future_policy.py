#!/usr/bin/env python3
"""Prospective-only browser checks: keep historical lotteries out of new work.

Cutover: 2026-10-26 12:25 Japan time, when the user decided to stop
checking completed/legacy lotteries. The app keeps all historical records.
Regular new Discord notices and their bounded retries continue as normal.
Explicit developer-triggered historical checks remain available.
"""
import os
from datetime import datetime

FUTURE_ONLY_SINCE = datetime.fromisoformat("2026-10-26T12:25:00+09:00")


def as_aware_datetime(value):
    """Parse timestamp without inferring a missing timezone or date."""
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str) and value.strip():
        try:
            result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if result.tzinfo is None or result.utcoffset() is None:
        return None
    return result


def after_cutover(value, cutoff=FUTURE_ONLY_SINCE):
    """Inclusive, timezone-safe check. Missing timestamps fail closed."""
    timestamp = as_aware_datetime(value)
    baseline = as_aware_datetime(cutoff)
    if baseline is None:
        raise ValueError("An explicit timezone-aware cutover is required")
    return timestamp is not None and timestamp >= baseline


def scheduled_future_only():
    """Enabled on scheduled collectors; manual developer runs can opt into old work."""
    return os.getenv("LIVEPOCKET_AUTO_FUTURE_ONLY", "").lower() in ("true", "1", "yes")
