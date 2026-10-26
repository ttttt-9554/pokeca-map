import unittest
from livepocket_detail_period_revalidate import changed_urls

U="https://livepocket.jp/e/a"

class RevalidationTests(unittest.TestCase):
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
