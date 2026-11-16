"""長期紀錄：點亮鄉鎮、熱力圖、累計統計（規格 4.6）。

Redis：
- idx:townshape         GEOSHAPE：點 → 鄉鎮（FT.SEARCH "@shape:[CONTAINS $pt]"）
- celltown              Hash：迷霧格子 → 鄉鎮 ID 的快取（同一格不必每次都查空間索引）
- user:{uid}:towns      Set：點亮過的鄉鎮；SADD 回傳 1 就是「第一次點亮」
- user:{uid}:townfirst  Hash：鄉鎮 → 第一次點亮的時間
- heat:{uid}            Sorted Set：格子 → 經過的點數（ZINCRBY），ZREVRANGE 就是「最常去的地方」
"""
import json
import time

from fastapi import APIRouter, Depends, Query

from .auth import current_uid
from .db import K, r
from .geo import CELL, cell_of

router = APIRouter(prefix="/api")


def cell_center(cell: str) -> tuple[float, float]:
    a, b = cell.split(":")
    return (int(a) + 0.5) * CELL, (int(b) + 0.5) * CELL  # lat, lon


async def town_of_cell(cell: str) -> str | None:
    """格子 → 鄉鎮 ID（先查快取，沒有才用 GEOSHAPE 空間索引查，查完寫回快取；不在任何鄉鎮記成 "-"）。"""
    hit = await r.hget("celltown", cell)
    if hit is not None:
        return hit if hit != "-" else None
    lat, lon = cell_center(cell)
    res = await r.execute_command("FT.SEARCH", "idx:townshape", "@shape:[CONTAINS $pt]", "PARAMS", 2, "pt",
                                  f"POINT({lon:.6f} {lat:.6f})", "RETURN", 1, "code", "LIMIT", 0, 1, "DIALECT", 3)
    code = None
    if isinstance(res, dict):
        rows = res.get("results", [])
        code = rows[0]["id"].split(":")[1] if rows else None
    elif res and res[0]:
        code = res[1].split(":")[1]
    await r.hset("celltown", cell, code or "-")
    return code


async def record_point(uid: str, lat: float, lon: float, ts: int) -> str | None:
    """一個位置點：熱力圖＋點亮鄉鎮。回傳「第一次點亮」的鄉鎮 ID（沒有就 None）。"""
    cell = cell_of(lat, lon)
    await r.zincrby(f"heat:{uid}", 1, cell)
    code = await town_of_cell(cell)
    if code and await r.sadd(f"user:{uid}:towns", code):
        await r.hsetnx(f"user:{uid}:townfirst", code, ts)
        return code
    return None


# ---------- API ----------

@router.get("/towns/geo")
async def towns_geo(uid: str = Depends(current_uid)):
    """全台鄉鎮界線 GeoJSON（簡化過）。組好後快取在 Redis，1 天過期。"""
    cached = await r.get("cache:towns:geojson")
    if cached:
        return json.loads(cached)
    ids = list(await r.smembers("towns:all"))
    async with r.pipeline(transaction=False) as p:
        for i in ids:
            p.hmget(f"town:{i}", "name", "county", "geojson")
        rows = await p.execute()
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": int(i), "properties": {"id": i, "name": n, "county": c}, "geometry": json.loads(g)}
        for i, (n, c, g) in zip(ids, rows) if g]}
    await r.set("cache:towns:geojson", json.dumps(fc, separators=(",", ":")), ex=86400)
    return fc


@router.get("/me/towns")
async def my_towns(uid: str = Depends(current_uid)):
    lit = await r.smembers(f"user:{uid}:towns")
    all_ids = list(await r.smembers("towns:all"))
    async with r.pipeline(transaction=False) as p:
        for i in all_ids:
            p.hmget(f"town:{i}", "name", "county")
        rows = await p.execute()
    by: dict[str, dict] = {}
    for i, (name, county) in zip(all_ids, rows):
        b = by.setdefault(county, {"county": county, "lit": 0, "total": 0, "towns": []})
        b["total"] += 1
        if i in lit:
            b["lit"] += 1
            b["towns"].append(name)
    first = await r.hgetall(f"user:{uid}:townfirst")
    recent = sorted(first.items(), key=lambda x: -int(x[1]))[:8]
    names = {i: (n, c) for i, (n, c) in zip(all_ids, rows)}
    return {
        "total": len(all_ids), "lit": len(lit & set(all_ids)), "ids": sorted(lit),
        "counties": sorted(by.values(), key=lambda b: (-b["lit"] / b["total"], b["county"])),
        "recent": [{"id": i, "name": names.get(i, ("", ""))[0], "county": names.get(i, ("", ""))[1], "ts": int(t)} for i, t in recent],
    }


@router.get("/me/heat")
async def my_heat(limit: int = Query(30000, ge=100, le=60000), uid: str = Depends(current_uid)):
    """熱力圖：經過次數最多的前 N 個格子（ZREVRANGE … WITHSCORES）。"""
    rows = await r.zrevrange(f"heat:{uid}", 0, limit - 1, withscores=True)
    out = []
    for cell, n in rows:
        lat, lon = cell_center(cell)
        out.append([round(lon, 5), round(lat, 5), int(n)])
    return {"cells": out, "total_cells": await r.zcard(f"heat:{uid}")}


@router.get("/me/stats")
async def my_stats(uid: str = Depends(current_uid)):
    """累計統計：每月里程（足跡的每日里程 Hash 加總）、最常去的地方（熱力圖前幾名合併到鄉鎮）、行程數。"""
    days = await r.hgetall(K.daykm(uid))
    months: dict[str, float] = {}
    for d, km in days.items():
        months[d[:6]] = months.get(d[:6], 0) + float(km)
    total_km = sum(float(v) for v in days.values())
    # 最常去的地方：前 400 個熱門格子，依所在鄉鎮加總
    top = await r.zrevrange(f"heat:{uid}", 0, 399, withscores=True)
    per_town: dict[str, float] = {}
    for cell, n in top:
        code = await town_of_cell(cell)
        if code:
            per_town[code] = per_town.get(code, 0) + n
    places = []
    for code, n in sorted(per_town.items(), key=lambda x: -x[1])[:8]:
        name, county = await r.hmget(f"town:{code}", "name", "county")
        places.append({"id": code, "name": name, "county": county, "points": int(n)})
    trips = await r.zcard(K.user_trips(uid))
    return {
        "total_km": round(total_km, 1), "days": len(days), "trips": trips,
        "months": [{"month": m, "km": round(v, 1)} for m, v in sorted(months.items())],
        "places": places, "now": int(time.time() * 1000),
    }
