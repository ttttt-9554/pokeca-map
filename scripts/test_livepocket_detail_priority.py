import unittest
from livepocket_v13 import extract_deadline


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

    def test_fallback_ticket_when_no_detail_signup(self):
        body="""詳細
商品の案内です。
受付・チケット情報
抽選受付期間 2026年10月23日15:02～2026年10月26日21:45"""
        start,end=extract_deadline(body)
        self.assertEqual(end.strftime("%Y-%m-%d %H:%M"),"2026-10-26 21:45")

if __name__=="__main__":
    unittest.main()
