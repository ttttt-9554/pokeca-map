"""Build an offline-importable Tochigi convenience-store CSV from Geofabrik OSM data.

Source: https://download.geofabrik.de/asia/japan/kanto.html
OSM data © OpenStreetMap contributors, ODbL 1.0.
"""
import csv
import os
import sys
import tempfile
from pathlib import Path

import osmium
import requests
from shapely.geometry import Point, shape
from shapely.ops import unary_union

PBF_URL = "https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf"
GEOBOUNDARIES_API = "https://www.geoboundaries.org/api/current/gbOpen/JPN/ADM1/"
OUTPUT = Path("tochigi-convenience-stores.csv")


def get_tochigi_boundary():
    print("Downloading prefecture boundaries from geoBoundaries", flush=True)
    r = requests.get(GEOBOUNDARIES_API, timeout=60)
    r.raise_for_status()
    meta = r.json()
    url = meta.get("simplifiedGeometryGeoJSON") or meta.get("gjDownloadURL")
    if not url:
        raise RuntimeError("geoBoundaries returned no GeoJSON download URL")
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    features = r.json().get("features", [])
    matches = []
    for f in features:
        p = f.get("properties") or {}
        name = " ".join(str(p.get(k, "")) for k in ("shapeName", "name", "NAME_1", "name_en", "name_ja"))
        if "Tochigi" in name or "栃木" in name:
            matches.append(shape(f["geometry"]))
    if len(matches) != 1:
        raise RuntimeError(f"Could not uniquely identify Tochigi: {len(matches)} matches")
    return unary_union(matches)


def download_pbf(destination):
    print("Downloading Kanto OSM extract (this may take several minutes)", flush=True)
    with requests.get(PBF_URL, stream=True, timeout=(30, 180)) as r:
        r.raise_for_status()
        with open(destination, "wb") as out:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    out.write(chunk)
    print(f"Downloaded {os.path.getsize(destination):,} bytes", flush=True)


class Stores(osmium.SimpleHandler):
    def __init__(self, boundary):
        super().__init__()
        self.boundary = boundary
        self.rows = []
        self.seen = set()

    def add(self, tags, lon, lat):
        if tags.get("shop") != "convenience":
            return
        name = tags.get("name:ja") or tags.get("name") or tags.get("brand:ja") or tags.get("brand")
        if not name:
            return
        if not self.boundary.covers(Point(lon, lat)):
            return
        name = str(name).strip()
        if not name:
            return
        city = tags.get("addr:city") or tags.get("addr:municipality") or ""
        lat, lon = round(lat, 7), round(lon, 7)
        key = (name, round(lat, 5), round(lon, 5))
        if key in self.seen:
            return
        self.seen.add(key)
        self.rows.append((name, city, lat, lon))

    def node(self, n):
        if n.location.valid():
            self.add(n.tags, n.location.lon, n.location.lat)

    def way(self, w):
        if w.tags.get("shop") != "convenience":
            return
        coords = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        if not coords:
            return
        # Representative point of mapped building footprint (centroid approximation).
        lon = sum(x for x, _ in coords) / len(coords)
        lat = sum(y for _, y in coords) / len(coords)
        self.add(w.tags, lon, lat)


def main():
    boundary = get_tochigi_boundary()
    with tempfile.TemporaryDirectory() as folder:
        pbf = os.path.join(folder, "kanto.osm.pbf")
        download_pbf(pbf)
        handler = Stores(boundary)
        print("Reading convenience-store nodes and ways", flush=True)
        handler.apply_file(pbf, locations=True, idx="flex_mem")
    rows = sorted(handler.rows, key=lambda x: (x[0], x[1], x[2], x[3]))
    if not rows:
        raise RuntimeError("No convenience stores found; refusing to create empty CSV")
    with OUTPUT.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["name", "city", "lat", "lng"])
        writer.writerows(rows)
    print(f"Exported {len(rows)} convenience stores to {OUTPUT}", flush=True)
    print("Source: OpenStreetMap contributors, ODbL 1.0; Geofabrik Kanto extract", flush=True)


if __name__ == "__main__":
    main()
