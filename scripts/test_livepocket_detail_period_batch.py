import unittest
from datetime import datetime, timedelta, timezone
from livepocket_detail_period_batch import candidates, run

U="https://livepocket.jp/e/test_"
TEXT="""詳細
応募期間 2099年10月24日13:00～2099年10月26日21:45
受付・チケット情報
販売受付期間 2099年10月23日15:02～2099年10月26日21:45"""

class BatchTests(unittest.TestCase):
    def test_select_only_missing_and_unmodified(self):
        p={"items":[{"url":U+"a"},{"url":U+"b","application_end_at":"known"},
                    {"url":U+"c"},{"url":U+"d"}]}
        self.assertEqual(candidates(p,{U+"c"},8),[U+"a",U+"d"])
        self.assertEqual(candidates(p,{U+"c"},1,1),[U+"d"])

    def test_older_discord_listing_is_skipped(self):
        now=datetime.now(timezone.utc)
        old=(now-timedelta(days=30)).isoformat()
        recent=(now-timedelta(days=1)).isoformat()
        p={"items":[{"url":U+"old","discord_posted_at":old},
                    {"url":U+"recent","discord_posted_at":recent}]}
        self.assertEqual(candidates(p,set(),5,now=now),[U+"recent"])

    def test_newest_posted_event_is_first(self):
        now=datetime.now(timezone.utc)
        earlier=(now-timedelta(days=3)).isoformat()
        later=(now-timedelta(hours=1)).isoformat()
        public={"items":[
            {"url":U+"alpha","discord_posted_at":earlier},
            {"url":U+"zeta","discord_posted_at":later},
            {"url":U+"unknown"}]}
        self.assertEqual(candidates(public,set(),3,now=now),
                         [U+"zeta",U+"alpha",U+"unknown"])

    def test_duplicate_identifiers_do_not_consume_browser_checks(self):
        public={"items":[{"url":U+"dup"},{"url":U+"dup"},{"url":U+"ok"}]}
        raw={"items":[{"url":U+"dup"},{"url":U+"ok"}]}
        visited=[]
        def fetch(url):
            visited.append(url)
            return {"status":"browser_blocked"}
        result=run(public,set(),fetch,raw=raw)
        self.assertEqual(visited,[U+"ok"])
        self.assertEqual(result["checked"],1)

    def test_duplicate_raw_identifiers_are_excluded(self):
        public={"items":[{"url":U+"dup"},{"url":U+"ok"}]}
        raw={"items":[{"url":U+"dup"},{"url":U+"dup"},{"url":U+"ok"}]}
        self.assertEqual(candidates(public,set(),raw=raw),[U+"ok"])

    def test_raw_known_period_skipped_before_fetch(self):
        public={"items":[{"url":U+"a"},{"url":U+"b"}]}
        raw={"items":[{"url":U+"a","application_end_at":"2099-10-26T21:45:00+09:00"},
                      {"url":U+"b"}]}
        seen=[]
        def fetch(url):
            seen.append(url)
            return {"status":"browser_blocked"}
        run(public,set(),fetch,raw=raw)
        self.assertEqual(seen,[U+"b"])

    def test_verified_date_written_once(self):
        p={"items":[{"url":U+"a"}]}
        def fetch(url):
            return {"status":"ok","final_url":url,"text":TEXT}
        self.assertEqual(run(p,set(),fetch)["updated"],1)
        self.assertEqual(p["items"][0]["application_start_at"],
                         "2099-10-24T13:00:00+09:00")
        self.assertEqual(run(p,set(),fetch)["updated"],0)

    def test_expired_deadline_not_published(self):
        p={"items":[{"url":U+"a"}]}
        # Use a simulated time after the fixture's deadline.
        from livepocket_detail_period_batch import apply
        q={"items":[{"url":U+"a"}]}
        self.assertFalse(apply(q,U+"a",TEXT,set(),
                               now=datetime(2099,10,27,tzinfo=timezone.utc)))
        self.assertNotIn("application_end_at",q["items"][0])

    def test_raw_and_public_are_updated_together(self):
        public={"items":[{"url":U+"a"}]}
        raw={"items":[{"url":U+"a"}]}
        fetch=lambda u:{"status":"ok","final_url":u,"text":TEXT}
        self.assertEqual(run(public,set(),fetch,raw=raw)["updated"],1)
        self.assertEqual(raw["items"][0]["application_end_at"],
                         public["items"][0]["application_end_at"])
        self.assertEqual(run(public,set(),fetch,raw=raw)["updated"],0)

    def test_raw_existing_date_prevents_partial_write(self):
        public={"items":[{"url":U+"a"}]}
        raw={"items":[{"url":U+"a","application_end_at":"2099-10-26T21:45:00+09:00"}]}
        fetch=lambda u:{"status":"ok","final_url":u,"text":TEXT}
        self.assertEqual(run(public,set(),fetch,raw=raw)["updated"],0)
        self.assertNotIn("application_end_at",public["items"][0])

    def test_failed_page_never_updates(self):
        p={"items":[{"url":U+"a"}]}
        self.assertEqual(run(p,set(),lambda u:{"status":"browser_blocked"})["updated"],0)
        self.assertNotIn("application_end_at",p["items"][0])

if __name__=="__main__":
    unittest.main()
