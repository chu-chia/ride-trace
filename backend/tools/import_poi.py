"""從本機的台灣 OSM 檔（data/valhalla/taiwan-latest.osm.pbf）匯入地名與 POI，給規劃頁搜尋、沿路線找加油站等用。
全部在本機處理，不呼叫任何外部服務。

    uv run --with osmium python -m tools.import_poi

Redis：
- poi:{id}            Hash：名稱、種類、座標、所在區域
- idx:poi             RediSearch：名稱中文全文、種類 TAG、位置 GEO、重要度 NUMERIC（排序用）
- poi:geo:{kind}      GEO：每一類一個集合，沿路線找「加油站」時對路線上每個取樣點 GEOSEARCH
- sug:poi             FT.SUGADD 自動完成字典（只放地名、車站、景點、山這類名稱不重複的；不放 7-ELEVEN 這種連鎖店）
"""
import argparse
import os
import time

import osmium
import redis

PBF = os.path.join(os.path.dirname(__file__), "..", "..", "data", "valhalla", "taiwan-latest.osm.pbf")

# (tag, 值) → (種類, 重要度, 要不要放進自動完成)
RULES = {
    ("place", "city"): ("place", 100, True), ("place", "town"): ("place", 85, True),
    ("place", "suburb"): ("place", 60, True), ("place", "village"): ("place", 55, True),
    ("place", "hamlet"): ("place", 40, True), ("place", "locality"): ("place", 35, True),
    ("railway", "station"): ("station", 75, True), ("public_transport", "station"): ("station", 70, True),
    ("natural", "peak"): ("peak", 50, True), ("natural", "saddle"): ("peak", 50, True),
    ("tourism", "attraction"): ("sight", 45, True), ("tourism", "viewpoint"): ("sight", 45, True),
    ("historic", "monument"): ("sight", 35, True), ("leisure", "park"): ("sight", 25, True),
    ("amenity", "university"): ("school", 45, True), ("amenity", "college"): ("school", 40, True),
    ("highway", "rest_area"): ("rest", 40, True), ("highway", "services"): ("rest", 40, True),
    ("amenity", "fuel"): ("fuel", 30, False), ("shop", "convenience"): ("convenience", 20, False),
    ("amenity", "restaurant"): ("food", 20, False), ("amenity", "fast_food"): ("food", 15, False),
    ("amenity", "cafe"): ("food", 15, False),
    ("tourism", "hotel"): ("lodging", 25, False), ("tourism", "hostel"): ("lodging", 20, False),
    ("tourism", "guest_house"): ("lodging", 20, False), ("tourism", "motel"): ("lodging", 20, False),
    ("tourism", "camp_site"): ("lodging", 25, True),
    ("amenity", "parking"): ("parking", 5, False),
}
KEYS = {k for k, _ in RULES}


def norm(s: str) -> str:
    return s.replace("台", "臺")


class Grab(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out = []

    def _take(self, tags, lat, lon):
        name = tags.get("name:zh_TW") or tags.get("name:zh-TW") or tags.get("name")
        if not name:
            return
        for k in KEYS:
            v = tags.get(k)
            if v and (k, v) in RULES:
                kind, rank, sug = RULES[(k, v)]
                if kind == "parking" and "停車" not in name:
                    return
                self.out.append((name.strip()[:60], kind, rank, sug, lat, lon, tags.get("brand", "")))
                return

    def node(self, n):
        if n.tags and n.location.valid():
            self._take(n.tags, n.location.lat, n.location.lon)

    def way(self, w):
        # 面狀的 POI（加油站、公園、車站）取所有節點的平均當代表點
        if not w.tags or not any(k in w.tags for k in KEYS):
            return
        try:
            pts = [(nd.lat, nd.lon) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            return
        if pts:
            self._take(w.tags, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pbf", default=PBF)
    ap.add_argument("--redis", default=os.environ.get("REDIS_URL", "redis://localhost:6390/0"))
    a = ap.parse_args()
    t0 = time.time()
    h = Grab()
    h.apply_file(a.pbf, locations=True, idx="flex_mem")
    print(f"讀取 OSM：{len(h.out)} 筆，{time.time() - t0:.0f} 秒")

    r = redis.Redis.from_url(a.redis, decode_responses=True)
    try:
        r.execute_command("FT.DROPINDEX", "idx:poi")
    except redis.ResponseError:
        pass
    old = list(r.scan_iter("poi:[0-9]*", count=5000)) + list(r.scan_iter("poi:geo:*")) + ["sug:poi"]
    for i in range(0, len(old), 5000):
        r.delete(*old[i:i + 5000])

    p = r.pipeline(transaction=False)
    places = []
    seen_sug = set()
    for i, (name, kind, rank, sug, lat, lon, brand) in enumerate(h.out, 1):
        p.hset(f"poi:{i}", mapping={"name": name, "name_n": norm(name), "kind": kind, "rank": rank, "brand": brand,
                                     "lat": round(lat, 6), "lon": round(lon, 6), "loc": f"{lon:.6f},{lat:.6f}"})
        p.geoadd(f"poi:geo:{kind}", [lon, lat, i])
        if kind == "place" and rank >= 55:
            places.append((i, name))
            p.geoadd("poi:geo:area", [lon, lat, name])
        if sug and norm(name) not in seen_sug:
            seen_sug.add(norm(name))
            p.execute_command("FT.SUGADD", "sug:poi", norm(name), rank, "PAYLOAD", i)
        if i % 5000 == 0:
            p.execute()
    p.execute()

    # 所在區域：離最近的鄉鎮／村里名稱，搜尋結果才分得出「中山路（埔里）」和「中山路（臺北）」
    ids = list(range(1, len(h.out) + 1))
    for s in range(0, len(ids), 2000):
        chunk = ids[s:s + 2000]
        q = r.pipeline(transaction=False)
        for i in chunk:
            _, _, _, _, lat, lon, _ = h.out[i - 1]
            q.geosearch("poi:geo:area", longitude=lon, latitude=lat, radius=15, unit="km", sort="ASC", count=1)
        res = q.execute()
        w = r.pipeline(transaction=False)
        for i, near in zip(chunk, res):
            if near and near[0] != h.out[i - 1][0]:
                w.hset(f"poi:{i}", "area", near[0])
        w.execute()

    r.execute_command(
        "FT.CREATE", "idx:poi", "ON", "HASH", "PREFIX", "1", "poi:", "LANGUAGE", "chinese",
        "SCHEMA", "name_n", "TEXT", "WEIGHT", "2", "kind", "TAG", "brand", "TEXT", "rank", "NUMERIC", "SORTABLE",
        "loc", "GEO")
    r.hset("meta:poi", mapping={"source": "OpenStreetMap（Geofabrik 台灣）", "count": len(h.out), "updated": int(time.time() * 1000)})
    kinds = {}
    for x in h.out:
        kinds[x[1]] = kinds.get(x[1], 0) + 1
    print(f"匯入完成：{len(h.out)} 筆，自動完成 {len(seen_sug)} 個名稱，{time.time() - t0:.0f} 秒")
    print("各類：", dict(sorted(kinds.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    main()
