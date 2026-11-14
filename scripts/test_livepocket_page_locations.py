"""Event overview locations, source priority and collector continuity."""
import copy
from datetime import timedelta
import unittest
from unittest.mock import patch

import livepocket_v21 as v21
import livepocket_individual_fetch as individual
from livepocket_page_locations import overview_from_html, observation_from_html
from livepocket_store_policy import PAGE, MANUAL, set_locations, recheck_candidates
from test_livepocket_site_stores import URL, NOW, pair
import livepocket_yellow_submarine as yellow


def html(venue='TSUTAYA宇都宮テクノ店トレカ売場', prefecture='栃木県', seller='うさぎや株式会社'):
    block = f'''<div class="event-detail-info__block">
      <dt><span class="event-detail-info__place">会場</span></dt>
      <dd class="event-detail-info__data"><a>{venue}</a> <span>({prefecture})</span>
        <span>宇都宮市ゆいの杜 4-1-39</span>
        <div class="event-detail-info__link-box"><a href="/e/sample/map">会場マップ・アクセス方法はこちら</a></div>
      </dd></div>
      <div class="event-detail-info__block"><dt>販売元</dt><dd><a>{seller}</a></dd></div>'''
    return f'''<h1>【宇都宮テクノ店】ワンピースカード「HEROINES PRECIOUS BOX」抽選販売受付</h1>
      <h2>概要</h2><dl>{block}</dl><dl>{block}</dl>
      <h2>詳細</h2><p>ワンピースカード抽選販売</p>
      <h2>受付・チケット情報</h2><h2>お問い合わせ</h2>'''


class PageLocationTests(unittest.TestCase):
    def observation(self, document=None):
        page = observation_from_html(document or html(), URL)
        page = v21.normalize_event_title_observation(page, URL)
        return v21.quarantine_unconfirmed_event(page, URL)

    def test_nested_branch_name_is_not_company_address_or_map_label(self):
        value = overview_from_html(html())
        self.assertEqual(value, {
            'overview_venue': 'TSUTAYA宇都宮テクノ店トレカ売場 (栃木県)',
            'overview_seller': 'うさぎや株式会社',
            'overview_address': '宇都宮市ゆいの杜 4-1-39'})
        fields = individual.extract(v21, URL, self.observation())['fields']
        self.assertEqual(fields['stores'], [{'name': 'TSUTAYA宇都宮テクノ店トレカ売場', 'prefecture': '栃木県'}])

    def test_structured_browser_html_supports_wrapped_name_and_address(self):
        class Locator:
            def evaluate_all(self, _): return []
        class Page:
            def locator(self, _): return Locator()
            def content(self): return html().replace('<a>TSUTAYA宇都宮テクノ店トレカ売場</a>',
                '<div><span>TSUTAYA宇都宮テクノ店トレカ売場</span></div>')
        value = v21.overview_observation(Page(), {})
        self.assertEqual(value['overview_venue'], 'TSUTAYA宇都宮テクノ店トレカ売場 (栃木県)')

    def test_disagreeing_desktop_mobile_venues_are_not_chosen_arbitrarily(self):
        document = html() + html(venue='別店舗', prefecture='東京都')
        self.assertEqual(overview_from_html(document)['overview_venue'], '')
        self.assertNotIn('stores', individual.extract(v21, URL, self.observation(document))['fields'])

    def test_complete_venue_survives_next_collection_with_shorter_cached_title(self):
        raw, public = pair()
        for row in (raw['items'][0], public['items'][0]):
            row['event_title'] = '【宇都宮テクノ店】ワンピースカード抽選販売'
        raw['items'][0]['field_sources']['event_title'] = 'v14_livepocket_page_title'
        v21.v19.apply_stores(raw, public, {URL: self.observation()})
        expected = copy.deepcopy(public['items'][0]['stores'])
        v21.v19.apply_stores(raw, public)
        self.assertEqual(public['items'][0]['stores'], expected)
        self.assertEqual(expected[0]['name'], 'TSUTAYA宇都宮テクノ店トレカ売場')

    def test_in_store_floor_and_register_is_a_branch_not_company(self):
        page = self.observation(html(venue='TSUTAYA東仙台店 ２階TSUTAYAレジ',
                                     prefecture='宮城県', seller='TSUTAYA東仙台店'))
        fields = individual.extract(v21, URL, page)['fields']
        self.assertEqual(fields['stores'], [{'name': 'TSUTAYA東仙台店 ２階TSUTAYAレジ', 'prefecture': '宮城県'}])

    def test_official_venue_with_floor_or_internal_shop_word_keeps_full_name(self):
        for name, seller, title in (
            ('カードキングダム秋葉原駅前店4階', 'カードキングダム 秋葉原駅前店', 'ワンピースカード抽選販売'),
            ('アゾンレーベルショップ池袋', '株式会社アゾンインターナショナル', 'ドール抽選予約販売'),
        ):
            page = self.observation(html(venue=name, prefecture='東京都', seller=seller))
            page['titles'] = [title]
            fields = individual.extract(v21, URL, page)['fields']
            self.assertEqual(fields['stores'], [{'name': name, 'prefecture': '東京都'}])

    def test_exact_branch_region_is_enriched_without_spreading_it_to_other_shops(self):
        page = self.observation(html(venue='キデイランド吉祥寺店', prefecture='東京都'))
        page['text'] += '\n対象店舗\nキデイランド吉祥寺店\n別の名古屋店\n応募期間\n'
        stores, _ = v21.v19.observation_stores(page)
        self.assertEqual(stores, [{'name': 'キデイランド吉祥寺店', 'prefecture': '東京都'},
                                  {'name': '別の名古屋店', 'prefecture': ''}])

    def test_lottery_sales_store_heading_accepts_shop_branches_without_store_suffix(self):
        body = '【抽選販売実施店舗】\nHMVトレカショップ新宿\nHMVららぽーと豊洲\n【応募期間】\n2026年11月1日～11月5日'
        self.assertEqual(v21.v19.page_stores(body), [
            {'name': 'HMVトレカショップ新宿', 'prefecture': ''},
            {'name': 'HMVららぽーと豊洲', 'prefecture': ''}])

    def test_quoted_sales_store_matches_official_venue_in_both_fetch_paths(self):
        name = 'TSUTAYA調布駅南口店'
        for left, right in (('[', ']'), ('［', '］'), ('【', '】'), ('「', '」'), ('『', '』')):
            with self.subTest(left=left):
                document = html(venue=name, prefecture='東京都', seller=name)
                document += f'<p>販売店舗：{left}{name}{right}</p>'
                page = self.observation(document)
                expected = [{'name': name, 'prefecture': '東京都'}]
                self.assertEqual(individual.extract(v21, URL, page)['fields']['stores'], expected)
                raw, public = pair()
                v21.v19.apply_stores(raw, public, {URL: page})
                v21.v19.apply_stores(raw, public)
                self.assertEqual(public['items'][0]['stores'], expected)

    def test_quoted_store_list_only_receives_matching_venue_region(self):
        page = self.observation(html(venue='TSUTAYA調布駅南口店', prefecture='東京都'))
        page['text'] += '\n販売店舗：［TSUTAYA調布駅南口店］／［TSUTAYA別店舗］\n'
        self.assertEqual(v21.v19.observation_stores(page)[0], [
            {'name': 'TSUTAYA調布駅南口店', 'prefecture': '東京都'},
            {'name': 'TSUTAYA別店舗', 'prefecture': ''}])

    def test_label_quotes_preserve_explicit_regions_and_internal_name_brackets(self):
        self.assertEqual(v21.v19.store_part('［TSUTAYA調布駅南口店（東京都）］'),
                         {'name': 'TSUTAYA調布駅南口店', 'prefecture': '東京都'})
        self.assertEqual(v21.v19.store_part('[TSUTAYA調布駅南口店]（東京都）'),
                         {'name': 'TSUTAYA調布駅南口店', 'prefecture': '東京都'})
        self.assertEqual(v21.v19.safe_name('SHOP[本館]店'), 'SHOP[本館]店')
        self.assertEqual(v21.v19.unwrap_store_label('[A店][B店]'), '[A店][B店]')
        self.assertIsNone(v21.v19.safe_name('［］'))

    def test_stale_region_reference_cannot_abort_or_recreate_discord_shop(self):
        raw, public = pair()
        result = v21.process(raw, public, lambda _: self.observation(), catalog={}, now=NOW,
            new_limit=0, background_limit=0, retry_limit=0, title_limit=0,
            verified={'products': {}, 'prefectures': {URL: {'古いDiscordの店舗': '大阪府'}}},
            v19_verified={}, verified_titles={}, verified_unavailable={}, location_limit=1)
        self.assertEqual(result[-1]['verified_prefectures_waiting_for_store'], 1)
        self.assertEqual(result[1]['items'][0]['stores'][0]['name'], 'TSUTAYA宇都宮テクノ店トレカ売場')

    def test_known_short_titles_and_missing_regions_are_rechecked_but_manual_rows_are_kept(self):
        raw, public = pair(4)
        for r, p in zip(raw['items'], public['items']):
            set_locations(r, p, [{'name': '店舗A店', 'prefecture': '東京都'}], PAGE)
        raw['items'][0]['field_sources']['stores'] = 'v22_official_title_shop'
        raw['items'][1]['stores'][0]['prefecture'] = public['items'][1]['stores'][0]['prefecture'] = ''
        raw['items'][2]['store_location_source'] = public['items'][2]['store_location_source'] = MANUAL
        urls = recheck_candidates(raw, public, now=NOW, limit=8)
        self.assertEqual(set(urls), {raw['items'][0]['url'], raw['items'][1]['url']})
        for row in public['items']:
            row['application_end_at'] = (NOW - timedelta(days=1)).isoformat()
        self.assertEqual(recheck_candidates(raw, public, now=NOW), [])

    def test_online_draw_uses_shop_brand_with_nationwide_scope(self):
        page = self.observation()
        page.update(overview_venue='ECサイト上 (東京都)', overview_seller='NexusTradingCards',
                    titles=['ポケモンカード BOX 購入権抽選'], title_sources=['h1'],
                    text='概要\n会場\nECサイト上 (東京都)\n詳細\n送料：無料（日本国内）。商品の発送を行います。')
        shops, _ = v21.v19.observation_stores(page)
        self.assertEqual(shops, [{'name': 'NexusTradingCards', 'prefecture': '全国'}])
        raw, public = pair()
        v21.v19.apply_stores(raw, public, {URL: page})
        v21.v19.apply_stores(raw, public)
        self.assertEqual(public['items'][0]['stores'], shops)
        page['overview_venue'] = '実店舗店 (東京都)'
        self.assertIsNone(v21.v19.online_store(page))
        page['overview_venue'] = 'オンライン'
        page['overview_seller'] = '運営会社株式会社'
        self.assertIsNone(v21.v19.online_store(page))

    def test_named_online_title_does_not_turn_corporate_seller_into_branch(self):
        page = self.observation()
        page.update(overview_venue='オンライン', overview_seller='株式会社晴れる屋',
                    titles=['ハレツー通販 ポケモンカード拡張パック購入権'],
                    title_sources=['h1'], text='詳細\n商品は発送。店頭受け取りはご利用いただけません。')
        self.assertEqual(v21.v19.online_store(page), {'name': 'ハレツー通販', 'prefecture': '全国'})

    def test_chain_list_requires_explicit_participation_on_the_event_page(self):
        page = self.observation()
        page.update(overview_venue='イエローサブマリン (その他)', overview_seller='イエローサブマリン')
        with patch.object(yellow, 'load_preset') as load:
            self.assertEqual(yellow.page_chain_stores(page), [])
            load.assert_not_called()
        page['text'] = 'イエローサブマリンの取扱店舗全店統一での抽選のため、店舗のエリアがその他と表記されます。'
        self.assertEqual(len(yellow.page_chain_stores(page)), 22)
        page['text'] = page['text'].replace('の取扱', 'のポケカ取扱')
        self.assertEqual(len(yellow.page_chain_stores(page)), 22)
        page['text'] += '\n対象外店舗があります。'
        self.assertEqual(yellow.page_chain_stores(page), [])

    def test_online_registration_for_in_store_pickup_is_not_nationwide(self):
        page = self.observation()
        page.update(overview_venue='オンライン', overview_seller='サンプルショップ',
                    text='商品の発送は行いません。店頭受け取りのみです。')
        self.assertIsNone(v21.v19.online_store(page))


if __name__ == '__main__':
    unittest.main()
