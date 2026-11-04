"""Observe five future new-page checks without making extra network requests.

Results are diagnostic candidates, never lottery card data. The existing
collector decides whether a page is accessible and remains in control of
all retry and access-block handling.
"""
import re
from datetime import datetime, timezone

LIMIT = 5
# Include URLs discovered after the trial was prepared, even if they arrive
# before the first scheduled run has created the persistent trial state.
TRIAL_CUTOVER = datetime(2026, 11, 4, 13, 29, 52, tzinfo=timezone.utc)
RESULT = re.compile(r'(?:抽選結果(?:発表)?|当選(?:結果)?発表|結果発表|当落発表|当選通知)')
PURCHASE = re.compile(r'(?:商品(?:の)?(?:販売|購入|引取|受取)期間|店頭(?:販売|購入|引取|受取)期間|購入期間|引取期間|受取期間|お受け取り期間)')
STOP = re.compile(r'^(?:受付・チケット情報|応募(?:受付)?期間|申込(?:受付)?期間|抽選受付期間|お問い合わせ|注意事項)')


def parse_time(value):
    try:
        result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (TypeError, ValueError): return None


def start(raw, now):
    state = raw.setdefault('collector_state', {})
    trial = state.setdefault('period_trial_v1', {})
    if not parse_time(trial.get('started_at')):
        trial['started_at'] = min(now, TRIAL_CUTOVER).isoformat()
    trial.setdefault('results', [])
    start_at = parse_time(trial['started_at'])
    source = state.get('v14', {})
    pending = source.get('pending_new_urls', [])
    checks = source.get('new_url_checks', {})
    eligible = set()
    for url in pending:
        row = checks.get(url, {})
        detected = parse_time(row.get('detected_at')) if isinstance(row, dict) else None
        if detected and detected >= start_at: eligible.add(url)
    return eligible


def excerpts(text, expression):
    lines = [' '.join(line.split()) for line in str(text or '').splitlines()]
    hits = []
    for i, line in enumerate(lines):
        if not expression.search(line): continue
        # Nearby text is evidence for a human, not a confirmed date.
        parts = [line]
        for nearby in lines[i+1:i+3]:
            if RESULT.search(nearby) or PURCHASE.search(nearby) or STOP.search(nearby): break
            if nearby: parts.append(nearby)
        snippet = ' '.join(parts)[:220]
        if snippet and snippet not in hits: hits.append(snippet)
        if len(hits) >= 3: break
    return hits


def observation(url, result, now):
    status = str(result.get('status') or 'browser_error') if isinstance(result, dict) else 'browser_error'
    entry = {'url': url, 'checked_at': now.isoformat(), 'status': status,
             'result_candidates': [], 'purchase_candidates': []}
    if status == 'ok' and isinstance(result.get('text'), str):
        entry['result_candidates'] = excerpts(result['text'], RESULT)
        entry['purchase_candidates'] = excerpts(result['text'], PURCHASE)
    return entry


def lottery_or_unavailable(result):
    if not isinstance(result, dict) or result.get('status') != 'ok': return True
    text = str(result.get('text') or '') + ' '.join(str(x) for x in result.get('titles') or [])
    return '抽選' in text


def append(raw, entries):
    trial = raw.setdefault('collector_state', {}).setdefault('period_trial_v1', {})
    rows = trial.setdefault('results', [])
    known = {row.get('url') for row in rows if isinstance(row, dict)}
    for entry in entries:
        if len(rows) >= LIMIT: break
        if entry['url'] not in known:
            rows.append(entry); known.add(entry['url'])
    return rows
