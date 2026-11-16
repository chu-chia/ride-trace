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
import logging
import os
import socket

from redis.exceptions import ResponseError

from . import events
from .db import K, check_lag, r, update_stats

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
    """每位隊友的里程、極速、移動時間。Lua 原子更新，依 ts 去重，重送不會重算。"""
    changed: dict[tuple[str, str], None] = {}
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
        await r.publish(K.live(tid), json.dumps({"kind": "stats", "uid": uid, **stats_dict(s)}))
    return [i for i, _ in msgs]


def stats_dict(s) -> dict:
    km, mx, mv = (float(x) if x else 0.0 for x in s)
    return {"km": round(km, 2), "max_kmh": round(mx, 1), "moving_s": int(mv),
            "avg_kmh": round(km / (mv / 3600), 1) if mv > 60 else None}


LAG_DEFAULT_KM = 2.0
LAG_EVERY_MS = 2000
LAG_TEXT = {1: "落隊：離全隊中心 {km} km", 2: "跑太前面：超前全隊中心 {km} km", 3: "已跟上隊伍"}
LAG_TYPE = {1: "behind", 2: "ahead", 3: "regroup"}


async def check_trip_lag(tid: str):
    """判斷一個行程的落隊。2 秒節流：用 SET NX PX 當鎖，多個 worker 只會有一個去算。"""
    if not await r.set(K.lagchk(tid), CONSUMER, nx=True, px=LAG_EVERY_MS):
        return
    uids = sorted(await r.smembers(K.active(tid)), key=int)
    if len(uids) < 2:
        return
    thr_km = float(await r.hget(K.trip(tid), "lag_km") or LAG_DEFAULT_KM)
    keys = [K.geo(tid), K.lagflag(tid)]
    for u in uids:
        keys += [K.state(tid, u), K.stats(tid, u)]
    res = await check_lag(keys=keys, args=[int(thr_km * 1000), *uids])
    if not res:
        return
    gaps = {}
    for i in range(0, len(res), 3):
        uid, signed_m, tr = res[i], int(res[i + 1]), int(res[i + 2])
        gaps[uid] = round(signed_m / 1000, 2)
        if tr:
            km = f"{abs(signed_m) / 1000:.1f}"
            await events.emit(tid, LAG_TYPE[tr], uid, LAG_TEXT[tr].format(km=km),
                              ts=await events.last_fix_ts(tid, uid), gap_km=gaps[uid])
    await r.delete(K.gap(tid))
    await r.hset(K.gap(tid), mapping=gaps)
    flags = await r.hgetall(K.lagflag(tid))
    await events.publish(tid, {"kind": "gap", "gaps": gaps, "flags": flags, "lag_km": thr_km})


async def handle_alerts(msgs: list[tuple[str, dict]]) -> list[str]:
    """警示類：落隊（之後加抵達集合點、前方測速）。同一批裡同一個行程只判斷一次。"""
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
