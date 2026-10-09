"""Build Tochigi convenience-store CSV from OpenStreetMap.
Data: © OpenStreetMap contributors, ODbL 1.0.
Boundaries: geoBoundaries.
"""
import csv
import os
import tempfile
from pathlib import Path

import osmium
import requests
from shapely.geometry import Point, shape
from shapely.ops import unary_union
from shapely.prepared import prep

PBF_URL = "https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf"
BOUNDARY_API = "https://www.geoboundaries.org/api/current/gbOpen/JPN/"
OUTPUT = Path("tochigi-convenience-stores.csv")


def get_features(level):
    print(f"Downloading {level} boundaries", flush=True)
    r = requests.get(BOUNDARY_API + level + "/", timeout=60)
    r.raise_for_status()
    meta = r.json()
    url = meta.get("simplifiedGeometryGeoJSON") or meta.get("gjDownloadURL")
    if not url:
        raise RuntimeError(f"No geometry URL for {level}")
    r = requests.get(url, timeout=180)
    r.raise_for_status()
    return r.json()["features"]


def feature_name(feature):
    props = feature.get("properties") or {}
    return str(
        props.get("shapeName")
        or props.get("name")
        or props.get("NAME_2")
        or ""
    ).strip()


def get_boundaries():
    prefectures = get_features("ADM1")
    matches = [
        shape(f["geometry"])
        for f in prefectures
        if "Tochigi" in feature_name(f) or "栃木" in feature_name(f)
    ]
    if len(matches) != 1:
        raise RuntimeError("Could not identify Tochigi prefecture")
    prefecture = unary_union(matches)

    municipalities = []
    for f in get_features("ADM2"):
        geometry = shape(f["geometry"])
        if geometry.is_empty:
            continue

        # Keep boundaries located inside Tochigi.
        if not prefecture.covers(geometry.representative_point()):
            continue

        name = feature_name(f)
        if name:
            municipalities.append((name, prep(geometry)))

    print(f"Municipality boundaries: {len(municipalities)}", flush=True)
    return prep(prefecture), municipalities


def normalize_name(name):
    name = str(name or "").strip()
    compact = (
        name.lower()
        .replace(" ", "")
        .replace("-", "")
        .replace("‐", "")
        .replace("‑", "")
        .replace("－", "")
        .replace("・", "")
        .replace("ー", "")
    )

    if "7eleven" in compact or "セブンイレブン" in compact:
        if compact in ("7eleven", "セブンイレブン"):
            return "セブン‐イレブン"
        return "セブン‐イレブン " + name

    if "familymart" in compact or "ファミリーマート" in compact:
        if compact in ("familymart", "ファミリーマート"):
            return "ファミリーマート"
        return "ファミリーマート " + name

    if "lawson" in compact or "ローソン" in compact:
        if compact in ("lawson", "ローソン"):
            return "ローソン"
        return "ローソン " + name

    return name


def chain_name(tags):
    values = " ".join(
        str(tags.get(k) or "")
        for k in ("name", "name:ja", "brand", "brand:ja")
    ).lower()

    if "7-eleven" in values or "7‐eleven" in values or "セブン" in values:
        return "セブン‐イレブン"
    if "familymart" in values or "ファミリーマート" in values:
        return "ファミリーマート"
    if "lawson" in values or "ローソン" in values:
        return "ローソン"
    return ""


class Stores(osmium.SimpleHandler):
    def __init__(self, prefecture, municipalities):
        super().__init__()
        self.prefecture = prefecture
        self.municipalities = municipalities
        self.rows = []
        self.seen = set()

    def add(self, tags, lon, lat):
        shop = tags.get("shop")
        chain = chain_name(tags)

        # Include regular convenience stores and known chains
        # whose shop classification is missing.
        if shop != "convenience" and not (chain and not shop):
            return

        name = (
            tags.get("name:ja")
            or tags.get("name")
            or tags.get("brand:ja")
            or tags.get("brand")
            or chain
        )
        if not name:
            return

        point = Point(lon, lat)
        if not self.prefecture.covers(point):
            return

        name = normalize_name(name)
        city = ""

        for municipality_name, boundary in self.municipalities:
            if boundary.covers(point):
                city = municipality_name
                break

        if not city:
            city = (
                tags.get("addr:city")
                or tags.get("addr:municipality")
                or ""
            )

        lat, lon = round(lat, 7), round(lon, 7)
        key = (name, round(lat, 5), round(lon, 5))
        if key in self.seen:
            return

        self.seen.add(key)
        self.rows.append((name, city, lat, lon))

    def node(self, node):
        if node.location.valid():
            self.add(node.tags, node.location.lon, node.location.lat)

    def way(self, way):
        if way.tags.get("shop") != "convenience" and not (
            chain_name(way.tags) and not way.tags.get("shop")
        ):
            return

        coords = [
            (node.lon, node.lat)
            for node in way.nodes
            if node.location.valid()
        ]
        if not coords:
            return

        lon = sum(x for x, _ in coords) / len(coords)
        lat = sum(y for _, y in coords) / len(coords)
        self.add(way.tags, lon, lat)


def main():
    prefecture, municipalities = get_boundaries()

    with tempfile.TemporaryDirectory() as folder:
        pbf = os.path.join(folder, "kanto.osm.pbf")

        print("Downloading Kanto OSM data", flush=True)
        with requests.get(
            PBF_URL, stream=True, timeout=(30, 180)
        ) as response:
            response.raise_for_status()
            with open(pbf, "wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    if chunk:
                        output.write(chunk)

        handler = Stores(prefecture, municipalities)
        print("Reading store locations", flush=True)
        handler.apply_file(pbf, locations=True, idx="flex_mem")

    rows = sorted(handler.rows)
    if not rows:
        raise RuntimeError("No stores found")

    with OUTPUT.open(
        "w", newline="", encoding="utf-8-sig"
    ) as output:
        writer = csv.writer(output)
        writer.writerow(["name", "city", "lat", "lng"])
        writer.writerows(rows)

    missing_city = sum(not row[1] for row in rows)
    print(f"Exported {len(rows)} stores", flush=True)
    print(f"Stores without municipality: {missing_city}", flush=True)


if __name__ == "__main__":
    main()
