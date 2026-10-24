#!/usr/bin/env python3
"""Smoke tests for deterministic sale-transition behavior (no network)."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

FILE = Path(__file__).resolve().parent / "guerrilla_sale_monitor.py"
spec = importlib.util.spec_from_file_location("sale_monitor", FILE)
mon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mon)


class SaleMonitorTests(unittest.TestCase):
    def test_https_guard(self):
        self.assertTrue(mon.safe_https_url("https://shop.example.com/item"))
        self.assertFalse(mon.safe_https_url("http://shop.example.com/item"))
        self.assertFalse(mon.safe_https_url("https://localhost/item"))
        self.assertFalse(mon.safe_https_url("https://127.0.0.1/item"))

    def test_html_evidence(self):
        target = {
            "url": "https://shop.example.com/item",
            "available_text": ["カートに入れる"],
            "unavailable_text": ["売り切れ"],
            "required_text": ["トレカ"],
        }
        with patch.object(mon, "fetch_page", return_value="トレカ カートに入れる"):
            self.assertEqual(mon.detect(target)[0], "available")
        with patch.object(mon, "fetch_page", return_value="トレカ 売り切れ"):
            self.assertEqual(mon.detect(target)[0], "unavailable")
        with patch.object(mon, "fetch_page", return_value="トレカ 売り切れ カートに入れる"):
            self.assertEqual(mon.detect(target)[0], "unknown")
        with patch.object(mon, "fetch_page", return_value="別の商品 カートに入れる"):
            self.assertEqual(mon.detect(target)[0], "unknown")

    def test_only_transition_notifies_and_is_deduplicated(self):
        target = {
            "id": "shop-a",
            "shop": "販売店A",
            "product": "トレカA",
            "url": "https://shop.example.com/item",
            "enabled": True,
            "available_text": ["販売中"],
            "unavailable_text": ["売り切れ"],
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "targets.json").write_text(json.dumps({"targets": [target]}), encoding="utf-8")
            with (
                patch.object(mon, "CONFIG", root / "targets.json"),
                patch.object(mon, "STATE", root / "state.json"),
                patch.object(mon, "FEED", root / "feed.json"),
                patch.object(mon, "post_discord", return_value=True) as send,
                patch.object(mon, "detect", side_effect=[
                    ("unavailable", ""), ("available", ""), ("available", ""),
                ]),
            ):
                mon.main()  # establish baseline
                self.assertEqual(send.call_count, 0)
                mon.main()  # inventory went available
                self.assertEqual(send.call_count, 1)
                mon.main()  # same state, never alert twice
                self.assertEqual(send.call_count, 1)
                feed = json.loads((root / "feed.json").read_text(encoding="utf-8"))
                self.assertEqual(len(feed["events"]), 1)
                self.assertEqual(feed["items"][0]["status"], "available")


if __name__ == "__main__":
    unittest.main()
