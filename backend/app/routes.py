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
    street = "／".join((m.get("street_names") or m.get("begin_street_names") or [])[:2])
    return act, street


async def valhalla_route(points: list[dict], avoid_highways: bool) -> dict:
    body = {
        "locations": [{"lat": p["lat"], "lon": p["lon"], "type": "break" if i in (0, len(points) - 1) else "through"}
                      for i, p in enumerate(points)],
        "costing": "motorcycle",
        # 台灣 550cc 以下機車不能上國道：use_highways=0 盡量避開高速公路等級的道路
        "costing_options": {"motorcycle": {"use_highways": 0 if avoid_highways else 0.5, "use_trails": 0}},
        "units": "kilometers",
    }
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            res = await c.post(f"{VALHALLA}/route", json=body)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"路線引擎沒有回應：{e!r}")
    d = res.json()
    if "trip" not in d:
        raise HTTPException(422, f"算不出路線：{d.get('error', d)}")
    coords, maneuvers, km0 = [], [], 0.0
    for leg in d["trip"]["legs"]:
        shape = decode_polyline6(leg["shape"])
        base = len(coords) - (1 if coords else 0)
        if coords:
            shape = shape[1:]  # 下一段的起點就是上一段的終點
        for m in leg["maneuvers"]:
            act, street = turn_text(m)
            if m.get("type") in (4, 5, 6) and leg is not d["trip"]["legs"][-1]:
                act = "抵達途經點"
            maneuvers.append({"i": base + m["begin_shape_index"], "type": m.get("type", 0), "act": act, "street": street,
                              "len_km": round(m.get("length", 0), 3)})
        coords.extend(shape)
    # 累計里程
    cum = [0.0]
    for a, b in zip(coords, coords[1:]):
        cum.append(cum[-1] + haversine_m(a[1], a[0], b[1], b[0]) / 1000)
    # 太密就抽稀（轉彎點一定保留）
    keep = set(m["i"] for m in maneuvers) | {0, len(coords) - 1}
    step = max(1, math.ceil(len(coords) / MAX_POINTS))
    idx = sorted(set(range(0, len(coords), step)) | keep)
    remap = {old: new for new, old in enumerate(idx)}
    for m in maneuvers:
        m["km"] = round(cum[m["i"]], 3)
        m["i"] = remap[m["i"]]
    s = d["trip"]["summary"]
    return {
        "coords": [coords[i] for i in idx], "cum_km": [round(cum[i], 4) for i in idx], "maneuvers": maneuvers,
        "summary": {"km": round(s["length"], 2), "min": round(s["time"] / 60), "points": len(idx)},
    }


class PointIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    name: str = Field("", max_length=30)


class PlanIn(BaseModel):
    points: list[PointIn] = Field(min_length=2, max_length=25)
    avoid_highways: bool = True
    source_url: str = Field("", max_length=4000)


@router.post("/routes/preview")
async def preview(body: PlanIn, uid: str = Depends(current_uid)):
    """只算不存：規劃頁預覽用。"""
    return await valhalla_route([p.model_dump() for p in body.points], body.avoid_highways)


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
    res = await r.json().get(K.route(rid), "$.summary", "$.points", "$.avoid_highways")
    return {"summary": res["$.summary"][0], "points": res["$.points"][0], "avoid_highways": res["$.avoid_highways"][0]}


@router.put("/trips/{tid}/route")
async def set_route(tid: str, body: PlanIn, uid: str = Depends(current_uid)):
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以設定路線")
    if t.get("status") == "ended":
        raise HTTPException(409, "行程已經結束")
    pts = [p.model_dump() for p in body.points]
    route = await valhalla_route(pts, body.avoid_highways)
    rid = str(await r.incr("seq:route"))
    doc = {"id": rid, "trip": tid, "by": uid, "created": int(time.time() * 1000), "points": pts,
           "avoid_highways": body.avoid_highways, "source_url": body.source_url, **route}
    await r.json().set(K.route(rid), "$", doc)
    old = t.get("route")
    await r.hset(K.trip(tid), "route", rid)
    if old:
        await r.delete(K.route(old))
    await r.delete(K.progress(tid))
    s = route["summary"]
    await events.emit(tid, "route", uid, f"設定路線：{s['km']:.1f} km，預估 {s['min'] // 60} 小時 {s['min'] % 60} 分")
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
