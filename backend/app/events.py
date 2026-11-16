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
    await r.publish(K.live(tid), json.dumps(msg, ensure_ascii=False))
    return msg


async def publish(tid: str, msg: dict):
    await r.publish(K.live(tid), json.dumps(msg, ensure_ascii=False))


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
