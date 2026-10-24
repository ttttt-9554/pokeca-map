"""Apply the reviewed 2026-10-24 source repair once; never touch event data.

Every replacement is checked in memory before any file is written. An already
applied repair is a no-op. Changed upstream anchors fail closed.
"""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
changes = {}


def edit(path, old, new):
    source = changes.get(path, (root / path).read_text(encoding="utf-8"))
    if source.count(new) == 1:
        return
    if source.count(old) != 1:
        raise RuntimeError("Source changed; review repair anchor in " + path)
    changes[path] = source.replace(old, new)

for file in ['livepocket_collect.py','livepocket_v7.py','livepocket_v9.py','livepocket_v14.py','livepocket_v15.py','livepocket_v17.py','livepocket_v19.py','livepocket_v21.py']:
    edit('scripts/'+file, 'from __future__ import annotations', 'from __future__ import annotations\nimport livepocket_arrival_policy as arrival_policy')
edit('scripts/livepocket_collect.py', 'if not s or not 2 <= len(s) <= 90:', 'if not s or arrival_policy.unknown_shop(s) or not 2 <= len(s) <= 90:')
edit('scripts/livepocket_v7.py','and not BAD_NAME.search(value) and STORE_HINTS.search(value)', 'and not arrival_policy.unknown_shop(value)\n            and not BAD_NAME.search(value) and STORE_HINTS.search(value)')
edit('scripts/livepocket_v9.py', '    raw_items, public_items = raw[\'items\'], public[\'items\']', "    raw = json.loads(json.dumps(raw, ensure_ascii=False))\n    public = json.loads(json.dumps(public, ensure_ascii=False))\n    arrival_policy.clean_placeholders(raw, public)\n    raw_items, public_items = raw['items'], public['items']")
edit('scripts/livepocket_v9.py', 'if isinstance(name, str) and name.strip() and pref in PREFECTURES:', 'if isinstance(name, str) and name.strip() and not arrival_policy.unknown_shop(name) and pref in PREFECTURES:')
edit('scripts/livepocket_v15.py', "    if field == 'store_name':\n        if BAD_STORE.search(value)", "    if field == 'store_name':\n        if arrival_policy.unknown_shop(value):\n            return None\n        if BAD_STORE.search(value)")
edit('scripts/livepocket_v19.py', "    if not isinstance(s, str):\n        return None", "    if not isinstance(s, str) or arrival_policy.unknown_shop(s):\n        return None")
edit('scripts/livepocket_v19.py', "    seen_pages = seen_pages or {}\n    manual = manual or {}", "    arrival_policy.clean_placeholders(raw, public)\n    seen_pages = seen_pages or {}\n    manual = manual or {}")
# Only recover an explicitly bracketed, officially observed shop, never its prefecture.
edit('scripts/livepocket_v19.py', "        legacy = r.get('store_name') or p.get('store_name') or ''\n        product", """        legacy = r.get('store_name') or p.get('store_name') or ''
        origin = str((r.get('field_sources') or {}).get('event_title') or '')
        if not safe_name(legacy) and origin.startswith(('v14_livepocket_', 'v21_official_')):
            heading = re.match(r'^【\\s*([^【】]{2,90}?店)\\s*】', str(r.get('event_title') or ''))
            observed_shop = safe_name(heading.group(1), strict_retail=True) if heading else None
            if observed_shop:
                legacy = observed_shop
                r['store_name'] = p['store_name'] = observed_shop
                r.setdefault('field_sources', {})['store_name'] = 'v22_official_title_shop'
        product""")
# Retain numeric HTTP diagnostics in the same check record and stop a failing batch.
edit('scripts/livepocket_v14.py', "    for url in urgent + background:\n", "    http_error_streak = 0\n    for url in urgent + background:\n")
edit('scripts/livepocket_v14.py', "        checks[url] = {'checked_at': stamp, 'status': status}", "        checks[url] = {'checked_at': stamp, 'status': status, 'http_status': result.get('http_status')}")
edit('scripts/livepocket_v14.py', "            entry.update({'checked_at': stamp, 'status': status})", "            entry.update({'checked_at': stamp, 'status': status, 'http_status': result.get('http_status')})")
edit('scripts/livepocket_v14.py', "        if status in ('browser_blocked', 'browser_blocked_or_empty'):\n            stats['blocked']", "        http_error_streak, stop_http = arrival_policy.stop_repeated_http_errors(state, result, http_error_streak, now)\n        if stop_http:\n            break\n        if status in ('browser_blocked', 'browser_blocked_or_empty'):\n            stats['blocked']")
# Due retries already run on every collector tick through v17 (not only background jobs).
edit('scripts/livepocket_v17.py', '        if now - last.astimezone(now.tzinfo) < timedelta(hours=v16.RETRY_DELAY_HOURS):', '        wait = arrival_policy.quick_retry_wait(raw, url, now) or timedelta(hours=v16.RETRY_DELAY_HOURS)\n        if now - last.astimezone(now.tzinfo) < wait:')
edit('scripts/livepocket_v17.py', '    eligible = last.astimezone(now.tzinfo) + timedelta(hours=v16.RETRY_DELAY_HOURS)', '    wait = arrival_policy.quick_retry_wait(raw, url, now) or timedelta(hours=v16.RETRY_DELAY_HOURS)\n    eligible = last.astimezone(now.tzinfo) + wait')
edit('scripts/livepocket_v17.py', '    for url in selected:\n', '    http_error_streak = 0\n    for url in selected:\n')
edit('scripts/livepocket_v17.py', "        checks[url] = {'checked_at': time, 'status': status}", "        checks[url] = {'checked_at': time, 'status': status, 'http_status': result.get('http_status')}")
edit('scripts/livepocket_v17.py', "        firsts[url]['status'] = status", "        firsts[url]['status'] = status\n        firsts[url]['http_status'] = result.get('http_status')")
edit('scripts/livepocket_v17.py', "        if status in ('browser_blocked', 'browser_blocked_or_empty'):\n            stats['retry_blocked']", "        http_error_streak, stop_http = arrival_policy.stop_repeated_http_errors(state['v14'], result, http_error_streak, now)\n        if stop_http:\n            break\n        if status in ('browser_blocked', 'browser_blocked_or_empty'):\n            stats['retry_blocked']")
# All schedules and developer explanations use the same delay.
edit('scripts/livepocket_v21.py', "            wait = timedelta(hours=24) if successful else timedelta(hours=6)\n            next_at = latest_check + wait", "            wait = (timedelta(hours=24) if successful else\n                    arrival_policy.quick_retry_wait(raw, url, now) or timedelta(hours=6))\n            next_at = latest_check + wait\n            cooldown_at = arrival_policy.stamp(v14state.get('blocked_until'))\n            if cooldown_at and cooldown_at > next_at:\n                next_at = cooldown_at\n            if include_items:\n                last_status, last_http, _ = arrival_policy.latest_result(raw, url)\n                review_item['last_check_status'] = last_status\n                review_item['last_http_status'] = last_http\n                review_item['last_checked_at'] = latest_check.isoformat()\n                review_item['next_retry_at'] = next_at.isoformat()")
edit('scripts/livepocket_v21.py', "    raw, public = v14.read_pair()\n    known", "    raw, public = v14.read_pair()\n    arrival_policy.clean_placeholders(raw, public)\n    known")
# Annotate each failed row with finite status labels, not remote error text.
edit('app.js', "      const missing=row.missing.map(x=>LP_DEV_MISSING_LABELS[x]).filter(Boolean);", """      const missing=row.missing.map(x=>LP_DEV_MISSING_LABELS[x]).filter(Boolean);
      const http=Number(row.last_http_status);
      const failures={browser_timeout:'ページ取得がタイムアウト',browser_no_response:'ページから応答なし',
        browser_http_error:'ページ取得に失敗',browser_blocked:'サイト側のアクセス制限',
        browser_blocked_or_empty:'認証画面・アクセス制限',browser_error:'ページ取得エラー',
        browser_unverified_page:'イベント本文を確認できませんでした'};
      const failure=failures[row.last_check_status]||'';
      const detail=failure+(failure&&http>=400&&http<=599?'（HTTP '+http+'）':'');
      const retryAt=row.queue==='retry_wait'&&Number.isFinite(Date.parse(row.next_retry_at||''))?
        '再確認可能：'+lpDevReportDate(row.next_retry_at):'';""")
edit('app.js', "        '<span class=\"lp-dev-review-state\">'+(row.queue==='retry_wait'?'⏳ 再試行待ち':'🔎 今すぐ確認')+'</span>'+", "        '<span class=\"lp-dev-review-state\">'+(row.queue==='retry_wait'?'⏳ 再試行待ち':'🔎 今すぐ確認')+'</span>'+\n        (detail?'<p class=\"hint\">'+escape(detail)+'</p>':'')+\n        (retryAt?'<p class=\"hint\">'+escape(retryAt)+'</p>':'')+")
edit('index.html','app.js?v=20261024-toreca-radar','app.js?v=20261024-livepocket-new-arrival-repair')
edit('scripts/test_livepocket_manual_review.py',
     '"application_end_at","missing","queue"})',
     '"application_end_at","missing","queue","last_check_status",\n             "last_http_status","last_checked_at","next_retry_at"})')
edit('scripts/livepocket_v17.py',
     "Keeps v16's six-hour spacing, maximum two retries, 14-day age window,",
     "Keeps a maximum of two retries and the 14-day age window; transient NEW\nfailures use bounded 15/30/60-minute spacing, access gates keep six hours.")
for path, source in changes.items():
    (root / path).write_text(source, encoding="utf-8")
print("Reviewed source files repaired:", len(changes))
