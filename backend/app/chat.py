"""文字聊天室（規格 4.4）：休息時聊天用，訊息也會出現在回放裡。

快速訊息（interact.py）是「一鍵警示」：寫進行程事件、跳出提醒；聊天是一串對話，另外存一條 Stream。

Redis：
- trip:{id}:chat         Streams：聊天紀錄。ID 就是時間，XREVRANGE 從最新往回翻頁（「載入更早」）
- trip:{id}:chatread     Hash：uid → 讀到的最後一則 ID。用 Lua 比大小，只會往前推（兩台裝置同時回報也不會倒退）
- ratelimit:chat:{uid}   SET NX PX 1000：一秒最多一則
未讀數：XRANGE (讀到的ID  +  COUNT 100，數別人發的。SQL 要 WHERE id > ? AND uid <> ? 再 COUNT，這裡 Stream ID 本身就能比大小。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import events
from .auth import current_uid
from .db import r
from .interact import event_ts
from .trips import reader, require_member

router = APIRouter(prefix="/api/trips")
UNREAD_CAP = 99

chat_key = lambda tid: f"trip:{tid}:chat"          # noqa: E731
read_key = lambda tid: f"trip:{tid}:chatread"      # noqa: E731

# 只在新 ID 比較大時才更新「讀到哪裡」。Stream ID 是「毫秒-序號」，拆開比較。
_mark_read = r.register_script("""
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local cm, cs = string.match(cur, '(%d+)-(%d+)')
  local nm, ns = string.match(ARGV[2], '(%d+)-(%d+)')
  cm, cs, nm, ns = tonumber(cm), tonumber(cs), tonumber(nm), tonumber(ns)
  if cm > nm or (cm == nm and cs >= ns) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
""")


def item(eid: str, f: dict) -> dict:
    return {"id": eid, "uid": f.get("uid", ""), "text": f.get("text", ""), "ts": int(f.get("ts") or eid.split("-")[0])}


async def unread(tid: str, uid: str) -> int:
    last = await r.hget(read_key(tid), uid)
    rows = await r.xrange(chat_key(tid), min=f"({last}" if last else "-", max="+", count=UNREAD_CAP + 50)
    return min(UNREAD_CAP, sum(1 for _, f in rows if f.get("uid") != uid))


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=200)


class ReadIn(BaseModel):
    id: str = Field(pattern=r"^\d+-\d+$")


@router.get("/{tid}/chat")
async def history(tid: str, before: str | None = Query(None, pattern=r"^\d+-\d+$"), limit: int = Query(40, ge=1, le=100),
                  uid: str = Depends(reader)):  # 成員或觀看連結
    rows = await r.xrevrange(chat_key(tid), max=f"({before}" if before else "+", min="-", count=limit + 1)
    more = len(rows) > limit
    items = [item(i, f) for i, f in rows[:limit]][::-1]  # 舊 → 新
    return {"items": items, "more": more, "unread": await unread(tid, uid), "read": await r.hget(read_key(tid), uid)}


@router.post("/{tid}/chat")
async def send(tid: str, body: ChatIn, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "訊息是空的")
    if not await r.set(f"ratelimit:chat:{uid}", 1, nx=True, px=1000):
        raise HTTPException(429, "太快了，等一下再發")
    ts = await event_ts(tid, uid) or int(__import__("time").time() * 1000)
    eid = await r.xadd(chat_key(tid), {"uid": uid, "text": text, "ts": ts})
    await _mark_read(keys=[read_key(tid)], args=[uid, eid])  # 自己發的當然算讀過
    msg = {"kind": "chat", "id": eid, "uid": uid, "text": text, "ts": ts}
    await events.publish(tid, msg)
    await events.notify(tid, eid, "chat", uid, text)
    return msg


@router.post("/{tid}/chat/read")
async def mark_read(tid: str, body: ReadIn, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    await _mark_read(keys=[read_key(tid)], args=[uid, body.id])
    return {"unread": await unread(tid, uid)}
