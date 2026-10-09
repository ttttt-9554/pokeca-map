import csv, json, requests, sys
from shapely.geometry import shape, Point
from shapely.ops import unary_union

API='https://www.geoboundaries.org/api/current/gbOpen/JPN/ADM1/'
meta=requests.get(API,timeout=45);meta.raise_for_status();meta=meta.json()
url=meta.get('simplifiedGeometryGeoJSON') or meta.get('gjDownloadURL')
if not url: raise RuntimeError('geoBoundaries returned no GeoJSON URL')
resp=requests.get(url,timeout=90);resp.raise_for_status();geo=resp.json()
features=geo.get('features',[])
selected=[]
for f in features:
 p=f.get('properties') or {}
 names=' '.join(str(p.get(k,'')) for k in ('shapeName','name','NAME_1','name_en','name_ja'))
 if 'Tochigi' in names or '栃木' in names:
  selected.append(shape(f['geometry']))
if len(selected)!=1:
 available=[(f.get('properties') or {}).get('shapeName') for f in features]
 raise RuntimeError(f'Could not uniquely identify Tochigi prefecture ({len(selected)} matches). Available: {available}')
polygon=unary_union(selected)
rows=[];seen=set()
with open('convenience.geojson',encoding='utf-8') as f:
 data=json.load(f)
for feat in data.get('features',[]):
 props=feat.get('properties') or {}
 name=props.get('name:ja') or props.get('name')
 if not name or not isinstance(name,str):continue
 geom=feat.get('geometry')
 if not geom:continue
 try:
  g=shape(geom)
  if g.is_empty:continue
  point=g if isinstance(g,Point) else g.representative_point()
  if not polygon.covers(point):continue
  lat,lng=round(point.y,7),round(point.x,7)
  key=(name,round(lat,5),round(lng,5))
  if key in seen:continue
  seen.add(key)
  city=props.get('addr:city') or props.get('addr:municipality') or ''
  rows.append((name,city,lat,lng))
 except Exception as e:
  print('Skipping invalid geometry:',e,file=sys.stderr)
rows.sort(key=lambda x:(x[0],x[1],x[2],x[3]))
if not rows:raise RuntimeError('No stores found: refusing to export empty CSV')
with open('tochigi-convenience-stores.csv','w',newline='',encoding='utf-8-sig') as f:
 w=csv.writer(f);w.writerow(['name','city','lat','lng']);w.writerows(rows)
print('Exported',len(rows),'OSM convenience stores in Tochigi')
