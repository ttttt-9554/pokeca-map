"""Regression tests for unique exact-match store-master LivePocket fallback."""
import copy
import io
import json
import unittest
import urllib.parse

from livepocket_master_prefecture import (
    MIN_SPECIFIC_NAME_LENGTH, SOURCE_NAME,
    apply_master, fetch_manual_locations, fetch_regions, normalize
)

URL = "https://livepocket.jp/e/abcde"
NAME = "ふるいちイオンモール熱田店"
KEY = normalize(NAME)
MASTER = {KEY: "愛知県", normalize("TSUTAYA加須店"): "埼玉県"}


class Response(io.BytesIO):
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.close()


def catalogs(stores=None, legacy=NAME, pref=""):
    item = {"url": URL, "store_name": legacy, "prefecture": pref}
    if stores is not None:
        item["stores"] = copy.deepcopy(stores)
    return {"items": [copy.deepcopy(item)]}, {"items": [copy.deepcopy(item)]}


class LivePocketMasterPrefectureTests(unittest.TestCase):
    def test_normalizer_matches_database_rules(self):
        self.assertEqual(normalize(" ふるいち・イオンモール熱田店 様"), KEY)
        self.assertEqual(normalize("イエサブ池袋"), "イエローサブマリン池袋店")

    def test_single_store_fills_only_unknown_and_keeps_source_label(self):
        raw, public = catalogs([{"name": NAME, "prefecture": ""}])
        self.assertEqual(apply_master(raw, public, MASTER),
                         {"events": 1, "stores": 1})
        for obj in (raw["items"][0], public["items"][0]):
            self.assertEqual(obj["stores"][0]["prefecture"], "愛知県")
            self.assertEqual(obj["prefecture"], "愛知県")
            self.assertEqual(obj["field_sources"]["prefecture"], SOURCE_NAME)
        self.assertEqual(apply_master(raw, public, MASTER),
                         {"events": 0, "stores": 0})

    def test_single_legacy_without_stores_is_enriched_without_inventing_store_rows(self):
        raw, public = catalogs(None)
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 1)
        self.assertEqual(raw["items"][0]["prefecture"], "愛知県")
        self.assertNotIn("stores", public["items"][0])

    def test_multi_store_keeps_distinct_regions_and_no_event_level_guess(self):
        shops = [{"name": NAME, "prefecture": ""},
                 {"name": "TSUTAYA加須店", "prefecture": ""}]
        raw, public = catalogs(shops, "各店")
        result = apply_master(raw, public, MASTER)
        self.assertEqual(result["stores"], 2)
        for event in (raw["items"][0], public["items"][0]):
            self.assertEqual([x["prefecture"] for x in event["stores"]],
                             ["愛知県", "埼玉県"])
            self.assertEqual(event["prefecture"], "")

    def test_generic_chain_label_is_not_a_specific_store(self):
        raw, public = catalogs([{"name": "TSUTAYA", "prefecture": ""}],
                               legacy="TSUTAYA")
        self.assertEqual(apply_master(raw, public, {"tsutaya": "東京都"})["stores"], 0)

    def test_missing_or_ambiguous_store_does_not_guess(self):
        raw, public = catalogs([{"name": "未知の店舗新町店", "prefecture": ""}])
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 0)
        raw, public = catalogs([{"name": "豊橋店", "prefecture": ""}], legacy="豊橋店")
        self.assertEqual(apply_master(raw, public, {"豊橋店": "愛知県"})["stores"], 0)
        self.assertLess(len("豊橋店"), MIN_SPECIFIC_NAME_LENGTH)

    def test_existing_manual_region_remains_even_if_master_differs(self):
        raw, public = catalogs([{"name": NAME, "prefecture": "東京都"}], pref="東京都")
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 0)
        self.assertEqual(public["items"][0]["stores"][0]["prefecture"], "東京都")

    def test_parent_region_conflict_never_fills_single_store(self):
        raw, public = catalogs([{"name": NAME, "prefecture": ""}], pref="東京都")
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 0)
        self.assertEqual(public["items"][0]["stores"][0]["prefecture"], "")

    def test_protected_admin_url_skips_changes(self):
        raw, public = catalogs([{"name": NAME, "prefecture": ""}])
        self.assertEqual(apply_master(raw, public, MASTER, {URL})["stores"], 0)

    def test_different_store_lists_across_raw_and_public_are_skipped(self):
        raw, public = catalogs([{"name": NAME, "prefecture": ""}])
        public["items"][0]["stores"] = [{"name": "TSUTAYA加須店", "prefecture": ""}]
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 0)

    def test_duplicate_store_names_do_not_silently_collapse(self):
        raw, public = catalogs([{"name": NAME, "prefecture": ""},
                                {"name": NAME, "prefecture": ""}])
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 0)

    def test_noncanonical_or_unpaired_event_fails_closed(self):
        raw, public = catalogs([{"name": NAME, "prefecture": ""}])
        public["items"][0]["url"] = "https://livepocket.jp.evil.org/e/abcde"
        self.assertEqual(apply_master(raw, public, MASTER)["stores"], 0)

    def test_backend_rpc_returns_only_valid_unique_keys(self):
        def opener(req, timeout):
            self.assertTrue(req.full_url.endswith("/rpc/lottery_store_unique_regions_v1"))
            self.assertEqual(req.get_method(), "POST")
            self.assertTrue(req.has_header("Apikey"))
            rows = [
                {"norm_name": KEY, "prefecture": "愛知県"},
                {"norm_name": "あいまい大型店舗", "prefecture": "東京都"},
                {"norm_name": "あいまい大型店舗", "prefecture": "千葉県"},
            ]
            return Response(json.dumps(rows).encode("utf-8"))
        found = fetch_regions("https://aypcmtlaaygmiexboypk.supabase.co", "dummy", opener)
        self.assertEqual(found, {KEY: "愛知県"})

    def test_backend_rpc_error_fails_closed(self):
        def opener(req, timeout):
            return Response(json.dumps({"error": "not allowed"}).encode())
        with self.assertRaises(ValueError):
            fetch_regions("https://aypcmtlaaygmiexboypk.supabase.co", "dummy", opener)

    def test_manual_admin_status_blocks_only_relevant_edits(self):
        def opener(req, timeout):
            path = req.full_url.split("/rest/v1/")[1].split("?")[0]
            self.assertEqual(req.get_method(), "GET")
            if path == "livepocket_location_overrides":
                records = [{"event_url": "https://livepocket.jp/e/manual1"}]
            elif path == "lottery_card_overrides":
                records = [
                    {"event_url": "https://livepocket.jp/e/card111", "edited_fields": ["stores"]},
                    {"event_url": "https://livepocket.jp/e/card222",
                     "edited_fields": ["product_name"], "review_complete": False},
                    {"event_url": "https://livepocket.jp/e/card333",
                     "edited_fields": ["product_name"], "review_complete": True}
                ]
            else:
                records = [
                    {"event_url": "https://livepocket.jp/e/removed1", "resolution": "unavailable"},
                    {"event_url": "https://livepocket.jp/e/title11", "resolution": "title"}
                ]
            return Response(json.dumps(records).encode())
        blocked = fetch_manual_locations(
            "https://aypcmtlaaygmiexboypk.supabase.co", "dummy", opener)
        self.assertEqual(blocked, {
            "https://livepocket.jp/e/manual1", "https://livepocket.jp/e/card111",
            "https://livepocket.jp/e/card333", "https://livepocket.jp/e/removed1"
        })

    def test_unknown_supabase_origin_is_rejected(self):
        with self.assertRaises(ValueError):
            fetch_regions("https://another.supabase.co", "secret")


if __name__ == "__main__":
    unittest.main()
