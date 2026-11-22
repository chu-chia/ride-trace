"""路線：Google Maps 連結解析、本機 Valhalla 算機車路線、存成 RedisJSON。

Redis：
- route:{rid}   RedisJSON：途經點、路線幾何（座標＋累計里程）、轉彎指示、摘要、原始連結
                整份文件很大（幾千個座標），JSON.GET 可以只取某個路徑，例如只拿 $.summary 或 $.maneuvers，
                不必像存成字串那樣每次整包讀出來再解析。
- trip:{id} 的 route 欄位指向 route:{rid}
"""
import asyncio
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
from .geo import haversine_m, project_on_route
from .pace import category, curvy_flags, get_pace, kmh_for
from .trips import reader, require_member, trip_or_404

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


TRACE_ATTRS = ["edge.road_class", "edge.names", "edge.length", "edge.density", "edge.speed", "edge.speed_limit",
               "edge.begin_shape_index", "edge.end_shape_index"]


async def _trace(body: dict) -> list[dict] | None:
    t = await _post("/trace_attributes", {**body, "filters": {"attributes": TRACE_ATTRS, "action": "include"}})
    return t.get("edges") if "edges" in t else None


async def route_edges(trip: dict, costing: str) -> list[dict] | None:
    """把算出來的路線丟回 trace_attributes，取得每個路段的道路等級、市區密度、長度、速度：
    檢查路權（國道 motorway／快速道路 trunk）和依個人速度估時間都靠它。
    先用 edge_walk（沿著路線本身的路段走，最準）；要用和算路線相同的交通工具，否則機車能走、汽車不能走的路段會對不上。
    失敗就切成 150 km 以內的小段做地圖比對（Valhalla 的比對上限 200 km）。都失敗回傳 None（呼叫端要明講「無法檢查」）。"""
    out = []
    for leg in trip["legs"]:
        shape = [(lat, lon) for lon, lat in decode_polyline6(leg["shape"])]
        edges = await _trace({"encoded_polyline": leg["shape"], "costing": costing, "shape_match": "edge_walk"})
        if edges is None:
            edges, start = [], 0
            cum = [0.0]
            for x, y in zip(shape, shape[1:]):
                cum.append(cum[-1] + haversine_m(x[0], x[1], y[0], y[1]))
            while start < len(shape) - 1:
                end = start
                while end + 1 < len(shape) and cum[end + 1] - cum[start] < 150_000:
                    end += 1
                part = await _trace({"shape": [{"lat": a, "lon": b} for a, b in shape[start:end + 1]],
                                     "costing": costing, "shape_match": "map_snap"})
                if part is None:
                    return None
                for e in part:  # 索引換回整條路線的
                    e["begin_shape_index"] = e.get("begin_shape_index", 0) + start
                    e["end_shape_index"] = e.get("end_shape_index", 0) + start
                edges += part
                start = end
        # 彎路：用路線本身的形狀算（和個人速度的分類方式一樣），取路段中點的判斷
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


def speed_limits(edges: list[dict]) -> list[list[float]]:
    """導航畫面的速限：沿路線累加路段長度，合併成 [起點 km, 終點 km, 速限 km/h]。
    只收 OSM 有標速限（maxspeed）的路段；沒標的不放，畫面上就不顯示速限牌。"""
    out, km = [], 0.0
    for e in edges:
        ln = float(e.get("length") or 0)
        lim = e.get("speed_limit")
        if isinstance(lim, (int, float)) and 0 < lim < 200:
            if out and out[-1][2] == lim and abs(out[-1][1] - km) < 1e-6:
                out[-1][1] = round(km + ln, 3)
            else:
                out.append([round(km, 3), round(km + ln, 3), int(lim)])
        km += ln
    return out


def build_route(trip: dict, edges: list[dict] | None, vehicle: str, pace: dict) -> dict:
    checked = edges is not None
    edges = edges or []
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
    if not via:  # 市區短程沒有超過 8 km 的路：改列最長的兩條（照路線順序），不要只印「—」
        named = [(m["len_km"], k, m["street"].split(" · ")[0].split("／")[-1]) for k, m in enumerate(maneuvers) if m["street"]]
        top: list[tuple[int, str]] = []
        for _, k, name in sorted(named, reverse=True):
            if name not in [n for _, n in top]:
                top.append((k, name))
            if len(top) == 2:
                break
        via = [n for _, n in sorted(top)]
    s = trip["summary"]
    return {
        "coords": [coords[i] for i in idx], "cum_km": [round(cum[i], 4) for i in idx], "maneuvers": maneuvers,
        "summary": {"km": round(s["length"], 2), "min": round(s["time"] / 60), "points": len(idx),
                    "min_personal": personal_minutes(edges, pace) if vehicle != "car" else None},
        "via": " → ".join(via[:5]),
        "limits": speed_limits(edges),
        "uses_3a": vehicle == "heavy" and any(e.get("road_class") == "motorway" and is_3a(e) for e in edges),
        "warnings": violations(edges, vehicle) + ([] if checked or not VEHICLES[vehicle]["forbid"]
                                                  else ["（這條路線無法自動檢查路權，請自行確認沒有國道或快速道路）"]),
    }


async def valhalla_routes(points: list[dict], vehicle: str, uid: str | None = None) -> list[dict]:
    """回傳 1～3 條路線（只有起終點時，Valhalla 會另外給替代路線；有停靠點就只有一條）。"""
    v = VEHICLES[vehicle]
    # heading：重算個人路線時帶上目前車頭方向，Valhalla 才不會叫人原地迴轉
    locs = [{"lat": p["lat"], "lon": p["lon"], "type": "break" if i in (0, len(points) - 1) else "through",
             **({"heading": round(p["heading"]) % 360, "heading_tolerance": 60} if p.get("heading") is not None else {})}
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
    # 路段資料：路權檢查、依個人速度估時間、導航的速限都靠它（汽車沒有路權限制，但導航還是要速限）
    need_edges = True
    all_edges = [await route_edges(t, v["costing"]) if need_edges else [] for t in trips]
    if vehicle == "heavy":
        # 國道3甲例外：OSM 把 3甲 也標成收費，exclude_tolls 會一起擋掉。
        # 另外算一條允許國道的路線，如果它用到的國道「全部都是 3甲」而且比較快，就換掉第一條。
        alt = await _post("/route", body({**v["options"], "exclude_tolls": False}))
        if "trip" in alt and alt["trip"]["summary"]["time"] < trips[0]["summary"]["time"] - 30:
            alt_edges = await route_edges(alt["trip"], v["costing"]) or []
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
async def trip_route(tid: str, uid: str = Depends(reader)):  # 成員或觀看連結
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
    now = int(time.time() * 1000)
    doc = {"id": rid, "trip": tid, "by": uid, "created": now, "points": pts,
           "vehicle": vehicle, "avoid_highways": vehicle == "scooter", "source_url": body.source_url, **route}
    await r.json().set(K.route(rid), "$", doc)
    old = t.get("route")
    live = t.get("status") == "live"
    old_km = None
    if old and live:
        # 騎到一半改路線：舊路線留著（第 4 點：回放看得到原本要走哪），只標上被換掉的時間
        old_km = ((await r.json().get(K.route(old), "$.summary.km")) or [None])[0]
        await r.json().set(K.route(old), "$.replaced", now)
    elif old:
        await r.delete(K.route(old))
    if not live:
        await r.delete(K.routes(tid))  # 還沒出發前改幾次都不算紀錄，只留最後一條
    s = route["summary"]
    # Stream：ID 就是換路線的時間，回放用 XRANGE 依時間讀出每一段該走哪條路
    await r.xadd(K.routes(tid), {"rid": rid, "by": uid, "km": s["km"]}, id=f"{now}-*")
    await r.hset(K.trip(tid), "route", rid)
    await r.delete(K.progress(tid))
    await drop_navroutes(tid)  # 全隊路線換了，每個人的個人路線都作廢
    msg = {"kind": "route", "id": rid}
    if live and old:
        diff = s["km"] - old_km if old_km is not None else None
        await r.delete(K.offroute(tid))  # 舊路線的偏離標記作廢；離新路線太遠的人下面會先標上，避免誤報「偏離」
        await events.emit(tid, "route", uid, f"改了路線：{s['km']:.1f} km" +
                          (f"（{'多' if diff >= 0 else '少'} {abs(diff):.1f} km）" if diff is not None else "") + "，原本的路線保留在回放")
        msg.update(changed=True, by=uid, km=s["km"], diff_km=None if diff is None else round(diff, 2))
        asyncio.create_task(rejoin_all(tid, doc))
    else:
        await events.emit(tid, "route", uid, f"設定路線（{VEHICLES[vehicle]['name']}）：{s['km']:.1f} km，"
                                              f"預估 {s['min'] // 60} 小時 {s['min'] % 60} 分")
    await events.publish(tid, msg)
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
        await drop_navroutes(tid)
        await events.publish(tid, {"kind": "route", "id": None})
    return {"ok": True}


# ---------- 偏離後的個人路線 ----------
# 偏離全隊路線時，從目前位置（含車頭方向）重算到「下一個停靠點」，沒有停靠點才到終點（使用者 11-20 決定）。
# 只有這個人用；騎到停靠點、或自己騎回全隊路線時，worker 會把它刪掉，接回全隊路線。
# 存 trip:{tid}:navroute:{uid}（RedisJSON）。team_from_km／team_to_km 是個人路線兩端在全隊路線上的里程：
# worker 用「個人路線走了幾成」換算成全隊路線上的里程，落隊／超前的距離才不會因為走別條路而亂跳。
NAVROUTE_TTL = 6 * 3600
NEXT_STOP_MIN_KM = 0.3      # 太近的停靠點（300 m 內）跳過，直接找下一個
STOP_ON_ROUTE_M = 300       # 集合點／休息點離全隊路線 300 m 內才算「在路線上」


class RerouteIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    heading: float | None = Field(None, ge=0, le=360)


async def drop_navroutes(tid: str):
    keys = [k async for k in r.scan_iter(match=K.navroute(tid, "*"), count=200)]
    if keys:
        await r.delete(*keys)


async def next_stop(tid: str, route: dict, from_km: float) -> dict:
    """全隊路線上、from_km 之後的第一個停靠點：規劃時的途經點，或成員設的集合點／休息點（要在路線附近）。"""
    from .waypoints import list_waypoints  # 避免循環匯入
    coords, cum = route["coords"], route["cum_km"]
    cands = []
    for p in route.get("points", [])[1:-1]:
        km, off, _ = project_on_route(coords, cum, p["lat"], p["lon"])
        cands.append({"name": p.get("name") or "途經點", "lat": p["lat"], "lon": p["lon"], "km": km})
    for w in await list_waypoints(tid):
        km, off, _ = project_on_route(coords, cum, float(w["lat"]), float(w["lon"]))
        if off <= STOP_ON_ROUTE_M:
            cands.append({"name": w["name"], "lat": float(w["lat"]), "lon": float(w["lon"]), "km": km})
    ahead = sorted((c for c in cands if c["km"] > from_km + NEXT_STOP_MIN_KM), key=lambda c: c["km"])
    if ahead:
        return {**ahead[0], "kind": "stop"}
    end = route["points"][-1] if route.get("points") else {"lat": coords[-1][1], "lon": coords[-1][0], "name": ""}
    return {"name": end.get("name") or "終點", "lat": end["lat"], "lon": end["lon"], "km": cum[-1], "kind": "end"}


async def make_navroute(tid: str, uid: str, team: dict, lat: float, lon: float, heading: float | None,
                        from_km: float, reason: str = "offroute") -> dict:
    """從 (lat, lon, heading) 算到全隊路線上 from_km 之後的下一個停靠點，存成這個人的個人路線。"""
    stop = await next_stop(tid, team, from_km)
    vehicle = team.get("vehicle") or ("scooter" if team.get("avoid_highways", True) else "heavy")
    end = {"lat": stop["lat"], "lon": stop["lon"]}
    try:
        route = (await valhalla_routes([{"lat": lat, "lon": lon, "heading": heading}, end], vehicle))[0]
    except HTTPException:
        # 附近沒有和車頭方向相符的路（GPS 飄、在停車場裡繞）：不限方向再算一次
        if heading is None:
            raise
        route = (await valhalla_routes([{"lat": lat, "lon": lon}, end], vehicle))[0]
    doc = {"by": uid, "created": int(time.time() * 1000), "team_route": team.get("id"), "target": stop, "reason": reason,
           "team_from_km": round(from_km, 3), "team_to_km": round(stop["km"], 3), "vehicle": vehicle, **route}
    key = K.navroute(tid, uid)
    await r.json().set(key, "$", doc)
    await r.expire(key, NAVROUTE_TTL)
    await r.hdel(K.offroute(tid), uid)  # 換成新路線了：之後再偏離這條才會重新通知
    s = route["summary"]
    extra = s["km"] - (stop["km"] - from_km)
    head = "接回新路線" if reason == "routechange" else "重新規劃"
    await events.emit(tid, "reroute", uid, f"{head}：到「{stop['name']}」{s['km']:.1f} km"
                                            f"（{'多' if extra >= 0 else '少'} {abs(extra):.1f} km）")
    await events.publish(tid, {"kind": "navroute", "uid": uid, "reason": reason})
    return doc


REJOIN_FRESH_MS = 10 * 60_000  # 位置 10 分鐘內有更新的人才幫他算（太久沒回報的，等他回來偏離時再自動算）


async def rejoin_all(tid: str, team: dict):
    """第 3 點：建立者騎到一半改路線。每個正在騎的人用自己目前的位置判斷：
    還在新路線上（150 m 內）就照常；不在（已經過了分岔口、或本來就在別條路）就各自算一條接回新路線的個人路線。"""
    try:
        uids = await r.smembers(K.active(tid))
        roles = await r.hgetall(K.role(tid))
        now = int(time.time() * 1000)
        for u in uids:
            if roles.get(u) == "viewer":
                continue
            lat, lon, heading, speed, seen = await r.hmget(K.state(tid, u), "lat", "lon", "heading", "speed", "seen")
            if not lat or not lon or not seen or now - int(float(seen)) > REJOIN_FRESH_MS:
                continue
            lat, lon = float(lat), float(lon)
            km, off, _ = project_on_route(team["coords"], team["cum_km"], lat, lon)
            if off <= OFF_NEW_ROUTE_M:
                continue
            await r.hsetnx(K.offroute(tid), u, round(km, 2))  # 先占住：worker 才不會在算好之前推「你偏離路線」
            hd = float(heading) if heading and speed and float(speed) > 1 else None
            try:
                await make_navroute(tid, u, team, lat, lon, hd, km, "routechange")
            except Exception:  # noqa: BLE001  算不出來：交給前端偏離 10 秒自動重算
                await r.hdel(K.offroute(tid), u)
    except Exception:  # noqa: BLE001  背景工作，失敗不影響改路線本身
        pass


OFF_NEW_ROUTE_M = 150  # 跟 worker 的 OFF_ROUTE_M 一樣


@router.post("/trips/{tid}/reroute")
async def reroute(tid: str, body: RerouteIn, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    t = await trip_or_404(tid)
    if t.get("status") != "live":
        raise HTTPException(409, "行程進行中才能重新規劃")
    team = await get_route_doc(tid)
    if not team:
        raise HTTPException(409, "這趟沒有規劃路線")
    # 我在全隊路線上的里程：偏離當下記下的那個值（offroute），沒有就用最新進度
    from_km = await r.hget(K.offroute(tid), uid) or await r.hget(K.progress(tid), uid)
    from_km = float(from_km) if from_km is not None else project_on_route(team["coords"], team["cum_km"], body.lat, body.lon)[0]
    return await make_navroute(tid, uid, team, body.lat, body.lon, body.heading, from_km)


@router.get("/trips/{tid}/navroute")
async def my_navroute(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return await r.json().get(K.navroute(tid, uid)) or {}


@router.delete("/trips/{tid}/navroute")
async def drop_my_navroute(tid: str, uid: str = Depends(current_uid)):
    """不要個人路線了（想自己騎回原路線）：刪掉，回到全隊路線。"""
    await require_member(tid, uid)
    if await r.delete(K.navroute(tid, uid)):
        await events.publish(tid, {"kind": "navroute", "uid": uid})
    return {"ok": True}
