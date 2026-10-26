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

    def test_reject_partial_date(self):
        before={"items":[{"url":U}]}
        after={"items":[{"url":U,"application_end_at":"2099-10-26T21:45:00+09:00"}]}
        with self.assertRaises(RuntimeError):
            changed_urls(before,after)

if __name__=="__main__":
    unittest.main()
