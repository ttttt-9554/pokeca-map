import unittest
from livepocket_prefecture_sync_public import apply


class SyncTests(unittest.TestCase):
    def test_only_exact_unlocated_single_store(self):
        url="https://livepocket.jp/e/test1"
        public={"items":[{"url":url,"stores":[{"name":"テスト店舗","prefecture":""}]}]}
        verified=[{"url":url,"store_name":"テスト店舗","prefecture":"愛知県","verified":"yes","source_url":url}]
        changed=apply(public,verified,set())
        self.assertEqual(len(changed),1)
        self.assertEqual(public["items"][0]["stores"][0]["prefecture"],"愛知県")
        self.assertEqual(apply(public,verified,set()),[])

    def test_manual_override_skipped(self):
        url="https://livepocket.jp/e/test2"
        public={"items":[{"url":url,"stores":[{"name":"テスト店舗","prefecture":""}]}]}
        verified=[{"url":url,"store_name":"テスト店舗","prefecture":"愛知県","verified":"yes","source_url":url}]
        self.assertEqual(apply(public,verified,{url}),[])
        self.assertEqual(public["items"][0]["stores"][0]["prefecture"],"")

    def test_multiple_stores_preserved(self):
        url="https://livepocket.jp/e/test3"
        public={"items":[{"url":url,"stores":[{"name":"テスト店舗","prefecture":""},{"name":"別店舗","prefecture":""}]}]}
        verified=[{"url":url,"store_name":"テスト店舗","prefecture":"愛知県","verified":"yes","source_url":url}]
        self.assertEqual(apply(public,verified,set()),[])

    def test_missing_exclusions_fails(self):
        with self.assertRaises(ValueError):
            apply({"items":[]},[],None)


if __name__=="__main__":
    unittest.main()
