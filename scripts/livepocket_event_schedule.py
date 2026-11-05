"""Extract labelled announcement and purchase dates from verified event text."""
from datetime import date, datetime, timedelta
import re
import unicodedata

from livepocket_v11 import JST


ANNOUNCEMENT_FIELDS = ('result_announcement_date', 'result_announcement_time')
PURCHASE_FIELDS = ('purchase_start_date', 'purchase_start_time',
                   'purchase_end_date', 'purchase_end_time')
FIELDS = ANNOUNCEMENT_FIELDS + PURCHASE_FIELDS

LABEL = re.compile(
    r'(?P<result>(?:抽選(?:結果(?:の)?(?:発表)?|発表)|当選(?:結果)?発表|結果発表|当落発表|当選通知)'
    r'(?:予定)?(?:日時|期間|日)?(?:予定)?)'
    r'|(?P<purchase>(?:商品(?:の)?|店頭(?:での)?|当選者様?(?:の)?)?'
    r'(?:ご)?(?:販売|購入(?:可能)?|お?受け?取り?|引き?取り?)期間)'
)
DATE = re.compile(r'(?:(20\d{2})\s*[年/.-]\s*)?(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?!\d)')
SHORT_END = re.compile(r'(\d{1,2})\s*日?(?![\d:/月年時])')
CLOCK = re.compile(r'\s*(\d{1,2})(?:\s*:\s*(\d{2})(?!\d)|\s*時\s*(?:(\d{1,2})分|(半))?)')
WEEKDAY = re.compile(r'\s*\([月火水木金土日](?:曜(?:日)?)?(?:・祝|祝)?\)')
BUSINESS_HOURS = re.compile(r'\s*(?:営業(?:開始|終了)|開店|閉店)(?:時刻|時間|時)?')
RANGE = re.compile(r'\s*(?:[〜~～–—−-]|から)\s*')
OTHER_SALES = re.compile(r'(?:チケット(?:の)?|入場券(?:の)?|抽選|先着|一般|申込|応募|予約)\s*$')


def local_day(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed.astimezone(JST).date() if parsed.tzinfo else parsed.date()


def calendar_day(year, month, day, anchor):
    if year is None and anchor is None:
        return None
    years = (int(year),) if year else (anchor.year - 1, anchor.year, anchor.year + 1)
    days = []
    for candidate in years:
        try:
            days.append(date(candidate, int(month), int(day)))
        except ValueError:
            continue
    if not days:
        return None
    if year:
        return days[0]
    nearest = min(days, key=lambda value: (abs(value - anchor), value < anchor))
    return nearest if abs(nearest - anchor) <= timedelta(days=183) else None


def read_clock(tail):
    match = WEEKDAY.match(tail)
    if match:
        tail = tail[match.end():]
    match = BUSINESS_HOURS.match(tail)
    if match:
        return '', tail[match.end():], True
    match = CLOCK.match(tail)
    if not match:
        return '', tail, False
    hour, colon_minute, japanese_minute, half = match.groups()
    hour, minute = int(hour), int(colon_minute or japanese_minute or ('30' if half else '0'))
    rest = tail[match.end():]
    # Approximate times and store hours do not establish a clock time.
    if hour > 23 or minute > 59 or re.match(r'\s*(?:頃|ごろ|前後|以降|以後|UTC)', rest, re.I):
        return '', rest, False
    return f'{hour:02d}:{minute:02d}', rest, False


def read_period(tail, anchor, *, purchase):
    first = DATE.match(tail.lstrip(' \t\r\n:】]'))
    if not first:
        return None
    tail = first.string[first.end():]
    first_time, tail, business = read_clock(tail)
    separator = RANGE.match(tail)
    first_year, first_month, first_day = first.groups()
    second = DATE.match(tail, separator.end()) if separator else None
    if not first_year and anchor is None and second and second[1]:
        anchor = calendar_day(*second.groups(), None)
    start = calendar_day(first_year, first_month, first_day, anchor)
    if start is None:
        return None
    if not separator:
        if not purchase:
            if re.match(r'\s*(?:以降|以後|から順次|より順次)', tail):
                return None
            other_date = re.match(r'\s*(?:[、,・]|または|と)\s*', tail)
            if other_date and DATE.match(tail, other_date.end()):
                return None
            return (start, first_time)
        if re.match(r'\s*(?:まで|限り)', tail):
            return (None, (start, first_time))
        if business or first_time or re.match(r'\s*(?:より|開始)', tail):
            return ((start, first_time), None)
        return ((start, ''), (start, ''))

    tail = tail[separator.end():]
    if second:
        end_year, end_month, end_day = second.groups()
        if not end_year:
            end_year = start.year + (int(end_month) < start.month)
        end = calendar_day(end_year, end_month, end_day, None)
        tail = second.string[second.end():]
    else:
        short = SHORT_END.match(tail)
        if short:
            end = calendar_day(start.year, start.month, short[1], None)
            tail = tail[short.end():]
        elif first_time and CLOCK.match(tail):
            end = start
        else:
            return ((start, first_time), None) if purchase and not tail.strip() else None
    end_time, _, _ = read_clock(tail)
    if (end is None or end < start or end - start > timedelta(days=183)
            or (end == start and end_time and first_time and end_time < first_time)):
        return None
    return ((start, first_time), (end, end_time)) if purchase else (end, end_time)


def same_day(points):
    dates = {day for day, _ in points}
    if len(dates) != 1:
        return None
    times = {clock for _, clock in points if clock}
    return dates.pop(), times.pop() if len(times) == 1 else ''


def extract(text, item):
    if not isinstance(text, str) or not text:
        return {}
    deadline = local_day(item.get('application_end_at'))
    anchor = deadline or local_day(item.get('application_start_at')) or local_day(item.get('discord_posted_at'))
    body = unicodedata.normalize('NFKC', text)
    labels = list(LABEL.finditer(body))
    results, starts, ends = [], [], []
    for i, label in enumerate(labels):
        purchase = label.lastgroup == 'purchase'
        if purchase and OTHER_SALES.search(body[max(0, label.start() - 20):label.start()].split('\n')[-1]):
            continue
        stop = labels[i + 1].start() if i + 1 < len(labels) else len(body)
        point = read_period(body[label.end():min(stop, label.end() + 180)], anchor, purchase=purchase)
        if point is None:
            continue
        if not purchase:
            results.append(point)
            continue
        start, end = point
        # A ticket sales period during applications is not a purchase period
        # for lottery winners. Use the known deadline to reject that overlap.
        if deadline and any(p and p[0] < deadline for p in (start, end)):
            continue
        if start:
            starts.append(start)
        if end:
            ends.append(end)
    fields = {}
    result, start, end = map(same_day, (results, starts, ends))
    if result:
        fields['result_announcement_date'] = result[0].isoformat()
        if result[1]:
            fields['result_announcement_time'] = result[1]
    if ((starts and not start) or (ends and not end)
            or (start and end and (start[0] > end[0] or
                (start[0] == end[0] and start[1] and end[1] and start[1] > end[1])))):
        return fields
    for name, point in (('start', start), ('end', end)):
        if point:
            fields[f'purchase_{name}_date'] = point[0].isoformat()
            if point[1]:
                fields[f'purchase_{name}_time'] = point[1]
    return fields


def apply(raw_row, public_row, fields, *, replace=True):
    changed = False
    for group in (ANNOUNCEMENT_FIELDS, PURCHASE_FIELDS):
        if not any(key in fields for key in group):
            continue
        if not replace and any(row.get(key) for row in (raw_row, public_row) for key in group):
            continue
        for row in (raw_row, public_row):
            for key in group:
                if key in fields:
                    if row.get(key) != fields[key]:
                        row[key] = fields[key]
                        changed = True
                elif key in row:
                    del row[key]
                    changed = True
    return changed


def seed_trial(raw, raw_index, public_index):
    """Use the five existing confirmed observations without visiting old pages."""
    changed = 0
    trial = raw.get('collector_state', {}).get('period_trial_v1', {})
    for entry in trial.get('results', [])[:5]:
        url = entry.get('url')
        if entry.get('status') != 'ok' or url not in raw_index or url not in public_index:
            continue
        snippets = entry.get('result_candidates', []) + entry.get('purchase_candidates', [])
        fields = extract('\n\n'.join(value for value in snippets if isinstance(value, str)), raw_index[url])
        changed += int(apply(raw_index[url], public_index[url], fields, replace=False))
    return changed
