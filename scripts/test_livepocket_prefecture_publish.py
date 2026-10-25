import unittest
from livepocket_prefecture_publish import merge_verified_csv

URL="https://livepocket.jp/e/testvenue"
NAME="テスト店舗本店"
CSV="url,store_name,prefecture,verified,source_url\n"
MANIFEST={"changes":[{"url":URL,"store_name":NAME,"prefecture":"愛知県","source_url":URL}]}
PUBLIC={"items":[{"url":URL,"stores":[{"name":NAME,"prefecture":""}]}]}


class PublisherTests(unittest.TestCase):
    def test_add_and_idempotent(self):
        text, count=merge_verified_csv(CSV,MANIFEST,PUBLIC,set())
        self.assertEqual(count,1)
        again, count=merge_verified_csv(text,MANIFEST,PUBLIC,set())
        self.assertEqual(count,0)
        self.assertEqual(text,again)

    def test_supabase_override(self):
        _,count=merge_verified_csv(CSV,MANIFEST,PUBLIC,{URL})
        self.assertEqual(count,0)

    def test_conflicting_existing_csv(self):
        old=CSV+f"{URL},{NAME},東京都,yes,{URL}\n"
        with self.assertRaises(ValueError):
            merge_verified_csv(old,MANIFEST,PUBLIC,set())

    def test_changed_store_skipped(self):
        _,count=merge_verified_csv(CSV,MANIFEST,{"items":[{"url":URL,"stores":[{"name":"別店舗","prefecture":""}]}]},set())
        self.assertEqual(count,0)

    def test_multiple_stores_skipped(self):
        p={"items":[{"url":URL,"stores":[{"name":NAME,"prefecture":""},{"name":"別店舗","prefecture":""}]}]}
        _,count=merge_verified_csv(CSV,MANIFEST,p,set())
        self.assertEqual(count,0)

    def test_reject_oversized_manifest(self):
        with self.assertRaises(ValueError):
            merge_verified_csv(CSV,{"changes":MANIFEST["changes"]*4},PUBLIC,set())

if __name__=="__main__":
    unittest.main()
