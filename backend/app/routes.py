"""路線：Google Maps 連結解析、本機 Valhalla 算機車路線、存成 RedisJSON。

Redis：
- route:{rid}   RedisJSON：途經點、路線幾何（座標＋累計里程）、轉彎指示、摘要、原始連結
                整份文件很大（幾千個座標），JSON.GET 可以只取某個路徑，例如只拿 $.summary 或 $.maneuvers，
                不必像存成字串那樣每次整包讀出來再解析。
- trip:{id} 的 route 欄位指向 route:{rid}
"""
import math
import os
import re
import time
from urllib.parse import unquote, urlparse, parse_qs

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import events
from .auth import current_uid
from .db import K, r
from .geo import haversine_m
from .pace import category, curvy_flags, get_pace, kmh_for
from .trips import require_member, trip_or_404

router = APIRouter(prefix="/api")
VALHALLA = os.environ.get("VALHALLA_URL", "http://localhost:8752")
MAX_POINTS = 4000  # 存進 Redis 的路線點數上限（太密的先抽稀）


# ---------- Google Maps 連結 ----------

COORD = re.compile(r"^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$")
DATA_PAIR = re.compile(r"!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)")
# data= 裡每個地點佔一格：有座標的是 …!2m2!1d經度!2d緯度，沒座標的（我的位置）是 !1m0
DATA_SLOT = re.compile(r"(!1m0)(?=!|$)|!2m2!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)")


def parse_gmaps(url: str) -> list[dict]:
    """從 Google Maps 路線網址取出依序的地點。支援：
    1. /maps/dir/A/B/C/…（A 可以是「緯度,經度」或地名；地名的座標在 data= 參數裡的 !1d經度!2d緯度，依序出現）
    2. ?api=1&origin=…&destination=…&waypoints=a|b（只認座標）
    「我的位置」這種沒有座標的點會被略過。"""
    u = urlparse(url)
    q = parse_qs(u.query)
    if "origin" in q or "destination" in q:
        parts = q.get("origin", []) + (q.get("waypoints", [""])[0].split("|") if q.get("waypoints") else []) + q.get("destination", [])
        out = []
        for p in parts:
            m = COORD.match(unquote(p))
            if m:
                out.append({"lat": float(m.group(1)), "lon": float(m.group(2)), "name": ""})
        return out
    path = unquote(u.path)
    if "/dir/" not in path:
        return []
    segs = path.split("/dir/", 1)[1].split("/")
    segs = [s for s in segs if s and not s.startswith("@") and not s.startswith("data=")]
    data = unquote(url).split("data=", 1)[1] if "data=" in url else ""
    slots = [None if empty else (float(lat), float(lon)) for empty, lon, lat in DATA_SLOT.findall(data)]
    if len(slots) != len(segs):  # 格數對不上：只把有座標的依序配給地名
        slots = None
    pairs = [(float(lat), float(lon)) for lon, lat in DATA_PAIR.findall(data)]
    out = []
    for i, s in enumerate(segs):
        name = s.replace("+", " ").strip()
        name = re.sub(r"\s+\d{3,6}\S*.*$", "", name)  # Google 會在地名後面接「郵遞區號＋地址」，只留地名
        m = COORD.match(name)
        if m:
            out.append({"lat": float(m.group(1)), "lon": float(m.group(2)), "name": ""})
            continue
        pos = slots[i] if slots is not None else (pairs.pop(0) if pairs else None)
        if pos:
            out.append({"lat": pos[0], "lon": pos[1], "name": name[:30]})
    return out


async def expand(url: str) -> str:
    """展開 maps.app.goo.gl／goo.gl 短網址（只送出使用者貼上的那個連結本身）。"""
    host = urlparse(url).netloc
    if not any(h in host for h in ("goo.gl", "google.")):
        raise HTTPException(400, "請貼 Google Maps 的分享連結")
    if "goo.gl" not in host:
        return url
    async with httpx.AsyncClient(follow_redirects=True, timeout=10, headers={"user-agent": "Mozilla/5.0"}) as c:
        res = await c.get(url)
    return str(res.url)


class GmapsIn(BaseModel):
    url: str = Field(min_length=10, max_length=4000)


@router.post("/routes/parse-gmaps")
async def parse_link(body: GmapsIn, uid: str = Depends(current_uid)):
    full = await expand(body.url.strip())
    pts = parse_gmaps(full)
    if len(pts) < 2:
        raise HTTPException(422, "連結裡找不到起點和終點（「我的位置」沒有座標，請改成實際地點）")
    return {"points": pts, "expanded": full[:300]}


# ---------- Valhalla ----------

def decode_polyline6(s: str) -> list[list[float]]:
    coords, idx, lat, lon = [], 0, 0, 0
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        coords.append([round(lon / 1e6, 6), round(lat / 1e6, 6)])
    return coords


# Valhalla 的轉彎種類 → 繁中（官方語系沒有 zh-TW，自己組）
TURN = {
    1: "出發", 2: "出發", 3: "出發", 4: "抵達終點", 5: "抵達終點", 6: "抵達終點",
    7: "直行", 8: "直行", 9: "靠右", 10: "右轉", 11: "向右急轉", 12: "右側迴轉", 13: "左側迴轉",
    14: "向左急轉", 15: "左轉", 16: "靠左", 17: "靠右進入匝道", 18: "靠右進入匝道", 19: "靠左進入匝道",
    20: "靠右下匝道", 21: "靠左下匝道", 22: "直行", 23: "靠右", 24: "靠左", 25: "併入",
    26: "進入圓環", 27: "駛出圓環", 28: "搭渡輪", 29: "下渡輪", 36: "抵達途經點", 37: "併入", 38: "併入",
}


def turn_text(m: dict) -> tuple[str, str]:
    t = m.get("type", 0)
    act = TURN.get(t, "繼續")
    if t in (26,) and m.get("roundabout_exit_count"):
        act = f"進入圓環，第 {m['roundabout_exit_count']} 個出口"
    names = (m.get("street_names") or m.get("begin_street_names") or [])[:2]
    street = "／".join(road_name(n, names, bool(m.get("highway"))) for n in names)
    # 交流道：附上出口名稱和方向牌，例如「霧峰系統交流道（往國姓／埔里）」
    sign = m.get("sign") or {}
    exit_name = "／".join(x["text"] for x in sign.get("exit_name_elements", [])[:1])
    toward = "／".join(x["text"] for x in sign.get("exit_toward_elements", [])[:2])
    extra = f"{exit_name}（往{toward}）" if exit_name and toward else exit_name or (f"往{toward}" if toward else "")
    return act, " · ".join(x for x in (street, extra) if x)


def road_name(n: str, all_names: list[str], highway: bool = False) -> str:
    """OSM 的道路編號只寫數字。Valhalla 標 highway（國道等級）就是國道；
    其餘 1～99 是省道（台3、台7甲），100～199 是縣道。"""
    m = re.fullmatch(r"(\d{1,3})([甲乙丙丁戊己庚]?)", n)
    if not m:
        return n
    if highway or any("高速" in x for x in all_names):
        return f"國道{n}"
    num = int(m.group(1))
    return f"台{n}" if num < 100 else f"縣道{n}" if num < 200 else n


# 交通工具 → Valhalla 的 costing 與台灣的路權規定：
#   機車（550cc 以下）：國道、快速道路都不能走
#   重機（550cc 以上紅牌）：國道不行（國道3甲例外），快速道路可以
#   汽車：都可以
# 路網裡國道是 motorway（OSM 也把國道標成收費，包含其實不收費的 3甲），快速道路是 trunk。
# Valhalla 的 exclude_tolls 是「禁止」，正好擋掉國道；use_highways=0 是「盡量避開」高速等級（含快速道路）。
# 「盡量」不是保證，所以算完再用 trace_attributes 檢查實際走到的道路等級，違規就警告。
VEHICLES = {
    "scooter": {"name": "機車", "costing": "motorcycle", "options": {"use_highways": 0, "exclude_tolls": True, "use_trails": 0},
                "forbid": {"motorway", "trunk"}},
    "heavy": {"name": "重機", "costing": "motorcycle", "options": {"use_highways": 1, "exclude_tolls": True, "use_trails": 0},
              "forbid": {"motorway"}},
    "car": {"name": "汽車", "costing": "auto", "options": {}, "forbid": set()},
}


def is_3a(edge: dict) -> bool:
    return any(n.startswith("3甲") for n in edge.get("names", []))


async def _post(path: str, body: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            res = await c.post(f"{VALHALLA}{path}", json=body)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"路線引擎沒有回應：{e!r}")
    return res.json()


async def route_edges(trip: dict) -> list[dict]:
    """把算出來的路線丟回 trace_attributes，取得每個路段的道路等級、市區密度、長度、速度：
    檢查路權（國道 motorway／快速道路 trunk）和依個人速度估時間都靠它。"""
    out = []
    for leg in trip["legs"]:
        t = await _post("/trace_attributes", {"encoded_polyline": leg["shape"], "costing": "auto", "shape_match": "edge_walk",
                                               "filters": {"attributes": ["edge.road_class", "edge.names", "edge.length",
                                                                          "edge.density", "edge.speed", "edge.begin_shape_index",
                                                                          "edge.end_shape_index"], "action": "include"}})
        edges = t.get("edges", [])
        # 彎路：用路線本身的形狀算（和個人速度的分類方式一樣），取路段中點的判斷
        shape = [(lat, lon) for lon, lat in decode_polyline6(leg["shape"])]
        flags = curvy_flags(shape)
        for e in edges:
            mid = (e.get("begin_shape_index", 0) + e.get("end_shape_index", 0)) // 2
            e["curvy"] = flags[min(mid, len(flags) - 1)] if flags else False
        out += edges
    return out


def violations(edges: list[dict], vehicle: str) -> list[str]:
    """回傳違反路權的路段說明（依道路彙整）。重機走國道3甲不算違規。"""
    forbid = VEHICLES[vehicle]["forbid"]
    agg: dict[tuple, float] = {}
    for e in edges:
        rc = e.get("road_class")
        if rc not in forbid or (vehicle == "heavy" and rc == "motorway" and is_3a(e)):
            continue
        k = (rc, (e.get("names") or ["未命名"])[0])
        agg[k] = agg.get(k, 0) + e.get("length", 0)
    label = lambda rc, n: road_name(n, [n], True) if rc == "motorway" else f"快速道路 {road_name(n, [n])}"
    return [f"{label(rc, n)}（{km:.1f} km）" for (rc, n), km in agg.items() if km >= 0.05]


def personal_minutes(edges: list[dict], pace: dict) -> int | None:
    if not pace or not edges:
        return None
    hours = 0.0
    for e in edges:
        hours += e.get("length", 0) / max(5.0, kmh_for(pace, category(e, e.get("curvy", False)), e.get("speed") or 40))
    return round(hours * 60)


def build_route(trip: dict, edges: list[dict], vehicle: str, pace: dict) -> dict:
    coords, maneuvers = [], []
    legs = trip["legs"]
    for leg in legs:
        shape = decode_polyline6(leg["shape"])
        base = len(coords) - (1 if coords else 0)
        if coords:
            shape = shape[1:]  # 下一段的起點就是上一段的終點
        for m in leg["maneuvers"]:
            act, street = turn_text(m)
            if m.get("type") in (4, 5, 6) and leg is not legs[-1]:
                act = "抵達停靠點"
            maneuvers.append({"i": base + m["begin_shape_index"], "type": m.get("type", 0), "act": act, "street": street,
                              "len_km": round(m.get("length", 0), 3)})
        coords.extend(shape)
    cum = [0.0]
    for a, b in zip(coords, coords[1:]):
        cum.append(cum[-1] + haversine_m(a[1], a[0], b[1], b[0]) / 1000)
    keep = set(m["i"] for m in maneuvers) | {0, len(coords) - 1}
    step = max(1, math.ceil(len(coords) / MAX_POINTS))
    idx = sorted(set(range(0, len(coords), step)) | keep)
    remap = {old: new for new, old in enumerate(idx)}
    for m in maneuvers:
        m["km"] = round(cum[m["i"]], 3)
        m["i"] = remap[m["i"]]
    # 路線標籤：主要走哪幾條路（長度超過 8 km 的）
    via = []
    for m in maneuvers:
        name = m["street"].split(" · ")[0].split("／")[-1] if m["street"] else ""
        if name and m["len_km"] > 8 and name not in via:
            via.append(name)
    s = trip["summary"]
    return {
        "coords": [coords[i] for i in idx], "cum_km": [round(cum[i], 4) for i in idx], "maneuvers": maneuvers,
        "summary": {"km": round(s["length"], 2), "min": round(s["time"] / 60), "points": len(idx),
                    "min_personal": personal_minutes(edges, pace) if vehicle != "car" else None},
        "via": " → ".join(via[:5]),
        "uses_3a": vehicle == "heavy" and any(e.get("road_class") == "motorway" and is_3a(e) for e in edges),
        "warnings": violations(edges, vehicle),
    }


async def valhalla_routes(points: list[dict], vehicle: str, uid: str | None = None) -> list[dict]:
    """回傳 1～3 條路線（只有起終點時，Valhalla 會另外給替代路線；有停靠點就只有一條）。"""
    v = VEHICLES[vehicle]
    locs = [{"lat": p["lat"], "lon": p["lon"], "type": "break" if i in (0, len(points) - 1) else "through"}
            for i, p in enumerate(points)]

    def body(opts, alternates=0):
        b = {"locations": locs, "costing": v["costing"], "costing_options": {v["costing"]: opts} if opts else {},
             "units": "kilometers"}
        if alternates and len(locs) == 2:
            b["alternates"] = alternates
        return b

    d = await _post("/route", body(v["options"], alternates=2))
    if "trip" not in d:
        raise HTTPException(422, f"算不出路線：{d.get('error', d)}")
    trips = [d["trip"]] + [a["trip"] for a in d.get("alternates", []) if "trip" in a]
    pace = await get_pace(uid) if uid and vehicle != "car" else {}
    need_edges = bool(v["forbid"] or pace)
    all_edges = [await route_edges(t) if need_edges else [] for t in trips]
    if vehicle == "heavy":
        # 國道3甲例外：OSM 把 3甲 也標成收費，exclude_tolls 會一起擋掉。
        # 另外算一條允許國道的路線，如果它用到的國道「全部都是 3甲」而且比較快，就換掉第一條。
        alt = await _post("/route", body({**v["options"], "exclude_tolls": False}))
        if "trip" in alt and alt["trip"]["summary"]["time"] < trips[0]["summary"]["time"] - 30:
            alt_edges = await route_edges(alt["trip"])
            mw = [e for e in alt_edges if e.get("road_class") == "motorway"]
            if mw and all(is_3a(e) for e in mw):
                trips[0], all_edges[0] = alt["trip"], alt_edges
    return [build_route(t, e, vehicle, pace) for t, e in zip(trips, all_edges)]


class PointIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    name: str = Field("", max_length=30)


class PlanIn(BaseModel):
    points: list[PointIn] = Field(min_length=2, max_length=25)
    vehicle: str = "scooter"            # scooter 機車／heavy 重機／car 汽車
    avoid_highways: bool | None = None  # 舊版欄位：有給就換算成 vehicle
    source_url: str = Field("", max_length=4000)
    alt: int = Field(0, ge=0, le=2)     # 選第幾條（預覽時列出的順序）

    def mode(self) -> str:
        if self.avoid_highways is not None and self.vehicle == "scooter":
            return "scooter" if self.avoid_highways else "heavy"
        if self.vehicle not in VEHICLES:
            raise HTTPException(400, "交通工具只能是 scooter、heavy、car")
        return self.vehicle


@router.post("/routes/preview")
async def preview(body: PlanIn, uid: str = Depends(current_uid)):
    """只算不存：規劃頁預覽用，回傳 1～3 條路線讓使用者選。"""
    return {"routes": await valhalla_routes([p.model_dump() for p in body.points], body.mode(), uid)}


# ---------- 行程的路線 ----------

async def get_route_doc(tid: str):
    rid = await r.hget(K.trip(tid), "route")
    return await r.json().get(K.route(rid)) if rid else None


@router.get("/trips/{tid}/route")
async def trip_route(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    doc = await get_route_doc(tid)
    return doc or {}


@router.get("/trips/{tid}/route/summary")
async def trip_route_summary(tid: str, uid: str = Depends(current_uid)):
    """RedisJSON 只取部分路徑：不必把幾千個座標都讀出來。"""
    await require_member(tid, uid)
    rid = await r.hget(K.trip(tid), "route")
    if not rid:
        return {}
    res = await r.json().get(K.route(rid), "$.summary", "$.points", "$.vehicle")
    return {"summary": res["$.summary"][0], "points": res["$.points"][0],
            "vehicle": (res["$.vehicle"] or ["scooter"])[0]}


@router.put("/trips/{tid}/route")
async def set_route(tid: str, body: PlanIn, uid: str = Depends(current_uid)):
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以設定路線")
    if t.get("status") == "ended":
        raise HTTPException(409, "行程已經結束")
    pts = [p.model_dump() for p in body.points]
    vehicle = body.mode()
    routes = await valhalla_routes(pts, vehicle, uid)
    route = routes[min(body.alt, len(routes) - 1)]
    rid = str(await r.incr("seq:route"))
    doc = {"id": rid, "trip": tid, "by": uid, "created": int(time.time() * 1000), "points": pts,
           "vehicle": vehicle, "avoid_highways": vehicle == "scooter", "source_url": body.source_url, **route}
    await r.json().set(K.route(rid), "$", doc)
    old = t.get("route")
    await r.hset(K.trip(tid), "route", rid)
    if old:
        await r.delete(K.route(old))
    await r.delete(K.progress(tid))
    s = route["summary"]
    await events.emit(tid, "route", uid, f"設定路線（{VEHICLES[vehicle]['name']}）：{s['km']:.1f} km，"
                                          f"預估 {s['min'] // 60} 小時 {s['min'] % 60} 分")
    await events.publish(tid, {"kind": "route", "id": rid})
    return {"id": rid, "summary": s}


@router.delete("/trips/{tid}/route")
async def clear_route(tid: str, uid: str = Depends(current_uid)):
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以設定路線")
    rid = t.get("route")
    if rid:
        await r.hdel(K.trip(tid), "route")
        await r.delete(K.route(rid), K.progress(tid))
        await events.publish(tid, {"kind": "route", "id": None})
    return {"ok": True}
