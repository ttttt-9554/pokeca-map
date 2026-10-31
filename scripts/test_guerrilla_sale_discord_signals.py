"""Offline regression checks for the UNCONFIRMED Pokemon sale signal collector."""
import io
import json
import unittest
from datetime import datetime, timedelta, timezone

from guerrilla_sale_discord_signals import (
    collect, digest, explicit_sale, official_url, reports_for_message, send
)

NOW = datetime(2026, 10, 31, 9, 15, tzinfo=timezone.utc)
URL = "https://www.pokemoncenter-online.com/4521329463261.html"


def message(author="111111111111111111", mid="222222222222222222",
            text=None, timestamp=None, bot=False, webhook=False):
    text = text or ("ポケセンでポケモンカード 拡張パック BOX 販売中！ " + URL)
    return {"id": mid, "timestamp": timestamp or NOW.isoformat(),
            "author": {"id": author, "bot": bot}, "content": text,
            "webhook_id": "333333333333333333" if webhook else None}


class Response(io.BytesIO):
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.close()


class ReportTests(unittest.TestCase):
    def test_pokemon_center_product_identity(self):
        self.assertEqual(official_url(URL+"?ref=share#top"), URL)
        self.assertIsNone(official_url("http://www.pokemoncenter-online.com/4521329463261.html"))
        self.assertIsNone(official_url("https://pokemoncenter-online.com/4521329463261.html"))
        self.assertIsNone(official_url("https://www.pokemoncenter-online.com.evil.com/4521329463261.html"))
        self.assertIsNone(official_url(URL+"?dwvar_4521329463261_color=red"))
        self.assertIsNone(official_url("https://www.pokemoncenter-online.com/search/"))

    def test_explicit_affirmative_sale_only(self):
        self.assertEqual(explicit_sale(message()["content"])[1], "pack")
        self.assertEqual(explicit_sale("ポケカ スタートデッキ 買えた "+URL)[1], "deck")
        for phrase in ("ポケカ 拡張パック 予約開始", "ポケカ 拡張パック 抽選販売",
                       "ポケカ 拡張パック 在庫なし", "ポケカ 拡張パック まだ販売待ち",
                       "ポケカ デッキケース 販売中", "ポケカ シングルカードBOX販売中",
                       "ポケセンで販売中", "ポケカ 拡張パック 欲しい",
                       "ポケカ 拡張パック 販売開始？"):
            with self.subTest(phrase=phrase):
                # A question or vague message must not become an alert.
                self.assertIsNone(explicit_sale(phrase+" "+URL))

    def test_ignores_bot_webhook_stale_and_future(self):
        self.assertFalse(reports_for_message(message(bot=True), "111111111111111111", NOW))
        self.assertFalse(reports_for_message(message(webhook=True), "111111111111111111", NOW))
        old = (NOW - timedelta(minutes=21)).isoformat()
        self.assertFalse(reports_for_message(message(timestamp=old), "111111111111111111", NOW))
        future = (NOW + timedelta(minutes=2)).isoformat()
        self.assertFalse(reports_for_message(message(timestamp=future), "111111111111111111", NOW))

    def test_hashes_only_no_raw_identifiers_or_text(self):
        rows = reports_for_message(message(), "444444444444444444", NOW)
        self.assertEqual(len(rows),1)
        row=rows[0]
        self.assertEqual(row["url"], URL)
        for key in ("message_hash","author_hash","channel_hash","statement_hash"):
            self.assertEqual(len(row[key]),64)
            self.assertNotIn("111111111111111111",row[key])
        self.assertNotIn("content",row)
        self.assertNotIn("author_id",row)

    def test_embed_url_and_own_text_per_block(self):
        m=message(text="無関係の話題")
        m["embeds"]=[{"url":URL,
                      "title":"ポケモンカード 拡張パック BOX",
                      "description":"ポケセンで販売開始"}]
        self.assertEqual(len(reports_for_message(m,"444444444444444444",NOW)),1)
        m["embeds"]=[{"url":URL,"title":"パック"},
                     {"description":"ポケモンカード 拡張パック 販売中"}]
        self.assertEqual(reports_for_message(m,"444444444444444444",NOW),[])

    def test_multiple_product_urls_not_ambiguous(self):
        body="ポケセンでポケカ 拡張パック 販売中 "+URL+" "+URL.replace("4521329463261","4521329463262")
        self.assertIsNone(explicit_sale(body))

    def test_repeated_message_in_channels_counts_once(self):
        m=message()
        result=collect(["111111111111111111","222222222222222222"],
                       "test",lambda _token,_channel:[m],NOW)
        self.assertEqual(len(result),1)

    def test_distinct_authors_create_distinct_signals(self):
        one=message()
        two=message(author="555555555555555555",mid="666666666666666666",
                    text="ポケモンカードゲーム 拡張パック 在庫あり！ ポケセン "+URL)
        result=collect(["444444444444444444"],"test",
                       lambda _t,_c:[one,two],NOW)
        self.assertEqual(len(result),2)
        self.assertNotEqual(result[0]["author_hash"], result[1]["author_hash"])
        self.assertNotEqual(result[0]["statement_hash"],result[1]["statement_hash"])

    def test_request_uses_private_rpc_and_opaque_service_secret(self):
        def opener(req,timeout):
            self.assertTrue(req.full_url.endswith("/rpc/guerrilla_sale_ingest_reports_v1"))
            self.assertEqual(req.get_method(),"POST")
            self.assertEqual(req.get_header("Apikey"),"sb_secret_test")
            self.assertIsNone(req.get_header("Authorization"))
            posted=json.loads(req.data)
            self.assertEqual(len(posted["p_reports"]),1)
            return Response(json.dumps({"evidence_inserted":1,"unconfirmed_alerts_created":0}).encode())
        got=send(reports_for_message(message(),"444444444444444444",NOW),
                 "sb_secret_test",opener=opener)
        self.assertEqual(got["evidence_inserted"],1)

    def test_no_network_for_empty(self):
        self.assertEqual(send([],"secret")["unconfirmed_alerts_created"],0)


if __name__=="__main__":
    unittest.main()
