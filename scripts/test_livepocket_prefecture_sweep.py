import unittest
from datetime import datetime, timezone, timedelta
from livepocket_prefecture_sweep import sweep
from livepocket_prefecture_publish import merge_verified_csv


class SweepTests(unittest.TestCase):
    def test_active_only_and_manual_exclusions(self):
        future = (datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
        past = (datetime.now(timezone.utc)-timedelta(days=1)).isoformat()
        urls = ["https://livepocket.jp/e/testa","https://livepocket.jp/e/testb","https://livepocket.jp/e/testc"]
        raw = {"items":[{"url":u,"stores":[{"name":"テスト店舗本店","prefecture":""}]} for u in urls]}
        pub = {"items":[{"url":u,"application_end_at":future if i!=2 else past,
                          "stores":[{"name":"テスト店舗本店","prefecture":""}]} for i,u in enumerate(urls)]}
        calls = []
        def fetch(url):
            calls.append(url)
            return {"status":"ok","final_url":url,"text":"会場 テスト店舗本店（愛知県）"}
        manifest, stats = sweep(raw,pub,fetch,{urls[1]})
        self.assertEqual(calls,[urls[0]])
        self.assertEqual(stats["verified"],1)
        self.assertEqual(len(manifest["changes"]),1)

    def test_publisher_rejects_manual_override(self):
        url="https://livepocket.jp/e/testa"
        m={"changes":[{"url":url,"store_name":"テスト店舗本店","prefecture":"愛知県","source_url":url}]}
        p={"items":[{"url":url,"stores":[{"name":"テスト店舗本店","prefecture":""}]}]}
        text, count=merge_verified_csv("url,store_name,prefecture,verified,source_url\n",m,p,{url},max_changes=100)
        self.assertEqual(count,0)

if __name__ == "__main__":
    unittest.main()
