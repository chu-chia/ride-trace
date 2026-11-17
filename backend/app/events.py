"""行程事件：寫進 Streams 永久保存，同時用 Pub/Sub 即時推給畫面。"""
import json
import time

from .db import K, r


async def emit(tid: str, etype: str, uid: str | None, text: str, ts: int | None = None, **extra) -> dict:
    """ts：事件發生的時間。和某個人有關的事件用他裝置回報的時間（斷訊補傳、模擬器重播時才對得上軌跡）。"""
    ts = int(ts or time.time() * 1000)
    fields = {"type": etype, "uid": uid or "", "text": text, "ts": ts}
    fields.update({k: v for k, v in extra.items() if v is not None})
    eid = await r.xadd(K.events(tid), {k: str(v) for k, v in fields.items()})
    msg = {"kind": "event", "id": eid, **fields}
    await publish(tid, msg)
    await notify(tid, eid, etype, uid, text)
    return msg


# 要推播的事件類型（推給誰、多久推一次在 push.RULES）
NOTIFY_TYPES = {"sos", "lost", "behind", "stuck", "allin", "speedcam", "offroute", "start", "kick", "msg", "chat", "roadevent", "weather"}


async def notify(tid: str, eid: str, etype: str, uid: str | None, text: str):
    """交給 worker 的 consumer group「push」去推播（API 不等推播服務回應）。"""
    if etype in NOTIFY_TYPES:
        await r.xadd("stream:notify", {"trip": tid, "eid": eid, "type": etype, "uid": uid or "", "text": text},
                     maxlen=5000, approximate=True)


PUBSUB_TS = "ts:sys:pubsub"


async def count_pubsub(n: int = 1):
    """後台用：每秒 Pub/Sub 訊息數（TimeSeries，同一秒的累加）。"""
    await r.execute_command("TS.INCRBY", PUBSUB_TS, n, "TIMESTAMP", int(time.time()) * 1000, "RETENTION", 7 * 86400_000,
                            "LABELS", "metric", "sys", "kind", "pubsub")


async def publish(tid: str, msg: dict):
    await r.publish(K.live(tid), json.dumps(msg, ensure_ascii=False))
    await count_pubsub()


def event_from_stream(eid: str, f: dict) -> dict:
    out = {"kind": "event", "id": eid, **f}
    out["ts"] = int(f.get("ts", eid.split("-")[0]))
    return out


async def last_fix_ts(tid: str, uid: str) -> int | None:
    v = await r.hget(K.state(tid, uid), "ts")
    try:
        return int(float(v)) if v else None
    except ValueError:
        return None
