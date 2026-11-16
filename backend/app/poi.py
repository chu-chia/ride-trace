"""地點搜尋（規劃頁加停靠點）：資料由 tools/import_poi 從本機台灣 OSM 匯入，查詢不送到任何外部服務。

- /suggest   FT.SUGGET 自動完成（打字時即時建議，含 FUZZY 容錯）
- /search    FT.SEARCH 中文全文，先找附近（GEO 條件），不夠再找全台，依重要度排序
- /along     沿路線找某一類（加油站、便利商店…）：路線上每隔一段取一點，Pipeline 一次送出多個 GEOSEARCH
"""
import re
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .auth import current_uid
from .db import r
from .geo import haversine_m

router = APIRouter(prefix="/api/poi")
KIND_NAME = {"place": "地名", "station": "車站", "peak": "山", "sight": "景點", "school": "學校", "rest": "休息站",
             "fuel": "加油站", "convenience": "便利商店", "food": "餐廳", "lodging": "住宿", "parking": "停車場"}
ALONG_KINDS = {"fuel", "convenience", "food", "sight", "lodging", "rest", "parking"}


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
    return out[:12]


class AlongIn(BaseModel):
    kind: str
    samples: list[list[float]] = Field(min_length=1, max_length=400)  # [經度, 緯度, 沿路線 km]
    radius_m: int = Field(800, ge=100, le=3000)


@router.post("/along")
async def along(body: AlongIn, uid: str = Depends(current_uid)):
    """沿路線找：一次 Pipeline 送出每個取樣點的 GEOSEARCH，回傳依「沿路線里程」排序。
    SQL 要做「離這條線 800 m 內的加油站」通常得靠 PostGIS 的緩衝區運算。"""
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
