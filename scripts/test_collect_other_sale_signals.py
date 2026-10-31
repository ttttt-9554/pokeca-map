"""Offline regression tests for anonymous sale signals in the existing URL collector."""
import json
import unittest
from datetime import datetime, timezone

from collect_other_lottery import run
from guerrilla_sale_discord_signals import summarize_public

URL = "https://www.pokemoncenter-online.com/4521329463261.html"
CH = "111111111111111111"


def msg(mid,author,text,url=URL,bot=False):
    return {
        "id":mid,
        "timestamp":datetime.now(timezone.utc).isoformat(),
        "author":{"id":author,"bot":bot},
        "content":text+" "+url,
        "embeds":[]
    }


def scenario(messages):
    return run({"items":[],"last_seen_message_ids":{}},
               [CH],"fake",loader=lambda token,channel,before=None:messages)


class SaleSignalCollectorTests(unittest.TestCase):
    def test_two_independent_humans_publish_safe_aggregate(self):
        messages=[
            msg("200000000000000001","300000000000000001",
                "ポケセンでポケカ 拡張パック BOX 販売中"),
            msg("200000000000000002","300000000000000002",
                "ポケモンカードゲーム 拡張パック 在庫あり ポケセン")
        ]
        result=scenario(messages)
        signals=result["sale_report_signals"]
        self.assertEqual(len(signals),1)
        self.assertEqual(signals[0]["url"],URL)
        self.assertEqual(signals[0]["report_kind"],"pack")
        self.assertEqual(signals[0]["independent_reporters"],2)
        self.assertEqual(signals[0]["independent_statements"],2)
        sanitized=json.dumps(signals,ensure_ascii=False)
        for secret in ("200000000000000001","300000000000000001",
                       "author_hash","channel_hash","statement_hash",
                       "message_hash","ポケセンでポケカ"):
            self.assertNotIn(secret,sanitized)
        self.assertEqual(result["messages_scanned"],2)

    def test_one_report_or_duplicate_wording_never_triggers(self):
        first=msg("200000000000000001","300000000000000001",
                  "ポケセンでポケカ 拡張パック BOX 販売中")
        self.assertEqual(scenario([first])["sale_report_signals"],[])
        same=msg("200000000000000002","300000000000000002",
                 "ポケセンでポケカ 拡張パック BOX 販売中")
        self.assertEqual(scenario([first,same])["sale_report_signals"],[])

    def test_bots_are_not_independent_sources(self):
        first=msg("200000000000000001","300000000000000001",
                  "ポケセンでポケカ 拡張パック BOX 販売中")
        automated=msg("200000000000000002","300000000000000002",
                      "ポケモンカードゲーム 拡張パック 在庫あり ポケセン",
                      bot=True)
        self.assertEqual(scenario([first,automated])["sale_report_signals"],[])

    def test_different_products_and_kinds_never_correlate(self):
        first=msg("200000000000000001","300000000000000001",
                  "ポケセンでポケカ 拡張パック BOX 販売中")
        second=msg("200000000000000002","300000000000000002",
                   "ポケセンでポケカ 拡張パック BOX 販売中",
                   url=URL.replace("4521329463261","4521329463262"))
        self.assertEqual(scenario([first,second])["sale_report_signals"],[])

    def test_repeated_collect_retains_recent_reports_without_duplicate_messages(self):
        message=msg("200000000000000001","300000000000000001",
                    "ポケセンでポケカ 拡張パック BOX 販売中")
        second=msg("200000000000000002","300000000000000002",
                   "ポケモンカードゲーム 拡張パック 在庫あり ポケセン")
        fresh=scenario([message,second])
        later=run(fresh,[CH],"fake",loader=lambda token,channel,before=None:[message,second])
        self.assertEqual(fresh["sale_report_signals"],later["sale_report_signals"])


if __name__=="__main__":
    unittest.main()
