#!/usr/bin/env python3
"""Publish verified application deadlines against the CURRENT main catalog.

This tool never scrapes a webpage, guesses a date, or overwrites corrections.
Capture a minimal manifest from the original checkout; after fetching the
latest main branch, apply that manifest only to still-unmodified events.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess

DATE_FIELDS = ('application_start_at', 'application_end_at')
EVENT_URL = re.compile(r'https://livepocket\.jp/e/[A-Za-z0-9_-]{4,64}\Z')
MAX_CHANGES = 5


def _index(catalog):
    if not isinstance(catalog, dict) or not isinstance(catalog.get('items'), list):
        raise ValueError('Invalid event catalog')
    result = {}
    for row in catalog['items']:
        if not isinstance(row, dict) or not isinstance(row.get('url'), str):
            raise ValueError('Malformed event')
        url = row['url']
        if not EVENT_URL.fullmatch(url) or url in result:
            raise ValueError('Invalid or duplicate event URL')
        result[url] = row
    return result


def _period(start, end, now):
    """Verify a real cutoff time; start may be None, never inferred."""
    if (not isinstance(end, str) or not end
            or (start is not None and (not isinstance(start, str) or not start))):
        raise ValueError('Expected a verified end and optional verified start')
    try:
        begin = datetime.fromisoformat(start.replace('Z', '+00:00')) if start else None
        finish = datetime.fromisoformat(end.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('Invalid date format') from exc
    if (finish.tzinfo is None or (begin is not None and begin.tzinfo is None)
            or (begin is not None and begin > finish) or finish <= now):
        raise ValueError('Incoherent or expired application deadline')
    return start, end


def _changes(original, updated, now):
    old, new = _index(original), _index(updated)
    if old.keys() != new.keys():
        raise ValueError('Event URLs unexpectedly changed')
    if ({key:value for key,value in original.items() if key != 'items'} !=
            {key:value for key,value in updated.items() if key != 'items'}):
        raise ValueError('Catalog metadata unexpectedly changed')
    changes = {}
    for url, before in old.items():
        after = new[url]
        if ({key:value for key,value in before.items() if key not in DATE_FIELDS} !=
                {key:value for key,value in after.items() if key not in DATE_FIELDS}):
            raise ValueError('Unrelated event fields unexpectedly changed')
        previous_dates = tuple(before.get(key) for key in DATE_FIELDS)
        new_dates = tuple(after.get(key) for key in DATE_FIELDS)
        if previous_dates != new_dates:
            if any(previous_dates):
                raise ValueError('Existing application period overwritten')
            changes[url] = _period(*new_dates, now)
    return changes


def capture(original_raw, original_public, updated_raw, updated_public, now=None):
    now = now or datetime.now(timezone.utc)
    a = _changes(original_raw, updated_raw, now)
    b = _changes(original_public, updated_public, now)
    if a != b or len(a) > MAX_CHANGES:
        raise ValueError('Raw/public date updates differ or exceed batch limit')
    return {'version': 1, 'changes': [
        {'url': url, 'application_start_at': dates[0], 'application_end_at': dates[1]}
        for url, dates in sorted(a.items())
    ]}


def apply_manifest(raw, public, manifest, excluded_urls, now=None):
    """Update two catalogs in-place, skipping all manually corrected/stale rows."""
    if excluded_urls is None:
        raise ValueError('Fresh administrator exclusions are mandatory')
    if not isinstance(manifest, dict) or manifest.get('version') != 1:
        raise ValueError('Invalid manifest version')
    changes = manifest.get('changes')
    if not isinstance(changes, list) or len(changes) > MAX_CHANGES:
        raise ValueError('Oversized or invalid manifest')
    now = now or datetime.now(timezone.utc)
    raw_rows, public_rows = _index(raw), _index(public)
    if raw_rows.keys() != public_rows.keys():
        raise ValueError('Current raw/public event lists differ')
    updates = 0
    seen = set()
    # Validate the WHOLE manifest before changing either catalog.
    for row in changes:
        if not isinstance(row, dict) or set(row) != {'url', *DATE_FIELDS}:
            raise ValueError('Invalid manifest entry')
        url = row['url']
        if not isinstance(url, str) or not EVENT_URL.fullmatch(url) or url in seen:
            raise ValueError('Invalid or repeated manifest URL')
        seen.add(url)
        _period(row['application_start_at'], row['application_end_at'], now)
    for entry in changes:
        url = entry['url']
        if url in excluded_urls or url not in raw_rows:
            continue
        source, published = raw_rows[url], public_rows[url]
        if any(source.get(key) or published.get(key) for key in DATE_FIELDS):
            continue
        for row in (source, published):
            # Preserve an unknown start as unknown (no fabricated timestamp).
            if entry['application_start_at'] is not None:
                row['application_start_at'] = entry['application_start_at']
            row['application_end_at'] = entry['application_end_at']
        updates += 1
    return updates


def _read(filename):
    return json.loads(Path(filename).read_text(encoding='utf-8'))


def _git_before(filename):
    return json.loads(subprocess.check_output(['git', 'show', 'HEAD:' + str(filename)]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('capture', 'apply'))
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--manual-overrides-json', type=Path)
    options = parser.parse_args()
    raw_path, public_path = Path('livepocket_urls.json'), Path('livepocket_public.json')
    raw, public = _read(raw_path), _read(public_path)
    if options.action == 'capture':
        manifest = capture(_git_before(raw_path), _git_before(public_path), raw, public)
        options.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('Verified candidate event count:', len(manifest['changes']))
        return
    if not options.manual_overrides_json:
        raise ValueError('Missing current administrator exclusions')
    snapshot = _read(options.manual_overrides_json)
    excluded = snapshot.get('urls') if isinstance(snapshot, dict) else None
    if not isinstance(excluded, list) or not excluded or any(not isinstance(x, str) for x in excluded):
        raise ValueError('Invalid current administrator exclusions')
    manifest = _read(options.manifest)
    count = apply_manifest(raw, public, manifest, set(excluded))
    if count:
        # Two temp files then atomic replacement, no network or publishing here.
        from livepocket_v11 import write_json
        write_json(raw_path, raw)
        write_json(public_path, public)
    print('Fresh verified application periods merged:', count)


if __name__ == '__main__':
    main()
