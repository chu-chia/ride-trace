"""Web Push 推播：警示、SOS、訊息推到手機，鎖螢幕、網頁沒開也收得到。

流程：events.emit() 遇到要推播的事件 → XADD stream:notify → worker 的 consumer group「push」
讀出來 → 依規則決定推給誰 → 去重 → 用 VAPID 簽章送到各瀏覽器的推播服務（Apple／Google／Mozilla）。
推播內容用訂閱裡的 p256dh／auth 金鑰端對端加密，推播服務看不到內容；內容也不放座標。

為什麼另開 stream:notify，不直接掛在 stream:ingest？
位置回報每 2～3 秒一筆，要推播的事件一趟只有幾十筆；分開後推播 worker 不用掃過大量位置，
而且「同一份事件，警示／統計／推播各自消費」正是 Consumer Group 的用途。

Redis：
- user:{uid}:push              Hash：訂閱 ID（endpoint 的 sha1 前 16 碼）→ 訂閱 JSON。一個人可以有多台裝置
- user:{uid} 的 push_chat       聊天訊息要不要推（"0"＝關閉，預設開）
- stream:notify                Streams（MAXLEN ~5000）：推播入口
- push:sent:{eid}:{uid}        SET NX EX：worker at-least-once 重送時，同一則不會推兩次
- push:calm:{tid}:{uid}:{type} SET NX EX：落隊、偏離路線這類會來回抖動的警示，一段時間內只推一次
- ts:sys:push                  TimeSeries：後台看每秒推播數
"""
import asyncio
import hashlib
import json
import logging
import os
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import current_uid
from .db import K, r

log = logging.getLogger("qiji.push")
router = APIRouter(prefix="/api/push")

PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
NOTIFY = "stream:notify"
PUSH_TS = "ts:sys:push"


def subs_key(uid: str) -> str:
    return f"user:{uid}:push"


def sub_id(endpoint: str) -> str:
    return hashlib.sha1(endpoint.encode()).hexdigest()[:16]


# ---------- 推給誰 ----------
# who：others＝全隊除了本人、all＝全隊、self＝只有本人（測速、偏離是給騎的人自己看的）
# calm：秒；同一個人同一種警示在這段時間內只推一次（0＝每次都推）
# urgent：通知不會自己消失、震動比較長
RULES = {
    "sos":      {"who": "others", "calm": 0,   "urgent": True,  "title": "SOS 求救"},
    "lost":     {"who": "others", "calm": 300, "urgent": False, "title": "隊友失聯"},
    "behind":   {"who": "all",    "calm": 300, "urgent": False, "title": "落隊"},
    "stuck":    {"who": "others", "calm": 600, "urgent": False, "title": "異常久停"},
    "allin":    {"who": "all",    "calm": 0,   "urgent": False, "title": "全員到齊"},
    "roadevent": {"who": "all",   "calm": 0,   "urgent": False, "title": "前方路況"},
    "weather":  {"who": "all",    "calm": 0,   "urgent": False, "title": "前方降雨"},
    "speedcam": {"who": "self",   "calm": 0,   "urgent": False, "title": "前方測速"},
    "offroute": {"who": "self",   "calm": 300, "urgent": False, "title": "偏離路線"},
    "start":    {"who": "others", "calm": 0,   "urgent": False, "title": "行程開始"},
    "kick":     {"who": "self",   "calm": 0,   "urgent": False, "title": "你被移出行程"},
    "msg":      {"who": "others", "calm": 0,   "urgent": False, "title": "快速訊息"},
    "chat":     {"who": "others", "calm": 0,   "urgent": False, "title": "聊天"},
}


async def recipients(tid: str, etype: str, uid: str) -> list[str]:
    who = RULES[etype]["who"]
    if who == "self":
        return [uid] if uid else []
    members = await r.smembers(K.members(tid))
    out = [m for m in members if who == "all" or m != uid]
    if etype == "chat":  # 聊天可以個別關掉
        prefs = [await r.hget(K.user(m), "push_chat") for m in out]
        out = [m for m, p in zip(out, prefs) if p != "0"]
    return out


async def build_payload(f: dict) -> dict:
    tid, etype, uid = f["trip"], f["type"], f.get("uid") or ""
    rule = RULES[etype]
    trip_name = await r.hget(K.trip(tid), "name") or "行程"
    nick = (await r.hget(K.user(uid), "nickname") or await r.hget(K.user(uid), "username") or "") if uid else ""
    text = f.get("text", "")
    if etype in ("msg", "chat"):
        title, body = f"{nick}・{trip_name}", text
    elif rule["who"] == "self":
        title, body = f"{rule['title']}・{trip_name}", text
    else:
        title, body = f"{rule['title']}・{trip_name}", f"{nick}：{text}" if nick else text
    return {
        "title": title, "body": body[:160],
        "url": f"/trip?id={tid}",
        # 同一行程同一類收在同一則（聊天一直來只留最新），SOS 每次都要跳出來
        "tag": f"{tid}-{etype}" + (f"-{f.get('eid')}" if etype == "sos" else ""),
        "renotify": True, "urgent": rule["urgent"],
    }


# ---------- 送出 ----------

def _send_one(sub: dict, data: str, urgent: bool) -> int:
    """回傳 HTTP 狀態碼；0＝連線失敗。pywebpush 是同步的，放在 thread 裡跑。"""
    from pywebpush import WebPushException, webpush
    try:
        resp = webpush(subscription_info=sub, data=data, vapid_private_key=PRIVATE_KEY,
                       vapid_claims={"sub": SUBJECT}, ttl=3600 if urgent else 600, timeout=10,
                       headers={"Urgency": "high" if urgent else "normal"})
        return resp.status_code
    except WebPushException as e:
        return e.response.status_code if e.response is not None else 0
    except Exception as e:  # noqa: BLE001
        log.warning("推播失敗：%r", e)
        return 0


async def send_to_user(uid: str, payload: dict) -> int:
    """推給這個人的所有裝置，回傳成功幾台。訂閱過期（404／410）就刪掉。"""
    if not PRIVATE_KEY:
        return 0
    subs = await r.hgetall(subs_key(uid))
    if not subs:
        return 0
    data = json.dumps(payload, ensure_ascii=False)
    codes = await asyncio.gather(*(asyncio.to_thread(_send_one, json.loads(s), data, payload.get("urgent", False))
                                   for s in subs.values()))
    ok = 0
    for sid, code in zip(subs, codes):
        if code in (404, 410):
            await r.hdel(subs_key(uid), sid)
            log.info("uid %s 的訂閱 %s 已失效，刪除", uid, sid)
        elif 200 <= code < 300:
            ok += 1
        else:
            log.warning("uid %s 推播回應 %s", uid, code)
    if ok:
        await r.execute_command("TS.INCRBY", PUSH_TS, ok, "TIMESTAMP", int(time.time()) * 1000,
                                "RETENTION", 7 * 86400_000, "LABELS", "metric", "sys", "kind", "push")
    return ok


async def handle_push(msgs: list[tuple[str, dict]]) -> list[str]:
    """worker 的 consumer group「push」。"""
    for _, f in msgs:
        etype, tid, uid, eid = f.get("type"), f.get("trip"), f.get("uid") or "", f.get("eid", "")
        if etype not in RULES or not tid:
            continue
        rule = RULES[etype]
        if rule["calm"] and uid and not await r.set(f"push:calm:{tid}:{uid}:{etype}", 1, nx=True, ex=rule["calm"]):
            continue
        payload = await build_payload(f)
        for to in await recipients(tid, etype, uid):
            if not await r.set(f"push:sent:{eid}:{to}", 1, nx=True, ex=86400):
                continue  # 這則已經推過（worker 重送）
            await send_to_user(to, payload)
    return [i for i, _ in msgs]


# ---------- API：網頁開通知 ----------

class Keys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class SubIn(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: Keys


class UnsubIn(BaseModel):
    endpoint: str = Field(max_length=1000)


class PrefIn(BaseModel):
    chat: bool


@router.get("/config")
async def config(uid: str = Depends(current_uid)):
    return {"enabled": bool(PUBLIC_KEY and PRIVATE_KEY), "public_key": PUBLIC_KEY,
            "devices": await r.hlen(subs_key(uid)), "chat": await r.hget(K.user(uid), "push_chat") != "0"}


@router.post("/subscribe")
async def subscribe(body: SubIn, uid: str = Depends(current_uid)):
    if not body.endpoint.startswith("https://"):
        raise HTTPException(400, "推播網址不正確")
    await r.hset(subs_key(uid), sub_id(body.endpoint), body.model_dump_json())
    return {"ok": True, "devices": await r.hlen(subs_key(uid))}


@router.post("/unsubscribe")
async def unsubscribe(body: UnsubIn, uid: str = Depends(current_uid)):
    await r.hdel(subs_key(uid), sub_id(body.endpoint))
    return {"ok": True, "devices": await r.hlen(subs_key(uid))}


@router.post("/prefs")
async def prefs(body: PrefIn, uid: str = Depends(current_uid)):
    await r.hset(K.user(uid), "push_chat", "1" if body.chat else "0")
    return {"ok": True}


@router.post("/test")
async def test(uid: str = Depends(current_uid)):
    n = await send_to_user(uid, {"title": "騎跡通知測試", "body": "收到這則，騎車時的警示和訊息就會推到這台裝置。",
                                 "url": "/", "tag": "test", "renotify": True, "urgent": False})
    if not n:
        raise HTTPException(409, "沒有送出去：這個帳號還沒有開通知的裝置，或推播服務拒絕了")
    return {"ok": True, "sent": n}
