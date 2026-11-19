"""地點搜尋（規劃頁加停靠點）：資料由 tools/import_poi 從本機台灣 OSM 匯入，查詢不送到任何外部服務。

- /suggest   FT.SUGGET 自動完成（打字時即時建議，含 FUZZY 容錯）
- /search    FT.SEARCH 中文全文＋附近（GEO 條件）＋全台，候選收齊後依「名稱比對、距離、重要度」一起排序（score）
- /along     沿路線找某一類（加油站、便利商店…）：路線上每隔一段取一點，Pipeline 一次送出多個 GEOSEARCH
"""
import json
import math
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


# 連鎖店：名稱常常只有「7-Eleven」不帶分店，用類別＋品牌（名稱）找附近的
CHAINS = {"7-11": ("convenience", ("7-eleven", "7-11", "統一超商")), "711": "7-11", "7-eleven": "7-11",
          "小七": "7-11", "統一超商": "7-11", "全家": ("convenience", ("全家",)),
          "萊爾富": ("convenience", ("萊爾富",)), "ok超商": ("convenience", ("ok",))}
# 名稱以這些字結尾＝通稱（媽祖廟、公館國小、xx 機車行）：要的是「附近那一間」，不是同名的地名
GENERIC_SUFFIX = ("廟", "宮", "寺", "國小", "國中", "高中", "大學", "醫院", "診所", "派出所", "分局", "郵局", "銀行",
                  "公廁", "廁所", "加油站", "機車行", "車行", "便利商店", "超商", "教堂", "藥局", "充電站", "市場",
                  "停車場", "幼兒園", "消防隊", "公所")
NEAR_KM = 30


def chain(qn: str):
    c = CHAINS.get(qn.lower())
    return CHAINS[c] if isinstance(c, str) else c


async def _sugget(term: str) -> list[str]:
    res = await r.execute_command("FT.SUGGET", "sug:poi", term, "MAX", 8, "WITHPAYLOADS")
    if not res and len(term) >= 2:
        res = await r.execute_command("FT.SUGGET", "sug:poi", term, "FUZZY", "MAX", 8, "WITHPAYLOADS")
    return [res[i + 1] for i in range(0, len(res or []), 2) if res[i + 1]]


@router.get("/suggest")
async def suggest(q: str = Query(min_length=1, max_length=40), lon: float | None = None, lat: float | None = None,
                  uid: str = Depends(current_uid)):
    """打字時的建議。有基準點時和 /search 用同一套排序（取前 8），
    否則只打「媽祖廟」會先跳出 260 km 外同名的地名，附近的廟要按 Enter 才看得到。"""
    if lon is not None and lat is not None:
        return (await search(q, lon, lat, "", uid))[:8]
    ids = await _sugget(norm(q.strip()))
    rows = await fetch(ids)
    return [poi_dict(i, h) for i, h in zip(ids, rows) if h]


def _parse(res) -> list[tuple[str, dict]]:
    if isinstance(res, dict):  # RESP3
        return [(x["id"].split(":", 1)[1], x.get("extra_attributes", {})) for x in res.get("results", [])]
    rest = res[1:]
    return [(rest[i].split(":", 1)[1], dict(zip(rest[i + 1][::2], rest[i + 1][1::2]))) for i in range(0, len(rest), 2)]


def score(x: dict, qn: str, generic: bool) -> float:
    """越大越前面＝名稱比對＋重要度－距離。
    - 名稱：完全相同 +1.2、開頭相同 +0.6、包含 0、其他（模糊、拆詞）-0.5；直接打類別找到的算「包含」
    - 重要度 rank（0～100）：一般 /50，通稱 /150（通稱要的是最近那間，大小不重要）
    - 距離取 log：一般 ln(1+d/10)（九份 120 km 的完全相同仍贏 66 km 的「九份二山」），
      通稱 ln(1+d/3)（越近越重要）
    - 明確名稱（不是通稱）：地名再加聚落大小 (rank-40)/15（村 +1、鄉鎮 +3），自動完成字典裡那一筆
      （同名只收一筆，是代表的那個）+1.5，所以苗栗的「九份」小聚落 6.7 km 不會蓋過瑞芳的九份
    - 通稱：30 km 內的實際地點（不是 place，且名稱以搜尋詞結尾或是那個類別）+1；地名 -0.5"""
    n = norm(x["name"] or "").lower()
    m = 1.2 if n == qn else 0.6 if n.startswith(qn) else 0 if (qn in n or x["_cat"]) else -0.5
    d = x.get("dist_km")
    s = m + x["_rank"] / (150 if generic else 50)
    if d is not None:
        s -= math.log1p(d / (3 if generic else 10))
    if not generic:
        if x["kind"] == "place":
            s += (x["_rank"] - 40) / 15
        if x["_sug"] and m > 0:
            s += 1.5
    else:
        if x["kind"] == "place":
            s -= 0.5
        elif d is not None and d <= NEAR_KM and (x["_cat"] or n.endswith(qn)):
            s += 1
    return s


@router.get("/search")
async def search(q: str = Query(min_length=1, max_length=40), lon: float | None = None, lat: float | None = None,
                 kind: str = "", uid: str = Depends(current_uid)):
    """名稱全文（中文斷詞）＋前綴＋種類＋位置，候選全部收齊後用 score() 一起排序。
    中文斷詞會把「埔里鎮」當成一個詞，只查「埔里」找不到，所以每個詞都同時用原詞和前綴（埔里*）查。
    候選：① 打的是類別或連鎖店 → GEOSEARCH 這一類最近的 ② 自動完成字典 ③ 基準點 3／10／30 km 內全文
    （分三圈，免得 30 km 內太多筆時 LIMIT 截掉最近的）④ 全台全文依重要度。"""
    words = clean(norm(q)).split()
    if not words:
        return []
    qn = norm(q.strip()).lower()
    text = " ".join(f"({w}|{w}*)" for w in words)
    base = text + (f" @kind:{{{clean(kind)}}}" if kind else "")
    has_loc = lon is not None and lat is not None
    cand: dict[str, dict] = {}

    def add(pairs, cat=False, sug=False):
        for pid, h in pairs:
            if not h or "lat" not in h:
                continue
            if pid in cand:
                cand[pid]["_cat"] |= cat
                cand[pid]["_sug"] |= sug
                continue
            it = poi_dict(pid, h, lon, lat)
            it["_rank"], it["_cat"], it["_sug"] = int(h.get("rank", 0) or 0), cat, sug
            cand[pid] = it

    wk = None if kind else KIND_WORDS.get(norm(q.strip()))
    ch = None if kind else chain(qn)
    if has_loc and (wk or ch):
        k = wk or ch[0]
        ids = await r.geosearch(f"poi:geo:{k}", longitude=lon, latitude=lat, radius=NEAR_KM, unit="km",
                                sort="ASC", count=12 if wk else 300)
        rows = await fetch(ids)
        pairs = list(zip(ids, rows))
        if ch:
            pairs = [(i, h) for i, h in pairs
                     if h and any(b in f"{h.get('name', '')} {h.get('brand', '')}".lower() for b in ch[1])][:12]
        add(pairs, cat=True)
    if not kind:
        ids = await _sugget(norm(q.strip()))
        rows = await fetch(ids)
        # FUZZY 自動完成可能帶出只差一個字的地名（中油 → 中寮），只留夠像的
        add([(i, h) for i, h in zip(ids, rows) if h and (
            qn in norm(h["name"]).lower() or SequenceMatcher(None, qn, norm(h["name"]).lower()).ratio() >= 0.6)], sug=True)
    async with r.pipeline(transaction=False) as p:
        if has_loc:
            for km in (3, 10, NEAR_KM):
                p.execute_command("FT.SEARCH", "idx:poi", f"{base} @loc:[{lon} {lat} {km} km]", "LANGUAGE", "chinese",
                                  "LIMIT", 0, 40, "DIALECT", 2)
        p.execute_command("FT.SEARCH", "idx:poi", base, "LANGUAGE", "chinese", "SORTBY", "rank", "DESC",
                          "LIMIT", 0, 12, "DIALECT", 2)
        for res in await p.execute():
            add(_parse(res))
    generic = bool(wk or ch) or qn.endswith(GENERIC_SUFFIX)
    out = sorted(cand.values(), key=lambda x: -score(x, qn, generic))[:12]
    for x in out:
        del x["_rank"], x["_cat"], x["_sug"]
    # 多個詞要同時符合（AND）；像「北海岸 金山老街」這種「區域＋地點」沒有一筆同時有兩個詞，
    # 就改成每個詞分開找再合併（UX-26）。長的詞通常比較具體（金山老街 > 北海岸），先放
    if len(words) > 1 and len(out) < 3:
        seen = {x["id"] for x in out}
        for w in sorted(words, key=len, reverse=True):
            for x in await search(w, lon, lat, kind, uid):
                if x["id"] not in seen:
                    seen.add(x["id"])
                    out.append(x)
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
