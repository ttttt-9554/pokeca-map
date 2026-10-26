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

    def test_aggregate_missing_dates_respects_manual_exclusions(self):
        now=datetime(2026,10,26,3,0,tzinfo=timezone.utc)
        recent=(now-timedelta(days=2)).isoformat()
        old=(now-timedelta(days=20)).isoformat()
        p={"items":[
            {"url":U+"safe","discord_posted_at":recent},
            {"url":U+"manual","discord_posted_at":recent},
            {"url":U+"history","discord_posted_at":old},
            {"url":U+"known","discord_posted_at":recent,
             "application_end_at":"2026-10-29T21:00:00+09:00"},
        ]}
        stats=run(p,{U+"manual"},fetch=lambda _:{"status":"browser_timeout"},
                  now=now)
        self.assertEqual(stats["public_recent_missing"],2)
        self.assertEqual(stats["manual_excluded_recent"],1)
        self.assertEqual(stats["selected"],1)
        self.assertEqual(stats["checked"],1)
        self.assertEqual(stats["updated"],0)

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

    def test_failure_counts_are_distinct_without_exposing_urls(self):
        p={"items":[{"url":U+"timeout"},{"url":U+"redirect"},{"url":U+"no_date"}]}
        def fetch(url):
            if url.endswith("timeout"):
                return {"status":"browser_timeout"}
            if url.endswith("redirect"):
                return {"status":"ok","final_url":U+"other","text":TEXT}
            return {"status":"ok","final_url":url,"text":"No verified application period"}
        stats=run(p,set(),fetch)
        self.assertEqual(stats["checked"],3)
        self.assertEqual(stats["unavailable"],2)
        self.assertEqual(stats["fetch_failed"],1)
        self.assertEqual(stats["wrong_event"],1)
        self.assertEqual(stats["no_verified_period"],1)
        self.assertEqual(stats["updated"],0)
        self.assertNotIn(U, str(stats))

    def test_browser_redirect_status_is_counted_as_wrong_event(self):
        p={"items":[{"url":U+"redirect"}]}
        stats=run(p,set(),lambda url:{"status":"browser_redirected"})
        self.assertEqual(stats["checked"],1)
        self.assertEqual(stats["wrong_event"],1)
        self.assertEqual(stats["fetch_failed"],0)
        self.assertEqual(stats["unavailable"],1)

    def test_explicit_access_block_stops_remaining_checks(self):
        p={"items":[{"url":U+"a"},{"url":U+"b"},{"url":U+"c"}]}
        seen=[]
        def fetch(url):
            seen.append(url)
            return {"status":"browser_blocked","http_status":429}
        stats=run(p,set(),fetch)
        self.assertEqual(seen,[U+"a"])
        self.assertEqual(stats["selected"],3)
        self.assertEqual(stats["checked"],1)
        self.assertEqual(stats["blocked"],1)
        self.assertEqual(stats["deferred"],2)
        self.assertEqual(stats["fetch_failed"],1)

    def test_challenge_pages_stop_checks(self):
        p={"items":[{"url":U+"a"},{"url":U+"b"}]}
        for reason in ("robot_verification_page", "access_gate"):
            with self.subTest(gate_reason=reason):
                stats=run(p,set(),lambda url:{
                    "status":"browser_blocked_or_empty",
                    "gate_reason":reason})
                self.assertEqual(stats["checked"],1)
                self.assertEqual(stats["blocked"],1)
                self.assertEqual(stats["deferred"],1)

    def test_missing_page_and_empty_body_do_not_block_other_events(self):
        p={"items":[{"url":U+"a"},{"url":U+"b"},{"url":U+"c"}]}
        def fetch(url):
            if url.endswith("a"):
                return {"status":"browser_http_error","http_status":404}
            if url.endswith("b"):
                return {"status":"browser_blocked_or_empty",
                        "gate_reason":"blocked_or_empty"}
            return {"status":"ok","final_url":url,"text":TEXT}
        stats=run(p,set(),fetch)
        self.assertEqual(stats["checked"],3)
        self.assertEqual(stats["fetch_failed"],2)
        self.assertEqual(stats["updated"],1)
        self.assertEqual(stats["blocked"],0)
        self.assertEqual(stats["deferred"],0)

    def test_end_only_is_diagnosed_but_not_published(self):
        p={"items":[{"url":U+"deadline"}]}
        message="応募締切 2099年10月26日21:45"
        fetch=lambda u:{"status":"ok","final_url":u,"text":message}
        stats=run(p,set(),fetch,now=datetime(2099,10,20,tzinfo=timezone.utc))
        self.assertEqual(stats["checked"],1)
        self.assertEqual(stats["no_verified_period"],1)
        self.assertEqual(stats["period_without_start"],1)
        self.assertEqual(stats["updated"],0)
        self.assertNotIn("application_end_at",p["items"][0])

    def test_expired_explicit_pair_is_diagnosed(self):
        p={"items":[{"url":U+"expired"}]}
        fetch=lambda u:{"status":"ok","final_url":u,"text":TEXT}
        stats=run(p,set(),fetch,now=datetime(2099,10,27,tzinfo=timezone.utc))
        self.assertEqual(stats["no_verified_period"],1)
        self.assertEqual(stats["period_expired"],1)
        self.assertEqual(stats["updated"],0)
        self.assertNotIn("application_end_at",p["items"][0])

    def test_conflicting_periods_remain_unverified(self):
        p={"items":[{"url":U+"conflict"}]}
        message="""詳細
応募期間 2099年10月24日13:00～2099年10月26日21:45
申込期間 2099年10月24日13:00～2099年10月27日21:45
受付・チケット情報
販売受付期間 2099年10月23日15:02～2099年10月26日21:45"""
        fetch=lambda u:{"status":"ok","final_url":u,"text":message}
        stats=run(p,set(),fetch,now=datetime(2099,10,20,tzinfo=timezone.utc))
        self.assertEqual(stats["period_unverified"],1)
        self.assertEqual(stats["no_verified_period"],1)
        self.assertEqual(stats["updated"],0)

    def test_new_counts_do_not_expose_private_page_content(self):
        p={"items":[{"url":U+"unverified"}]}
        body="このイベント本文には個別の店名があるが応募期間は書かれていない"
        stats=run(p,set(),lambda u:{"status":"ok","final_url":u,"text":body})
        self.assertEqual(stats["period_unverified"],1)
        self.assertNotIn(body,str(stats))
        self.assertNotIn(U,str(stats))

    def test_failed_page_never_updates(self):
        p={"items":[{"url":U+"a"}]}
        self.assertEqual(run(p,set(),lambda u:{"status":"browser_blocked"})["updated"],0)
        self.assertNotIn("application_end_at",p["items"][0])

if __name__=="__main__":
    unittest.main()
