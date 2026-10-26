import unittest
from livepocket_detail_period_batch import candidates, run

U="https://livepocket.jp/e/"
TEXT="""詳細
応募期間 2026年10月24日13:00～2026年10月26日21:45
受付・チケット情報
販売受付期間 2026年10月23日15:02～2026年10月26日21:45"""

class BatchTests(unittest.TestCase):
    def test_select_only_missing_and_unmodified(self):
        p={"items":[{"url":U+"a"},{"url":U+"b","application_end_at":"known"},
                    {"url":U+"c"},{"url":U+"d"}]}
        self.assertEqual(candidates(p,{U+"c"},8),[U+"a",U+"d"])
        self.assertEqual(candidates(p,{U+"c"},1,1),[U+"d"])

    def test_verified_date_written_once(self):
        p={"items":[{"url":U+"a"}]}
        def fetch(url):
            return {"status":"ok","final_url":url,"text":TEXT}
        self.assertEqual(run(p,set(),fetch)["updated"],1)
        self.assertEqual(p["items"][0]["application_start_at"],
                         "2026-10-24T13:00:00+09:00")
        self.assertEqual(run(p,set(),fetch)["updated"],0)

    def test_failed_page_never_updates(self):
        p={"items":[{"url":U+"a"}]}
        self.assertEqual(run(p,set(),lambda u:{"status":"browser_blocked"})["updated"],0)
        self.assertNotIn("application_end_at",p["items"][0])

if __name__=="__main__":
    unittest.main()
