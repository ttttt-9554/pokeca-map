import unittest
from livepocket_v13 import extract_deadline, detail_signup_period


class DetailPriorityTests(unittest.TestCase):
    def test_detail_precedes_serial_ticket_period(self):
        body = """イベント概要
詳細
○応募期間 2026年10月24日13:00～2026年10月26日21:45
○当選発表 2026年10月28日13:00
受付・チケット情報
シリアルコードチケット
販売受付期間：2026年10月23日15:02～2026年10月26日21:45
"""
        start,end=extract_deadline(body)
        self.assertEqual(start.strftime("%Y-%m-%d %H:%M"),"2026-10-24 13:00")
        self.assertEqual(end.strftime("%Y-%m-%d %H:%M"),"2026-10-26 21:45")

    def test_ticket_before_details_still_prefers_details(self):
        body = """受付・チケット情報
販売受付期間 2026年10月23日15:02～2026年10月26日21:45
詳細
○応募期間 2026年10月24日13:00～2026年10月26日21:45
○当選発表 2026年10月28日13:00
"""
        start,end=extract_deadline(body)
        self.assertEqual(start.strftime("%Y-%m-%d %H:%M"),"2026-10-24 13:00")
        self.assertEqual(end.strftime("%Y-%m-%d %H:%M"),"2026-10-26 21:45")

    def test_ticket_start_time_must_match_detail_dates(self):
        details = "詳細\n〇応募期間:2026年11月6日(金) ～ 11月9日(\ufeff月)21：00まで\n"
        cases = (
            ("2026年11月6日(金) 00:00\n〜2026年11月9日(月) 21:00", "2026-11-06T00:00:00+09:00"),
            ("2026年11月5日(木) 00:00〜2026年11月9日(月) 21:00", None),
            ("2026年11月6日(金) 00:00〜2026年11月9日(月) 20:00", None),
            ("2026年11月6日(金)〜2026年11月9日(月) 21:00", None),
        )
        for period, expected_start in cases:
            with self.subTest(period=period):
                body = details + "受付・チケット情報\n販売受付期間\n" + period
                start, end = extract_deadline(body)
                self.assertEqual(start.isoformat() if start else None, expected_start)
                self.assertEqual(end.isoformat(), "2026-11-09T21:00:00+09:00")

    def test_conflicting_ticket_start_times_do_not_fill_missing_time(self):
        body = """詳細
応募期間 2026年11月6日〜11月9日21:00
受付・チケット情報
販売受付期間 2026年11月6日00:00〜2026年11月9日21:00
販売受付期間 2026年11月6日01:00〜2026年11月9日21:00
"""
        start, end = extract_deadline(body)
        self.assertIsNone(start)
        self.assertEqual(end.isoformat(), "2026-11-09T21:00:00+09:00")

    def test_detail_without_period_does_not_consume_other_section(self):
        body = """詳細
商品の説明のみ
注意事項
応募期間 2026年10月24日13:00～2026年10月26日21:45
受付・チケット情報
抽選受付期間 2026年10月23日15:02～2026年10月26日21:45"""
        start,end=extract_deadline(body)
        # Other sections cannot masquerade as details. The full-page
        # fallback remains conservative when multiple starts conflict.
        self.assertIsNone(detail_signup_period(body))
        self.assertIsNone(start)
        self.assertIsNone(end)

    def test_reception_period_in_details_precedes_ticket_sale(self):
        body="""概要
詳細
応募受付期間 2026年10月24日13:00～2026年10月26日21:45
受付・チケット情報
販売受付期間 2026年10月23日15:02～2026年10月26日21:45"""
        start,end=extract_deadline(body)
        self.assertEqual(start.strftime("%Y-%m-%d %H:%M"),"2026-10-24 13:00")
        self.assertEqual(end.strftime("%Y-%m-%d %H:%M"),"2026-10-26 21:45")

    def test_fullwidth_space_headings_protect_detail_priority(self):
        body="""　詳細　
申込受付期間 2026年10月24日13:00～2026年10月26日21:45
　受付・チケット情報　
販売受付期間 2026年10月23日15:02～2026年10月26日21:45"""
        start,end=extract_deadline(body)
        self.assertEqual(start.strftime("%Y-%m-%d %H:%M"),"2026-10-24 13:00")
        self.assertEqual(end.strftime("%Y-%m-%d %H:%M"),"2026-10-26 21:45")

    def test_conflicting_reception_periods_in_details_are_rejected(self):
        body="""詳細
応募受付期間 2026年10月24日13:00～2026年10月26日21:45
申込受付期間 2026年10月24日13:00～2026年10月27日21:45
受付・チケット情報
販売受付期間 2026年10月23日15:02～2026年10月26日21:45"""
        self.assertEqual(extract_deadline(body),(None,None))

    def test_fallback_ticket_when_no_detail_signup(self):
        body="""詳細
商品の案内です。
受付・チケット情報
抽選受付期間 2026年10月23日15:02～2026年10月26日21:45"""
        start,end=extract_deadline(body)
        self.assertEqual(end.strftime("%Y-%m-%d %H:%M"),"2026-10-26 21:45")

if __name__=="__main__":
    unittest.main()
