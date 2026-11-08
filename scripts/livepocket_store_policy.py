"""LivePocket locations must have exact-event page or verified manual evidence.

Discord remains a URL/product discovery source, never a location source.
Legacy combined lists cannot prove that every shop came from the event page.
"""
import copy
import re
from datetime import datetime
from livepocket_venue_prefecture import PREFECTURES

PAGE = 'livepocket_official_page'
MANUAL = 'livepocket_verified_manual'
PENDING = 'livepocket_page_required'
AREAS = frozenset((*PREFECTURES, '全国', ''))
LOCATION_KEYS = frozenset(('store_name', 'prefecture', 'stores',
                          'store_location_source', 'store_location_url'))
URL_RE = re.compile(r'https://livepocket\.jp/e/[A-Za-z0-9_-]{3,64}$')
LEGACY_PAGE_NAMES = frozenset(('v15_page_store_label', 'v15_page_explicit_retail_venue',
                              'v22_official_title_shop', 'v19_livepocket_overview_venue',
                              'livepocket_event_page'))
MANUAL_PREFIXES = ('user_safari_screenshots', 'v10_user_verified_csv', 'user_verified', 'manual_verified')
PAGE_REGIONS = frozenset(('livepocket_exact_venue', 'v19_livepocket_overview_venue',
                          'store_master_unique_exact_name_v21_146'))


def valid_rows(rows):
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows[:35]:
        if not isinstance(row, dict):
            continue
        name, pref = row.get('name'), row.get('prefecture') or ''
        if (not isinstance(name, str) or not 2 <= len(name.strip()) <= 200
                or pref not in AREAS):
            continue
        value = {'name': name.strip(), 'prefecture': pref}
        if value not in out:
            out.append(value)
    return out


def verified(row):
    return (isinstance(row, dict) and URL_RE.fullmatch(str(row.get('url') or ''))
            and row.get('store_location_url') == row['url']
            and row.get('store_location_source') in (PAGE, MANUAL))


def set_locations(raw, public, rows, source):
    """Replace the location atomically; never combine with unverified legacy data."""
    rows = valid_rows(rows)
    for item in (raw, public) if public is not None else (raw,):
        item['store_location_source'] = source if rows else PENDING
        item['store_location_url'] = raw.get('url')
        if rows:
            item['stores'] = copy.deepcopy(rows)
            item['store_name'] = rows[0]['name']
            prefs = {s['prefecture'] for s in rows}
            item['prefecture'] = next(iter(prefs)) if len(prefs) == 1 else ''
        else:
            for key in ('stores', 'store_name', 'prefecture'):
                item.pop(key, None)
    return rows


def sanitize_pair(raw, public=None):
    """Retain independent page facts, not a global details_source=discord tag.

    Manual CSV lists are reapplied from their approved rows by v19. Old mixed
    lists with a page label alone are deliberately not grandfathered in.
    """
    before = (raw.get('store_name'), raw.get('prefecture'), copy.deepcopy(raw.get('stores')))
    fields = raw.get('field_sources') or {}
    if not isinstance(fields, dict):
        fields = {}
    rows, source = [], PAGE
    if verified(raw):
        rows = valid_rows(raw.get('stores'))
        source = raw['store_location_source']
    else:
        name_source = str(fields.get('store_name') or '')
        manual = name_source.startswith(MANUAL_PREFIXES)
        if name_source in LEGACY_PAGE_NAMES or manual or fields.get('prefecture') == 'livepocket_exact_venue':
            name = raw.get('store_name')
            # A master lookup is usable only after the branch name itself has
            # independent page evidence; never promote a Discord shop label.
            manual_region = str(fields.get('prefecture') or '').startswith(MANUAL_PREFIXES)
            pref = raw.get('prefecture') if manual_region or fields.get('prefecture') in PAGE_REGIONS else ''
            rows = valid_rows([{'name': name, 'prefecture': pref or ''}])
            source = MANUAL if manual else PAGE
        elif str(fields.get('venue_name') or '').startswith(MANUAL_PREFIXES):
            # Previously verified event screenshots can contain a venue/address
            # without duplicating that venue into a separate store_name field.
            address = str(raw.get('venue_address') or '')
            pref = next((p for p in PREFECTURES if address.startswith(p)), '')
            rows = valid_rows([{'name': raw.get('venue_name'), 'prefecture': pref}])
            source = MANUAL
    if not rows:
        for item in (raw, public) if public is not None else (raw,):
            sources = item.get('field_sources')
            if isinstance(sources, dict):
                for key in ('store_name', 'stores', 'prefecture', 'stores_prefectures'):
                    sources.pop(key, None)
    set_locations(raw, public, rows, source)
    after = (raw.get('store_name'), raw.get('prefecture'), raw.get('stores'))
    return before != after


def sanitize_catalog(raw, public):
    pindex = {row.get('url'): row for row in public.get('items', []) if isinstance(row, dict)}
    return sum(sanitize_pair(row, pindex.get(row.get('url')))
               for row in raw.get('items', []) if isinstance(row, dict))


def recheck_candidates(raw, public, *, now, limit=8):
    """Only open events; never start crawling expired history for this migration."""
    checks = raw.get('collector_state', {}).get('official_store_checks_v1', {})
    index = {row.get('url'): row for row in raw.get('items', []) if isinstance(row, dict)}
    candidates = []
    for row in public.get('items', []):
        if row.get('manual_page_unavailable') or row.get('store_location_source') == MANUAL:
            continue
        url = row.get('url')
        source = (index.get(url, {}).get('field_sources') or {}).get('stores')
        if (verified(row) and source != 'v22_official_title_shop'
                and valid_rows(row.get('stores'))
                and all(store.get('prefecture') for store in row['stores'])):
            continue
        if not isinstance(url, str) or not URL_RE.fullmatch(url):
            continue
        try:
            end = datetime.fromisoformat(str(row.get('application_end_at') or '').replace('Z', '+00:00'))
            if end.tzinfo is None or end <= now:
                continue
            retry = checks.get(url, {}).get('next_check_at')
            if retry and datetime.fromisoformat(retry.replace('Z', '+00:00')) > now:
                continue
        except (ValueError, TypeError):
            continue
        candidates.append((end, url))
    return [url for _, url in sorted(candidates)[:max(0, min(int(limit), 12))]]
