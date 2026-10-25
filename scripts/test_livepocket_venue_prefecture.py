import unittest
from livepocket_venue_prefecture import venue_prefecture, fill_one


class VenueTests(unittest.TestCase):
    def test_split_venue(self):
        self.assertEqual(venue_prefecture("概要\n会場\nふるいちイオンモール木曽川店（愛知県）", "ふるいちイオンモール木曽川店"), "愛知県")

    def test_unrelated(self):
        self.assertEqual(venue_prefecture("会場\n別店舗（愛知県）", "ふるいちイオンモール木曽川店"), "")

    def test_conflict(self):
        self.assertEqual(venue_prefecture("会場 テストA店（愛知県）\n会場 テストA店（東京都）", "テストA店"), "")

    def test_fill(self):
        a = {"url":"https://livepocket.jp/e/abcde", "stores":[{"name":"テストA店","prefecture":""}]}
        b = {"url":a["url"],"stores":[{"name":"テストA店","prefecture":""}]}
        self.assertTrue(fill_one(a,b,"会場 テストA店（愛知県）"))
        self.assertEqual(b["stores"][0]["prefecture"],"愛知県")
        self.assertFalse(fill_one(a,b,"会場 テストA店（東京都）"))

    def test_multiple_stores(self):
        a = {"url":"u","stores":[{"name":"テストA店","prefecture":""},{"name":"B店","prefecture":""}]}
        b = {"url":"u","stores":a["stores"].copy()}
        self.assertFalse(fill_one(a,b,"会場 テストA店（愛知県）"))


if __name__ == "__main__":
    unittest.main()
