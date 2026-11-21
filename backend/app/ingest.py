"""位置回報：網頁（/api/track）和 Traccar Client（/osmand）共用同一條寫入流程。"""
import json
import time
from datetime import datetime
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import events, interact
from .auth import current_uid
from .db import K, r
from .geo import ALT_MAX_M, ALT_MIN_M, MAX_SPEED_KMH, bucket_of, day_key, is_rough, segment_cells, step

router = APIRouter()
HEARTBEAT_S = 90         # 移動中：90 秒沒有回報就算失聯（騎車中斷訊要馬上知道）
HEARTBEAT_REST_S = 600   # 停著（< 5 km/h）：10 分鐘。iPhone 停著時定位 App 會休眠、要離開原地一段距離才醒，
                         # 停紅燈、休息、出發前在室內等都不會有新點；停太久的安全問題交給「久停」警示
REST_KMH = 5
DUP_MS = 20_000          # 同一個人 20 秒內有 Traccar 的點，網頁的點只當心跳（兩邊交錯會讓軌跡鋸齒，見 11-18 #62）


def heartbeat_s(speed_ms: float | None) -> int:
    """心跳 TTL：最後一點是停著的就放寬。沒有速度的點當成移動中（保守）。"""
    return HEARTBEAT_REST_S if speed_ms is not None and speed_ms * 3.6 < REST_KMH else HEARTBEAT_S
TS_RETENTION_MS = 0  # 0 = 永久保存
PRE_TTL_S = HEARTBEAT_REST_S  # 開始前的即時位置：10 分鐘沒新點就自己消失（不設心跳，不會觸發失聯）
PRE_SCAN = 20                 # 開始前分享位置：只看最近加入的 20 個行程裡「等待開始」的


async def planned_trips(uid: str) -> list[str]:
    """這個人參加、還在等待開始的行程（集合時隊友先互相看得到）。Demo 行程不算。"""
    ids = await r.zrevrange(K.user_trips(uid), 0, PRE_SCAN - 1)
    if not ids:
        return []
    async with r.pipeline(transaction=False) as p:
        for t in ids:
            p.hmget(K.trip(t), "status", "demo")
            p.sismember(K.members(t), uid)
            p.hget(K.role(t), uid)
        res = await p.execute()
    # 只看的人（viewer）不分享位置
    return [t for t, (st, demo), mem, role in zip(ids, res[::3], res[1::3], res[2::3]) if st == "planned" and not demo and mem and role != "viewer"]


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


MAX_FUTURE_MS = 5 * 60_000       # 手機時間比伺服器快超過 5 分鐘：改用伺服器時間（不然之後的正常點都會被當成舊點）
MAX_PAST_MS = 24 * 3600_000      # 超過一天前的點不收（斷網補傳最多也就幾小時）


async def ingest(uid: str, fix: Fix) -> dict:
    now = int(time.time() * 1000)
    ts = fix.ts or now
    if ts > now + MAX_FUTURE_MS:
        ts = now
    elif ts < now - MAX_PAST_MS:
        raise HTTPException(400, "這個點的時間超過一天前，不收")
    if not (-90 <= fix.lat <= 90 and -180 <= fix.lon <= 180):
        raise HTTPException(400, "座標不合法")
    # 速度、海拔明顯不合理（GPS 亂跳、模擬資料瞬移）就當成沒回報：位置照收，只是不進極速／海拔統計與曲線
    if fix.speed is not None and not (0 <= fix.speed * 3.6 <= MAX_SPEED_KMH):
        fix.speed = None
    if fix.alt is not None and not (ALT_MIN_M <= fix.alt <= ALT_MAX_M):
        fix.alt = None

    # 先讀：目前所在行程、上一個點、目前狀態（一次 round trip）
    async with r.pipeline(transaction=False) as p:
        p.get(K.active_trip(uid))
        p.hmget(K.last(uid), "ts", "lat", "lon", "ats", "alat", "alon", "tts")
        tid_res, last = await p.execute()
    tid = tid_res
    live = False
    prev_status = None
    demo = False
    if tid:
        async with r.pipeline(transaction=False) as p:
            p.hget(K.trip(tid), "status")
            p.sismember(K.active(tid), uid)
            p.hget(K.state(tid, uid), "status")
            p.hget(K.trip(tid), "demo")
            status, is_active, prev_status, demo = await p.execute()
        live = status == "live" and bool(is_active)
    # Demo 行程（tools.simulate --loop）只收模擬器的點：成員真的出去騎時，手機／Traccar 的點不會混進 demo。
    # 「sim-self」＝模擬器代替真人帳號重播他自己的舊紀錄：只進 demo 行程，不寫個人足跡（不然每圈都污染真的足跡），
    # 不在 demo 行程時整個忽略。
    sim = fix.src in ("sim", "sim-self")
    if demo and not sim:
        live = False
    if fix.src == "sim-self" and not (demo and live):
        return {"ok": True, "trip": None, "footprint": False, "rough": False, "errors": [], "stale": False, "ignored": True}
    personal = fix.src != "sim-self"
    # 行程開始前：位置只更新「即時位置」（GEO＋狀態 Hash，10 分鐘 TTL）並廣播給隊友與戰情室，
    # 不寫軌跡、速度曲線、統計，也不交給 worker 判斷警示（stream:ingest 的 trip 欄位留空），開始那一刻才開始記錄
    pre = await planned_trips(uid) if not live and not sim else []

    prev = (int(last[0]), float(last[1]), float(last[2])) if last[0] else None
    # 里程從「錨點」算（geo.step）：位移不到 3 m 錨點不動。舊資料沒有錨點就用上一點
    anchor = (int(last[3]), float(last[4]), float(last[5])) if last[3] else prev
    # 精度太差的點（geo.MAX_ACC_M）：只更新目前位置與心跳，不進足跡、軌跡、里程
    rough = is_rough(fix.acc)
    fresh = prev is None or ts > prev[0]

    # 網頁＋Traccar 同時開：以 Traccar 為準（背景、鎖螢幕都能跑）。時間用手機的 GPS 時間（兩邊是同一個時鐘）。
    # Traccar 超過 20 秒沒送（例如 iPhone 停著時休眠）網頁就自動接手；被略過的網頁點仍然續心跳，不會被判失聯。
    if fix.src == "web" and last[6] and fresh and ts - int(last[6]) < DUP_MS:
        hb = heartbeat_s(fix.speed)
        async with r.pipeline(transaction=False) as p:
            if live:
                p.hset(K.state(tid, uid), mapping={"seen": now, "status": "ok", "hbs": hb})
                p.set(K.hb(tid, uid), now, ex=hb)
            for t in pre:
                p.hset(K.state(t, uid), mapping={"seen": now, "status": "ok", "pre": 1})
                p.expire(K.state(t, uid), PRE_TTL_S)
            p.zadd("online:report", {uid: now})
            await p.execute()
        return {"ok": True, "trip": tid if live else None, "footprint": False, "rough": rough, "errors": [], "stale": False, "dup": True}
    keep = fresh and not rough and personal
    cells = segment_cells(prev, (ts, fix.lat, fix.lon)) if keep else set()
    dist_m, _, new_anchor = step(anchor, (ts, fix.lat, fix.lon), fix.acc) if keep else (0.0, 0.0, anchor)
    day, bucket = day_key(ts), bucket_of(ts)

    fields = {"lat": fix.lat, "lon": fix.lon, "alt": fix.alt, "speed": fix.speed, "heading": fix.heading,
              "acc": fix.acc, "batt": fix.batt, "ts": ts, "src": fix.src}
    fields = {k: str(round(v, 7) if isinstance(v, float) else v) for k, v in fields.items() if v is not None}

    # 一個 Pipeline 寫完所有東西：一次網路來回
    async with r.pipeline(transaction=False) as p:
        if keep:
            # 全年足跡：Stream ID 直接用時間戳，之後可以用 XRANGE 依時間範圍查
            p.xadd(K.footprint(uid), {"lat": fields["lat"], "lon": fields["lon"], "ele": fields.get("alt", "0")}, id=f"{ts}-*")
            p.geoadd(K.fp_geo(uid), [fix.lon, fix.lat, str(ts)])  # 熱力圖放大時用 GEOSEARCH 取畫面內的點
            p.incr(K.fp_ver(uid))
            p.hset(K.last(uid), mapping={"ts": ts, "lat": fix.lat, "lon": fix.lon,
                                         "ats": new_anchor[0], "alat": new_anchor[1], "alon": new_anchor[2]})
            if cells:
                p.sadd(K.fog(uid, day, bucket), *cells)
                p.sadd(K.fog_all(uid), *cells)
            if dist_m:
                p.hincrbyfloat(K.daykm(uid), day, round(dist_m / 1000, 4))
            else:
                p.hincrbyfloat(K.daykm(uid), day, 0)
        if live and (fresh or not personal):
            if not rough:
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
            pos = {"kind": "pos", "uid": uid, **{k: _num(v) if k != "src" else v for k, v in fields.items()}}
            if rough:
                pos["rough"] = 1  # 前端只移動圖釘、不接軌跡線
            p.publish(K.live(tid), json.dumps(pos))
            p.execute_command("TS.INCRBY", "ts:sys:pubsub", 1, "TIMESTAMP", now // 1000 * 1000, "RETENTION", 7 * 86400_000,
                              "LABELS", "metric", "sys", "kind", "pubsub")
        if fresh:
            pos = {"kind": "pos", "uid": uid, "pre": 1, **{k: _num(v) if k != "src" else v for k, v in fields.items()}}
            if rough:
                pos["rough"] = 1
            for t in pre:
                p.geoadd(K.geo(t), [fix.lon, fix.lat, uid])
                p.hset(K.state(t, uid), mapping={**fields, "status": "ok", "seen": now, "pre": 1})
                p.expire(K.state(t, uid), PRE_TTL_S)
                p.publish(K.live(t), json.dumps(pos))
        if live:
            hb = heartbeat_s(fix.speed)
            p.hset(K.state(tid, uid), mapping={**(fields if fresh or not personal else {}), "status": "ok", "seen": now, "hbs": hb})
            p.set(K.hb(tid, uid), now, ex=hb)
        if fix.src == "traccar" and fresh:
            p.hset(K.last(uid), "tts", ts)  # 最後一個 Traccar 點的 GPS 時間（網頁點要不要略過看這個）
        p.zadd("online:report", {uid: now})  # 後台「線上人數」：最近 2 分鐘有回報位置的人（ZCOUNT）
        # 交給 worker：行程中的回報（警示、統計），以及所有新的足跡點（熱力圖、點亮鄉鎮）
        if fresh or not personal:
            # 粗略點也交給 worker（落隊、抵達判斷用得到），但 fp=0 不點亮鄉鎮／熱力圖，統計 Lua 也會略過
            p.xadd(K.ingest, {"trip": tid if live else "", "uid": uid, "fp": 0 if rough or not personal else 1, **fields},
                   maxlen=100_000, approximate=True)
        p.execute_command("TS.INCRBY", K.ts_writes, 1, "TIMESTAMP", now // 1000 * 1000, "RETENTION", 7 * 86400_000)
        results = await p.execute(raise_on_error=False)

    errors = [str(x) for x in results if isinstance(x, Exception)]
    if live and prev_status == "lost":
        await events.emit(tid, "back", uid, "恢復連線", ts=ts)
        await events.publish(tid, {"kind": "status", "uid": uid, "status": "ok"})
    return {"ok": True, "trip": tid if live else None, "footprint": keep, "rough": rough, "errors": errors[:3], "stale": not fresh,
            "pre": pre}


@router.post("/api/track")
async def track(fix: Fix, uid: str = Depends(current_uid)):
    return await ingest(uid, fix)


class Batch(BaseModel):
    points: list[Fix]


@router.post("/api/track/batch")
async def track_batch(body: Batch, uid: str = Depends(current_uid)):
    """網頁斷網時暫存的點一次補傳（gpsqueue.js）。依 GPS 時間排序後逐點走同一條 ingest，
    所以軌跡、里程、足跡都跟即時送的一樣；單點座標不合法就略過，不影響其他點。"""
    if len(body.points) > 500:
        raise HTTPException(413, "一次最多 500 點")
    ok = stale = bad = dup = 0
    trip = None
    for fix in sorted(body.points, key=lambda f: f.ts or 0):
        try:
            res = await ingest(uid, fix)
        except HTTPException:
            bad += 1
            continue
        ok += 1
        stale += res["stale"]
        dup += res.get("dup", False)
        trip = res["trip"] or trip
    return {"ok": True, "accepted": ok, "stale": stale, "rejected": bad, "dup": dup, "trip": trip}


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
    alarm = _alarm(q, body)
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
    res = await ingest(uid, fix)
    if alarm == "sos" and res["trip"]:
        # Traccar Client 的 SOS 按鈕：先寫入這一點的位置，再走跟網頁 SOS 相同的流程（事件、推播、紅色橫幅）
        ev = await interact.raise_sos(res["trip"], uid, via="Traccar")
        res["sos"] = ev["id"] if ev else "already"
    return res


def _alarm(q: dict, body) -> str:
    """OsmAnd 協定是 ?alarm=sos；新版 JSON 可能放在 body、location 或 location.extras。"""
    cands = [q.get("alarm")]
    if isinstance(body, dict):
        loc = body.get("location") if isinstance(body.get("location"), dict) else {}
        extras = loc.get("extras") if isinstance(loc.get("extras"), dict) else {}
        cands += [body.get("alarm"), loc.get("alarm"), extras.get("alarm"), loc.get("event")]
    for c in cands:
        if isinstance(c, str) and c.strip():
            return c.strip().lower()
    return ""
