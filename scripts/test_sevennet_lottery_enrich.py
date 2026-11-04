import unittest
from datetime import datetime, timezone
import sevennet_lottery_enrich as seven

URL = 'https://7net.omni7.jp/detail/2190054281.html'
PAGE = '''<html><h1>【抽選応募】ポケモンカードゲーム MEGA 拡張パック ハドウシーカー【BOX】</h1>
<p>応募期間：2026年11月4日17:00～2026年11月9日23:59</p>
<p>応募条件：2025年10月1日～2026年10月23日の購入履歴</p></html>'''


class SevennetLotteryTest(unittest.TestCase):
    def test_extracts_official_title_and_application_dates(self):
        item = seven.extract(PAGE)
        self.assertEqual(item['event_title'], '【抽選応募】ポケモンカードゲーム MEGA 拡張パック ハドウシーカー【BOX】')
        self.assertEqual(item['application_start_at'], '2026-11-04T17:00:00+09:00')
        self.assertEqual(item['application_end_at'], '2026-11-09T23:59:00+09:00')
        self.assertEqual((item['store_name'], item['prefecture']), ('セブンイレブン', '全国'))

    def test_never_confuses_other_dates_or_non_lottery(self):
        self.assertIsNone(seven.extract(PAGE.replace('応募期間：', '購入期間：')))
        self.assertIsNone(seven.extract(PAGE.replace('【抽選応募】', '【通常販売】')))
        self.assertIsNone(seven.extract(PAGE.replace('</html>', '<p>応募期間：2026年11月5日17:00～2026年11月9日23:59</p></html>')))

    def test_fetches_only_matching_unverified_urls_and_preserves_failed_data(self):
        now = datetime(2026, 11, 4, tzinfo=timezone.utc)
        data = {'items': [{'url': URL}, {'url': 'https://example.org/detail/1.html'},
                          {'url': 'https://7net.omni7.jp.evil.example/detail/1.html'}]}
        called = []
        self.assertEqual(seven.enrich(data, lambda u: called.append(u) or PAGE, now), 1)
        self.assertEqual(called, [URL])
        self.assertEqual(data['items'][0]['store_name'], 'セブンイレブン')
        self.assertEqual(seven.enrich(data, lambda u: self.fail('must not refetch verified page'), now), 0)
        failed = {'items': [{'url': URL, 'event_title': '既存の情報'}]}
        seven.enrich(failed, lambda u: (_ for _ in ()).throw(OSError('offline')), now)
        self.assertEqual(failed['items'][0]['event_title'], '既存の情報')
        self.assertNotIn('sevennet_verified_at', failed['items'][0])
        self.assertEqual(seven.enrich(failed, lambda u: self.fail('retry too soon'), now), 0)


if __name__ == '__main__': unittest.main()
