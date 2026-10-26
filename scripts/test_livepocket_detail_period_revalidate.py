import unittest
from livepocket_detail_period_revalidate import changed_urls, matching_date_changes

U="https://livepocket.jp/e/test_event"

class RevalidationTests(unittest.TestCase):
    def test_raw_public_must_have_same_dates(self):
        changes=[{U},{U}]
        same=[{U:("2099-10-24T13:00:00+09:00","2099-10-26T21:45:00+09:00")}]*2
        self.assertTrue(matching_date_changes(changes,same))
        different=[same[0],{U:("2099-10-23T15:02:00+09:00","2099-10-26T21:45:00+09:00")}]
        self.assertFalse(matching_date_changes(changes,different))
        self.assertFalse(matching_date_changes([{U},set()],same))

    def test_only_new_complete_dates(self):
        before={"items":[{"url":U}]}
        after={"items":[{"url":U,"application_start_at":"2099-10-24T13:00:00+09:00",
                         "application_end_at":"2099-10-26T21:45:00+09:00"}]}
        self.assertEqual(changed_urls(before,after),{U})

    def test_reject_existing_date_overwrite(self):
        before={"items":[{"url":U,"application_start_at":"2099-10-23T15:02:00+09:00"}]}
        after={"items":[{"url":U,"application_start_at":"2099-10-24T13:00:00+09:00",
                         "application_end_at":"2099-10-26T21:45:00+09:00"}]}
        with self.assertRaises(RuntimeError):
            changed_urls(before,after)

    def test_accept_future_end_only(self):
        before={"items":[{"url":U}]}
        after={"items":[{"url":U,"application_end_at":"2099-10-26T21:45:00+09:00"}]}
        self.assertEqual(changed_urls(before,after),{U})

    def test_reject_start_without_deadline(self):
        before={"items":[{"url":U}]}
        after={"items":[{"url":U,"application_start_at":"2099-10-24T13:00:00+09:00"}]}
        with self.assertRaises(RuntimeError):
            changed_urls(before,after)

    def test_reject_malformed_end_only(self):
        before={"items":[{"url":U}]}
        for end in ("", "not-a-date", "2099-10-26T21:45:00", None):
            with self.subTest(end=end), self.assertRaises(RuntimeError):
                changed_urls(before,{"items":[{"url":U,"application_end_at":end}]})

    def test_reject_changed_non_date_fields(self):
        before={"items":[{"url":U,"store_name":"Original"}]}
        after={"items":[{"url":U,"store_name":"Unexpected",
                         "application_start_at":"2099-10-24T13:00:00+09:00",
                         "application_end_at":"2099-10-26T21:45:00+09:00"}]}
        with self.assertRaises(RuntimeError):
            changed_urls(before,after)

    def test_reject_removed_or_duplicate_event(self):
        before={"items":[{"url":U}]}
        with self.assertRaises(RuntimeError):
            changed_urls(before,{"items":[]})
        with self.assertRaises(RuntimeError):
            changed_urls(before,{"items":[{"url":U},{"url":U}]})

    def test_reject_invalid_or_expired_deadline(self):
        from datetime import datetime, timezone
        before={"items":[{"url":U}]}
        after={"items":[{"url":U,
            "application_start_at":"2026-10-20T12:00:00+09:00",
            "application_end_at":"2026-10-22T15:00:00+09:00"}]}
        with self.assertRaises(RuntimeError):
            changed_urls(before,after,now=datetime(2026,10,26,tzinfo=timezone.utc))
        after["items"][0]["application_start_at"]="not-a-date"
        after["items"][0]["application_end_at"]="2099-10-26T21:45:00+09:00"
        with self.assertRaises(RuntimeError):
            changed_urls(before,after)

    def test_reject_top_level_metadata_changes(self):
        before={"items":[{"url":U}],"schema_version":7}
        after={"items":[{"url":U}],"schema_version":8}
        with self.assertRaises(RuntimeError):
            changed_urls(before,after)

if __name__=="__main__":
    unittest.main()
