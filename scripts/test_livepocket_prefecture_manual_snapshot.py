import io
import json
import unittest
import urllib.parse
from livepocket_prefecture_manual_snapshot import (
    PROJECT_HOST, MANUAL_TABLES, MANUAL_SELECTS,
    canonical_event_url, fetch_manual_urls, needs_exclusion
)


class Response(io.BytesIO):
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


URL = "https://livepocket.jp/e/abcde"
BASE = "https://" + PROJECT_HOST


class SnapshotTests(unittest.TestCase):
    def test_only_date_or_resolved_events_are_excluded(self):
        read_tables = []
        def opener(request, timeout):
            path, query = request.full_url.split("/rest/v1/")[1].split("?")
            read_tables.append(path)
            selected = urllib.parse.parse_qs(query)["select"][0]
            self.assertEqual(selected, MANUAL_SELECTS[path])
            records = {
                "lottery_card_overrides": [
                    {"event_url": URL + "/?src=admin",
                     "edited_fields": ["application_end_at"],
                     "review_complete": False,
                     "review_deadline_unpublished": False,
                     "application_start_at": None, "application_end_at": None},
                    {"event_url": "https://livepocket.jp/e/store123",
                     "edited_fields": ["stores"], "review_complete": False,
                     "review_deadline_unpublished": False,
                     "application_start_at": None, "application_end_at": None},
                    {"event_url": "https://example.org/x",
                     "edited_fields": ["application_start_at"]},
                ],
                "livepocket_location_overrides": [
                    {"event_url": "https://www.livepocket.jp/e/abcd2"},
                ],
                "livepocket_event_overrides": [
                    {"event_url": "https://livepocket.jp/e/title123", "resolution": "title"},
                    {"event_url": "https://livepocket.jp/e/removed1", "resolution": "unavailable"},
                ],
            }
            return Response(json.dumps(records[path]).encode())
        self.assertEqual(fetch_manual_urls(BASE, "secret", opener),
                         [URL, "https://livepocket.jp/e/removed1"])
        self.assertEqual(tuple(read_tables), MANUAL_TABLES)

    def test_non_date_edits_remain_eligible(self):
        for fields in (["stores"], ["store_name", "prefecture"],
                       ["event_title"], ["review_category", "product_type"]):
            with self.subTest(fields=fields):
                self.assertFalse(needs_exclusion("lottery_card_overrides", {
                    "edited_fields": fields,
                    "review_complete": False,
                    "review_deadline_unpublished": False,
                    "application_start_at": None,
                    "application_end_at": None,
                }))
        self.assertFalse(needs_exclusion("livepocket_location_overrides",
                                         {"event_url": URL}))
        self.assertFalse(needs_exclusion("livepocket_event_overrides",
                                         {"event_url": URL, "resolution": "title"}))

    def test_manual_date_and_review_confirmations_stay_excluded(self):
        base = {"edited_fields": ["stores"],
                "review_complete": False, "review_deadline_unpublished": False,
                "application_start_at": None, "application_end_at": None}
        cases = [
            {"edited_fields": ["application_end_at"]},
            {"edited_fields": ["application_start_at", "stores"]},
            {"review_complete": True},
            {"review_deadline_unpublished": True},
            {"application_end_at": "2026-10-29T20:00:00+09:00"},
            {"edited_fields": ["unknown_future_attribute"]},
            {"edited_fields": None},
            {"edited_fields": ["stores"], "review_complete": "false"},
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertTrue(needs_exclusion("lottery_card_overrides",
                                               {**base, **case}))
        for status in ("active", "unavailable", None, "unknown"):
            with self.subTest(resolution=status):
                self.assertTrue(needs_exclusion("livepocket_event_overrides",
                                                {"event_url": URL, "resolution": status}))

    def test_canonical_url_validation(self):
        self.assertEqual(canonical_event_url(URL + "/?via=x"), URL)
        self.assertIsNone(canonical_event_url("https://livepocket.jp.evil.com/e/abcde"))
        self.assertIsNone(canonical_event_url("https://livepocket.jp/e/a"))
        self.assertIsNone(canonical_event_url("http://livepocket.jp/e/abcde"))
        self.assertIsNone(canonical_event_url("https://livepocket.jp/e/abcde\n"))

    def test_missing_secret_fails_closed(self):
        with self.assertRaises(ValueError):
            fetch_manual_urls(BASE, "")

    def test_unexpected_project_fails_closed(self):
        with self.assertRaises(ValueError):
            fetch_manual_urls("https://other.supabase.co", "secret")

    def test_failure_of_any_manual_table_aborts(self):
        def opener(request, timeout):
            if "livepocket_location_overrides" in request.full_url:
                raise RuntimeError("manual table unavailable")
            return Response(json.dumps([{"event_url": URL}]).encode())
        with self.assertRaises(RuntimeError):
            fetch_manual_urls(BASE, "secret", opener)

    def test_malformed_response_aborts(self):
        def opener(request, timeout):
            return Response(json.dumps({"event_url": URL}).encode())
        with self.assertRaises(ValueError):
            fetch_manual_urls(BASE, "secret", opener)


if __name__ == "__main__":
    unittest.main()
