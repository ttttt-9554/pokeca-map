#!/usr/bin/env python3
"""Read one official search group and write a reviewable, idempotent SQL import.

Example: python scripts/import_pokemon_card_set.py 961 '30th CELEBRATION'
         '30th CELEBRATION' /tmp/pokemon-card-set.sql

Store only card identifiers, names, set marks and printed numbers. The SQL
can be applied by the database operator after inspecting the generated rows.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen


ORIGIN = 'https://www.pokemon-card.com'
DETAIL = '/card-search/details.php/card/'
SPACING = 1.0  # Share the request rate between all workers.
MAX_PAGES = 30


def compact(value):
    return ' '.join(value.split())


class Detail(HTMLParser):
    def __init__(self):
        super().__init__()
        self.heading = []
        self.subtext = []
        self.set_code = None
        self.url = ''
        self.in_heading = False
        self.subtext_depth = 0
        self.found_subtext = False

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        classes = fields.get('class', '').split()
        if tag == 'meta' and fields.get('property') == 'og:url':
            self.url = fields.get('content', '')
        if tag == 'h1' and 'Heading1' in classes:
            self.in_heading = True
        if tag == 'div':
            if self.subtext_depth:
                self.subtext_depth += 1
            elif 'subtext' in classes:
                self.found_subtext = True
                self.subtext_depth = 1
        if tag == 'img' and self.subtext_depth and 'img-regulation' in classes:
            value = fields.get('alt', '')
            if re.fullmatch(r'[A-Za-z0-9+/\-]{1,20}', value):
                self.set_code = value

    def handle_endtag(self, tag):
        if tag == 'h1':
            self.in_heading = False
        if tag == 'div' and self.subtext_depth:
            self.subtext_depth -= 1

    def handle_data(self, data):
        if self.in_heading:
            self.heading.append(data)
        if self.subtext_depth:
            self.subtext.append(data)


def read_printing(html, card_id):
    detail = Detail()
    detail.feed(html)
    if detail.url != f'{ORIGIN}{DETAIL}{card_id}/regu/all' or not compact(''.join(detail.heading)):
        raise ValueError(f'Expected an official detail page for card {card_id}')
    if not detail.found_subtext:
        raise ValueError(f'Card {card_id} has no detail metadata block')
    text = compact(''.join(detail.subtext))
    found = re.search(r'(?<![0-9A-Za-z])([0-9]{1,5}[A-Za-z]?)\s*/\s*([0-9]{1,5}|[A-Za-z0-9-]{1,12}/P)(?![0-9A-Za-z])', text)
    return detail.set_code, '/'.join(found.groups()) if found else None


class Source:
    def __init__(self):
        self.start_lock = threading.Lock()
        self.stopped = threading.Event()
        self.last_start = 0.0

    def get(self, path):
        for attempt in range(2):
            with self.start_lock:
                self.stopped.wait(max(0, self.last_start + SPACING - time.monotonic()))
                if self.stopped.is_set():
                    raise RuntimeError('Import stopped after a source error')
                self.last_start = time.monotonic()
            try:
                with urlopen(ORIGIN + path, timeout=25) as response:
                    if response.geturl() != ORIGIN + path:
                        raise ValueError('Official URL redirected unexpectedly')
                    data = response.read(1_000_001)
                    if len(data) > 1_000_000:
                        raise ValueError('Official response was larger than expected')
                    return data.decode('utf-8')
            except HTTPError as error:
                if error.code not in (500, 502, 503, 504) or attempt:
                    self.stopped.set()
                    raise
            except (TimeoutError, URLError):
                if attempt:
                    self.stopped.set()
                    raise
            self.stopped.wait(3)

    def cards(self, group, title):
        cards = []
        expected = None
        for page in range(1, MAX_PAGES + 1):
            query = urlencode({'keyword': '', 'se_ta': '', 'regulation_sidebar_form': 'all',
                               'pg': group, 'illust': '', 'sm_and_keyword': 'true', 'page': page})
            result = json.loads(self.get('/card-search/resultAPI.php?' + query))
            counts = (int(result['hitCnt']), int(result['maxPage']))
            if expected is None:
                expected = counts
            if (str(result['result']) != '1' or int(result['thisPage']) != page
                    or counts != expected or not 1 <= counts[1] <= MAX_PAGES
                    or not any(title in s for s in result['searchCondition'])):
                raise ValueError('Official search response does not match the requested group')
            for row in result['cardList']:
                name = compact(row['cardNameAltText'])
                card_id = int(row['cardID'])
                if not 0 < card_id <= 2147483647 or not 1 <= len(name) <= 160:
                    raise ValueError('Invalid official card ID or name')
                cards.append((card_id, name))
            if page == counts[1]:
                break
        if len(cards) != expected[0] or len({i for i, _ in cards}) != len(cards):
            raise ValueError('Official search pages were incomplete or contained duplicates')
        return cards

    def printing(self, card):
        card_id, name = card
        try:
            code, number = read_printing(self.get(f'{DETAIL}{card_id}/regu/all'), card_id)
        except Exception:
            self.stopped.set()
            raise
        return card_id, name, code, number


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, int):
        return str(value)
    return "'" + value.replace("'", "''") + "'"


def render_import(group, product_name, title, cards):
    card_rows = ',\n'.join('  (' + ', '.join(map(literal, row)) + ')' for row in cards)
    entry_rows = ',\n'.join(f'  ({group}, {row[0]}, {position})'
                           for position, row in enumerate(cards, start=1))
    return f"""-- Source: {ORIGIN}/card-search/index.php?pg={group}&regulation_sidebar_form=all
BEGIN;
INSERT INTO public.pokemon_card_sets_v1 (official_group_id, product_id, title)
VALUES ({group}, (SELECT id FROM public.catalog_products
  WHERE genre = 'pokemon' AND name = {literal(product_name)}), {literal(title)})
ON CONFLICT (official_group_id) DO UPDATE SET product_id=excluded.product_id, title=excluded.title;

INSERT INTO public.pokemon_cards_v1 (card_id, name, set_code, card_number) VALUES
{card_rows}
ON CONFLICT (card_id) DO UPDATE SET name=excluded.name, set_code=excluded.set_code,
  card_number=excluded.card_number;

INSERT INTO public.pokemon_card_set_entries_v1 (official_group_id, card_id, sort_order) VALUES
{entry_rows}
ON CONFLICT (official_group_id, card_id) DO UPDATE SET sort_order=excluded.sort_order;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('group', type=int)
    parser.add_argument('product_name')
    parser.add_argument('title')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    title = compact(args.title)
    if not 0 < args.group <= 2147483647 or not 1 <= len(title) <= 200 or not args.product_name.strip():
        parser.error('Specify a valid official product group and title')
    source = Source()
    cards = source.cards(args.group, title)
    print(f'Official search returned {len(cards)} cards. Checking detail pages.', flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        printings = []
        for row in pool.map(source.printing, cards):
            printings.append(row)
            if len(printings) % 25 == 0:
                print(f'Checked {len(printings)}/{len(cards)} cards.', flush=True)
    args.output.write_text(render_import(args.group, args.product_name, title, printings), encoding='utf-8')
    print(f'Ready: {len(printings)} cards, {sum(row[3] is not None for row in printings)} numbered.')


if __name__ == '__main__':
    main()
