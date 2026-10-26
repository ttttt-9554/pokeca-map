import unittest
from livepocket_detail_period_publish import apply

URL="https://livepocket.jp/e/qg3as"
TEXT="""詳細
○応募期間 2026年10月24日13:00～2026年10月26日21:45
受付・チケット情報
販売受付期間 2026年10月23日15:02～2026年10月26日21:45"""

class PublishTests(unittest.TestCase):
    def test_exact_and_idempotent(self):
        public={"items":[{"url":URL}]}
        self.assertEqual(apply(public,URL,TEXT,set()),1)
        self.assertEqual(public["items"][0]["application_start_at"],"2026-10-24T13:00:00+09:00")
        self.assertEqual(apply(public,URL,TEXT,set()),0)
    def test_manual_override_protected(self):
        public={"items":[{"url":URL}]}
        self.assertEqual(apply(public,URL,TEXT,{URL}),0)
        self.assertNotIn("application_end_at",public["items"][0])
    def test_existing_period_protected(self):
        public={"items":[{"url":URL,"application_start_at":"2026-10-23T15:02:00+09:00"}]}
        self.assertEqual(apply(public,URL,TEXT,set()),0)
    def test_other_url_protected(self):
        public={"items":[{"url":"https://livepocket.jp/e/other"}]}
        self.assertEqual(apply(public,URL,TEXT,set()),0)

if __name__=="__main__":
    unittest.main()
