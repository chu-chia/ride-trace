"""從本機的台灣 OSM 檔（data/valhalla/taiwan-latest.osm.pbf）匯入地名與 POI，給規劃頁搜尋、沿路線找加油站等用。
全部在本機處理，不呼叫任何外部服務。

    uv run --with osmium python -m tools.import_poi

Redis：
- poi:{id}            Hash：名稱、種類、座標、所在區域
- idx:poi             RediSearch：名稱中文全文、種類 TAG、位置 GEO、重要度 NUMERIC（排序用）
- poi:geo:{kind}      GEO：每一類一個集合，沿路線找「加油站」時對路線上每個取樣點 GEOSEARCH
- sug:poi             FT.SUGADD 自動完成字典（地名、車站、景點、學校、醫院、機車行、廟宇…；不放加油站、便利商店、餐廳這種連鎖店）

重新執行會先刪掉 idx:poi、poi:{數字}、poi:geo:*、sug:poi 再寫，不會留下重複。
"""
import argparse
import os
import time

import osmium
import redis

from app.redis_url import default_redis_url

PBF = os.path.join(os.path.dirname(__file__), "..", "..", "data", "valhalla", "taiwan-latest.osm.pbf")

# (tag, 值) → (種類, 重要度, 要不要放進自動完成)
# 重要度：地名、車站、地標、學校高；ATM、飲水機、停車場低（同名搜尋時排序用）
RULES = {
    ("place", "city"): ("place", 100, True), ("place", "town"): ("place", 85, True),
    ("place", "suburb"): ("place", 60, True), ("place", "village"): ("place", 55, True),
    ("place", "hamlet"): ("place", 40, True), ("place", "locality"): ("place", 35, True),
    ("railway", "station"): ("station", 75, True), ("public_transport", "station"): ("station", 70, True),
    ("amenity", "bus_station"): ("busstation", 45, True), ("amenity", "ferry_terminal"): ("ferry", 45, True),
    ("natural", "peak"): ("peak", 50, True), ("natural", "saddle"): ("peak", 50, True),
    ("natural", "beach"): ("beach", 50, True), ("natural", "waterfall"): ("waterfall", 50, True),
    ("waterway", "waterfall"): ("waterfall", 50, True),
    ("tourism", "museum"): ("museum", 55, True),
    ("tourism", "attraction"): ("sight", 45, True), ("tourism", "viewpoint"): ("sight", 45, True),
    ("historic", "monument"): ("sight", 35, True), ("leisure", "park"): ("sight", 25, True),
    ("amenity", "place_of_worship"): ("temple", 35, True),
    ("man_made", "bridge"): ("bridge", 30, True),
    ("amenity", "marketplace"): ("market", 30, True),
    ("amenity", "university"): ("school", 55, True), ("amenity", "college"): ("school", 50, True),
    ("amenity", "school"): ("school", 50, True), ("amenity", "kindergarten"): ("kindergarten", 25, True),
    ("amenity", "hospital"): ("hospital", 55, True), ("amenity", "clinic"): ("clinic", 20, True),
    ("amenity", "townhall"): ("townhall", 50, True), ("amenity", "police"): ("police", 40, True),
    ("amenity", "fire_station"): ("fire", 35, True), ("amenity", "post_office"): ("post", 30, True),
    ("highway", "rest_area"): ("rest", 40, True), ("highway", "services"): ("rest", 40, True),
    ("shop", "mall"): ("mall", 40, True), ("shop", "department_store"): ("department", 45, True),
    ("shop", "supermarket"): ("supermarket", 15, True),
    ("shop", "motorcycle"): ("moto", 30, True), ("shop", "motorcycle_repair"): ("moto", 30, True),
    ("shop", "car_repair"): ("carrepair", 15, True),
    ("amenity", "charging_station"): ("charging", 20, True), ("amenity", "pharmacy"): ("pharmacy", 15, True),
    ("amenity", "toilets"): ("toilet", 10, True), ("amenity", "drinking_water"): ("water", 5, True),
    ("amenity", "bank"): ("bank", 15, True), ("amenity", "atm"): ("atm", 5, True),
    ("amenity", "fuel"): ("fuel", 30, False), ("shop", "convenience"): ("convenience", 20, False),
    ("amenity", "restaurant"): ("food", 20, False), ("amenity", "fast_food"): ("food", 15, False),
    ("amenity", "cafe"): ("food", 15, False),
    ("tourism", "hotel"): ("lodging", 25, False), ("tourism", "hostel"): ("lodging", 20, False),
    ("tourism", "guest_house"): ("lodging", 20, False), ("tourism", "motel"): ("lodging", 20, False),
    ("tourism", "camp_site"): ("lodging", 25, True),
    ("amenity", "parking"): ("parking", 5, False),
}
# 依 RULES 寫的順序比對（同時有好幾個 tag 時，前面的優先；例如車站兼景點算車站）
KEYS = list(dict.fromkeys(k for k, _ in RULES))
LAKE_WORDS = ("湖", "潭", "埤", "陂", "水庫")
# 線狀／面狀的東西（橋、老街常被切成好幾段 way）同名又靠很近只留一筆
DEDUPE_KINDS = {"bridge", "oldstreet", "lake", "beach", "waterfall", "market"}
DEDUPE_KM = 1.5


def norm(s: str) -> str:
    return s.replace("台", "臺")


def classify(tags):
    """回傳 (名稱, 種類, 重要度, 自動完成) 或 None。只收有名稱的。"""
    name = tags.get("name:zh_TW") or tags.get("name:zh-TW") or tags.get("name")
    bname = tags.get("bridge:name")
    if not name and not bname:
        return None
    name = (name or bname).strip()[:60]
    if name.endswith("老街"):  # 老街可能是道路、地點或景點，統一歸一類
        return name, "oldstreet", 55, True
    for k in KEYS:
        v = tags.get(k)
        if v and (k, v) in RULES:
            kind, rank, sug = RULES[(k, v)]
            if kind == "parking" and "停車" not in name:
                return None
            if kind == "temple" and tags.get("religion") == "christian":
                kind, rank = "church", 30
            return name, kind, rank, sug
    if tags.get("natural") == "water" and any(w in name for w in LAKE_WORDS):
        return name, "lake", 50, True
    # 橋：有 bridge:name，或道路的 bridge=yes 段名稱本身就是「…橋」
    b = tags.get("bridge")
    if b and b != "no":
        if bname:
            return bname.strip()[:60], "bridge", 30, True
        if name.endswith("橋"):
            return name, "bridge", 30, True
    return None


class Grab(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out = []

    def _add(self, hit, tags, lat, lon):
        name, kind, rank, sug = hit
        self.out.append((name, kind, rank, sug, lat, lon, tags.get("brand", "")))

    def node(self, n):
        if n.tags and n.location.valid():
            hit = classify(n.tags)
            if hit:
                self._add(hit, n.tags, n.location.lat, n.location.lon)

    def way(self, w):
        # 面狀或線狀的 POI（加油站、公園、車站、橋、老街）取所有節點的平均當代表點
        if not w.tags:
            return
        hit = classify(w.tags)
        if not hit:
            return
        try:
            pts = [(nd.lat, nd.lon) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            return
        if pts:
            self._add(hit, w.tags, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    def area(self, a):
        # 只處理由 relation 組成的多邊形（大湖泊、海灘、大學校園常是 multipolygon）；封閉 way 已在 way() 處理
        if a.from_way() or not a.tags:
            return
        hit = classify(a.tags)
        if not hit:
            return
        pts = [(nd.lat, nd.lon) for ring in a.outer_rings() for nd in ring if nd.location.valid()]
        if pts:
            self._add(hit, a.tags, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def dedupe(rows):
    """橋、老街、湖泊這類同名、相距 1.5 km 內的只留第一筆。"""
    from app.geo import haversine_m
    keep, groups = [], {}
    for x in rows:
        name, kind, _, _, lat, lon, _ = x
        if kind not in DEDUPE_KINDS:
            keep.append(x)
            continue
        g = groups.setdefault((kind, norm(name)), [])
        if any(haversine_m(lat, lon, a, b) < DEDUPE_KM * 1000 for a, b in g):
            continue
        g.append((lat, lon))
        keep.append(x)
    return keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pbf", default=PBF)
    ap.add_argument("--redis", default=default_redis_url())
    ap.add_argument("--dry-run", action="store_true", help="只讀 OSM 印各類筆數，不寫 Redis")
    a = ap.parse_args()
    t0 = time.time()
    h = Grab()
    h.apply_file(a.pbf, locations=True, idx="flex_mem")
    raw = len(h.out)
    h.out = dedupe(h.out)
    print(f"讀取 OSM：{raw} 筆，去掉同名相鄰的橋／老街等後 {len(h.out)} 筆，{time.time() - t0:.0f} 秒")
    if a.dry_run:
        kinds = {}
        for x in h.out:
            kinds[x[1]] = kinds.get(x[1], 0) + 1
        print("各類：", dict(sorted(kinds.items(), key=lambda x: -x[1])))
        return

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
