"""Read the event's labelled overview from its already downloaded HTML.

The store is the venue, not the seller/company or a recommended event.  This
parser is also used on browser page.content(), so it needs no extra request.
"""
from html.parser import HTMLParser
import re

from livepocket_enrich import VisibleHTML


VOID = frozenset(('area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                  'link', 'meta', 'param', 'source', 'track', 'wbr'))
IGNORE = frozenset(('script', 'style', 'noscript', 'svg', 'template'))


def clean(text):
    return re.sub(r'\s+', ' ', text).strip()


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        if self.tag in IGNORE:
            return ''
        return ''.join(child.text() if isinstance(child, Node) else child
                       for child in self.children)


class OverviewHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def unique(values):
    values = {clean(value) for value in values if clean(value)}
    return next(iter(values)) if len(values) == 1 else ''


def venue_parts(node):
    """Keep the full branch (even inside a span/anchor), separate the address."""
    parts = []
    for child in node.children:
        if isinstance(child, str):
            if clean(child):
                parts.append(clean(child))
        elif child.tag not in IGNORE and not (
            'link-box' in child.attrs.get('class', '')
            or '/map' in child.attrs.get('href', '')
        ):
            if child.tag == 'div':
                name, address = venue_parts(child)
                parts.extend(value for value in (name, address) if value)
                continue
            value = clean(child.text())
            if value and not re.search(r'マップ|アクセス方法', value):
                parts.append(value)
    if not parts:
        return '', ''
    # The venue label is the first value; subsequent spans are its address.
    # A separately wrapped prefecture is still part of the venue label.
    name = parts.pop(0)
    if parts and re.fullmatch(r'[（(][^（）()]{2,5}[）)]', parts[0]):
        name += ' ' + parts.pop(0)
    return name, clean(' '.join(parts))


def overview_from_html(html):
    if not isinstance(html, str) or len(html) > 2_000_000:
        return {}
    parser = OverviewHTML()
    parser.feed(html)
    venues, sellers, addresses = [], [], []
    for block in parser.root.walk():
        if 'event-detail-info__block' not in block.attrs.get('class', '').split():
            continue
        labels = [child for child in block.children if isinstance(child, Node) and child.tag == 'dt']
        values = [child for child in block.children if isinstance(child, Node) and child.tag == 'dd']
        if len(labels) != 1 or len(values) != 1:
            continue
        label = clean(labels[0].text())
        if label in ('会場', '会場名', '開催場所'):
            venue, address = venue_parts(values[0])
            venues.append(venue)
            addresses.append(address)
        elif label in ('販売元', '主催者'):
            sellers.append(clean(values[0].text()))
    result = {'overview_venue': unique(venues), 'overview_seller': unique(sellers)}
    if result['overview_venue'] and unique(addresses):
        result['overview_address'] = unique(addresses)
    return result


def observation_from_html(html, url):
    """An offline equivalent of the normal exact-event browser observation."""
    visible = VisibleHTML()
    visible.feed(html)
    tree = OverviewHTML()
    tree.feed(html)
    headings = [clean(node.text()) for node in tree.root.walk() if node.tag == 'h1']
    return {'status': 'ok', 'final_url': url, 'text': '\n'.join(visible.lines()),
            'titles': headings, 'title_sources': ['h1'] * len(headings),
            **overview_from_html(html)}
