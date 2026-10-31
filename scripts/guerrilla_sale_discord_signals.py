#!/usr/bin/env python3
"""Corroborate Pokemon Center sale reports from already-connected Discord channels.

Only explicitly linked official product URLs + affirmative sealed TCG sale
reports from distinct human authors qualify. Never claim official stock status.
Do not store Discord text, usernames, message IDs or channel IDs in Supabase.
No retailer request and no waiting-room access is made here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
import re
from urllib.parse import urlsplit
import urllib.error
import urllib.request

from collect_other_lottery import fetch as fetch_discord
from livepocket_prefecture_manual_snapshot import PROJECT_HOST

MAX_REPORT_AGE = timedelta(minutes=20)
MAX_MESSAGES_PER_RUN = 100
PRODUCT_URL_RE = re.compile(
    r"https://www[.]pokemoncenter-online[.]com/[0-9]{6,20}"
    r"(?:-[A-Za-z0-9_-]+)?[.]html(?:[?#][^\s<>\"']*)?",
    re.I
)
PRODUCT_PATH_RE = re.compile(r"^/[0-9]{6,20}(?:-[A-Za-z0-9_-]+)?[.]html$")
POSITIVE = re.compile(
    r"販売開始|販売中|販売再開|再販(?:開始|中)?|再入荷|"
    r"在庫あり|在庫復活|購入(?:でき|可能|成功)|買えた|買える|"
    r"カート(?:に|へ)?入|販売復活|ゲリラ販売(?:中|開始)",
    re.I
)
NEGATIVE = re.compile(
    r"在庫なし|在庫切れ|品切れ|売り切れ|売切|販売終了|"
    r"買えない|買えません|カートに入らない|"
    r"抽選|予約|待機室|待合室|予告|予定|まだ|未確認|デマ|"
    r"嘘|本当[?？]|情報求む|報告募集中|しそう|可能性|不明",
    re.I
)
POKEMON = re.compile(r"ポケモンカード|ポケカ", re.I)
PACK = re.compile(r"拡張パック|強化拡張|ブースター|パック|BOX|ボックス", re.I)
DECK = re.compile(r"スターター|スタートデッキ|構築デッキ|構築済みデッキ|デッキ", re.I)
SUPPLIES = re.compile(
    r"シングルカード|オリパ|カードケース|デッキケース|"
    r"スリーブ|プレイマット|サプライ|ぬいぐるみ|文具|"
    r"フィギュア|グッズ|保護ケース|カードファイル", re.I
)
DISCORD_ID = re.compile(r"[0-9]{15,22}")
MENTION = re.compile(r"<@!?[0-9]{15,22}>")


def digest(kind, value):
    return hashlib.sha256((kind + ":" + str(value)).encode("utf-8")).hexdigest()


def official_url(url):
    if not isinstance(url, str):
        return None
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https"
                or parsed.netloc.lower() != "www.pokemoncenter-online.com"
                or parsed.username or parsed.password or parsed.port
                or not PRODUCT_PATH_RE.fullmatch(parsed.path)):
            return None
        if any(key.startswith("dwvar_") for key in
               (x.split("=", 1)[0] for x in parsed.query.split("&") if x)):
            return None
        return "https://www.pokemoncenter-online.com" + parsed.path
    except ValueError:
        return None


def evidence_blocks(message):
    """Do not accidentally associate links from different embeds."""
    if isinstance(message.get("content"), str):
        yield message["content"]
    for embed in message.get("embeds") or []:
        if not isinstance(embed, dict):
            continue
        parts = [embed.get("title"), embed.get("description"), embed.get("url")]
        parts += [f.get("value") for f in embed.get("fields") or []
                  if isinstance(f, dict)]
        body = "\n".join(part for part in parts if isinstance(part, str))
        if body:
            yield body


def explicit_sale(block):
    if not isinstance(block, str) or len(block) > 16000:
        return None
    # Ignore questions and hearsay, even if they contain the words
    # "販売開始". Strip official links first so query parameters are safe.
    text_only = PRODUCT_URL_RE.sub("", block)
    if (not POSITIVE.search(text_only) or NEGATIVE.search(text_only)
            or re.search(r"[?？]|らしい|かも|噂|確認中", text_only)
            or not POKEMON.search(text_only) or SUPPLIES.search(text_only)):
        return None
    product_kind = ("pack" if PACK.search(block) and not DECK.search(block)
                    else "deck" if DECK.search(block) and not PACK.search(block)
                    else None)
    if product_kind is None:
        return None
    candidates = {official_url(m.group(0)) for m in PRODUCT_URL_RE.finditer(block)}
    candidates.discard(None)
    if len(candidates) != 1:
        return None
    statement = MENTION.sub("", PRODUCT_URL_RE.sub("", block)).casefold()
    statement = re.sub(r"[\W_]+", "", statement)
    if len(statement) < 6:
        return None
    return next(iter(candidates)), product_kind, statement[:1200]


def reports_for_message(message, channel, now=None):
    if not isinstance(message, dict) or message.get("webhook_id"):
        return []
    author = message.get("author") or {}
    if not isinstance(author, dict) or author.get("bot"):
        return []
    mid, aid = str(message.get("id") or ""), str(author.get("id") or "")
    if not DISCORD_ID.fullmatch(mid) or not DISCORD_ID.fullmatch(aid):
        return []
    ts = message.get("timestamp")
    try:
        stamp = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return []
        stamp = stamp.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return []
    now = now or datetime.now(timezone.utc)
    if stamp < now - MAX_REPORT_AGE or stamp > now + timedelta(seconds=90):
        return []

    results = {}
    for block in evidence_blocks(message):
        match = explicit_sale(block)
        if not match:
            continue
        url, kind, statement = match
        # A conflicting classification in one message is not evidence.
        if url in results and results[url]["report_kind"] != kind:
            results.pop(url, None)
            continue
        results[url] = {
            "url": url,
            "report_kind": kind,
            "posted_at": stamp.isoformat(),
            "message_hash": digest("discord-message-v1", mid + "|" + url),
            "author_hash": digest("discord-user-v1", aid),
            "channel_hash": digest("discord-channel-v1", channel),
            "statement_hash": digest("discord-statement-v1", statement),
        }
    # A roundup that links multiple different product URLs cannot be mapped
    # confidently to individual stock reports without further context.
    return list(results.values()) if len(results) == 1 else []


def collect(channels, token, loader=fetch_discord, now=None):
    now = now or datetime.now(timezone.utc)
    records = {}
    for channel in channels[:20]:
        messages = loader(token, channel)
        if not isinstance(messages, list):
            raise RuntimeError("Invalid Discord response")
        for message in messages[:100]:
            for report in reports_for_message(message, channel, now):
                records[report["message_hash"]] = report
    return sorted(records.values(), key=lambda r: r["posted_at"], reverse=True)[
        :MAX_MESSAGES_PER_RUN
    ]


def summarize_public(reports, now=None):
    """Output only anonymous aggregate evidence; no raw or hashed identities.

    Published signals cannot claim verified stock. The privileged backend
    independently validates time, retailer URL, vote count and deduplication.
    """
    now = now or datetime.now(timezone.utc)
    by_url = {}
    for row in reports:
        try:
            posted = datetime.fromisoformat(str(row["posted_at"]).replace("Z", "+00:00"))
        except (KeyError, ValueError, TypeError):
            continue
        if (posted.tzinfo is None or posted < now - timedelta(minutes=15)
                or posted > now + timedelta(seconds=90)):
            continue
        url = official_url(row.get("url"))
        if not url or row.get("report_kind") not in ("pack", "deck"):
            continue
        target = by_url.setdefault(url, [])
        target.append((posted, row))

    result = []
    for url, evidences in by_url.items():
        authors = {row["author_hash"] for _, row in evidences}
        statements = {row["statement_hash"] for _, row in evidences}
        kinds = {row["report_kind"] for _, row in evidences}
        if len(authors) < 2 or len(statements) < 2 or len(kinds) != 1:
            continue
        result.append({
            "url": url,
            "report_kind": next(iter(kinds)),
            "independent_reporters": min(len(authors), 20),
            "independent_statements": min(len(statements), 20),
            "independent_channels": min(len({row["channel_hash"] for _, row in evidences}), 20),
            "latest_at": max(posted for posted, _ in evidences).isoformat(),
        })
    return sorted(result, key=lambda r: r["latest_at"], reverse=True)[:30]


def send(reports, service_key, base="https://" + PROJECT_HOST,
         opener=urllib.request.urlopen):
    if not reports:
        return {"evidence_inserted": 0, "unconfirmed_alerts_created": 0}
    if (base != "https://" + PROJECT_HOST
            or not service_key
            or not isinstance(reports, list)
            or len(reports) > MAX_MESSAGES_PER_RUN):
        raise ValueError("Invalid server configuration")
    headers = {"apikey": service_key, "Content-Type": "application/json"}
    if service_key.startswith("eyJ"):
        headers["Authorization"] = "Bearer " + service_key
    req = urllib.request.Request(
        base + "/rest/v1/rpc/guerrilla_sale_ingest_reports_v1",
        headers=headers, method="POST",
        data=json.dumps({"p_reports": reports}, ensure_ascii=False).encode()
    )
    try:
        with opener(req, timeout=20) as res:
            if res.status != 200:
                raise RuntimeError("Report ingestion was not accepted")
            data = json.load(res)
    except urllib.error.HTTPError as ex:
        # Never log a response body or authorization credentials.
        raise RuntimeError("Report ingestion HTTP " + str(ex.code)) from None
    if not isinstance(data, dict) or not isinstance(
            data.get("unconfirmed_alerts_created"), int):
        raise RuntimeError("Unexpected report ingestion response")
    return data


def main():
    channels = list(dict.fromkeys(DISCORD_ID.findall(
        os.getenv("DISCORD_CHANNEL_IDS") or os.getenv("DISCORD_CHANNEL_ID", "")
    )))
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    service = os.getenv("SUPABASE_SECRET_KEY") or os.getenv(
        "SUPABASE_SERVICE_ROLE_KEY", "")
    if not channels or not token or not service:
        raise SystemExit("Report sources or service credentials unavailable")
    reports = collect(channels, token)
    result = send(reports, service)
    print("Pokemon Center report signals:", len(reports),
          "accepted:", result.get("evidence_inserted", 0),
          "UNCONFIRMED alerts:", result["unconfirmed_alerts_created"])


if __name__ == "__main__":
    main()
