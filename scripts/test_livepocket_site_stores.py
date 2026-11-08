"""All tests are offline: Discord labels cannot become LivePocket locations."""
import copy
import unittest
from datetime import datetime, timedelta, timezone
import livepocket_collect as collect
import livepocket_v7 as v7
import livepocket_v8 as v8
import livepocket_v19 as v19
import livepocket_v21 as v21
import livepocket_store_policy as policy

URL = 'https://livepocket.jp/e/site123'
NOW = datetime(2026, 11, 8, 6, tzinfo=timezone.utc)
WRONG = {'name': 'Discordの別店舗', 'prefecture': '大阪府'}
SHOPS = [{'name': '公式渋谷店', 'prefecture': '東京都'}, {'name': '公式横浜店', 'prefecture': '神奈川県'}]
BODY = '概要\nポケモンカード抽選販売\n詳細\n対象店舗\n公式渋谷店（東京都）\n公式横浜店（神奈川県）\n受付・チケット情報\nお問い合わせ'


def pair(count=1):
    rows = [{'url': URL if i == 0 else f'https://livepocket.jp/e/site{i:03d}',
             'store_name': WRONG['name'], 'prefecture': WRONG['prefecture'], 'stores': [dict(WRONG)],
             'details_source': 'discord_post',
             'application_end_at': (NOW + timedelta(days=1)).isoformat(),
             'post_excerpt': '対象店舗：Discordの別店舗（大阪府）',
             'field_sources': {'stores': 'v19_discord_single_event_store_list'}} for i in range(count)]
    return {'items': copy.deepcopy(rows)}, {'items': copy.deepcopy(rows)}


def page(url=URL):
    return {'status': 'ok', 'final_url': url, 'text': BODY,
            'titles': ['ポケモンカード抽選販売'], 'title_sources': ['h1']}


class SiteStorePolicyTests(unittest.TestCase):
    def test_collector_keeps_urls_products_and_ignores_location_labels(self):
        message = {'id': 'test', 'content': f'📍大阪府\nDiscordの別店舗\n{URL}\n店舗名：偽物店\n都道府県：大阪府'}
        items = {}
        self.assertEqual(collect.merge_message(items, message, 'test', catalog={}), 1)
        self.assertFalse(items[URL].get('store_name'))
        self.assertFalse(items[URL].get('prefecture'))

    def test_embed_and_legacy_heading_cannot_restore_discord_locations(self):
        url, fields = v8.discord_candidates({'url': URL, 'fields': [
            {'name': '店舗名', 'value': 'Discordの別店舗'}, {'name': '都道府県', 'value': '大阪府'}]})
        self.assertEqual(url, URL)
        self.assertNotIn('store_name', fields)
        self.assertNotIn('prefecture', fields)
        data = {URL: {'url': URL}}
        v8.apply_candidates(data, {URL: {'store_name': '別店舗', 'prefecture': '大阪府'}}, 'discord_embed:test', {})
        self.assertNotIn('store_name', data[URL])
        raw, _ = pair()
        enriched, _ = v7.enrich(raw)
        self.assertFalse(enriched['items'][0].get('store_name'))
        self.assertIsNone(v21.shop_from_exact_discord_url(f'📍大阪府\n別店舗\n受付中\n{URL}', URL))

    def test_page_list_replaces_discord_name_region_and_old_stores(self):
        raw, public = pair()
        v19.apply_stores(raw, public, {URL: page()})
        for row in (raw['items'][0], public['items'][0]):
            self.assertEqual(row['stores'], SHOPS)
            self.assertNotIn(WRONG, row['stores'])
            self.assertTrue(policy.verified(row))
        # Global product/title provenance may still be Discord; it is not the location source.
        self.assertEqual(raw['items'][0]['details_source'], 'discord_post')
        policy.sanitize_catalog(raw, public)
        self.assertEqual(raw['items'][0]['stores'], SHOPS)

    def test_failed_or_wrong_page_never_falls_back_to_discord(self):
        for result in ({'status': 'browser_blocked'}, page('https://livepocket.jp/e/other123')):
            raw, public = pair()
            v19.apply_stores(raw, public, {URL: result})
            self.assertFalse(public['items'][0].get('stores'))
            self.assertFalse(public['items'][0].get('prefecture'))
        raw, public = pair()
        policy.set_locations(raw['items'][0], public['items'][0], SHOPS, policy.PAGE)
        v19.apply_stores(raw, public, {URL: {'status': 'browser_blocked'}})
        self.assertEqual(public['items'][0]['stores'], SHOPS)

    def test_old_mixed_lists_need_reverification_and_csv_is_preserved(self):
        raw, public = pair()
        raw['items'][0]['field_sources']['stores'] = 'v19_livepocket_explicit_store_list'
        v19.apply_stores(raw, public)
        self.assertFalse(public['items'][0].get('stores'))
        v19.apply_stores(raw, public, manual={URL: SHOPS})
        self.assertEqual(public['items'][0]['stores'], SHOPS)
        self.assertEqual(public['items'][0]['store_location_source'], policy.MANUAL)

    def test_independent_legacy_page_name_does_not_inherit_discord_prefecture(self):
        raw, public = pair()
        raw['items'][0]['store_name'] = '公式渋谷店'
        raw['items'][0]['field_sources']['store_name'] = 'v15_page_store_label'
        policy.sanitize_catalog(raw, public)
        self.assertEqual(public['items'][0]['stores'], [{'name': '公式渋谷店', 'prefecture': ''}])

    def test_verified_fact_cannot_be_copied_between_event_urls(self):
        raw, public = pair()
        policy.set_locations(raw['items'][0], public['items'][0], SHOPS, policy.PAGE)
        raw['items'][0]['url'] = public['items'][0]['url'] = 'https://livepocket.jp/e/other123'
        policy.sanitize_catalog(raw, public)
        self.assertFalse(public['items'][0].get('stores'))

    def test_current_event_migration_is_bounded_and_skips_expired_history(self):
        raw, public = pair(4)
        for rows in (raw['items'], public['items']):
            rows[-1]['application_end_at'] = (NOW - timedelta(days=1)).isoformat()
        calls = []
        result = v21.process(raw, public, lambda url: calls.append(url) or page(url), catalog=[], now=NOW,
            new_limit=0, background_limit=0, retry_limit=0, title_limit=0, verified={}, v19_verified={},
            verified_titles={}, verified_unavailable={}, location_limit=2)
        self.assertEqual(len(calls), 2)
        self.assertNotIn(public['items'][-1]['url'], calls)
        for row in result[1]['items']:
            self.assertEqual(bool(row.get('stores')), row['url'] in calls)

    def test_location_migration_obeys_global_access_cooldown(self):
        raw, public = pair(3)
        calls = []
        result = v21.process(raw, public, lambda url: calls.append(url) or {'status': 'browser_blocked'},
            catalog=[], now=NOW, new_limit=0, background_limit=0, retry_limit=0, title_limit=0,
            verified={}, v19_verified={}, verified_titles={}, verified_unavailable={}, location_limit=3)
        self.assertEqual(len(calls), 1)
        self.assertTrue(v21.v14._cooldown_active(result[0]['collector_state']['v14'], NOW))
        self.assertTrue(all(not row.get('stores') for row in result[1]['items']))

    def test_location_network_error_is_a_retry_not_a_failed_collection(self):
        raw, public = pair()
        def offline(_):
            raise OSError('offline')
        result = v21.process(raw, public, offline, catalog=[], now=NOW,
            new_limit=0, background_limit=0, retry_limit=0, title_limit=0, verified={}, v19_verified={},
            verified_titles={}, verified_unavailable={}, location_limit=1)
        self.assertFalse(result[1]['items'][0].get('stores'))
        self.assertEqual(policy.recheck_candidates(result[0], result[1], now=NOW, limit=3), [])


if __name__ == '__main__':
    unittest.main()
