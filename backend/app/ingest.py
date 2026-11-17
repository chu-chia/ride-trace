"""位置回報：網頁（/api/track）和 Traccar Client（/osmand）共用同一條寫入流程。"""
import json
import time
from datetime import datetime
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import events
from .auth import current_uid
from .db import K, r
from .geo import bucket_of, day_key, segment_cells

router = APIRouter()
HEARTBEAT_S = 90
TS_RETENTION_MS = 0  # 0 = 永久保存


class Fix(BaseModel):
    lat: float
    lon: float
    alt: float | None = None
    speed: float | None = None      # m/s
    heading: float | None = None
    acc: float | None = None
    batt: float | None = None       # 0–100
    ts: int | None = None           # ms
    src: str = "web"


def _num(v):
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def _ts(v) -> int | None:
    if v in (None, ""):
        return None
    try:
        f = float(v)
        return int(f if f > 1e12 else f * 1000)
    except ValueError:
        try:
            return int(datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None


async def ingest(uid: str, fix: Fix) -> dict:
    now = int(time.time() * 1000)
    ts = fix.ts or now
    if not (-90 <= fix.lat <= 90 and -180 <= fix.lon <= 180):
        raise HTTPException(400, "座標不合法")

    # 先讀：目前所在行程、上一個點、目前狀態（一次 round trip）
    async with r.pipeline(transaction=False) as p:
        p.get(K.active_trip(uid))
        p.hmget(K.last(uid), "ts", "lat", "lon")
        tid_res, last = await p.execute()
    tid = tid_res
    live = False
    prev_status = None
    if tid:
        async with r.pipeline(transaction=False) as p:
            p.hget(K.trip(tid), "status")
            p.sismember(K.active(tid), uid)
            p.hget(K.state(tid, uid), "status")
            status, is_active, prev_status = await p.execute()
        live = status == "live" and bool(is_active)

    prev = (int(last[0]), float(last[1]), float(last[2])) if last[0] else None
    fresh = prev is None or ts > prev[0]
    cells, dist_m = segment_cells(prev, (ts, fix.lat, fix.lon)) if fresh else (set(), 0.0)
    day, bucket = day_key(ts), bucket_of(ts)

    fields = {"lat": fix.lat, "lon": fix.lon, "alt": fix.alt, "speed": fix.speed, "heading": fix.heading,
              "acc": fix.acc, "batt": fix.batt, "ts": ts, "src": fix.src}
    fields = {k: str(round(v, 7) if isinstance(v, float) else v) for k, v in fields.items() if v is not None}

    # 一個 Pipeline 寫完所有東西：一次網路來回
    async with r.pipeline(transaction=False) as p:
        if fresh:
            # 全年足跡：Stream ID 直接用時間戳，之後可以用 XRANGE 依時間範圍查
            p.xadd(K.footprint(uid), {"lat": fields["lat"], "lon": fields["lon"], "ele": fields.get("alt", "0")}, id=f"{ts}-*")
            p.hset(K.last(uid), mapping={"ts": ts, "lat": fix.lat, "lon": fix.lon})
            if cells:
                p.sadd(K.fog(uid, day, bucket), *cells)
                p.sadd(K.fog_all(uid), *cells)
            if dist_m:
                p.hincrbyfloat(K.daykm(uid), day, round(dist_m / 1000, 4))
            else:
                p.hincrbyfloat(K.daykm(uid), day, 0)
        if live and fresh:
            p.xadd(K.track(tid, uid), fields)
            p.geoadd(K.geo(tid), [fix.lon, fix.lat, uid])
            if fix.speed is not None:
                p.execute_command("TS.ADD", K.ts_speed(tid, uid), ts, round(fix.speed * 3.6, 2),
                                  "RETENTION", TS_RETENTION_MS, "ON_DUPLICATE", "LAST",
                                  "LABELS", "trip", tid, "uid", uid, "kind", "speed")
            if fix.alt is not None:
                p.execute_command("TS.ADD", K.ts_alt(tid, uid), ts, round(fix.alt, 1),
                                  "RETENTION", TS_RETENTION_MS, "ON_DUPLICATE", "LAST",
                                  "LABELS", "trip", tid, "uid", uid, "kind", "alt")
            p.publish(K.live(tid), json.dumps({"kind": "pos", "uid": uid, **{k: _num(v) if k != "src" else v for k, v in fields.items()}}))
            p.execute_command("TS.INCRBY", "ts:sys:pubsub", 1, "TIMESTAMP", now // 1000 * 1000, "RETENTION", 7 * 86400_000,
                              "LABELS", "metric", "sys", "kind", "pubsub")
        if live:
            p.hset(K.state(tid, uid), mapping={**(fields if fresh else {}), "status": "ok", "seen": now})
            p.set(K.hb(tid, uid), now, ex=HEARTBEAT_S)
        p.zadd("online:report", {uid: now})  # 後台「線上人數」：最近 2 分鐘有回報位置的人（ZCOUNT）
        # 交給 worker：行程中的回報（警示、統計），以及所有新的足跡點（熱力圖、點亮鄉鎮）
        if fresh:
            p.xadd(K.ingest, {"trip": tid if live else "", "uid": uid, "fp": 1, **fields},
                   maxlen=100_000, approximate=True)
        p.execute_command("TS.INCRBY", K.ts_writes, 1, "TIMESTAMP", now // 1000 * 1000, "RETENTION", 7 * 86400_000)
        results = await p.execute(raise_on_error=False)

    errors = [str(x) for x in results if isinstance(x, Exception)]
    if live and prev_status == "lost":
        await events.emit(tid, "back", uid, "恢復連線", ts=ts)
        await events.publish(tid, {"kind": "status", "uid": uid, "status": "ok"})
    return {"ok": True, "trip": tid if live else None, "footprint": fresh, "errors": errors[:3], "stale": not fresh}


@router.post("/api/track")
async def track(fix: Fix, uid: str = Depends(current_uid)):
    return await ingest(uid, fix)


@router.api_route("/osmand", methods=["GET", "POST"])
async def osmand(request: Request):
    """Traccar Client：舊版用 OsmAnd 協定（query string，速度單位是節），新版送 JSON。"""
    q = dict(request.query_params)
    body = {}
    if request.method == "POST":
        raw = await request.body()
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            # iOS Traccar Client 用 x-www-form-urlencoded 送，自己解析，不依賴 python-multipart
            q.update(dict(parse_qsl(raw.decode("utf-8", "replace"))))
    if isinstance(body, dict) and "location" in body:
        loc = body["location"]
        c = loc.get("coords", {})
        device = body.get("device_id") or q.get("id")
        lvl = (loc.get("battery") or {}).get("level")
        fix = Fix(lat=c["latitude"], lon=c["longitude"], alt=_num(c.get("altitude")), speed=_num(c.get("speed")),
                  heading=_num(c.get("heading")), acc=_num(c.get("accuracy")),
                  batt=None if lvl is None else round(float(lvl) * 100 if float(lvl) <= 1 else float(lvl)),
                  ts=_ts(loc.get("timestamp")), src="traccar")
    else:
        device = q.get("id") or q.get("deviceid")
        if not device or "lat" not in q or "lon" not in q:
            raise HTTPException(400, "缺少 id、lat、lon")
        knots = _num(q.get("speed"))
        fix = Fix(lat=float(q["lat"]), lon=float(q["lon"]), alt=_num(q.get("altitude")),
                  speed=None if knots is None else knots * 0.514444, heading=_num(q.get("bearing") or q.get("heading")),
                  acc=_num(q.get("accuracy") or q.get("hdop")), batt=_num(q.get("batt")),
                  ts=_ts(q.get("timestamp")), src="traccar")
    uid = await r.get(K.device(device)) if device else None
    if not uid:
        raise HTTPException(403, "裝置 ID 沒有綁定帳號")
    return await ingest(uid, fix)
