import io
import json
import unittest
from livepocket_prefecture_manual_snapshot import fetch_manual_urls


class Response(io.BytesIO):
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


class SnapshotTests(unittest.TestCase):
    def test_urls_only(self):
        def opener(request, timeout):
            return Response(json.dumps([
                {"event_url":"https://livepocket.jp/e/abcde"},
                {"event_url":"https://livepocket.jp/e/abcde"},
                {"event_url":"https://example.org/x"},
            ]).encode())
        self.assertEqual(fetch_manual_urls("https://project.supabase.co","secret",opener),
                         ["https://livepocket.jp/e/abcde"])

    def test_missing_secret_fails_closed(self):
        with self.assertRaises(ValueError):
            fetch_manual_urls("https://project.supabase.co","")


if __name__ == "__main__":
    unittest.main()
