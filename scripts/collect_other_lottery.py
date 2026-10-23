#!/usr/bin/env python3
"""Discord links other than X/Twitter; metadata only, no external page requests."""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEST = Path("other_lottery_public.json")
API = "https://discord.com/api/v10"
RE = re.compile(r'https?://[^\s<>"\x27\u3000]+', re.I)
LP = re.compile(r"^https?://(?:www\.)?livepocket\.jp/e/[A-Za-z0-9_-]{4,64}/?$", re.I)
BLOCK = ("x.com", "twitter.com", "t.co", "fxtwitter.com",
         "vxtwitter.com", "fixupx.com",
         # v21.77: Discord notifications link back to this app; these are not
         # external lottery source URLs and must not be re-imported.
         "ttttt-9554.github.io")
PREFS = ("北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県",
 "栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県",
 "石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県",
 "滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県",
 "岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
 "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県","全国")


def valid(url):
    if not isinstance(url, str) or not 12 <= len(url) <= 2000 or "\\" in url:
        return False
    try:
        u = urllib.parse.urlsplit(url)
        host = (u.hostname or "").lower().rstrip(".")
        if u.scheme not in ("https", "http") or not host or "." not in host:
            return False
        if u.username or u.password or u.port not in (None, 80, 443):
            return False
        if not re.fullmatch(r"[a-z0-9.-]+", host):
            return False
        if host.endswith((".local", ".localhost", ".internal")):
            return False
        if any(host == b or host.endswith("." + b) for b in BLOCK):
            return False
        return not bool(LP.fullmatch(url))
    except ValueError:
        return False


def urls(text):
    output = []
    for m in RE.finditer(str(text or "")):
        u = m.group(0).rstrip(".,;:!?)）】]}>。")
        if valid(u) and u not in output:
            output.append(u)
    return output


def links(message):
    found = urls(message.get("content"))
    for embed in message.get("embeds") or []:
        if not isinstance(embed, dict):
            continue
        parts = [embed.get("url"), embed.get("description")]
        parts += [field.get("value") for field in (embed.get("fields") or [])
                  if isinstance(field, dict)]
        for part in parts:
            for u in urls(part):
                if u not in found: found.append(u)
    return found


def make(url, message):
    host = urllib.parse.urlsplit(url).hostname.lower()
    title = ""
    for e in message.get("embeds") or []:
        if url in urls(e.get("url")):
            name = str(e.get("title") or "").strip()
            if 3 <= len(name) <= 160 and "http" not in name.lower():
                title = name
                break
    pref = ""
    for line in str(message.get("content") or "").splitlines():
        label = line.strip().removeprefix("📍").strip()
        if line.strip().startswith("📍") and label in PREFS:
            pref = label
            break
    return {"url":url,"source_site":host[:120],"event_title":title,
            "prefecture":pref,"discord_posted_at":message.get("timestamp") or "",
            "first_detected_at":datetime.now(timezone.utc).isoformat(),
            "review_category":"unknown","application_start_at":None,
            "application_end_at":None,"external_url_unverified":True}


def fetch(token, channel, before=None):
    args = {"limit":100}
    if before: args["before"] = before
    url = API + "/channels/" + channel + "/messages?" + urllib.parse.urlencode(args)
    req = urllib.request.Request(url,headers={
        "Authorization":"Bot " + token,"User-Agent":"PokecaMapExternalCollector/1.0"})
    for retry in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as err:
            if err.code != 429 or retry == 3: raise
            try: delay = float(json.loads(err.read()).get("retry_after", 2))
            except Exception: delay = 2
            time.sleep(min(delay + 0.5, 15))
    return []


def run(data, channels, token, backfill=False, loader=fetch):
    records = {x["url"]:x for x in data.get("items",[]) if valid(x.get("url"))}
    seen = dict(data.get("last_seen_message_ids") or {})
    count = 0
    for channel in channels:
        last = int(seen.get(channel) or 0)
        highest = last
        before = None
        max_pages = 100 if backfill else (3 if last == 0 else 20)
        complete = False
        for _ in range(max_pages):
            messages = loader(token,channel,before)
            count += len(messages)
            if not messages:
                complete = True
                break
            ids = [int(m["id"]) for m in messages]
            highest = max(highest,max(ids))
            for message in messages:
                if not backfill and int(message["id"]) <= last: continue
                for url in links(message):
                    if url not in records:
                        records[url] = make(url,message)
                    else:
                        newer = make(url,message)
                        for k in ("event_title","prefecture"):
                            if not records[url].get(k) and newer.get(k):
                                records[url][k] = newer[k]
            if len(messages) < 100 or (last and min(ids) <= last):
                complete = True
                break
            before = str(min(ids))
        if not complete and last and not backfill:
            raise RuntimeError("Large backlog: checkpoint not advanced")
        seen[channel] = str(highest)
    return {"schema_version":1,"items":list(records.values()),
            "last_seen_message_ids":seen,
            "collected_at":datetime.now(timezone.utc).isoformat(),
            "messages_scanned":count}


def main():
    token = os.getenv("DISCORD_BOT_TOKEN","")
    channels = list(dict.fromkeys(re.findall(r"\d{15,22}",
        os.getenv("DISCORD_CHANNEL_IDS") or os.getenv("DISCORD_CHANNEL_ID",""))))
    if not token or not channels: raise SystemExit("Discord credentials missing")
    data = {"items":[],"last_seen_message_ids":{}}
    if DEST.is_file(): data=json.loads(DEST.read_text(encoding="utf-8"))
    backfill = os.getenv("BACKFILL","false").lower() in ("true","1","yes")
    result=run(data,channels,token,backfill=backfill)
    if (result["items"] != data.get("items") or
        result["last_seen_message_ids"] != data.get("last_seen_message_ids")):
        temp = DEST.with_suffix(".tmp")
        temp.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        temp.replace(DEST)
    print("Non-X links:",len(result["items"]),"Messages scanned:",result["messages_scanned"])


if __name__ == "__main__":
    main()
