"""地點搜尋（規劃頁加停靠點）：資料由 tools/import_poi 從本機台灣 OSM 匯入，查詢不送到任何外部服務。

- /suggest   FT.SUGGET 自動完成（打字時即時建議，含 FUZZY 容錯）
- /search    FT.SEARCH 中文全文，先找附近（GEO 條件），不夠再找全台，依重要度排序
- /along     沿路線找某一類（加油站、便利商店…）：路線上每隔一段取一點，Pipeline 一次送出多個 GEOSEARCH
"""
import json
import re
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import current_uid
from .db import r
from .geo import haversine_m

router = APIRouter(prefix="/api/poi")
KIND_NAME = {"place": "地名", "station": "車站", "peak": "山", "sight": "景點", "school": "學校", "rest": "休息站",
             "fuel": "加油站", "convenience": "便利商店", "food": "餐廳", "lodging": "住宿", "parking": "停車場",
             "kindergarten": "幼兒園", "hospital": "醫院", "clinic": "診所", "police": "警察局", "fire": "消防隊",
             "townhall": "公所", "post": "郵局", "moto": "機車行", "carrepair": "汽車修理", "charging": "充電站",
             "toilet": "公廁", "water": "飲水機", "pharmacy": "藥局", "temple": "廟宇", "church": "教堂",
             "museum": "博物館", "beach": "海灘", "waterfall": "瀑布", "lake": "湖泊", "bridge": "橋",
             "market": "市場", "oldstreet": "老街", "busstation": "客運站", "ferry": "碼頭", "supermarket": "超市",
             "mall": "購物中心", "department": "百貨公司", "bank": "銀行", "atm": "ATM"}
ALONG_KINDS = {"fuel", "convenience", "food", "sight", "lodging", "rest", "parking", "moto", "toilet", "charging"}
# 直接打種類名稱（「機車行」「公廁」「廟」）＝找附近這一類；店名裡不一定有這幾個字
KIND_WORDS = {v: k for k, v in KIND_NAME.items() if k != "place"}
KIND_WORDS.update({"廟": "temple", "寺廟": "temple", "宮廟": "temple", "廁所": "toilet", "機車": "moto",
                   "機車修理": "moto", "修車": "moto", "便利店": "convenience", "超商": "convenience",
                   "飲水": "water", "飲水站": "water", "百貨": "department", "警局": "police", "派出所": "police"})


def norm(s: str) -> str:
    return s.replace("台", "臺")


def clean(s: str) -> str:
    return re.sub(r"[@{}\[\]()|\-~*:\"'<>!%$^&=+;,./\\]", " ", s).strip()


def poi_dict(pid: str, h: dict, lon: float | None = None, lat: float | None = None) -> dict:
    out = {"id": pid, "name": h.get("name"), "kind": h.get("kind"), "kind_name": KIND_NAME.get(h.get("kind"), ""),
           "area": h.get("area", ""), "lat": float(h["lat"]), "lon": float(h["lon"])}
    if lon is not None and lat is not None:
        out["dist_km"] = round(haversine_m(lat, lon, out["lat"], out["lon"]) / 1000, 1)
    return out


async def fetch(ids: list[str]) -> list[dict]:
    async with r.pipeline(transaction=False) as p:
        for i in ids:
            p.hgetall(f"poi:{i}")
        return await p.execute()


@router.get("/suggest")
async def suggest(q: str = Query(min_length=1, max_length=40), lon: float | None = None, lat: float | None = None,
                  uid: str = Depends(current_uid)):
    term = norm(q.strip())
    res = await r.execute_command("FT.SUGGET", "sug:poi", term, "MAX", 8, "WITHPAYLOADS")
    if not res and len(term) >= 2:
        res = await r.execute_command("FT.SUGGET", "sug:poi", term, "FUZZY", "MAX", 8, "WITHPAYLOADS")
    ids = [res[i + 1] for i in range(0, len(res or []), 2) if res[i + 1]]
    rows = await fetch(ids)
    return [poi_dict(i, h, lon, lat) for i, h in zip(ids, rows) if h]


def _parse(res) -> list[tuple[str, dict]]:
    if isinstance(res, dict):  # RESP3
        return [(x["id"].split(":", 1)[1], x.get("extra_attributes", {})) for x in res.get("results", [])]
    rest = res[1:]
    return [(rest[i].split(":", 1)[1], dict(zip(rest[i + 1][::2], rest[i + 1][1::2]))) for i in range(0, len(rest), 2)]


@router.get("/search")
async def search(q: str = Query(min_length=1, max_length=40), lon: float | None = None, lat: float | None = None,
                 kind: str = "", uid: str = Depends(current_uid)):
    """名稱全文（中文斷詞）＋前綴＋種類＋位置。
    中文斷詞會把「埔里鎮」當成一個詞，只查「埔里」找不到，所以每個詞都同時用原詞和前綴（埔里*）查。
    有給地圖中心就先找 30 km 內（依距離，重要的地名稍微優先），再補全台結果（依重要度）。"""
    words = clean(norm(q)).split()
    if not words:
        return []
    text = " ".join(f"({w}|{w}*)" for w in words)
    base = text + (f" @kind:{{{clean(kind)}}}" if kind else "")
    out, seen = [], set()

    def add(items):
        for it in items:
            if it["id"] not in seen:
                seen.add(it["id"])
                out.append(it)

    # 打的是種類名稱：先列附近這一類（依距離），再接名稱比對的結果
    wk = KIND_WORDS.get(norm(q.strip()))
    if wk and not kind and lon is not None and lat is not None:
        res = await r.execute_command("FT.SEARCH", "idx:poi", f"@kind:{{{wk}}} @loc:[{lon} {lat} 30 km]",
                                      "LIMIT", 0, 60, "DIALECT", 2)
        add(sorted((poi_dict(pid, h, lon, lat) for pid, h in _parse(res)), key=lambda x: x["dist_km"])[:8])
    # 自動完成字典裡的名稱（地名、車站、景點）放最前面
    if not kind:
        qn = norm(q.strip())
        # FUZZY 自動完成可能帶出只差一個字的地名（中油 → 中寮），只留夠像的
        add(x for x in await suggest(q, lon, lat, uid)
            if qn in norm(x["name"]) or SequenceMatcher(None, qn, norm(x["name"])).ratio() >= 0.6)
    if lon is not None and lat is not None:
        res = await r.execute_command("FT.SEARCH", "idx:poi", f"{base} @loc:[{lon} {lat} 30 km]", "LANGUAGE", "chinese",
                                      "LIMIT", 0, 60, "DIALECT", 2)
        near = [poi_dict(pid, h, lon, lat) for pid, h in _parse(res)]
        rank = {pid: int(h.get("rank", 0)) for pid, h in _parse(res)}
        near.sort(key=lambda x: x["dist_km"] - rank[x["id"]] / 10)  # 鎮（85）約等於近 8.5 km
        add(near[:10])
    if len(out) < 12:
        res = await r.execute_command("FT.SEARCH", "idx:poi", base, "LANGUAGE", "chinese", "SORTBY", "rank", "DESC",
                                      "LIMIT", 0, 12, "DIALECT", 2)
        add(poi_dict(pid, h, lon, lat) for pid, h in _parse(res))
    # 多個詞要同時符合（AND）；像「北海岸 金山老街」這種「區域＋地點」沒有一筆同時有兩個詞，
    # 就改成每個詞分開找再合併（UX-26）。長的詞通常比較具體（金山老街 > 北海岸），先放
    if len(words) > 1 and len(out) < 3:
        for w in sorted(words, key=len, reverse=True):
            add(await search(w, lon, lat, kind, uid))
    return out[:12]


class AlongIn(BaseModel):
    kind: str
    samples: list[list[float]] = Field(min_length=1, max_length=400)  # [經度, 緯度, 沿路線 km]
    radius_m: int = Field(800, ge=100, le=3000)
    kmh: float = Field(40, ge=5, le=150)  # 天氣：估計經過時間用的平均速度


@router.post("/along")
async def along(body: AlongIn, uid: str = Depends(current_uid)):
    """沿路線找：一次 Pipeline 送出每個取樣點的 GEOSEARCH，回傳依「沿路線里程」排序。
    SQL 要做「離這條線 800 m 內的加油站」通常得靠 PostGIS 的緩衝區運算。"""
    if body.kind == "roadevent":
        return await along_roadevents(body)
    if body.kind == "weather":
        return await along_weather(body)
    if body.kind not in ALONG_KINDS:
        return []
    async with r.pipeline(transaction=False) as p:
        for lon, lat, _ in body.samples:
            p.geosearch(f"poi:geo:{body.kind}", longitude=lon, latitude=lat, radius=body.radius_m, unit="m",
                        withdist=True, sort="ASC", count=5)
        res = await p.execute()
    best: dict[str, tuple[float, float]] = {}
    for (lon, lat, km), hits in zip(body.samples, res):
        for pid, dist in hits:
            d = float(dist)
            if pid not in best or d < best[pid][1]:
                best[pid] = (km, d)
    ids = sorted(best, key=lambda i: best[i][0])[:60]
    rows = await fetch(ids)
    out = []
    for pid, h in zip(ids, rows):
        if h:
            item = poi_dict(pid, h)
            item["route_km"] = round(best[pid][0], 1)
            item["off_m"] = round(best[pid][1])
            out.append(item)
    return out


async def along_roadevents(body: AlongIn) -> list[dict]:
    """沿途路況（規格 4.2 的沿途簡報）：TDX 省道即時事件。資料過期才去 TDX 抓（cache-aside），
    然後跟加油站一樣，Pipeline 一次送出每個取樣點的 GEOSEARCH。"""
    from . import traffic
    if not await traffic.ensure_fresh():
        raise HTTPException(503, "路況資料還沒設定（.env 的 TDX_CLIENT_ID／TDX_CLIENT_SECRET）")
    async with r.pipeline(transaction=False) as p:
        for lon, lat, _ in body.samples:
            p.geosearch(traffic.GEO, longitude=lon, latitude=lat, radius=body.radius_m, unit="m", withdist=True,
                        sort="ASC", count=5)
        res = await p.execute()
    best: dict[str, tuple[float, float]] = {}
    for (lon, lat, km), hits in zip(body.samples, res):
        for eid, dist in hits:
            if eid not in best or float(dist) < best[eid][1]:
                best[eid] = (km, float(dist))
    ids = sorted(best, key=lambda i: best[i][0])[:40]
    infos = await r.hmget(traffic.INFO, ids) if ids else []
    out = []
    for eid, raw in zip(ids, infos):
        if not raw:
            continue
        x = json.loads(raw)
        out.append({"id": eid, "name": f"{x['road']} {x['title']}".strip(), "area": traffic.short(x, 90),
                    "lon": x["lon"], "lat": x["lat"], "route_km": round(best[eid][0], 1), "off_m": round(best[eid][1]),
                    "type": x["type_name"]})
    return out


async def along_weather(body: AlongIn) -> list[dict]:
    """沿途天氣：路線經過哪些鄉鎮（本機 GEOSHAPE），用預計經過的時間查氣象署鄉鎮預報的 3 小時降雨機率。
    只向氣象署要縣市的整份預報（Redis 快取 30 分鐘），座標不送出去。"""
    import time as _t
    from . import weather
    if not weather.enabled():
        raise HTTPException(503, "天氣還沒設定（.env 的 CWA_API_KEY）")
    now = int(_t.time() * 1000)
    seen, out = set(), []
    for lon, lat, km in body.samples:
        t = await weather.town_at(lat, lon)
        if not t or t in seen:
            continue
        seen.add(t)
        eta = now + int(km / body.kmh * 3_600_000)
        w = await weather.rain_at(lat, lon, eta)
        if not w:
            continue
        out.append({"id": f"{t[0]}{t[1]}", "name": f"{t[0]}{t[1]}", "lon": lon, "lat": lat, "route_km": round(km, 1),
                    "off_m": 0, "pop": w["pop"], "type": f"降雨 {w['pop']}%",
                    "area": f"約 {weather.tw(eta)} 經過 · {weather.tw(w['start'], '%H')}–{weather.tw(w['end'], '%H')} 時預報"
                            + ("（模擬資料）" if w.get("fake") else "")})
    return out
