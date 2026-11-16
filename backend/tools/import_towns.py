"""匯入全台鄉鎮市區界線（本機 OSM 檔），給「點亮鄉鎮」用。

    uv run --with osmium --with shapely python -m tools.import_towns

Redis：
- townpart:{rid}:{n}  Hash，shape 欄位是 WKT POLYGON（多島的鄉鎮拆成多塊）
- idx:townshape       RediSearch GEOSHAPE 索引 → FT.SEARCH "@shape:[CONTAINS $pt]" 一次查出「這個點在哪個鄉鎮」
                      SQL 要做點在多邊形內通常得裝 PostGIS；這裡是 Redis 內建的空間索引。
- town:{rid}          Hash：名稱、縣市、面積、簡化過的 GeoJSON（畫地圖用）
- towns:all           Set：全部鄉鎮 ID（算完成度的分母）
"""
import argparse
import json
import os
import time

import osmium
import redis
from shapely import wkb
from shapely.geometry import MultiPolygon, Polygon, mapping

PBF = os.path.join(os.path.dirname(__file__), "..", "..", "data", "valhalla", "taiwan-latest.osm.pbf")


class Areas(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.fab = osmium.geom.WKBFactory()
        self.counties, self.towns = [], []
        self.parent = {}  # 鄉鎮 relation id → 縣市名稱（縣市 relation 的 subarea 成員）

    def relation(self, r):
        # 縣市的邊界多邊形有時不完整（例如高雄市），改用 OSM 明確記錄的上下層關係
        if r.tags.get("boundary") == "administrative" and r.tags.get("admin_level") == "4":
            name = r.tags.get("name:zh_TW") or r.tags.get("name")
            for m in r.members:
                if m.type == "r" and m.role == "subarea":
                    self.parent[m.ref] = name

    def area(self, a):
        if a.tags.get("boundary") != "administrative" or a.from_way():
            return
        lv = a.tags.get("admin_level")
        if lv not in ("4", "7", "8"):
            return
        try:
            g = wkb.loads(self.fab.create_multipolygon(a), hex=True)
        except Exception:  # noqa: BLE001  不完整的多邊形略過
            return
        name = a.tags.get("name:zh_TW") or a.tags.get("name")
        item = (a.orig_id(), name, g.buffer(0))
        (self.counties if lv == "4" else self.towns).append(item)


def polys(g):
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def wkt(p: Polygon) -> str:
    return "POLYGON((" + ", ".join(f"{x:.5f} {y:.5f}" for x, y in p.exterior.coords) + "))"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pbf", default=PBF)
    ap.add_argument("--redis", default=os.environ.get("REDIS_URL", "redis://localhost:6390/0"))
    a = ap.parse_args()
    t0 = time.time()
    h = Areas()
    h.apply_file(a.pbf, locations=True, idx="flex_mem")
    # 只留臺灣的縣市（同一個 OSM 檔裡也有對岸福建的行政區）
    counties = [(i, n, g) for i, n, g in h.counties if n and n != "福建省" and ("縣" in n or n.endswith("市"))]
    print(f"讀取：縣市 {len(counties)}、鄉鎮候選 {len(h.towns)}，{time.time() - t0:.0f} 秒")

    r = redis.Redis.from_url(a.redis, decode_responses=True)
    try:
        r.execute_command("FT.DROPINDEX", "idx:townshape")
    except redis.ResponseError:
        pass
    old = list(r.scan_iter("townpart:*", count=5000)) + list(r.scan_iter("town:[0-9]*", count=5000)) + ["towns:all"]
    for i in range(0, len(old), 5000):
        r.delete(*old[i:i + 5000])

    p = r.pipeline(transaction=False)
    kept = 0
    for rid, name, g in h.towns:
        if not name or g.is_empty:
            continue
        rep = g.representative_point()
        county = h.parent.get(rid) or next((cn for _, cn, cg in counties if cg.contains(rep)), None)
        if not county or county == "福建省" or not ("縣" in county or county.endswith("市")):
            continue  # 不在臺灣的縣市裡
        kept += 1
        shape = g.simplify(0.0003, preserve_topology=True)  # 約 30 m，查詢用
        view = g.simplify(0.002, preserve_topology=True)    # 約 200 m，畫地圖用
        for n, part in enumerate(polys(shape)):
            if part.area > 0:
                p.hset(f"townpart:{rid}:{n}", mapping={"code": rid, "shape": wkt(part)})
        area_km2 = g.area * (111.32 * 101.8)  # 臺灣緯度約 24 度的近似換算
        p.hset(f"town:{rid}", mapping={"name": name, "county": county, "area_km2": round(area_km2, 1),
                                       "lon": round(rep.x, 5), "lat": round(rep.y, 5),
                                       "geojson": json.dumps(mapping(view), separators=(",", ":"))})
        p.sadd("towns:all", rid)
    p.execute()
    r.execute_command("FT.CREATE", "idx:townshape", "ON", "HASH", "PREFIX", "1", "townpart:",
                      "SCHEMA", "code", "TAG", "shape", "GEOSHAPE", "FLAT")
    r.hset("meta:towns", mapping={"source": "OpenStreetMap 行政區界（admin_level 7、8）", "count": kept,
                                  "updated": int(time.time() * 1000)})
    by = {}
    for rid in r.smembers("towns:all"):
        c = r.hget(f"town:{rid}", "county")
        by[c] = by.get(c, 0) + 1
    print(f"匯入 {kept} 個鄉鎮市區，{time.time() - t0:.0f} 秒")
    print(dict(sorted(by.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
