"""Regression tests for Yellow Submarine chain preset auto-enrichment."""
import copy
import unittest

from livepocket_yellow_submarine import (
    apply_chain, chain_name, resolve_branches, source_is_generic, trusted_titles
)
from livepocket_store_name_normalize import normalize

URL = "https://livepocket.jp/e/test1"
PRESET = [
    {"name": "イエローサブマリン宇都宮店", "prefecture": "栃木県"},
    {"name": "イエローサブマリン池袋GAMESHOP", "prefecture": "東京都"},
    {"name": "イエローサブマリン横浜店", "prefecture": "神奈川県"},
    {"name": "イエローサブマリン横浜西口店", "prefecture": "神奈川県"}
]


def pair(official=None, *, event_title="", source="", pref="", stores=None):
    item = {
        "url": URL,
        "store_name": "イエローサブマリン",
        "prefecture": pref,
        "event_title": event_title
    }
    if stores is not None:
        item["stores"] = copy.deepcopy(stores)
    if official is not None:
        item["official_event_title"] = official
    if source:
        item["field_sources"] = {"event_title": source}
    return ({"items": [copy.deepcopy(item)]},
            {"items": [copy.deepcopy(item)]})


class YellowSubmarineChainTests(unittest.TestCase):
    def test_generic_alias_only(self):
        self.assertTrue(chain_name("イエローサブマリン"))
        self.assertTrue(chain_name("イエサブ"))
        self.assertFalse(chain_name("イエローサブマリン宇都宮店"))

    def test_bare_chain_name_is_not_automatically_all_stores(self):
        raw, pub = pair()
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)
        self.assertNotIn("stores", pub["items"][0])

    def test_trusted_official_title_resolves_exact_branch(self):
        raw, pub = pair("【イエローサブマリン宇都宮店】新商品抽選")
        result = apply_chain(raw, pub, PRESET)
        self.assertEqual(result["single"], 1)
        self.assertEqual(result["stores"], 1)
        for item in (raw["items"][0], pub["items"][0]):
            self.assertEqual(item["store_name"], "イエローサブマリン宇都宮店")
            self.assertEqual(item["stores"][0]["prefecture"], "栃木県")
            self.assertEqual(item["prefecture"], "栃木県")
            self.assertTrue(item["field_sources"]["stores"].startswith("yellow_submarine"))
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)

    def test_trusted_verified_title_source_is_accepted(self):
        raw, pub = pair(event_title="イエサブ宇都宮店 抽選",
                        source="v14_livepocket_exact_page")
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 1)

    def test_unverified_title_not_allowed_to_pick_branch(self):
        raw, pub = pair(event_title="イエローサブマリン宇都宮店 抽選")
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)

    def test_chainwide_requires_official_all_store_scope(self):
        raw, pub = pair("イエローサブマリン 全店舗キャンペーン")
        result = apply_chain(raw, pub, PRESET)
        self.assertEqual(result["stores"], 4)
        self.assertEqual(result["chainwide"], 1)
        self.assertEqual(len(pub["items"][0]["stores"]), 4)
        self.assertEqual(pub["items"][0]["store_name"], "イエローサブマリン")
        self.assertEqual(pub["items"][0]["prefecture"], "")

    def test_chainwide_exclusions_prevent_auto_expansion(self):
        raw, pub = pair("イエローサブマリン 全店舗（一部店舗除く）")
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)

    def test_explicit_two_branches_only(self):
        raw, pub = pair("イエローサブマリン宇都宮店・イエローサブマリン横浜店で抽選")
        result = apply_chain(raw, pub, PRESET)
        self.assertEqual(result["stores"], 2)
        self.assertEqual([s["name"] for s in pub["items"][0]["stores"]],
                         [PRESET[0]["name"], PRESET[2]["name"]])

    def test_longer_branch_takes_priority(self):
        raw, pub = pair("イエローサブマリン横浜西口店の抽選")
        result = apply_chain(raw, pub, PRESET)
        self.assertEqual(result["stores"], 1)
        self.assertEqual(pub["items"][0]["stores"][0]["name"], PRESET[3]["name"])

    def test_conflicting_prefecture_not_overwritten(self):
        raw, pub = pair("イエローサブマリン宇都宮店 抽選", pref="東京都")
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)
        self.assertEqual(pub["items"][0]["prefecture"], "東京都")

    def test_manual_override_is_respected(self):
        raw, pub = pair("イエローサブマリン宇都宮店 抽選")
        self.assertEqual(apply_chain(raw, pub, PRESET, {URL})["stores"], 0)

    def test_existing_specific_or_multi_shops_not_overwritten(self):
        raw, pub = pair("イエローサブマリン宇都宮店 抽選",
                        stores=[{"name": "イエローサブマリン池袋GAMESHOP", "prefecture": "東京都"}])
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)
        raw, pub = pair("イエローサブマリン全店舗", stores=[
            {"name": "イエローサブマリン", "prefecture": ""},
            {"name": "イエローサブマリン宇都宮店", "prefecture": ""}])
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)

    def test_same_untrusted_brand_in_discord_not_used(self):
        raw, pub = pair()
        for row in (raw["items"][0], pub["items"][0]):
            row["post_excerpt"] = "イエローサブマリン全店舗イベント"
        self.assertEqual(apply_chain(raw, pub, PRESET)["stores"], 0)


if __name__ == "__main__":
    unittest.main()
