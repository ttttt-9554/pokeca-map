"""Unquoted branch names in real LivePocket purchase-ticket headings."""
from pathlib import Path
import unittest

import livepocket_v19 as stores
import livepocket_v21 as collector
import livepocket_individual_fetch as individual
from test_livepocket_individual_fetch import URL, NOW, pair, page


# Public ticket-section text captured from /e/wfku9 on 2026-11-18.
TICKETS = Path(__file__).with_name('fixtures').joinpath('livepocket_wfku9_tickets.txt').read_text()
BRANCHES = ('秋葉原タワー 仙台 郡山 大宮 立川 池袋 高田馬場 大須 なんば 京都 '
            '三宮 福岡 岡山 水戸 四日市 金沢 静岡 千葉').split()
EXPECTED = [{'name': '晴れる屋2' + branch + '店', 'prefecture': ''} for branch in BRANCHES]


class TicketStoreTests(unittest.TestCase):
    def test_actual_unquoted_ticket_names_in_individual_and_scheduled_fetches(self):
        observation = page(text='概要\n晴れる屋２各店 (全国各地)\n詳細\n' + TICKETS)
        observation['overview_venue'] = '晴れる屋２各店 (全国各地)'
        fields = individual.extract(collector, URL, observation)['fields']
        raw, public = pair(pending=True)
        raw, public, *_ = collector.process(
            raw, public, lambda _: observation, catalog={}, now=NOW,
            new_limit=1, background_limit=0, retry_limit=0, title_limit=0,
            verified={}, v19_verified={}, verified_titles={}, verified_unavailable={})
        for row in (fields, raw['items'][0], public['items'][0]):
            self.assertEqual(row['stores'], EXPECTED)
            self.assertEqual(row['application_start_at'], '2026-11-18T16:15:00+09:00')
            self.assertEqual(row['application_end_at'], '2026-11-23T23:59:00+09:00')

    def test_repeated_cards_do_not_exceed_distinct_store_limit(self):
        self.assertEqual(stores.page_stores(TICKETS + '\n' + TICKETS), EXPECTED)

    def test_names_in_prose_or_related_events_are_not_ticket_choices(self):
        cards = '\n'.join(name['name'] + ' ポケモンカードゲーム BOX購入権\n販売中\n¥0'
                          for name in EXPECTED[:2])
        self.assertEqual(stores.page_stores(cards + '\n受付・チケット情報'), [])
        self.assertEqual(stores.page_stores('受付・チケット情報\n関連イベント\n' + cards), [])
        self.assertEqual(stores.page_stores('受付・チケット情報\nお問い合わせ\n' + cards), [])

    def test_product_and_card_markers_and_multiple_branches_are_required(self):
        self.assertEqual(stores.page_stores(TICKETS.replace('販売中', '').replace('分配不可', '').replace('¥0(税込)', '')), [])
        self.assertEqual(stores.page_stores(TICKETS.replace('ポケモンカードゲーム【MEGA】拡張パック ハドウシーカー BOX 購入権', 'へのアクセス案内')), [])
        self.assertEqual(stores.page_stores('受付・チケット情報\n晴れる屋2各店 ポケモンカードゲーム\n販売中\n¥0\n'
                                           '別チェーン全店 ポケモンカードゲーム\n販売中\n¥0'), [])
        self.assertEqual(stores.page_stores('受付・チケット情報\n晴れる屋2仙台店 ポケモンカードゲーム\n販売中\n¥0'), [])

    def test_wrong_event_and_access_gate_still_produce_no_fields(self):
        observation = page(text=TICKETS)
        observation['final_url'] = URL + 'other'
        self.assertEqual(individual.extract(collector, URL, observation)['fields'], {})
        observation = page(text="Verify that you're not a robot\n" + TICKETS)
        self.assertEqual(individual.extract(collector, URL, observation)['fields'], {})


if __name__ == '__main__':
    unittest.main()
