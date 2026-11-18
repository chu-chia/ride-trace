"""即時：WebSocket 轉送 Pub/Sub，以及用 Keyspace Notification 偵測失聯。"""
import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import events
from .auth import COOKIE, uid_from_token
from .db import K, r
from .trips import build_snapshot

router = APIRouter()
log = logging.getLogger("qiji.live")
PING_S = 15


@router.websocket("/ws/trips/{tid}")
async def trip_ws(ws: WebSocket, tid: str):
    tok = ws.cookies.get(COOKIE) or ws.query_params.get("token")
    uid = await uid_from_token(tok)
    # 先 accept 再 close：握手階段就 close 的話，瀏覽器只會收到 1006（看不到原因），前端會一直重連。
    # 4401＝沒登入、4404＝行程不存在、4403＝不是成員（含被移出），前端收到就停止重連並顯示錯誤畫面。
    await ws.accept()
    code = None
    if not uid:
        code = 4401
    elif not await r.exists(K.trip(tid)):
        code = 4404
    elif not await r.sismember(K.members(tid), uid):
        code = 4403
    if code:
        await ws.close(code=code)
        return
    await r.incr("stat:ws")                       # 後台：目前的 WebSocket 連線數
    await r.zadd("online:viewer", {uid: int(time.time() * 1000)})
    ps = r.pubsub()
    await ps.subscribe(K.live(tid))
    try:
        await ws.send_text(json.dumps({"kind": "snapshot", "trip": await build_snapshot(tid, uid)}, ensure_ascii=False))

        async def pump():
            last = time.monotonic()
            while True:
                msg = await ps.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg and msg["type"] == "message":
                    await ws.send_text(msg["data"])
                    last = time.monotonic()
                elif time.monotonic() - last >= PING_S:
                    # 心跳：前端超過 40 秒沒收到任何訊息就顯示「連線中斷」並重連；送不出去也讓這端及早發現斷線
                    await ws.send_text('{"kind":"ping"}')
                    last = time.monotonic()

        async def recv():
            while True:
                await ws.receive_text()  # 只用來偵測斷線

        done, pending = await asyncio.wait(
            [asyncio.create_task(pump()), asyncio.create_task(recv())], return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:  # 瀏覽器關掉時 recv() 會丟 WebSocketDisconnect，取出來就不會被當成「沒處理的例外」印出來
            if not t.cancelled():
                t.exception()
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
                hbs = int(await r.hget(K.state(tid, uid), "hbs") or 90)
                await r.hset(K.state(tid, uid), "status", "lost")
                text = "失聯：90 秒沒有回報位置" if hbs < 120 else f"失聯：停車後 {hbs // 60} 分鐘沒有回報位置"
                await events.emit(tid, "lost", uid, text, ts=await events.last_fix_ts(tid, uid))
                await events.publish(tid, {"kind": "status", "uid": uid, "status": "lost"})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("失聯偵測中斷，5 秒後重連：%r", e)
            await asyncio.sleep(5)
