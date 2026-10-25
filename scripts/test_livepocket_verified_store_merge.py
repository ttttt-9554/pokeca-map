#!/usr/bin/env python3
"""Regression tests for verified LivePocket store prefecture merge."""
import unittest
import livepocket_v19 as v19


class VerifiedStoreMergeTests(unittest.TestCase):
    def test_kazawa(self):
        existing = [{"name": "TSUTAYA金沢店", "prefecture": ""}]
        manual = [{"name": "TSUTAYA金沢店", "prefecture": "石川県"}]
        self.assertEqual(v19.merge_stores(existing, [], manual, "TSUTAYA金沢店"),
                         manual)

    def test_kofu(self):
        existing = [{"name": "ふるいちイオンモール甲府昭和店", "prefecture": ""}]
        manual = [{"name": "ふるいちイオンモール甲府昭和店", "prefecture": "山梨県"}]
        self.assertEqual(v19.merge_stores(existing, [], manual,
                                          "ふるいちイオンモール甲府昭和店"), manual)

    def test_other_stores_preserved(self):
        existing = [{"name": "店舗A", "prefecture": "東京都"},
                    {"name": "店舗B", "prefecture": ""}]
        manual = [{"name": "店舗B", "prefecture": "愛知県"}]
        result = v19.merge_stores(existing, [], manual)
        self.assertIn(existing[0], result)
        self.assertIn(manual[0], result)
        self.assertNotIn(existing[1], result)

    def test_conflicting_prefecture_not_overwritten(self):
        existing = [{"name": "TSUTAYA金沢店", "prefecture": "石川県"}]
        manual = [{"name": "TSUTAYA金沢店", "prefecture": "東京都"}]
        result = v19.merge_stores(existing, [], manual)
        self.assertIn(existing[0], result)
        self.assertIn(manual[0], result)


if __name__ == "__main__":
    unittest.main()
