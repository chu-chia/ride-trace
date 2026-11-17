"""回放：用 XRANGE 取出每個人的完整軌跡與事件，用 TS.MRANGE 一次取所有人的速度、海拔曲線。"""
import math

from fastapi import APIRouter, Depends, Query

from .auth import current_uid
from .db import K, r
from .events import event_from_stream
from .geo import haversine_m
from .trips import require_member, trip_detail

router = APIRouter(prefix="/api/trips")


def _f(v, default=None):
    try:
        x = float(v)
        return default if math.isnan(x) else x
    except (TypeError, ValueError):
        return default


def summarize(pts: list[list]) -> dict:
    """pts: [ts, lat, lon, alt, km/h]。"""
    if len(pts) < 2:
        return {"km": 0, "duration_ms": 0, "moving_ms": 0, "avg_kmh": 0, "max_kmh": 0, "climb_m": 0, "max_alt": None, "stops": 0}
    dist = moving = climb = 0.0
    speeds = []
    stops = 0
    still_since = None
    last_alt = None
    for a, b in zip(pts, pts[1:]):
        dt = (b[0] - a[0]) / 1000
        if dt <= 0:
            continue
        d = haversine_m(a[1], a[2], b[1], b[2])
        v = d / dt * 3.6
        if v > 250:          # 跳點不算
            continue
        dist += d
        if v > 5:
            moving += dt
            if still_since is not None and a[0] - still_since >= 120_000:
                stops += 1    # 停超過 2 分鐘算一次休息
            still_since = None
        elif still_since is None:
            still_since = a[0]
        if dt >= 2:
            speeds.append(v)
        if b[4] is not None and b[4] < 250:
            speeds.append(b[4])
        if b[3] is not None:
            if last_alt is None:
                last_alt = b[3]
            elif abs(b[3] - last_alt) >= 3:  # 3 公尺門檻，避免 GPS 雜訊灌水
                if b[3] > last_alt:
                    climb += b[3] - last_alt
                last_alt = b[3]
    alts = [p[3] for p in pts if p[3] is not None]
    speeds.sort()
    max_kmh = speeds[int(len(speeds) * 0.99)] if speeds else 0  # 取 99 百分位，避開 GPS 尖峰
    return {
        "km": round(dist / 1000, 2),
        "duration_ms": pts[-1][0] - pts[0][0],
        "moving_ms": int(moving * 1000),
        "avg_kmh": round(dist / 1000 / (moving / 3600), 1) if moving else 0,
        "max_kmh": round(max_kmh, 1),
        "climb_m": round(climb),
        "max_alt": round(max(alts)) if alts else None,
        "stops": stops,
    }


@router.get("/{tid}/replay")
async def replay(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    detail = await trip_detail(tid, uid)
    t0 = t1 = None
    for m in detail["members"]:
        rows = await r.xrange(K.track(tid, m["uid"]))
        pts = []
        for _, f in rows:
            lat, lon = _f(f.get("lat")), _f(f.get("lon"))
            if lat is None or lon is None:
                continue
            spd = _f(f.get("speed"))
            pts.append([int(f["ts"]), round(lat, 6), round(lon, 6),
                        None if _f(f.get("alt")) is None else round(_f(f.get("alt")), 1),
                        None if spd is None else round(spd * 3.6, 1),
                        None if _f(f.get("heading")) is None else round(_f(f.get("heading")))])
        pts.sort(key=lambda p: p[0])  # Stream 是到達順序，斷訊補傳的點要依 GPS 時間重排
        m["track"] = pts
        m["summary"] = summarize(pts)
        m.pop("state", None)
        if pts:
            t0 = pts[0][0] if t0 is None else min(t0, pts[0][0])
            t1 = pts[-1][0] if t1 is None else max(t1, pts[-1][0])
    raw = await r.xrange(K.events(tid))
    evs = [event_from_stream(i, f) for i, f in raw]
    # 聊天另存一條 Stream（trip:{id}:chat），回放時併進事件時間軸
    for i, f in await r.xrange(f"trip:{tid}:chat"):
        evs.append({"kind": "event", "id": i, "type": "chat", "uid": f.get("uid", ""), "text": f.get("text", ""),
                    "ts": int(f.get("ts") or i.split("-")[0])})
    evs.sort(key=lambda e: e["ts"])
    detail["events"] = evs
    detail["t0"], detail["t1"] = t0, t1
    return detail


@router.get("/{tid}/series")
async def series(tid: str, kind: str = Query("speed", pattern="^(speed|alt)$"), points: int = 300,
                 uid: str = Depends(current_uid)):
    """TS.MRANGE＋FILTER：用標籤一次查出這趟所有人的曲線，並在 Redis 裡做平均降採樣。"""
    await require_member(tid, uid)
    span = _parse_mrange(await r.execute_command("TS.MRANGE", "-", "+", "WITHLABELS", "FILTER", f"trip={tid}", f"kind={kind}"))
    starts = [v[0][0] for v in span.values() if v]
    ends = [v[-1][0] for v in span.values() if v]
    if not starts:
        return {"kind": kind, "bucket_ms": 0, "series": {}}
    bucket = max(1000, (max(ends) - min(starts)) // max(10, min(points, 2000)))
    res = _parse_mrange(await r.execute_command("TS.MRANGE", "-", "+", "WITHLABELS", "AGGREGATION", "avg", bucket,
                                                "FILTER", f"trip={tid}", f"kind={kind}"))
    return {"kind": kind, "bucket_ms": bucket, "series": res}


def _parse_mrange(res) -> dict:
    """redis-py 依協定版本回傳 dict 或 list，統一成 {uid: [[ts, value], ...]}。"""
    items = res.items() if isinstance(res, dict) else ((x[0], x[1:]) for x in res)
    out = {}
    for key, val in items:
        labels, samples = {}, []
        for part in val:
            if isinstance(part, dict):
                labels = labels or part
            elif isinstance(part, list) and part and isinstance(part[0], (list, tuple)) and len(part[0]) == 2 and not isinstance(part[0][0], str):
                samples = part
            elif isinstance(part, list) and part and isinstance(part[0], (list, tuple)) and isinstance(part[0][0], str):
                labels = labels or dict(part)
        out[labels.get("uid", key)] = [[int(t), round(float(v), 1)] for t, v in samples]
    return out
