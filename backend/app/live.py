"""即時：WebSocket 轉送 Pub/Sub，以及用 Keyspace Notification 偵測失聯。"""
import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import events
from .auth import COOKIE, uid_from_token
from .db import K, r
from .trips import build_snapshot

router = APIRouter()
log = logging.getLogger("qiji.live")


@router.websocket("/ws/trips/{tid}")
async def trip_ws(ws: WebSocket, tid: str):
    tok = ws.cookies.get(COOKIE) or ws.query_params.get("token")
    uid = await uid_from_token(tok)
    if not uid or not await r.sismember(K.members(tid), uid):
        await ws.close(code=4403)
        return
    await ws.accept()
    await r.incr("stat:ws")                       # 後台：目前的 WebSocket 連線數
    await r.zadd("online:viewer", {uid: int(__import__("time").time() * 1000)})
    ps = r.pubsub()
    await ps.subscribe(K.live(tid))
    try:
        await ws.send_text(json.dumps({"kind": "snapshot", "trip": await build_snapshot(tid, uid)}, ensure_ascii=False))

        async def pump():
            while True:
                msg = await ps.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg and msg["type"] == "message":
                    await ws.send_text(msg["data"])

        async def recv():
            while True:
                await ws.receive_text()  # 只用來偵測斷線

        done, pending = await asyncio.wait(
            [asyncio.create_task(pump()), asyncio.create_task(recv())], return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("ws %s 結束：%r", tid, e)
    finally:
        await r.decr("stat:ws")
        await ps.unsubscribe()
        await ps.aclose()


async def expiry_listener():
    """心跳 key（hb:{trip}:{uid}）過期 → Redis 發出 expired 事件 → 標記失聯並通知全隊。"""
    while True:
        try:
            try:
                await r.config_set("notify-keyspace-events", "Ex")
            except Exception:  # noqa: BLE001  雲端 Redis 可能不給 CONFIG，就靠 redis.conf
                pass
            ps = r.pubsub()
            await ps.psubscribe("__keyevent@*__:expired")
            log.info("失聯偵測已啟動")
            async for msg in ps.listen():
                if msg["type"] != "pmessage":
                    continue
                key = msg["data"]
                if not key.startswith("hb:"):
                    continue
                _, tid, uid = key.split(":", 2)
                if not await r.sismember(K.active(tid), uid):
                    continue
                await r.hset(K.state(tid, uid), "status", "lost")
                await events.emit(tid, "lost", uid, "失聯：90 秒沒有回報位置", ts=await events.last_fix_ts(tid, uid))
                await events.publish(tid, {"kind": "status", "uid": uid, "status": "lost"})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("失聯偵測中斷，5 秒後重連：%r", e)
            await asyncio.sleep(5)
