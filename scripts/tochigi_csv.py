"""Build an offline Tochigi convenience-store CSV from OpenStreetMap.

Source: https://download.geofabrik.de/asia/japan/kanto.html
OSM data © OpenStreetMap contributors, ODbL 1.0.
Municipal boundaries © geoBoundaries (check applicable dataset license).
"""
import csv
import os
import re
import tempfile
import unicodedata
from pathlib import Path

import osmium
import requests
from shapely.geometry import Point, shape
from shapely.prepared import prep

PBF_URL = 'https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf'
BOUNDARY_API = 'https://www.geoboundaries.org/api/current/gbOpen/JPN/'
OUTPUT = Path('tochigi-convenience-stores.csv')

# geoBoundaries commonly supplies English transliterations.
MUNICIPALITIES = {
    'ashikaga': '足利市', 'kanuma': '鹿沼市', 'moka': '真岡市', 'mooka': '真岡市',
    'motegi': '茂木町', 'nasu': '那須町', 'nasushiobara': '那須塩原市',
    'nasukarasuyama': '那須烏山市', 'nasunobara': '那須塩原市',
    'nikko': '日光市', 'nikkō': '日光市', 'oyama': '小山市',
    'otawara': '大田原市', 'ootawara': '大田原市', 'sakura': 'さくら市',
    'sano': '佐野市', 'shimotsuke': '下野市', 'shiobara': '那須塩原市',
    'tochigi': '栃木市', 'utsunomiya': '宇都宮市', 'yaita': '矢板市',
    'haga': '芳賀町', 'ichikai': '市貝町', 'kaminokawa': '上三川町',
    'mashiko': '益子町', 'mibu': '壬生町', 'nakagawa': '那珂川町',
    'naka-gawa': '那珂川町', 'nishikata': '栃木市', 'nogi': '野木町',
    'shioya': '塩谷町', 'takanezawa': '高根沢町', 'tsuga': '栃木市',
    'nasu-karasuyama': '那須烏山市', 'nasu-shiobara': '那須塩原市',
    'utsunomiya-shi': '宇都宮市', 'ashikaga-shi': '足利市',
}


def compact(value):
    value = unicodedata.normalize('NFKC', str(value or '')).lower()
    return re.sub(r'[\s\-‐‑‒–—―ー・_]', '', value)


def municipality_name(value):
    name = str(value or '').strip()
    if not name:
        return ''
    if re.search(r'[市町村区]$', name) and re.search(r'[一-龯ぁ-んァ-ン]', name):
        return name
    return MUNICIPALITIES.get(compact(name), name)


def fetch_features(level):
    print(f'Downloading {level} boundaries', flush=True)
    response = requests.get(BOUNDARY_API + level + '/', timeout=60)
    response.raise_for_status()
    meta = response.json()
    url = meta.get('gjDownloadURL') or meta.get('simplifiedGeometryGeoJSON')
    if not url:
        raise RuntimeError(f'Missing geometry URL for {level}')
    response = requests.get(url, timeout=180)
    response.raise_for_status()
    return response.json()['features']


def feature_name(feature):
    props = feature.get('properties') or {}
    return str(props.get('shapeName') or props.get('name') or props.get('NAME_2') or '').strip()


def load_boundaries():
    prefectures = [shape(f['geometry']) for f in fetch_features('ADM1')
                   if compact(feature_name(f)) in ('tochigi', '栃木県')]
    if len(prefectures) != 1:
        raise RuntimeError(f'Expected one Tochigi prefecture, found {len(prefectures)}')
    prefecture = prefectures[0]
    municipalities = []
    for feature in fetch_features('ADM2'):
        geometry = shape(feature['geometry'])
        if geometry.is_empty or not prefecture.covers(geometry.representative_point()):
            continue
        raw_name = feature_name(feature)
        city = municipality_name(raw_name)
        if city:
            municipalities.append((city, prep(geometry)))
    print(f'Municipality polygons: {len(municipalities)}', flush=True)
    return prep(prefecture), municipalities


def chain_name(tags):
    candidates = [tags.get(k) or '' for k in ('brand:ja', 'brand', 'name:ja', 'name', 'operator')]
    for raw in candidates:
        s = compact(raw)
        if '7eleven' in s or 'セブンイレブン' in s:
            return 'セブン‐イレブン'
        if 'familymart' in s or 'ファミリーマート' in s:
            return 'ファミリーマート'
        if 'lawson' in s or 'ローソン' in s:
            return 'ローソン'
    return ''


def store_name(tags):
    chain = chain_name(tags)
    raw_name = str(tags.get('name:ja') or tags.get('name') or '').strip()
    branch = str(tags.get('branch:ja') or tags.get('branch') or '').strip()
    if not chain:
        return raw_name or str(tags.get('brand:ja') or tags.get('brand') or '').strip()

    prefixes = ('セブン‐イレブン', 'セブンイレブン', '7-Eleven',
                'ファミリーマート', 'FamilyMart', 'ローソン', 'Lawson')

    def strip_prefixes(value):
        # Strip *repeated* chain prefixes, e.g. "セブン‐イレブン セブン‐イレブン ○○店".
        value = value.strip()
        while value:
            previous = value
            for prefix in prefixes:
                if compact(value).startswith(compact(prefix)):
                    # Prefix variants differ in punctuation and width. Find the
                    # shortest original-text prefix whose compact form matches.
                    wanted = compact(prefix)
                    for index in range(1, len(value) + 1):
                        if compact(value[:index]) == wanted:
                            value = value[index:].lstrip(' \u3000-‐－・')
                            break
                    break
            if value == previous:
                break
        return value

    suffix = strip_prefixes(raw_name)
    if suffix and compact(suffix) != compact(chain):
        return f'{chain} {suffix}'
    branch_suffix = strip_prefixes(branch)
    if branch_suffix:
        return f'{chain} {branch_suffix}'
    return chain


class Stores(osmium.SimpleHandler):
    def __init__(self, prefecture, municipalities):
        super().__init__()
        self.prefecture = prefecture
        self.municipalities = municipalities
        self.rows = []
        self.seen = set()

    def eligible(self, tags):
        shop = tags.get('shop')
        return shop == 'convenience' or (not shop and bool(chain_name(tags)))

    def add(self, tags, lon, lat):
        if not self.eligible(tags):
            return
        name = store_name(tags)
        if not name:
            return
        point = Point(lon, lat)
        if not self.prefecture.covers(point):
            return
        city = next((name for name, boundary in self.municipalities if boundary.covers(point)), '')
        if not city:
            city = municipality_name(tags.get('addr:city') or tags.get('addr:municipality'))
        lat, lon = round(lat, 7), round(lon, 7)
        # Name-independent deduplication within roughly 1 meter.
        key = (round(lat, 5), round(lon, 5))
        if key in self.seen:
            return
        self.seen.add(key)
        self.rows.append((name, city, lat, lon))

    def node(self, node):
        if node.location.valid():
            self.add(node.tags, node.location.lon, node.location.lat)

    def way(self, way):
        if not self.eligible(way.tags):
            return
        coords = [(node.lon, node.lat) for node in way.nodes if node.location.valid()]
        if not coords:
            return
        # Avoid counting the repeated closing node twice for closed polygons.
        if len(coords) > 1 and coords[0] == coords[-1]:
            coords.pop()
        self.add(way.tags,
                 sum(x for x, _ in coords) / len(coords),
                 sum(y for _, y in coords) / len(coords))


def main():
    prefecture, municipalities = load_boundaries()
    with tempfile.TemporaryDirectory() as directory:
        pbf = os.path.join(directory, 'kanto.osm.pbf')
        print('Downloading Kanto OSM extract', flush=True)
        with requests.get(PBF_URL, stream=True, timeout=(30, 180)) as response:
            response.raise_for_status()
            with open(pbf, 'wb') as output:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        output.write(chunk)
        handler = Stores(prefecture, municipalities)
        handler.apply_file(pbf, locations=True, idx='flex_mem')
    rows = sorted(handler.rows, key=lambda r: (r[1], r[0], r[2], r[3]))
    if not rows:
        raise RuntimeError('No stores found; refusing to overwrite CSV')
    with OUTPUT.open('w', newline='', encoding='utf-8-sig') as output:
        writer = csv.writer(output)
        writer.writerow(('name', 'city', 'lat', 'lng'))
        writer.writerows(rows)
    print(f'Exported {len(rows)} stores to {OUTPUT}', flush=True)
    print(f'Missing municipality: {sum(not r[1] for r in rows)}', flush=True)
    print('Source: OpenStreetMap contributors, ODbL 1.0', flush=True)


if __name__ == '__main__':
    main()
