"""End-to-end planning tests: old lotteries never consume scheduled page calls."""
import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from datetime import datetime

import livepocket_v16 as v16
import livepocket_v18 as v18
from livepocket_future_policy import FUTURE_ONLY_SINCE, after_cutover, scheduled_future_only

OLD = "https://livepocket.jp/e/oldarriv"
NEW = "https://livepocket.jp/e/newarriv"
OLD_DETECTED = "2026-10-25T08:00:00+09:00"
NEW_DETECTED = "2026-10-26T12:30:00+09:00"
NOW = datetime.fromisoformat("2026-10-27T14:00:00+09:00")
PUBLIC = {"items": [{"url": OLD}, {"url": NEW}]}


def fixture(pending=True):
    history = {
        OLD: {"detected_at": OLD_DETECTED,
              "checked_at": "2026-10-25T09:00:00+09:00",
              "status": "checked_no_new_details"},
        NEW: {"detected_at": NEW_DETECTED,
              "checked_at": "2026-10-26T13:00:00+09:00",
              "status": "checked_no_new_details"},
    }
    return {
        "items": [{"url": OLD}, {"url": NEW}],
        "collector_state": {
            "v14": {"pending_new_urls": [OLD, NEW] if pending else [],
                    "new_url_checks": history},
            "v16": {"retry_log": {}},
        }
    }


class ForwardOnlyPolicyTests(TestCase):
    def test_cutover_requires_real_timezone_aware_timestamps(self):
        self.assertTrue(after_cutover(FUTURE_ONLY_SINCE))
        self.assertTrue(after_cutover("2026-10-26T03:25:00Z"))
        self.assertTrue(after_cutover(NEW_DETECTED))
        for stamp in (OLD_DETECTED, "", None,
                      "2026-10-26T12:25:00", "yesterday"):
            with self.subTest(stamp=stamp):
                self.assertFalse(after_cutover(stamp))
        with self.assertRaises(ValueError):
            after_cutover(NEW_DETECTED, datetime(2026,10,26))

    def test_scheduled_browser_urgent_queue_skips_legacy_urls(self):
        with patch.dict(os.environ, {"LIVEPOCKET_AUTO_FUTURE_ONLY": "true"}):
            self.assertTrue(scheduled_future_only())
            urgent, historical, cooling = v18.select(
                fixture(), PUBLIC, NOW, new_limit=5, background_limit=0)
            self.assertEqual(urgent, [NEW])
            self.assertEqual(historical, [])
            self.assertFalse(cooling)
        with patch.dict(os.environ, {"LIVEPOCKET_AUTO_FUTURE_ONLY": "false"}):
            urgent, _, _ = v18.select(fixture(), PUBLIC, NOW, new_limit=5, background_limit=0)
            self.assertCountEqual(urgent, [OLD, NEW])

    def test_scheduled_retry_skips_pre_cutover_but_keeps_new_arrivals(self):
        with patch.dict(os.environ, {"LIVEPOCKET_AUTO_FUTURE_ONLY": "true"}):
            self.assertEqual(v16.due_retries(fixture(False), PUBLIC, NOW, limit=5), [NEW])
        with patch.dict(os.environ, {"LIVEPOCKET_AUTO_FUTURE_ONLY": "false"}):
            self.assertCountEqual(v16.due_retries(fixture(False), PUBLIC, NOW, limit=5), [OLD, NEW])

    def test_scheduled_retry_skips_expired_verified_deadlines(self):
        public = {"items": [
            {"url": OLD}, {"url": NEW,
                          "application_end_at": "2026-10-27T12:00:00+09:00"}
        ]}
        with patch.dict(os.environ, {"LIVEPOCKET_AUTO_FUTURE_ONLY": "true"}):
            self.assertEqual(v16.due_retries(fixture(False), public, NOW, limit=5), [])

    def test_scheduled_collector_keeps_only_five_minute_new_scans(self):
        root = Path(__file__).resolve().parent.parent
        workflow = (root / ".github/workflows/livepocket-collect.yml").read_text()
        self.assertNotIn("23 1,13 * * *", workflow)
        self.assertIn("LIVEPOCKET_AUTO_FUTURE_ONLY:", workflow)
        self.assertIn("LIVEPOCKET_V14_RUN_BACKGROUND:", workflow)
