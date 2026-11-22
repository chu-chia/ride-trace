"""回放：用 XRANGE 取出每個人的完整軌跡與事件，用 TS.MRANGE 一次取所有人的速度、海拔曲線。"""
import json
import math

from fastapi import APIRouter, Depends, Query

from .auth import current_uid
from .db import K, r
from .events import event_from_stream
from .geo import ALT_MAX_M, ALT_MIN_M, MAX_SPEED_KMH, MOVING_KMH, haversine_m, is_rough, step
from .trips import former_people, require_member, trip_detail

router = APIRouter(prefix="/api/trips")


def _f(v, default=None):
    try:
        x = float(v)
        return default if math.isnan(x) else x
    except (TypeError, ValueError):
        return default


def summarize(pts: list[list]) -> dict:
    """整趟摘要。pts: [ts, lat, lon, alt, km/h, heading, acc]（acc 可省略），依 GPS 時間排好。
    這是里程、移動時間、極速的唯一定義：回放直接用；每個人結束紀錄時也用它重算即時統計（finalize_stats），
    所以行程頁、首頁、回放看到的數字一樣。行程進行中的即時統計（worker 的 Lua）是同一套規則的近似值。"""
    if len(pts) < 2:
        return {"km": 0, "duration_ms": 0, "moving_ms": 0, "avg_kmh": 0, "max_kmh": 0, "climb_m": 0, "max_alt": None, "stops": 0}
    dist = moving = climb = 0.0
    speeds = []
    reported = []   # 手機回報的速度（GPS 都卜勒測速，比用位置換算的穩）
    stops = 0
    still_since = None
    last_alt = None
    anchor = None
    for a, b in zip(pts, pts[1:]):
        dt = (b[0] - a[0]) / 1000
        if dt <= 0:
            continue
        if anchor is None:
            anchor = (a[0], a[1], a[2])
        # 里程與移動時間：跟即時統計同一套規則（geo.step：最小位移、跳點、斷訊）
        d_count, mv, anchor = step(anchor, (b[0], b[1], b[2]), b[6] if len(b) > 6 else None)
        dist += d_count
        moving += mv
        d = haversine_m(a[1], a[2], b[1], b[2])
        v = d / dt * 3.6
        if v > MAX_SPEED_KMH:  # 跳點不算
            continue
        if v > MOVING_KMH:
            if still_since is not None and a[0] - still_since >= 120_000:
                stops += 1    # 停超過 2 分鐘算一次休息
            still_since = None
        elif still_since is None:
            still_since = a[0]
        if dt >= 2:
            speeds.append(v)
        if b[4] is not None and b[4] < MAX_SPEED_KMH:
            speeds.append(b[4])
            if not (len(b) > 6 and is_rough(b[6])):
                reported.append(b[4])
        if b[3] is not None and ALT_MIN_M <= b[3] <= ALT_MAX_M:  # 海拔明顯不合理（GPS 亂跳）的點不算爬升
            if last_alt is None:
                last_alt = b[3]
            elif abs(b[3] - last_alt) >= 3:  # 3 公尺門檻，避免 GPS 雜訊灌水
                if b[3] > last_alt:
                    climb += b[3] - last_alt
                last_alt = b[3]
    alts = [p[3] for p in pts if p[3] is not None and ALT_MIN_M <= p[3] <= ALT_MAX_M]
    speeds.sort()
    # 極速：手機回報速度的最大值（跟即時統計一樣）；沒有回報速度時才用換算速度的 99 百分位（位置換算有跳點）
    max_kmh = max(reported) if reported else (speeds[int(len(speeds) * 0.99)] if speeds else 0)
    avg = dist / 1000 / (moving / 3600) if moving else 0
    # 平均不可能比極速快：里程是位置換算、極速是手機回報的速度，資料瞬移（模擬、GPS 亂跳）時兩者會對不上
    if max_kmh > 0:
        avg = min(avg, max_kmh)
    return {
        "km": round(dist / 1000, 2),
        "duration_ms": pts[-1][0] - pts[0][0],
        "moving_ms": int(moving * 1000),
        "avg_kmh": round(avg, 1),
        "max_kmh": round(max_kmh, 1),
        "climb_m": round(climb),
        "max_alt": round(max(alts)) if alts else None,
        "stops": stops,
    }


REPLAY_MIN_GAP_MS = 2000      # 送給前端的軌跡最密 2 秒一點（模擬器一秒好幾點，10 MB 太大）；摘要仍用完整資料算
REPLAY_CACHE_S = 7 * 86400


def _thin(pts: list[list]) -> list[list]:
    out = []
    for p in pts:
        if not out or p[0] - out[-1][0] >= REPLAY_MIN_GAP_MS:
            out.append(p)
    if pts and out[-1] is not pts[-1]:
        out.append(pts[-1])
    return out


async def _points(tid: str, uid: str) -> list[list]:
    rows = await r.xrange(K.track(tid, uid))
    pts = []
    for _, f in rows:
        lat, lon = _f(f.get("lat")), _f(f.get("lon"))
        if lat is None or lon is None or is_rough(f.get("acc")):  # 精度太差的舊點不畫、不算
            continue
        spd = _f(f.get("speed"))
        pts.append([int(f["ts"]), round(lat, 6), round(lon, 6),
                    None if _f(f.get("alt")) is None else round(_f(f.get("alt")), 1),
                    None if spd is None else round(spd * 3.6, 1),
                    None if _f(f.get("heading")) is None else round(_f(f.get("heading"))), _f(f.get("acc"))])
    pts.sort(key=lambda p: p[0])  # Stream 是到達順序，斷訊補傳的點要依 GPS 時間重排
    return pts


async def _tracks(tid: str, uids: list[str]) -> dict:
    """每個人的軌跡（抽稀後）與整趟摘要。"""
    out = {}
    for u in uids:
        pts = await _points(tid, u)
        out[u] = {"summary": summarize(pts), "track": [p[:6] for p in _thin(pts)]}  # acc 只拿來算摘要，不送前端
    return out


async def finalize_stats(tid: str, uid: str) -> dict | None:
    """結束紀錄時用整條軌跡重算即時統計（km、moving_s、max_kmh），跟回放摘要一致。
    lts 設成最後一點：還在 Stream 裡排隊的舊點，Lua 會當成重複的略過，不會再加上去。"""
    pts = await _points(tid, uid)
    if not pts:
        return None
    s = summarize(pts)
    await r.hset(K.stats(tid, uid), mapping={"km": s["km"], "moving_s": round(s["moving_ms"] / 1000, 1),
                                             "max_kmh": s["max_kmh"], "lts": pts[-1][0], "finalized": 1})
    return s


async def cached_tracks(tid: str, uids: list[str], ended: bool) -> dict:
    """整包（抽稀後的軌跡＋摘要）快取在 Redis（cache-aside）：已結束的行程軌跡不會再變，留 7 天；
    進行中的只留 30 秒（回放看到的是到剛剛為止）。"""
    ck = f"cache:replay:{tid}"
    cached = await r.get(ck)
    if cached:
        tracks = json.loads(cached)
        if set(tracks) == set(uids):
            return tracks
    tracks = await _tracks(tid, uids)
    await r.set(ck, json.dumps(tracks, separators=(",", ":")), ex=REPLAY_CACHE_S if ended else 30)
    return tracks


async def warm(tid: str):
    """行程剛結束時在背景先算好，第一個按「看回放」的人就不用等。"""
    try:
        members = list(await r.smembers(K.members(tid)))
        for u in members:  # 強制結束、全員結束時，還沒重算的人在這裡補上
            if not await r.hget(K.stats(tid, u), "finalized"):
                await finalize_stats(tid, u)
        await r.delete(f"cache:replay:{tid}")
        await cached_tracks(tid, members, True)
    except Exception:  # noqa: BLE001  背景預熱失敗不影響任何事
        pass


@router.get("/{tid}/replay")
async def replay(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    detail = await trip_detail(tid, uid)
    uids = [m["uid"] for m in detail["members"]]
    tracks = await cached_tracks(tid, uids, detail.get("status") == "ended")
    t0 = t1 = None
    for m in detail["members"]:
        tr = tracks.get(m["uid"], {"track": [], "summary": summarize([])})
        m["track"], m["summary"] = tr["track"], tr["summary"]
        m.pop("state", None)
        if m["track"]:
            t0 = m["track"][0][0] if t0 is None else min(t0, m["track"][0][0])
            t1 = m["track"][-1][0] if t1 is None else max(t1, m["track"][-1][0])
    raw = await r.xrange(K.events(tid))
    evs = [event_from_stream(i, f) for i, f in raw]
    # 聊天另存一條 Stream（trip:{id}:chat），回放時併進事件時間軸
    for i, f in await r.xrange(f"trip:{tid}:chat"):
        evs.append({"kind": "event", "id": i, "type": "chat", "uid": f.get("uid", ""), "text": f.get("text", ""),
                    "ts": int(f.get("ts") or i.split("-")[0])})
    evs.sort(key=lambda e: e["ts"])
    detail["events"] = evs
    detail["people"] = await former_people(detail["members"], evs)
    if detail.get("status") == "ended" and not detail.get("ended_reason"):
        # 舊行程沒存 ended_reason：用最後一筆「結束」事件的說明
        ends = [e for e in evs if e.get("type") == "end"]
        detail["ended_reason"] = ends[-1]["text"] if ends else ""
    detail["t0"], detail["t1"] = t0, t1
    detail["routes"] = await route_history(tid)
    return detail


ROUTE_PTS = 1500  # 回放只是畫線，抽稀到 1500 點內


async def route_history(tid: str) -> list[dict]:
    """這趟用過的每一條路線（Stream trip:{tid}:routes，ID＝換上的時間）：from～to 這段時間走的是哪條。
    舊行程沒有 Stream，就只回目前那一條（from=0）。"""
    items = [(int(i.split("-")[0]), f) for i, f in await r.xrange(K.routes(tid))]
    if not items:
        rid = await r.hget(K.trip(tid), "route")
        items = [(0, {"rid": rid})] if rid else []
    out = []
    for n, (ts, f) in enumerate(items):
        res = await r.json().get(K.route(f["rid"]), "$.coords", "$.summary.km", "$.by")
        if not res or not res["$.coords"]:
            continue
        c = res["$.coords"][0]
        step = max(1, len(c) // ROUTE_PTS)
        coords = c[::step]
        if coords[-1] != c[-1]:
            coords.append(c[-1])
        out.append({"id": f["rid"], "from": ts, "to": items[n + 1][0] if n + 1 < len(items) else None,
                    "by": (res["$.by"] or [""])[0], "km": (res["$.summary.km"] or [None])[0], "coords": coords})
    return out


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
