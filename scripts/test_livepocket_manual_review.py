#!/usr/bin/env python3
"""Regression tests: do not recheck completed LivePocket events repeatedly."""
import unittest
import json
import tempfile
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import livepocket_v21 as v21
import livepocket_manual_completed as cloud
import livepocket_check_summary as summary

NOW = datetime(2026, 10, 21, 10, 0, tzinfo=timezone.utc)
FUTURE = "2026-11-01T21:00:00+09:00"
PAST = "2026-10-20T21:00:00+09:00"


def url(name):
    return "https://livepocket.jp/e/" + name


def fixtures():
    names = (
        "finished", "needsname", "justchecked", "justfailed",
        "retryfailed", "retrychecked", "expired", "removed",
        "manualdone", "manualtitle", "manualplace", "productoptional",
        "deadlineunknown","readyafterfail","readyaftercheck"
    )
    raw, public = [], []
    for name in names:
        event = {
            "url":url(name),"event_title":"ポケモンカード抽選",
            "store_name":"TSUTAYA名古屋店","application_end_at":FUTURE
        }
        original = {"url":url(name),"event_title":event["event_title"]}
        if name in ("needsname","justchecked","justfailed","retryfailed",
                    "retrychecked","readyafterfail","readyaftercheck",
                    "manualdone","manualtitle","manualplace"):
            event["event_title"] = ""
            original["event_title"] = ""
        if name in ("manualdone","manualtitle","manualplace"):
            event["store_name"] = ""
        if name=="expired":event["application_end_at"]=PAST
        if name=="deadlineunknown":event["application_end_at"]=None
        if name=="productoptional":
            event["official_event_title"] = event["event_title"]
        public.append(event)
        raw.append(original)
    check={}
    for name,age,status in (
        ("justchecked",timedelta(hours=1),"checked_no_new_details"),
        ("justfailed",timedelta(hours=2),"browser_error"),
        ("retryfailed",timedelta(days=2),"browser_error"),
        ("retrychecked",timedelta(days=8),"checked_no_new_details"),
        ("readyafterfail",timedelta(hours=7),"browser_error"),
        ("readyaftercheck",timedelta(hours=25),"checked_no_new_details"),
    ):
        check[url(name)] = {
            "checked_at":(NOW-age).isoformat(),"status":status
        }
    raw_data={"items":raw,"collector_state":{
        "v14":{"pending_new_urls":[]},
        "v13":{"browser_checks":check},
        "v21_9":{"official_checks":{}}
    }}
    return raw_data, {"items":public}


class CandidateTests(unittest.TestCase):
    def test_never_requeue_completed_and_recent(self):
        raw,public=fixtures()
        found=v21.manual_recheck_candidates(
            raw,public,now=NOW,limit=12,
            completed_titles={url("manualdone"),url("manualtitle")},
            removed_pages={url("removed")},
            completed_locations={url("manualdone"),url("manualplace")},
        )
        expected={url(name) for name in (
            "needsname","retryfailed","retrychecked","manualtitle",
            "manualplace","deadlineunknown",
            "readyafterfail","readyaftercheck"
        )}
        self.assertEqual(set(found),expected)
        self.assertEqual(len(found),len(set(found)))

    def test_limit_and_no_filler(self):
        raw,public=fixtures()
        found=v21.manual_recheck_candidates(
            raw,public,now=NOW,limit=12,
            completed_titles={url("manualdone"),url("manualtitle")},
            removed_pages={url("removed")},
            completed_locations={url("manualdone"),url("manualplace")},
        )
        self.assertLess(len(found),12)
        self.assertEqual(v21.manual_recheck_candidates(
            raw,public,now=NOW,limit=0),[])

    def test_progress_categories_partition_catalog(self):
        raw,public=fixtures()
        counts=v21.manual_recheck_candidates(
            raw,public,now=NOW,limit=12,summary=True,
            completed_titles={url("manualdone"),url("manualtitle")},
            removed_pages={url("removed")},
            completed_locations={url("manualdone"),url("manualplace")})
        keys=("ready","retry_wait","completed","expired","removed",
              "new_pending","quarantined")
        self.assertEqual(counts["total"],len(raw["items"]))
        self.assertEqual(sum(counts[key] for key in keys),counts["total"])
        self.assertEqual(counts["next_batch_size"],counts["ready"])
        self.assertGreater(counts["completed"],0)
        self.assertEqual(counts["removed"],1)
        self.assertEqual(counts["expired"],1)
        self.assertEqual(counts["retry_wait"],2)
        self.assertEqual(counts["unresolved"],counts["ready"]+counts["retry_wait"])
        self.assertEqual(counts["missing_title"],8)
        self.assertIsNotNone(counts["next_retry_at"])
        self.assertLessEqual(
            datetime.fromisoformat(counts["next_retry_at"].replace("Z","+00:00")),
            NOW+timedelta(hours=5))

    def test_progress_cooldown_pauses_next_batch_without_losing_counts(self):
        raw,public=fixtures()
        raw["collector_state"]["v14"]["blocked_until"]=(NOW+timedelta(hours=1)).isoformat()
        counts=v21.manual_recheck_candidates(
            raw,public,now=NOW,summary=True)
        self.assertTrue(counts["access_cooldown"])
        self.assertEqual(counts["next_batch_size"],0)
        self.assertGreater(counts["ready"],0)
        self.assertEqual(v21.manual_recheck_candidates(raw,public,now=NOW),[])

    def test_expired_and_manual_page_unavailable(self):
        raw,public=fixtures()
        for x in public["items"]:
            if x["url"]==url("needsname"):
                x["manual_page_unavailable"]=True
        found=v21.manual_recheck_candidates(raw,public,now=NOW)
        self.assertNotIn(url("needsname"),found)
        self.assertNotIn(url("expired"),found)
        self.assertNotIn(url("finished"),found)

    def test_optional_product_does_not_trigger_auto_recheck(self):
        _raw,public=fixtures()
        item=next(x for x in public["items"]
                  if x["url"]==url("productoptional"))
        self.assertNotIn("product_name",v21.missing_details_v21(item))

    def test_public_report_uses_same_review_selector_without_urls(self):
        raw, public=fixtures()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            raw_path=root/"raw.json"
            public_path=root/"public.json"
            raw_path.write_text(json.dumps(raw),encoding="utf-8")
            public_path.write_text(json.dumps(public),encoding="utf-8")
            with patch.object(summary.v21,"PUBLIC_PATH",public_path):
                with patch.object(summary,"read_manual_completed",
                                  return_value=({url("manualdone"),url("manualtitle")},
                                                {url("removed")},
                                                {url("manualdone"),url("manualplace")})):
                    result=summary.current_manual_review_progress(raw_path,now=NOW)
        self.assertEqual(result["status"],"ok")
        self.assertEqual(result["total"],len(raw["items"]))
        self.assertEqual(result["source"],"v21_65_manual_selector")
        self.assertEqual(result["next_batch_size"],min(12,result["ready"]))
        self.assertEqual(result["unresolved"],result["ready"]+result["retry_wait"])
        self.assertGreater(result["missing_title"],0)
        self.assertIsNotNone(result["next_retry_at"])
        self.assertNotIn("livepocket.jp",json.dumps(result))

    def test_public_report_is_safe_when_snapshot_missing(self):
        result=summary.current_manual_review_progress(
            Path("/file/that/does/not/exist/review.json"),now=NOW)
        self.assertEqual(result,{"status":"unavailable"})

    def test_public_override_sync_classification(self):
        cloud.read_manual_completed.cache_clear()
        def fake_rows(endpoint,key,table,fields):
            if table=="livepocket_event_overrides":
                return [
                    {"event_url":url("manualdone"),"resolution":"title"},
                    {"event_url":url("removed"),"resolution":"unavailable"},
                    {"event_url":"https://x.com/notallowed","resolution":"title"}
                ]
            return [{"event_url":url("manualdone")}]
        with patch.object(cloud,"_client_config",return_value=("https://unused.supabase.co","test")):
            with patch.object(cloud,"_read_rows",side_effect=fake_rows):
                self.assertEqual(cloud.read_manual_completed(),
                                 ({url("manualdone")},{url("removed")},{url("manualdone")}))
        cloud.read_manual_completed.cache_clear()


class TicketTabDeadlineTests(unittest.TestCase):
    """Regression: single-event ticket-tab signup dates are not lost."""

    def test_missing_date_opens_ticket_tab_even_with_verified_store_options(self):
        overview = (
            "概要 詳細 受付・チケット情報 お問い合わせ\n"
            "【TSUTAYA鹿沼店】\n販売中\n"
            "【TSUTAYA宇都宮店】\n受付中"
        )
        self.assertTrue(v21.v19.ticket_option_stores(overview))
        self.assertTrue(v21.ticket_tab_needs_check(overview))

    def test_complete_signup_period_does_not_require_another_tab_click(self):
        overview = (
            "受付・チケット情報\n"
            "【TSUTAYA鹿沼店】\n販売中\n"
            "【TSUTAYA宇都宮店】\n受付中\n"
            "抽選受付期間 2026年10月22日 09:00 ～ "
            "2026年10月25日 22:03"
        )
        self.assertFalse(v21.ticket_tab_needs_check(overview))

    def test_explicit_ticket_tab_deadline_survives_without_store_cards(self):
        overview = "概要 詳細 受付・チケット情報 お問い合わせ\nTSUTAYA鹿沼店"
        ticket_tab = (
            "受付・チケット情報\n"
            "抽選受付期間 2026年10月22日 09:00 ～ "
            "2026年10月25日 22:03\n"
            "抽選結果は別途ご案内"
        )
        self.assertTrue(v21.ticket_tab_needs_check(overview))
        combined = v21.combine_ticket_tab_text(overview, ticket_tab)
        self.assertIn("2026年10月25日", combined)
        start, end = v21.v14.v13.extract_deadline(combined)
        self.assertEqual(v21.v11.iso(start), "2026-10-22T09:00:00+09:00")
        self.assertEqual(v21.v11.iso(end), "2026-10-25T22:03:00+09:00")

    def test_unrelated_event_date_never_becomes_application_deadline(self):
        overview = "概要 受付・チケット情報 お問い合わせ"
        ticket_tab = "受付・チケット情報\n開催日時 2026年10月30日 19:00"
        self.assertEqual(v21.combine_ticket_tab_text(overview, ticket_tab), overview)

    def test_conflicting_signup_deadlines_are_not_guessed(self):
        overview = "概要 受付・チケット情報 お問い合わせ"
        ticket_tab = (
            "受付・チケット情報\n"
            "応募期間 2026年10月22日 09:00 ～ 2026年10月25日 22:03\n"
            "応募期間 2026年10月22日 09:00 ～ 2026年10月26日 22:03"
        )
        self.assertEqual(v21.combine_ticket_tab_text(overview, ticket_tab), overview)

    def test_long_overview_keeps_official_deadline_from_ticket_tab(self):
        overview = "概要 詳細 受付・チケット情報\n" + "ご利用案内。"*6000
        ticket_tab = (
            "受付・チケット情報\n"
            "抽選受付期間 2026年10月22日 09:00 ～ "
            "2026年10月25日 22:03"
        )
        combined = v21.combine_ticket_tab_text(overview, ticket_tab)
        self.assertLessEqual(len(combined), 30000)
        self.assertEqual(
            v21.v11.iso(v21.v14.v13.extract_deadline(combined)[1]),
            "2026-10-25T22:03:00+09:00"
        )


if __name__=="__main__":
    unittest.main(verbosity=2)
