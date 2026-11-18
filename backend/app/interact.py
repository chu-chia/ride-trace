"""車隊互動：快速訊息、地圖標註、SOS。全部寫進 trip:{id}:events（Streams）並用 Pub/Sub 廣播，回放會自動帶到。

Redis：
- trip:{id}:marks            GEO：標註位置 → Worker 用 GEOSEARCH 提醒「前方 300 m 有坑洞／落石」
- trip:{id}:mark:{mid}       Hash：種類、說明、建立者、時間
- trip:{id}:sos              Hash：uid → 發出 SOS 的事件 ID（還沒解除的 SOS）
- ratelimit:msg:{uid}        SET NX PX 2000：同一個人 2 秒內只能發一則（防連點洗版）
"""
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import events
from .auth import current_uid
from .db import K, r
from .trips import require_member

router = APIRouter(prefix="/api/trips")
PRESETS = ["加油", "休息一下", "等我", "有狀況", "我先走"]
MARK_KINDS = {"pothole": "坑洞", "rock": "落石", "food": "美食", "view": "風景", "other": "標註"}
HAZARDS = {"pothole", "rock"}
MSG_GAP_MS = 2000


async def require_live_member(tid: str, uid: str):
    await require_member(tid, uid)
    if await r.hget(K.trip(tid), "status") == "ended":
        raise HTTPException(409, "行程已經結束")


async def my_position(tid: str, uid: str):
    lat, lon, ts = await r.hmget(K.state(tid, uid), "lat", "lon", "ts")
    return (float(lat), float(lon), int(float(ts))) if lat and lon else None


async def event_ts(tid: str, uid: str) -> int | None:
    """和人有關的事件用他裝置回報的時間（交接紀錄設計決定 4）：模擬器重播、斷訊補傳時回放才對得上軌跡。
    但只在他最近 60 秒內有回報時才用；只看不回報的人用伺服器時間（回傳 None）。"""
    ts, seen = await r.hmget(K.state(tid, uid), "ts", "seen")
    try:
        if ts and seen and time.time() * 1000 - float(seen) < 60_000:
            return int(float(ts))
    except ValueError:
        pass
    return None


# ---------- 快速訊息 ----------

class MsgIn(BaseModel):
    text: str = Field(min_length=1, max_length=40)


@router.get("/{tid}/presets")
async def presets(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return PRESETS


@router.post("/{tid}/messages")
async def send_message(tid: str, body: MsgIn, uid: str = Depends(current_uid)):
    await require_live_member(tid, uid)
    if not await r.set(f"ratelimit:msg:{uid}", 1, nx=True, px=MSG_GAP_MS):
        raise HTTPException(429, "太快了，等一下再發")
    pos = await my_position(tid, uid)
    extra = {"lat": pos[0], "lon": pos[1]} if pos else {}
    return await events.emit(tid, "msg", uid, body.text.strip(), ts=await event_ts(tid, uid), **extra)


# ---------- 地圖標註 ----------

class MarkIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    kind: str = "other"
    note: str = Field("", max_length=40)


async def list_marks(tid: str) -> list[dict]:
    ids = sorted(await r.zrange(K.marks(tid), 0, -1), key=int)
    out = []
    for mid in ids:
        h = await r.hgetall(K.mark(tid, mid))
        if h:
            out.append({"id": mid, "kind": h["kind"], "label": MARK_KINDS.get(h["kind"], "標註"), "note": h.get("note", ""),
                        "lat": float(h["lat"]), "lon": float(h["lon"]), "by": h["by"], "ts": int(h["ts"])})
    return out


@router.get("/{tid}/marks")
async def get_marks(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return await list_marks(tid)


@router.post("/{tid}/marks")
async def add_mark(tid: str, body: MarkIn, uid: str = Depends(current_uid)):
    await require_live_member(tid, uid)
    if body.kind not in MARK_KINDS:
        raise HTTPException(400, "標註種類不對")
    mid = str(await r.incr(f"seq:mark:{tid}"))
    note = body.note.strip()
    async with r.pipeline(transaction=True) as p:
        p.hset(K.mark(tid, mid), mapping={"kind": body.kind, "note": note, "lat": body.lat, "lon": body.lon,
                                          "by": uid, "ts": int(time.time() * 1000)})
        p.geoadd(K.marks(tid), [body.lon, body.lat, mid])
        await p.execute()
    label = MARK_KINDS[body.kind]
    await events.emit(tid, "mark", uid, f"標註{label}" + (f"：{note}" if note else ""), ts=await event_ts(tid, uid),
                      lat=body.lat, lon=body.lon, mid=mid)
    await events.publish(tid, {"kind": "marks", "items": await list_marks(tid)})
    return {"id": mid}


@router.delete("/{tid}/marks/{mid}")
async def delete_mark(tid: str, mid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    by = await r.hget(K.mark(tid, mid), "by")
    if by is None:
        raise HTTPException(404, "找不到這個標註")
    owner = await r.hget(K.trip(tid), "owner")
    if uid not in (by, owner):
        raise HTTPException(403, "只有標註的人或建立者可以刪除")
    async with r.pipeline(transaction=True) as p:
        p.zrem(K.marks(tid), mid)
        p.delete(K.mark(tid, mid))
        await p.execute()
    await events.publish(tid, {"kind": "marks", "items": await list_marks(tid)})
    return {"ok": True}


# ---------- SOS ----------

async def active_sos(tid: str) -> list[dict]:
    out = []
    for u, eid in (await r.hgetall(K.sos(tid))).items():
        rows = await r.xrange(K.events(tid), eid, eid)
        if rows:
            out.append(events.event_from_stream(*rows[0]))
    return out


@router.get("/{tid}/sos")
async def get_sos(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return await active_sos(tid)


async def raise_sos(tid: str, uid: str, via: str = "") -> dict | None:
    """網頁 SOS 與 Traccar 的 alarm=sos 共用：寫事件（推播、橫幅都由事件帶出）＋記在 trip:{id}:sos。
    已經有未解除的 SOS 就回 None（Traccar 可能重送同一個警報）。
    位置用伺服器上最後一次回報的位置（手機網頁定位或 Traccar），不靠前端傳。"""
    if await r.hexists(K.sos(tid), uid):
        return None
    pos = await my_position(tid, uid)
    extra = {"lat": pos[0], "lon": pos[1]} if pos else {}
    text = "發出 SOS 求救" + (f"（{via}）" if via else "") + ("" if pos else "（還沒有位置）")
    ev = await events.emit(tid, "sos", uid, text, ts=await event_ts(tid, uid), **extra)
    # HSETNX：兩個請求同時進來時只留第一個事件
    await r.hsetnx(K.sos(tid), uid, ev["id"])
    return ev


@router.post("/{tid}/sos")
async def send_sos(tid: str, uid: str = Depends(current_uid)):
    await require_live_member(tid, uid)
    ev = await raise_sos(tid, uid)
    if ev is None:
        raise HTTPException(409, "你的 SOS 已經發出，隊友都看得到")
    return ev


@router.delete("/{tid}/sos")
async def cancel_sos(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    if not await r.hdel(K.sos(tid), uid):
        raise HTTPException(404, "你沒有發出中的 SOS")
    return await events.emit(tid, "sos_off", uid, "解除 SOS：沒事了", ts=await event_ts(tid, uid))
