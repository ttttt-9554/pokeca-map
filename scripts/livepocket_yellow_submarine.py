"""Resolve Yellow Submarine generic venue labels using the existing 22-store preset.

A bare chain label does NOT prove that every branch participates. Expand
only when a verified official event heading explicitly names participating
branches or declares the whole chain. Otherwise keep the source unchanged.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

from livepocket_prefecture_manual_snapshot import canonical_event_url
from livepocket_store_name_normalize import normalize

SOURCE = "yellow_submarine_verified_chain_scope_v21_147"
BARE = frozenset(("イエローサブマリン店",))
CHAIN_NAME = "イエローサブマリン"
ALL_STORES = re.compile(r"(?:全店(?:舗)?|全国(?:の)?店舗|全ショップ)")
EXCEPTIONS = re.compile(r"(?:一部(?:店舗)?|除く|除外|限定|のみ|対象店のみ|店舗による)")


def chain_name(value):
    return normalize(value) in BARE


def load_preset(path=Path("yellow_submarine_stores.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    stores = data.get("stores") if isinstance(data, dict) else None
    if not isinstance(stores, list) or len(stores) != 22:
        raise ValueError("Yellow Submarine store list unavailable or incomplete")
    keys = set()
    out = []
    for row in stores:
        if not isinstance(row, dict):
            raise ValueError("Invalid preset row")
        name, pref = row.get("name"), row.get("prefecture")
        if (not isinstance(name, str) or not name.startswith(CHAIN_NAME)
                or not isinstance(pref, str) or not pref.endswith(("都", "道", "府", "県"))):
            raise ValueError("Invalid chain store")
        key = normalize(name)
        if key in keys:
            raise ValueError("Duplicate chain store")
        keys.add(key)
        out.append({"name": name, "prefecture": pref})
    return out


def source_is_generic(row):
    """Do not replace a manually identified branch or a mixed store list."""
    if not isinstance(row, dict):
        return False
    stores = row.get("stores")
    if isinstance(stores, list) and stores:
        if len(stores) != 1 or not isinstance(stores[0], dict):
            return False
        if not chain_name(stores[0].get("name")):
            return False
        # If the generic row already has a proven regional location, the
        # corresponding chain branches cannot be assumed.
        if stores[0].get("prefecture"):
            return False
    elif stores is not None and not isinstance(stores, list):
        return False
    if not chain_name(row.get("store_name")) and not (
        isinstance(stores, list) and len(stores) == 1
        and chain_name(stores[0].get("name"))
    ):
        return False
    return True


def trusted_titles(rows):
    """Consider only official-verified titles and explicit venue labels."""
    texts = set()
    for row in rows:
        if row.get("event_title_provisional"):
            continue
        title = row.get("official_event_title")
        if isinstance(title, str) and title.strip():
            texts.add(title.strip())
        sources = row.get("field_sources") or {}
        evidence = sources.get("event_title") if isinstance(sources, dict) else ""
        if isinstance(evidence, str) and evidence.startswith((
            "v14_livepocket_", "v21_official_", "v21_9_official_",
            "v22_official_", "livepocket_exact_venue"
        )):
            verified_title = row.get("event_title")
            if isinstance(verified_title, str) and verified_title.strip():
                texts.add(verified_title.strip())
        venue = row.get("venue_name")
        if isinstance(venue, str) and venue.strip() and (
                isinstance(sources, dict)
                and str(sources.get("venue_name") or "").startswith((
                    "v14_livepocket_", "v21_official_", "v4_verified_"
                ))):
            texts.add(venue.strip())
    return texts


def resolve_branches(titles, preset):
    if not titles:
        return []
    chosen = {}
    for title in titles:
        # Normalization is for comparison only. Never persist a modified title.
        compact = re.sub(r"イエサブ", CHAIN_NAME, normalize(title))
        for store in preset:
            full = normalize(store["name"])
            # "GAMESHOP" and similar suffixes may be followed directly by
            # "抽選", not a literal 店. For city 店 branches, require 店 itself.
            forms = [full]
            if store["name"].endswith(("GAMESHOP", "ゲームショップ", "カードショップ")):
                forms.append(full[:-1])
            if any(form in compact for form in forms):
                chosen[full] = store

    if chosen:
        # A heading with more than one explicit named branch is also valid.
        return [store for store in preset if normalize(store["name"]) in chosen]

    # Never equate a generic chain name with all participating shops.
    for title in titles:
        compact = re.sub(r"イエサブ", CHAIN_NAME, normalize(title))
        if (CHAIN_NAME in compact and ALL_STORES.search(title)
                and not EXCEPTIONS.search(title)):
            return list(preset)
    return []


def apply_chain(raw, public, preset, protected_urls=()):
    protected = set(protected_urls)
    if not isinstance(raw, dict) or not isinstance(public, dict):
        raise ValueError("Paired LivePocket catalogs required")
    rindex = {x.get("url"): x for x in raw.get("items", []) if isinstance(x, dict)}
    pindex = {x.get("url"): x for x in public.get("items", []) if isinstance(x, dict)}
    result = {"events": 0, "stores": 0, "single": 0, "chainwide": 0}
    for url, pubrow in pindex.items():
        if not isinstance(url, str) or canonical_event_url(url) != url or url in protected:
            continue
        rawrow = rindex.get(url)
        if not isinstance(rawrow, dict) or not all(
                source_is_generic(x) for x in (rawrow, pubrow)):
            continue
        evidence = trusted_titles((rawrow, pubrow))
        selected = resolve_branches(evidence, preset)
        if not selected:
            continue
        # Existing event-level prefectures must never be contradicted.
        existing = {x.get("prefecture") for x in (rawrow, pubrow)
                    if x.get("prefecture")}
        if existing and (
                len(selected) != 1 or existing != {selected[0]["prefecture"]}):
            continue
        for row in (rawrow, pubrow):
            row["stores"] = copy.deepcopy(selected)
            if len(selected) == 1:
                row["store_name"] = selected[0]["name"]
                if not row.get("prefecture"):
                    row["prefecture"] = selected[0]["prefecture"]
            sources = row.get("field_sources")
            if not isinstance(sources, dict):
                sources = {}
                row["field_sources"] = sources
            sources["stores"] = SOURCE
            if len(selected) == 1:
                sources.setdefault("store_name", SOURCE)
                sources.setdefault("prefecture", SOURCE)
        result["events"] += 1
        result["stores"] += len(selected)
        result["single" if len(selected) == 1 else "chainwide"] += 1
    return result
