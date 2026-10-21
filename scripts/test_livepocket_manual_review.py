#!/usr/bin/env python3
"""Regression tests: do not recheck completed LivePocket events repeatedly."""
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import livepocket_v21 as v21
import livepocket_manual_completed as cloud

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
        "deadlineunknown"
    )
    raw, public = [], []
    for name in names:
        event = {
            "url":url(name),"event_title":"ポケモンカード抽選",
            "store_name":"TSUTAYA名古屋店","application_end_at":FUTURE
        }
        original = {"url":url(name),"event_title":event["event_title"]}
        if name in ("needsname","justchecked","justfailed","retryfailed",
                    "retrychecked","manualdone","manualtitle","manualplace"):
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
            "manualplace","deadlineunknown"
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


if __name__=="__main__":
    unittest.main(verbosity=2)
