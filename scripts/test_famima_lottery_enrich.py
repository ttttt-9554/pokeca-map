import unittest
from datetime import datetime, timezone
import famima_lottery_enrich as famima

URL = 'https://famima-online.family.co.jp/item?itemCode=100163657179608640'
PAGE = '''<html><title>【抽選商品】ポケモンカードゲーム MEGA 拡張パック 「ハドウシーカー」 | ファミマオンライン</title>
<li>予約開始日：2026/11/04(水) 10:00
予約終了日：2026/11/09(月) 23:59
キャンセル可能期限：2026/11/09(月) 23:59
お受け取り期間：2026/12/11(金) ～12/24(木)
抽選発表日：2026/11/11(水)</li></html>'''


class FamimaLotteryTest(unittest.TestCase):
    def test_extracts_reservation_as_application_period(self):
        data = famima.extract(PAGE)
        self.assertEqual(data['event_title'], '【抽選商品】ポケモンカードゲーム MEGA 拡張パック 「ハドウシーカー」')
        self.assertEqual(data['application_start_at'], '2026-11-04T10:00:00+09:00')
        self.assertEqual(data['application_end_at'], '2026-11-09T23:59:00+09:00')
        self.assertEqual((data['store_name'], data['prefecture']), ('ファミリーマート', '全国'))

    def test_missing_ambiguous_and_non_lottery_are_rejected(self):
        self.assertIsNone(famima.extract(PAGE.replace('予約終了日', '期限')))
        self.assertIsNone(famima.extract(PAGE.replace('【抽選商品】', '【通常販売】')))
        self.assertIsNone(famima.extract(PAGE.replace('</li>', '予約終了日：2026/11/10(火) 23:59</li>')))
        self.assertIsNone(famima.extract('<title>ファミマオンライン</title>'))

    def test_checks_only_expected_domain_and_preserves_failed_records(self):
        now = datetime(2026, 11, 4, tzinfo=timezone.utc)
        data = {'items': [{'url': URL}, {'url': 'https://famima-online.family.co.jp.evil.example/item?itemCode=100163657179608640'},
                          {'url': 'https://famima-online.family.co.jp/item?itemCode=not-valid'}]}
        calls = []
        self.assertEqual(famima.enrich(data, lambda code: calls.append(code) or PAGE, now), 1)
        self.assertEqual(calls, ['100163657179608640'])
        self.assertEqual(data['items'][0]['store_name'], 'ファミリーマート')
        self.assertEqual(famima.enrich(data, lambda _: self.fail('already verified'), now), 0)
        failed = {'items': [{'url': URL, 'event_title': '保存済み'}]}
        famima.enrich(failed, lambda _: (_ for _ in ()).throw(OSError('offline')), now)
        self.assertEqual(failed['items'][0]['event_title'], '保存済み')
        self.assertNotIn('famima_verified_at', failed['items'][0])
        self.assertEqual(famima.enrich(failed, lambda _: self.fail('retry too soon'), now), 0)


if __name__ == '__main__': unittest.main()
