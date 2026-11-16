"""全年足跡（迷霧地圖）：依日期範圍與一天中的時段，查出去過的格子與軌跡。"""
import hashlib
import json
import math
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import current_uid
from .db import K, r
from .geo import BUCKETS, CELL, TPE, haversine_m, local_dt

router = APIRouter(prefix="/api/footprint")
MAX_LINE_POINTS = 40_000


def parse_day(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"日期格式要是 YYYY-MM-DD：{s}")


def parse_buckets(s: str | None) -> list[str]:
    if not s:
        return list(BUCKETS)
    out = [b for b in s.split(",") if b in BUCKETS]
    return out or list(BUCKETS)


@router.get("/summary")
async def summary(uid: str = Depends(current_uid)):
    daykm = await r.hgetall(K.daykm(uid))
    days = {d: round(float(v), 2) for d, v in sorted(daykm.items())}
    first = await r.xrange(K.footprint(uid), count=1)
    last = await r.xrevrange(K.footprint(uid), count=1)
    return {
        "days": days,
        "points": await r.xlen(K.footprint(uid)),
        "cells_all": await r.scard(K.fog_all(uid)),
        "first_ts": int(first[0][0].split("-")[0]) if first else None,
        "last_ts": int(last[0][0].split("-")[0]) if last else None,
        "cell_deg": CELL,
    }


async def _range_days(uid: str, start: date, end: date) -> list[str]:
    have = set(await r.hkeys(K.daykm(uid)))
    out, d = [], start
    while d <= end:
        k = d.strftime("%Y%m%d")
        if k in have:
            out.append(k)
        d += timedelta(days=1)
    return out


@router.get("/cells")
async def cells(
    start: str = Query(..., alias="from"),
    end: str = Query(..., alias="to"),
    buckets: str | None = None,
    uid: str = Depends(current_uid),
):
    """把範圍內每一天、每個時段的格子集合 SUNION 起來（運算在 Redis 裡完成）。"""
    s, e = parse_day(start), parse_day(end)
    if e < s:
        s, e = e, s
    bs = parse_buckets(buckets)
    days = await _range_days(uid, s, e)
    keys = [K.fog(uid, d, b) for d in days for b in bs]
    members: set[str] = set()
    for i in range(0, len(keys), 500):
        if keys[i:i + 500]:
            members |= await r.sunion(keys[i:i + 500])
    flat: list[int] = []
    area = 0.0
    for m in members:
        la, lo = m.split(":")
        la, lo = int(la), int(lo)
        flat += [la, lo]
        lat = (la + 0.5) * CELL
        area += (CELL * 111.32) * (CELL * 111.32 * math.cos(math.radians(lat)))
    daykm = await r.hmget(K.daykm(uid), days) if days else []
    km = sum(float(x or 0) for x in daykm)
    return {"cells": flat, "count": len(members), "area_km2": round(area, 1), "km": round(km, 1),
            "days": len(days), "cell_deg": CELL, "buckets": bs}


@router.get("/cells/all")
async def cells_all(uid: str = Depends(current_uid)):
    members = await r.smembers(K.fog_all(uid))
    flat: list[int] = []
    for m in members:
        la, lo = m.split(":")
        flat += [int(la), int(lo)]
    return {"cells": flat, "count": len(members), "cell_deg": CELL}


@router.get("/lines")
async def lines(
    start: str = Query(..., alias="from"),
    end: str = Query(..., alias="to"),
    buckets: str | None = None,
    uid: str = Depends(current_uid),
):
    """XRANGE 直接用時間戳當範圍查軌跡；結果用 TTL 快取 10 分鐘。"""
    s, e = parse_day(start), parse_day(end)
    if e < s:
        s, e = e, s
    bs = parse_buckets(buckets)
    t0 = int(datetime(s.year, s.month, s.day, tzinfo=TPE).timestamp() * 1000)
    t1 = int(datetime(e.year, e.month, e.day, tzinfo=TPE).timestamp() * 1000) + 86400_000 - 1
    last = await r.xrevrange(K.footprint(uid), count=1)
    qkey = hashlib.sha1(f"{t0}:{t1}:{','.join(bs)}:{last[0][0] if last else ''}".encode()).hexdigest()[:16]
    cached = await r.get(K.cache_lines(uid, qkey))
    if cached:
        return json.loads(cached)

    want = set(bs)
    segs: list[list[list[float]]] = []
    cur: list[list[float]] = []
    prev = None
    cursor = f"{t0}-0"
    total = 0
    while True:
        rows = await r.xrange(K.footprint(uid), min=cursor, max=f"{t1}-18446744073709551615", count=10_000)
        if not rows:
            break
        for rid, f in rows:
            ts = int(rid.split("-")[0])
            h = local_dt(ts).hour
            b = "dawn" if 4 <= h < 8 else "day" if 8 <= h < 17 else "dusk" if 17 <= h < 20 else "night"
            if b not in want:
                prev = None
                continue
            lat, lon = float(f["lat"]), float(f["lon"])
            if prev:
                gap = (ts - prev[0]) / 1000
                dist = haversine_m(prev[1], prev[2], lat, lon)
                if gap > 600 or dist > 3000 or (gap > 0 and dist / gap * 3.6 > 250):
                    if len(cur) > 1:
                        segs.append(cur)
                    cur = []
            cur.append([round(lon, 5), round(lat, 5)])
            prev = (ts, lat, lon)
            total += 1
        last_id = rows[-1][0]
        ms, seq = last_id.split("-")
        cursor = f"{ms}-{int(seq) + 1}"
        if len(rows) < 10_000:
            break
    if len(cur) > 1:
        segs.append(cur)
    stride = max(1, math.ceil(total / MAX_LINE_POINTS))
    if stride > 1:
        segs = [s[::stride] + [s[-1]] for s in segs]
        segs = [s for s in segs if len(s) > 1]
    out = {"type": "Feature", "properties": {"points": total, "stride": stride},
           "geometry": {"type": "MultiLineString", "coordinates": segs}}
    await r.set(K.cache_lines(uid, qkey), json.dumps(out), ex=600)
    return out
