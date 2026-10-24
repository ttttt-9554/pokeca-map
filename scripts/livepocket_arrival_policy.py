"""Shared, bounded new-arrival retry policy and placeholder data hygiene.

No requests are made here. HTTP 401/403/429 and verification pages keep the
existing long cooldown. Transient failures never become completed events.
"""
from datetime import datetime, timedelta, timezone
import re
import unicodedata

UNKNOWN_SHOPS = frozenset({
    '店舗名不明', '店舗不明', '店舗名未確認', '店舗未確認', '店舗名未取得',
    '店舗未取得', '店舗名未設定', '店舗未設定', '店舗名なし', '店舗名無し',
    '不明', '未確認', '未取得', '未設定', 'unknown', 'unknownstore',
})


def unknown_shop(value):
    if not isinstance(value, str):
        return False
    text = re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).casefold()
    return text in UNKNOWN_SHOPS


def clean_placeholders(raw, public=None):
    """Remove placeholders, and ONLY prefectures derived from those names.

    A prefecture independently provided in a Discord block remains untouched.
    Real shops, manual overrides and all titles/deadlines remain untouched.
    """
    pindex = {x.get('url'): x for x in (public or {}).get('items', [])}
    changed = 0
    for item in raw.get('items', []):
        name_bad = unknown_shop(item.get('store_name'))
        stores = item.get('stores')
        bad_list = isinstance(stores, list) and any(
            isinstance(s, dict) and unknown_shop(s.get('name')) for s in stores)
        if not (name_bad or bad_list):
            continue
        fields = item.get('field_sources') or {}
        bad_pref = fields.get('prefecture') == 'v9_exact_store_cross_reference'
        for row in (item, pindex.get(item.get('url'))):
            if not isinstance(row, dict):
                continue
            if unknown_shop(row.get('store_name')):
                row.pop('store_name', None)
                row.get('field_sources', {}).pop('store_name', None)
            if isinstance(row.get('stores'), list):
                row['stores'] = [s for s in row['stores']
                                 if isinstance(s, dict) and not unknown_shop(s.get('name'))]
                if not row['stores']:
                    row.pop('stores', None)
            if bad_pref:
                row.pop('prefecture', None)
                row.get('field_sources', {}).pop('prefecture', None)
        changed += 1
    return changed


def stamp(value):
    try:
        d = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return d.astimezone(timezone.utc) if d.tzinfo else None
    except (ValueError, TypeError):
        return None


def latest_result(raw, url):
    state = raw.get('collector_state', {})
    records = [
        state.get('v14', {}).get('new_url_checks', {}).get(url, {}),
        state.get('v16', {}).get('retry_log', {}).get(url, {}),
        state.get('v13', {}).get('browser_checks', {}).get(url, {}),
        state.get('v21_9', {}).get('official_checks', {}).get(url, {}),
    ]
    latest = None
    status, http = '', None
    for record in records:
        if not isinstance(record, dict):
            continue
        at = stamp(record.get('checked_at') or record.get('last_attempt_at'))
        if not at or (latest and at < latest):
            continue
        if latest != at:
            http = None
        latest = at
        status = str(record.get('status') or record.get('last_status') or '')
        code = record.get('http_status')
        if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599:
            http = code
    return status, http, latest


def quick_retry_wait(raw, url, now):
    """Return a short wait only for recent, failed NEW URLs with retry budget.

    HTTP 405: 30 then 60 minutes. Timeout/408/5xx: 15 then 30 minutes.
    Successful-but-incomplete pages and all access challenges stay unchanged.
    """
    state = raw.get('collector_state', {})
    first = state.get('v14', {}).get('new_url_checks', {}).get(url, {})
    detected = stamp(first.get('detected_at')) if isinstance(first, dict) else None
    if not detected or not timedelta(0) <= now - detected <= timedelta(days=14):
        return None
    retry = state.get('v16', {}).get('retry_log', {}).get(url, {})
    try:
        attempts = int(retry.get('attempts', 0))
    except (ValueError, TypeError):
        return None
    if attempts < 0 or attempts >= 2:
        return None
    status, code, checked = latest_result(raw, url)
    if not checked or checked > now:
        return None
    if status == 'browser_http_error' and code == 405:
        return timedelta(minutes=30 * (2 ** attempts))
    if (status in ('browser_timeout', 'browser_no_response', 'browser_error') or
            (status == 'browser_http_error' and code is not None and
             (code == 408 or 500 <= code <= 599))):
        return timedelta(minutes=15 * (2 ** attempts))
    return None


def stop_repeated_http_errors(state, result, streak, now):
    """Pause after 3 consecutive HTTP refusals; leave unvisited URLs pending."""
    code = result.get('http_status')
    failed = (result.get('status') == 'browser_http_error' and
              isinstance(code, int) and (code == 405 or 500 <= code <= 599))
    streak = streak + 1 if failed else 0
    if streak >= 3:
        until = now + timedelta(minutes=30)
        existing = stamp(state.get('blocked_until'))
        if not existing or existing < until:
            state['blocked_until'] = until.isoformat()
        return streak, True
    return streak, False
