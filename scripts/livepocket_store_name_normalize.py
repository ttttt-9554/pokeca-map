"""Store-name normalization matching private.lottery_store_norm_v1 in Supabase."""
import re

NORMALIZE_RE = re.compile(r"[\s　・･._－（）()【】「」-]+")


def normalize(name):
    if not isinstance(name, str):
        return ""
    key = NORMALIZE_RE.sub("", name.strip().lower())
    key = re.sub(r"様$", "", key)
    key = re.sub(r"^イエサブ", "イエローサブマリン", key)
    if key.startswith("イエローサブマリン") and not key.endswith("店"):
        key += "店"
    return key
