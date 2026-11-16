"""背景 Worker：用 Streams Consumer Group 消費 stream:ingest。

每筆位置回報在 ingest 時會 XADD 到 stream:ingest。這裡每個 consumer group 各自拿到「全部」訊息，
同一個 group 裡的多個 consumer（多開幾個 worker 容器）則是「分攤」訊息：
    docker compose up -d --scale worker=2

可靠性：
- 處理完才 XACK；worker 當掉時訊息留在 PEL（Pending Entries List），
  其他 consumer 用 XAUTOCLAIM 把閒置超過 CLAIM_IDLE_MS 的訊息接手重做。
- 所以同一筆可能被處理兩次（at-least-once），各 handler 必須冪等。

執行：python -m app.worker
"""
import asyncio
import json
import math
import logging
import os
import socket
import time

from redis.exceptions import ResponseError

from . import events
from .db import K, arrive, check_lag, r, update_stats
from .longterm import record_point
from .geo import bearing_deg

log = logging.getLogger("qiji.worker")

CONSUMER = os.environ.get("WORKER_NAME") or f"{socket.gethostname()}-{os.getpid()}"
BATCH = 200
BLOCK_MS = 2000  # 要小於 redis-py 8 預設的 socket_timeout（5 秒），否則沒訊息時會 TimeoutError
CLAIM_IDLE_MS = 60_000


async def ensure_group(group: str):
    try:
        # 從 $（現在之後）開始，不回頭處理建 group 之前的歷史訊息
        await r.xgroup_create(K.ingest, group, id="$", mkstream=True)
        log.info("建立 consumer group %s", group)
    except ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


# ---------- handlers：收到一批訊息，回傳要 XACK 的 ID ----------

async def handle_stats(msgs: list[tuple[str, dict]]) -> list[str]:
    """每位隊友的里程、極速、移動時間（Lua 原子更新，依 ts 去重，重送不會重算）；
    所有新的足跡點都更新熱力圖與點亮鄉鎮（不管有沒有在行程中）。"""
    changed: dict[tuple[str, str], None] = {}
    for _, f in msgs:
        if f.get("fp") == "1" and f.get("uid") and "lat" in f:
            code = await record_point(f["uid"], float(f["lat"]), float(f["lon"]), int(f["ts"]))
            if code and f.get("trip"):
                name, county = await r.hmget(f"town:{code}", "name", "county")
                await events.emit(f["trip"], "town", f["uid"], f"點亮新鄉鎮：{county}{name}", ts=int(f["ts"]), town=code)
    for _, f in msgs:
        tid, uid = f.get("trip"), f.get("uid")
        if not tid or not uid or "lat" not in f:
            continue
        kmh = float(f["speed"]) * 3.6 if f.get("speed") else -1
        applied = await update_stats(keys=[K.stats(tid, uid)], args=[f["ts"], f["lat"], f["lon"], kmh])
        if applied:
            changed[(tid, uid)] = None
    # 同一批裡同一個人只推一次，避免 Pub/Sub 訊息量翻倍
    for tid, uid in changed:
        s = await r.hmget(K.stats(tid, uid), "km", "max_kmh", "moving_s")
        await events.publish(tid, {"kind": "stats", "uid": uid, **stats_dict(s)})
    return [i for i, _ in msgs]


def stats_dict(s) -> dict:
    km, mx, mv = (float(x) if x else 0.0 for x in s)
    return {"km": round(km, 2), "max_kmh": round(mx, 1), "moving_s": int(mv),
            "avg_kmh": round(km / (mv / 3600), 1) if mv > 60 else None}


LAG_DEFAULT_KM = 2.0
LAG_EVERY_MS = 2000
LAG_TEXT = {1: "落隊：離全隊中心 {km} km", 2: "跑太前面：超前全隊中心 {km} km", 3: "已跟上隊伍"}
LAG_TEXT_ROUTE = {1: "落隊：沿路線落後全隊中心 {km} km", 2: "跑太前面：沿路線超前全隊中心 {km} km", 3: "已跟上隊伍"}
LAG_TYPE = {1: "behind", 2: "ahead", 3: "regroup"}


async def check_trip_lag(tid: str):
    """判斷一個行程的落隊。2 秒節流：用 SET NX PX 當鎖，多個 worker 只會有一個去算。"""
    if not await r.set(K.lagchk(tid), CONSUMER, nx=True, px=LAG_EVERY_MS):
        return
    uids = sorted(await r.smembers(K.active(tid)), key=int)
    if len(uids) < 2:
        return
    thr_km = float(await r.hget(K.trip(tid), "lag_km") or LAG_DEFAULT_KM)
    use_route = bool(await r.hget(K.trip(tid), "route"))
    keys = [K.geo(tid), K.lagflag(tid), K.progress(tid)]
    for u in uids:
        keys += [K.state(tid, u), K.stats(tid, u)]
    res = await check_lag(keys=keys, args=[int(thr_km * 1000), 1 if use_route else 0, *uids])
    if not res:
        return
    gaps = {}
    for i in range(0, len(res), 3):
        uid, signed_m, tr = res[i], int(res[i + 1]), int(res[i + 2])
        gaps[uid] = round(signed_m / 1000, 2)
        if tr:
            km = f"{abs(signed_m) / 1000:.1f}"
            await events.emit(tid, LAG_TYPE[tr], uid, (LAG_TEXT_ROUTE if use_route else LAG_TEXT)[tr].format(km=km),
                              ts=await events.last_fix_ts(tid, uid), gap_km=gaps[uid])
    await r.delete(K.gap(tid))
    await r.hset(K.gap(tid), mapping=gaps)
    flags = await r.hgetall(K.lagflag(tid))
    await events.publish(tid, {"kind": "gap", "gaps": gaps, "flags": flags, "lag_km": thr_km, "by_route": use_route})


WP_SEARCH_M = 2000  # 集合點半徑上限，GEOSEARCH 先用這個範圍撈，再逐一比對各自的半徑


async def check_arrival(tid: str, uid: str, lat: float, lon: float, ts: int):
    """GEOSEARCH 找我附近的集合點，進入半徑就算抵達（每人每點只通知一次）。"""
    near = await r.geosearch(K.waypoints(tid), longitude=lon, latitude=lat, radius=WP_SEARCH_M, unit="m",
                             withdist=True, sort="ASC")
    changed = False
    for wid, dist in near:
        w = await r.hmget(K.wp(tid, wid), "name", "kind", "radius_m")
        if w[0] is None or float(dist) > float(w[2] or 150):
            continue
        new, all_in = await arrive(keys=[K.arrived(tid, wid), K.active(tid), K.allin(tid, wid)], args=[uid])
        place = "休息點" if w[1] == "rest" else "集合點"
        if new:
            changed = True
            await events.emit(tid, "arrive", uid, f"抵達{place}「{w[0]}」", ts=ts, wid=wid)
        if all_in:
            changed = True
            await events.emit(tid, "allin", None, f"全員到齊：{place}「{w[0]}」", ts=ts, wid=wid)
    if changed:
        from .waypoints import broadcast  # 延後 import：waypoints → trips → worker 會循環
        await broadcast(tid)


CAM_AHEAD_M = 1000      # 規格 4.4：前方 1 km 內
CAM_SECTOR_DEG = 35     # 行進方向左右 35° 的扇形才算「前方」
CAM_LATERAL_M = 100     # 測速點離「行進方向延長線」的橫向距離上限：扇形在 1 km 外有 570 m 寬，會掃到旁邊的路
CAM_DIR_DEG = 60        # 測速點只拍單一方向時，我的行進方向要差不多才提醒
CAM_MIN_MS = 3          # 停車或牽車（< 約 11 km/h）不提醒
CAM_PERSONAL_TTL = 900  # 同一個人同一支測速 15 分鐘內只提醒一次
CAM_EVENT_TTL = 1800    # 寫進行程事件：同一支測速 30 分鐘內只記一次（全隊經過同一支不洗版）


def angdiff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


async def check_speedcam(tid: str, uid: str, f: dict):
    """GEOSEARCH poi:speedcam 找 1 km 內的測速點，留下「在我前方的扇形裡、而且拍我這個方向」的最近一支。
    去重用 SET NX EX：key 還在就代表提醒過，TTL 到了自動解除，不用另外清。"""
    try:
        lat, lon, hd, sp = float(f["lat"]), float(f["lon"]), float(f["heading"]), float(f["speed"])
    except (KeyError, ValueError):
        return
    if sp < CAM_MIN_MS:
        return
    near = await r.geosearch("poi:speedcam", longitude=lon, latitude=lat, radius=CAM_AHEAD_M, unit="m",
                             withdist=True, withcoord=True, sort="ASC", count=8)
    for cid, dist, (clon, clat) in near:
        a = angdiff(hd, bearing_deg(lat, lon, clat, clon))
        if float(dist) > 40 and (a > CAM_SECTOR_DEG or float(dist) * math.sin(math.radians(a)) > CAM_LATERAL_M):
            continue
        cam = await r.hmget(f"speedcam:{cid}", "addr", "limit", "bearing", "direct")
        if cam[2] not in (None, "") and angdiff(hd, float(cam[2])) > CAM_DIR_DEG:
            continue  # 單向測速、拍的是對向車道
        if not await r.set(f"camhit:{tid}:{uid}:{cid}", 1, nx=True, ex=CAM_PERSONAL_TTL):
            return  # 最近的那支已經提醒過
        kmh, limit = round(sp * 3.6), int(cam[1] or 0)
        info = {"cam": cid, "addr": cam[0], "limit": limit, "dist_m": round(float(dist)), "kmh": kmh,
                "lon": clon, "lat": clat, "direct": cam[3]}
        await events.publish(tid, {"kind": "speedcam", "uid": uid, **info})
        if await r.set(f"camevt:{tid}:{cid}", 1, nx=True, ex=CAM_EVENT_TTL):
            await events.emit(tid, "speedcam", uid, f"前方測速：{cam[0]}（速限 {limit}）", ts=int(f["ts"]), cam=cid)
        return


HAZARD_AHEAD_M = 300
HAZARD_LATERAL_M = 60
HAZARD_TTL = 600
HAZARD_NAME = {"pothole": "坑洞", "rock": "落石"}


async def check_hazard(tid: str, uid: str, f: dict):
    """隊友標註的坑洞／落石：GEOSEARCH 前方 300 m（同樣用扇形＋橫向距離），只提醒自己，標註的人不提醒。"""
    try:
        lat, lon, hd, sp = float(f["lat"]), float(f["lon"]), float(f["heading"]), float(f["speed"])
    except (KeyError, ValueError):
        return
    if sp < CAM_MIN_MS:
        return
    near = await r.geosearch(K.marks(tid), longitude=lon, latitude=lat, radius=HAZARD_AHEAD_M, unit="m",
                             withdist=True, withcoord=True, sort="ASC", count=5)
    for mid, dist, (mlon, mlat) in near:
        a = angdiff(hd, bearing_deg(lat, lon, mlat, mlon))
        if float(dist) > 30 and (a > CAM_SECTOR_DEG or float(dist) * math.sin(math.radians(a)) > HAZARD_LATERAL_M):
            continue
        kind, by, note = await r.hmget(K.mark(tid, mid), "kind", "by", "note")
        if kind not in HAZARD_NAME or by == uid:
            continue
        if await r.set(f"hazhit:{tid}:{uid}:{mid}", 1, nx=True, ex=HAZARD_TTL):
            await events.publish(tid, {"kind": "hazard", "uid": uid, "mid": mid, "label": HAZARD_NAME[kind],
                                       "note": note or "", "by": by, "dist_m": round(float(dist))})
        return


# ---------- 沿路線進度 ----------
ROUTES: dict[str, tuple] = {}     # tid → (rid, coords, cum_km, 載入時間)
LAST_IDX: dict[tuple, int] = {}   # (tid, uid) → 上次投影到的線段（下次先在附近找）
LAST_PUB: dict[tuple, float] = {}
OFF_ROUTE_M = 150                 # 離路線超過 150 m 算偏離
BACK_ROUTE_M = 60                 # 回到 60 m 內算回到路線（遲滯）
PROGRESS_PUB_S = 1.5


async def load_route(tid: str):
    rid = await r.hget(K.trip(tid), "route")
    if not rid:
        ROUTES.pop(tid, None)
        return None
    cached = ROUTES.get(tid)
    if cached and cached[0] == rid and time.time() - cached[3] < 30:
        return cached
    res = await r.json().get(K.route(rid), "$.coords", "$.cum_km")  # 只取需要的兩個欄位
    if not res or not res["$.coords"]:
        return None
    ROUTES[tid] = (rid, res["$.coords"][0], res["$.cum_km"][0], time.time())
    return ROUTES[tid]


def project(coords, cum, lat, lon, hint=None):
    """把點投影到路線（折線）上，回傳 (沿路線 km, 離路線 m, 線段 index)。先在上次位置附近找，找不到才全段掃。"""
    kx, ky = 111320 * math.cos(math.radians(lat)), 110540

    def scan(lo, hi):
        best = (float("inf"), 0, 0.0)
        for i in range(max(0, lo), min(len(coords) - 1, hi)):
            ax, ay = (coords[i][0] - lon) * kx, (coords[i][1] - lat) * ky
            bx, by = (coords[i + 1][0] - lon) * kx, (coords[i + 1][1] - lat) * ky
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
            px, py = ax + t * dx, ay + t * dy
            d = px * px + py * py
            if d < best[0]:
                best = (d, i, t)
        return best

    best = scan(hint - 150, hint + 400) if hint is not None else (float("inf"), 0, 0.0)
    if best[0] > 300 ** 2:
        best = scan(0, len(coords))
    d2, i, t = best
    km = cum[i] + (cum[i + 1] - cum[i]) * t
    return km, math.sqrt(d2), i


async def check_progress(tid: str, uid: str, f: dict):
    rt = await load_route(tid)
    if not rt:
        return
    _, coords, cum, _ = rt
    key = (tid, uid)
    km, off, i = project(coords, cum, float(f["lat"]), float(f["lon"]), LAST_IDX.get(key))
    LAST_IDX[key] = i
    async with r.pipeline(transaction=False) as p:
        p.hset(K.progress(tid), uid, round(km, 3))
        p.hset(K.state(tid, uid), mapping={"route_km": round(km, 3), "off_m": round(off)})
        await p.execute()
    # 偏離／回到路線：HSETNX／HDEL 的回傳值保證多個 worker 也只通知一次
    if off > OFF_ROUTE_M:
        if await r.hsetnx(K.offroute(tid), uid, round(km, 2)):
            await events.emit(tid, "offroute", uid, f"偏離路線 {round(off)} m", ts=int(f["ts"]))
    elif off < BACK_ROUTE_M and await r.hdel(K.offroute(tid), uid):
        await events.emit(tid, "onroute", uid, "回到路線", ts=int(f["ts"]))
    now = time.time()
    if now - LAST_PUB.get(key, 0) >= PROGRESS_PUB_S:
        LAST_PUB[key] = now
        await events.publish(tid, {"kind": "progress", "uid": uid, "km": round(km, 3), "off_m": round(off)})


STUCK_MIN = 10          # 規格 4.4：不在集合點或休息點，卻靜止超過 N 分鐘
STUCK_SPEED_MS = 1.0    # 低於這個速度算靜止
STUCK_NEAR_WP_M = 300   # 在集合點／休息點 300 m 內的停車是正常休息，不警示


async def check_stuck(tid: str, uid: str, f: dict):
    """異常久停：靜止開始的時間記在 state 的 stop_since（裝置時間）；超過 10 分鐘、附近又沒有集合點／休息點，
    就用 HSETNX 標記並通知一次；重新移動（> 3 m/s）時 HDEL 解除並通知「恢復移動」。"""
    try:
        sp, ts = float(f.get("speed") or 0), int(f["ts"])
    except (KeyError, ValueError):
        return
    key = K.state(tid, uid)
    if sp >= 3:
        await r.hdel(key, "stop_since")
        if await r.hdel(K.stuck(tid), uid):
            await events.emit(tid, "moving", uid, "恢復移動", ts=ts)
        return
    if sp >= STUCK_SPEED_MS:
        return
    since = await r.hget(key, "stop_since")
    if not since:
        await r.hset(key, "stop_since", ts)
        return
    mins = (ts - int(since)) / 60000
    if mins < STUCK_MIN:
        return
    near = await r.geosearch(K.waypoints(tid), longitude=float(f["lon"]), latitude=float(f["lat"]),
                             radius=STUCK_NEAR_WP_M, unit="m", count=1)
    if near:
        return  # 在集合點／休息點：正常休息
    if await r.hsetnx(K.stuck(tid), uid, ts):
        await events.emit(tid, "stuck", uid, f"異常久停：已經停了 {int(mins)} 分鐘，附近沒有集合點或休息點", ts=ts,
                          lat=f["lat"], lon=f["lon"])


async def handle_alerts(msgs: list[tuple[str, dict]]) -> list[str]:
    """警示類：抵達集合點、前方測速（每筆都查）、落隊（同一批裡同一個行程只判斷一次）。"""
    for _, f in msgs:
        if f.get("trip") and f.get("uid") and "lat" in f:
            await check_progress(f["trip"], f["uid"], f)  # 先算沿路線里程，落隊判斷會用到
            await check_arrival(f["trip"], f["uid"], float(f["lat"]), float(f["lon"]), int(f["ts"]))
            await check_speedcam(f["trip"], f["uid"], f)
            await check_hazard(f["trip"], f["uid"], f)
            await check_stuck(f["trip"], f["uid"], f)
    trips = dict.fromkeys(f["trip"] for _, f in msgs if f.get("trip"))
    for tid in trips:
        await check_trip_lag(tid)
    return [i for i, _ in msgs]


HANDLERS = {"stats": handle_stats, "alerts": handle_alerts}


async def run_group(group: str, handler):
    await ensure_group(group)
    claim_cursor = "0-0"
    while True:
        try:
            # 1. 先接手別人（或自己上次）卡住的訊息
            res = await r.xautoclaim(K.ingest, group, CONSUMER, min_idle_time=CLAIM_IDLE_MS,
                                     start_id=claim_cursor, count=BATCH)
            claim_cursor, claimed = res[0], res[1]
            claimed = [(i, f) for i, f in claimed if f]  # 已被 MAXLEN 修剪掉的訊息 f 會是 None
            if claimed:
                log.info("[%s] 接手 %d 筆閒置訊息", group, len(claimed))
                await ack(group, await handler(claimed))
            # 2. 再讀新訊息（> 表示從沒派給任何 consumer 的）
            resp = await r.xreadgroup(group, CONSUMER, {K.ingest: ">"}, count=BATCH, block=BLOCK_MS)
            for _, msgs in resp or []:
                await ack(group, await handler(msgs))
        except asyncio.CancelledError:
            raise
        except ResponseError as e:
            if "NOGROUP" in str(e):  # stream 被刪掉重建
                await ensure_group(group)
                continue
            log.exception("[%s] 處理失敗，3 秒後重試", group)
            await asyncio.sleep(3)
        except Exception:  # noqa: BLE001
            log.exception("[%s] 處理失敗，3 秒後重試", group)
            await asyncio.sleep(3)


async def ack(group: str, ids: list[str]):
    if ids:
        await r.xack(K.ingest, group, *ids)


async def main():
    await r.ping()
    log.info("worker 啟動：consumer=%s groups=%s", CONSUMER, list(HANDLERS))
    await asyncio.gather(*(run_group(g, h) for g, h in HANDLERS.items()))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    asyncio.run(main())
