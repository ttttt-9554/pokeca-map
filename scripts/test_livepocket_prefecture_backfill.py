import unittest
from datetime import datetime, timezone, timedelta
from livepocket_prefecture_backfill import select, backfill


class BackfillTests(unittest.TestCase):
    def data(self):
        url="https://livepocket.jp/e/hkxb0"
        end=(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()
        raw={"items":[{"url":url,"stores":[{"name":"ふるいちイオンモール木曽川店","prefecture":""}]}]}
        pub={"items":[{"url":url,"application_end_at":end,"stores":[{"name":"ふるいちイオンモール木曽川店","prefecture":""}]}]}
        return raw,pub,url

    def test_select_and_fill(self):
        raw,pub,url=self.data()
        self.assertEqual(select(raw,pub,datetime.now(timezone.utc),manual_override_urls=set()),[url])
        def fetch(u):
            return {"status":"ok","final_url":u,"text":"概要\n会場\nふるいちイオンモール木曽川店（愛知県）"}
        self.assertEqual(backfill(raw,pub,fetch,manual_override_urls=set())["updated"],1)
        self.assertEqual(pub["items"][0]["prefecture"],"愛知県")

    def test_supabase_manual_override_excluded(self):
        raw,pub,url=self.data()
        self.assertEqual(select(raw,pub,datetime.now(timezone.utc),manual_override_urls={url}),[])
        with self.assertRaises(ValueError):
            select(raw,pub,datetime.now(timezone.utc))

    def test_offset_skips_earlier_candidate(self):
        raw,pub,url=self.data()
        other="https://livepocket.jp/e/second"
        import copy
        extra_raw=copy.deepcopy(raw["items"][0])
        extra_pub=copy.deepcopy(pub["items"][0])
        extra_raw["url"]=other
        extra_pub["url"]=other
        raw["items"].append(extra_raw)
        pub["items"].append(extra_pub)
        self.assertEqual(select(raw,pub,datetime.now(timezone.utc),
                                manual_override_urls=set(),offset=1),[other])

    def test_never_override(self):
        raw,pub,url=self.data()
        pub["items"][0]["prefecture"]="岐阜県"
        self.assertEqual(select(raw,pub,datetime.now(timezone.utc),manual_override_urls=set()),[])

    def test_expired(self):
        raw,pub,url=self.data()
        pub["items"][0]["application_end_at"]="2020-01-01T00:00:00+09:00"
        self.assertEqual(select(raw,pub,datetime.now(timezone.utc),manual_override_urls=set()),[])

    def test_no_unverified_write(self):
        raw,pub,url=self.data()
        self.assertEqual(backfill(raw,pub,lambda u:{"status":"browser_blocked"},manual_override_urls=set())["updated"],0)


if __name__=="__main__":
    unittest.main()
