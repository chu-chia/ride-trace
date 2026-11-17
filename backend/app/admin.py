"""管理後台（規格 4.8）：Redis 狀態、線上人數、進行中的行程、每秒寫入／Pub/Sub 訊息量、外部資料同步狀態。
只有 ADMIN_USERS（逗號分隔的帳號，預設 wei）看得到。"""
import json
import os
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .auth import current_uid
from .db import K, r

router = APIRouter(prefix="/api/admin")
ADMINS = {x.strip() for x in os.environ.get("ADMIN_USERS", "wei").split(",") if x.strip()}
VALHALLA = os.environ.get("VALHALLA_URL", "http://localhost:8752")


async def is_admin(uid: str) -> bool:
    return (await r.hget(K.user(uid), "username")) in ADMINS


async def require_admin(uid: str = Depends(current_uid)) -> str:
    if not await is_admin(uid):
        raise HTTPException(403, "只有管理者可以看後台")
    return uid


@router.get("/whoami")
async def whoami(uid: str = Depends(current_uid)):
    return {"admin": await is_admin(uid)}


async def key_breakdown() -> dict:
    """掃過所有 key：各資料型別的數量，以及各「用途」（key 的第一段前綴）的數量與估計記憶體。
    SCAN 一輪要一兩秒，結果快取 60 秒。"""
    cached = await r.get("cache:admin:keys")
    if cached:
        return json.loads(cached)
    types: dict[str, int] = {}
    groups: dict[str, dict] = {}
    batch = []

    async def flush():
        async with r.pipeline(transaction=False) as p:
            for k in batch:
                p.type(k)
            res = await p.execute()
        for k, t in zip(batch, res):
            types[t] = types.get(t, 0) + 1
            g = k.split(":", 1)[0]
            gg = groups.setdefault(g, {"prefix": g, "keys": 0, "sample": []})
            gg["keys"] += 1
            if len(gg["sample"]) < 30:
                gg["sample"].append(k)
        batch.clear()

    async for k in r.scan_iter(count=5000):
        batch.append(k)
        if len(batch) >= 5000:
            await flush()
    if batch:
        await flush()
    # 每一組抽樣 MEMORY USAGE，平均 × 數量 ≈ 這一組的記憶體
    for g in groups.values():
        async with r.pipeline(transaction=False) as p:
            for k in g["sample"]:
                p.memory_usage(k)
            sizes = [x or 0 for x in await p.execute()]
        g["est_bytes"] = int(sum(sizes) / max(1, len(sizes)) * g["keys"])
        del g["sample"]
    out = {"types": types, "groups": sorted(groups.values(), key=lambda g: -g["est_bytes"])[:16], "at": int(time.time() * 1000)}
    await r.set("cache:admin:keys", json.dumps(out), ex=60)
    return out


async def series(key: str, minutes: int = 10, bucket_s: int = 10) -> list[list[float]]:
    """TS.INCRBY 是「在上一個值上加」：這兩條 series 其實是累計計數器。
    所以每 10 秒取最大值（AGGREGATION max），相鄰兩格相減 ÷ 秒數 = 每秒速率。"""
    now = int(time.time() * 1000)
    try:
        res = await r.execute_command("TS.RANGE", key, now - minutes * 60_000 - bucket_s * 1000, now,
                                      "AGGREGATION", "max", bucket_s * 1000)
    except Exception:  # noqa: BLE001  key 還不存在
        return []
    pts = [(int(t), float(v)) for t, v in res]
    out = []
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        dt = max(1, (t1 - t0) / 1000)
        out.append([t1, round(max(0.0, v1 - v0) / dt, 2)])
    return out[:-1]  # 最後一格還沒滿 10 秒，不畫（不然看起來像突然掉下來）


@router.get("/overview")
async def overview(uid: str = Depends(require_admin)):
    info = await r.info()
    now = int(time.time() * 1000)
    await r.zremrangebyscore("online:report", 0, now - 86_400_000)
    seq = int(await r.get("seq:trip") or 0)
    async with r.pipeline(transaction=False) as p:
        for i in range(1, seq + 1):
            p.hmget(K.trip(str(i)), "status", "name")
        trips = await p.execute()
    live = [{"id": str(i + 1), "name": n, "riders": await r.scard(K.active(str(i + 1)))}
            for i, (st, n) in enumerate(trips) if st == "live"]
    groups = []
    for stream in (K.ingest, "stream:notify"):  # 位置回報（統計、警示）、推播
        try:
            for g in await r.xinfo_groups(stream):
                groups.append({"name": f"{g['name']}（{stream}）", "consumers": g["consumers"], "pending": g["pending"],
                               "lag": g.get("lag")})
        except Exception:  # noqa: BLE001
            pass
    metas = {}
    for name, key in (("測速照相", "meta:speedcam"), ("地點與 POI", "meta:poi"), ("鄉鎮界線", "meta:towns")):
        m = await r.hgetall(key)
        metas[name] = {"source": m.get("source"), "count": int(m.get("count", 0)), "updated": int(m.get("updated", 0))}
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            vs = (await c.get(f"{VALHALLA}/status")).json()
        valhalla = {"ok": True, "version": vs.get("version"), "tileset": vs.get("tileset_last_modified")}
    except Exception:  # noqa: BLE001
        valhalla = {"ok": False}
    return {
        "redis": {
            "version": info.get("redis_version"), "uptime_s": info.get("uptime_in_seconds"),
            "used_memory": info.get("used_memory"), "used_memory_human": info.get("used_memory_human"),
            "peak_human": info.get("used_memory_peak_human"), "rss_human": info.get("used_memory_rss_human"),
            "keys": await r.dbsize(), "clients": info.get("connected_clients"),
            "ops_per_sec": info.get("instantaneous_ops_per_sec"), "commands": info.get("total_commands_processed"),
            "pubsub_channels": info.get("pubsub_channels"), "pubsub_patterns": info.get("pubsub_patterns"),
            "hits": info.get("keyspace_hits"), "misses": info.get("keyspace_misses"),
            "aof": info.get("aof_enabled"), "last_save": info.get("rdb_last_save_time"),
        },
        "online": {
            "reporting_2min": await r.zcount("online:report", now - 120_000, "+inf"),
            "reporting_today": await r.zcount("online:report", now - 86_400_000, "+inf"),
            "ws_connections": int(await r.get("stat:ws") or 0),
            "users": await r.get("seq:user") or 0,
        },
        "trips": {"live": live, "total": seq},
        "series": {"writes": await series(K.ts_writes), "pubsub": await series("ts:sys:pubsub")},
        "groups": groups,
        "data": {**metas, "TDX 路況": {"source": "未串接", "count": 0, "updated": 0},
                 "天氣": {"source": "未串接", "count": 0, "updated": 0}},
        "valhalla": valhalla,
        "now": now,
    }


@router.get("/keys")
async def keys(uid: str = Depends(require_admin)):
    return await key_breakdown()
