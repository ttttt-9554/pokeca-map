import io
import json
import unittest
from livepocket_prefecture_manual_snapshot import (
    PROJECT_HOST, MANUAL_TABLES, canonical_event_url, fetch_manual_urls
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
    def test_union_of_all_manual_sources(self):
        read_tables = []
        def opener(request, timeout):
            table = request.full_url.split("/rest/v1/")[1].split("?")[0]
            read_tables.append(table)
            records = {
                "lottery_card_overrides": [
                    {"event_url": URL + "/?src=admin"},
                    {"event_url": "https://example.org/x"},
                ],
                "livepocket_location_overrides": [
                    {"event_url": "https://www.livepocket.jp/e/abcd2"},
                ],
                "livepocket_event_overrides": [
                    {"event_url": URL}, {"event_url": "https://evil-livepocket.jp/e/abcd"},
                ],
            }
            return Response(json.dumps(records[table]).encode())
        self.assertEqual(fetch_manual_urls(BASE, "secret", opener),
                         [URL, "https://livepocket.jp/e/abcd2"])
        self.assertEqual(tuple(read_tables), MANUAL_TABLES)

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
