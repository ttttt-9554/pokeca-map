#!/usr/bin/env python3
"""Read-only, no-follow smoke probe for developer-only retailer monitoring.

GitHub and Supabase compare the EXACT same Pokemon category, User-Agent and
Accept headers. Do not enter a queue, follow redirects, persist cookies,
use credentials, or increase the number of first-page requests.
"""
from __future__ import annotations
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guerrilla_sale_monitor as monitor

POKEMON_TEST_URL = (
    'https://www.pokemoncenter-online.com/pokemon-card-game/'
    'booster-packs/?inStock=1&srule=top-new-product'
)
POKEMON_UA = 'TorecaRadarFastMonitor/1.0'


def probe(site):
    if site == 'pokemon':
        # Official retailer explicitly prohibits automated stock retrieval and
        # crawling; no network probe to this domain without authorization.
        return {'site': site,'status': 'paused',
                'reason': 'official_terms_automated_access_not_permitted'}
    # The same HTTP request method / header values as the Supabase monitor.
    # Both environments independently honor robots.txt and refuse redirects.
    client = (monitor.StoreClient(user_agent=POKEMON_UA, accept='text/html')
              if site == 'pokemon' else monitor.StoreClient())
    url = POKEMON_TEST_URL if site == 'pokemon' else monitor.catalog_url(site, 1)
    try:
        html = client.get(url, site)
        rows, total, next_links = monitor.parse_catalog(html, site, url)
        statuses = Counter(row.get('status', 'unknown') for row in rows)
        sample = [
            {'product': row.get('product', '')[:120],
             'status': row.get('status'), 'url': row.get('url')}
            for row in rows[:3]
        ]
        return {
            'site': site, 'status': 'ok', 'catalog_url': url,
            'http_diagnostic': client.last_http,
            'products_found': len(rows), 'reported_total': total,
            'next_links': len(next_links),
            'statuses': dict(statuses), 'sample': sample
        }
    except monitor.CheckError as exc:
        return {
            'site': site, 'status': 'blocked_or_unverified',
            'reason': exc.code, 'catalog_url': url,
            'http_diagnostic': client.last_http
        }
    except Exception as exc:
        return {
            'site': site, 'status': 'probe_error',
            'reason': type(exc).__name__, 'catalog_url': url
        }


def main():
    results = [probe(site) for site in ('pokemon', 'amenity')]
    print('GUERRILLA_SALE_PROBE_BEGIN')
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print('GUERRILLA_SALE_PROBE_END')
    # Retailer blocks never mean the deployment failed. No alert side effects.
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
