"""Web Push 推播：警示、SOS、訊息推到手機，鎖螢幕、網頁沒開也收得到。

流程：events.emit() 遇到要推播的事件 → XADD stream:notify → worker 的 consumer group「push」
讀出來 → 依規則決定推給誰 → 去重 → 用 VAPID 簽章送到各瀏覽器的推播服務（Apple／Google／Mozilla）。
推播內容用訂閱裡的 p256dh／auth 金鑰端對端加密，推播服務看不到內容；內容也不放座標。

為什麼另開 stream:notify，不直接掛在 stream:ingest？
位置回報每 2～3 秒一筆，要推播的事件一趟只有幾十筆；分開後推播 worker 不用掃過大量位置，
而且「同一份事件，警示／統計／推播各自消費」正是 Consumer Group 的用途。

Redis：
- user:{uid}:push              Hash：訂閱 ID（endpoint 的 sha1 前 16 碼）→ 訂閱 JSON。一個人可以有多台裝置
- user:{uid} 的 push_chat       聊天訊息要不要推（"0"＝關閉，預設開；舊欄位，和 push_mute 的 chat 同步）
- user:{uid}:push_mute         Set：使用者關掉的推播類型（SOS、解除 SOS、被移出不能關）
- user:{uid}:push_last         Hash：最近一則推播的標題、時間、送達幾台／共幾台，給設定卡顯示
- push:grpwin:{tid}:{type}     SET NX PX：失聯／落隊／久停的 45 秒合併視窗，第一則立刻推
- push:grp:{tid}:{type}        List：視窗內所有人（第一則也在裡面），到期時合併成「3 人失聯：A、B、C」
- push:due                     Sorted Set：member＝{tid}|{type}、score＝視窗到期時間（ms），worker 每 2 秒掃
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
from urllib.parse import quote

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
# calm_as：和別的類型共用冷卻（超前、落隊是同一件事的兩面，來回切換時不要一直推）
# fixed：一定推，設定卡不能關
RULES = {
    "sos":      {"who": "others", "calm": 0,   "urgent": True,  "title": "SOS 求救", "fixed": True},
    "sos_off":  {"who": "others", "calm": 0,   "urgent": False, "title": "SOS 解除", "fixed": True},
    "lost":     {"who": "others", "calm": 300, "urgent": False, "title": "隊友失聯"},
    "behind":   {"who": "all",    "calm": 300, "urgent": False, "title": "落隊"},
    "ahead":    {"who": "all",    "calm": 300, "urgent": False, "title": "超前", "calm_as": "behind"},
    "stuck":    {"who": "others", "calm": 600, "urgent": False, "title": "異常久停"},
    "allin":    {"who": "all",    "calm": 0,   "urgent": False, "title": "全員到齊"},
    "roadevent": {"who": "all",   "calm": 0,   "urgent": False, "title": "前方路況"},
    "weather":  {"who": "all",    "calm": 0,   "urgent": False, "title": "前方降雨"},
    "speedcam": {"who": "self",   "calm": 0,   "urgent": False, "title": "前方測速"},
    "offroute": {"who": "self",   "calm": 300, "urgent": False, "title": "偏離路線"},
    "start":    {"who": "others", "calm": 0,   "urgent": False, "title": "行程開始"},
    "kick":     {"who": "self",   "calm": 0,   "urgent": False, "title": "你被移出行程", "fixed": True},
    "msg":      {"who": "others", "calm": 0,   "urgent": False, "title": "快速訊息"},
    "chat":     {"who": "others", "calm": 0,   "urgent": False, "title": "聊天"},
}

# 設定卡的說明（UX-23：清單由後端給，不在前端寫死）
DESC = {
    "sos": "隊友按下 SOS（不會自己消失）", "sos_off": "隊友解除 SOS，會蓋掉原本那則",
    "lost": "隊友超過門檻沒有回報位置", "behind": "有人沿路線落後全隊中心", "ahead": "有人跑太前面",
    "stuck": "隊友在非休息點停太久", "allin": "全員抵達集合點", "roadevent": "前方 5 km 內有施工、事故",
    "weather": "前方路段可能下雨", "speedcam": "你前方 1 km 有測速照相", "offroute": "你偏離規劃路線",
    "start": "團主按下開始", "kick": "你被團主移出行程", "msg": "隊友送出快速訊息", "chat": "聊天室的新訊息",
}
# 這幾類常常好幾個人同時發生（一起停、一起進山區沒訊號），45 秒內跨人合併成一則
GROUP_TYPES = {"lost", "behind", "stuck"}
GROUP_MS = 45_000
GROUP_VERB = {"lost": "失聯", "behind": "落隊", "stuck": "異常久停"}
DUE = "push:due"


def mute_key(uid: str) -> str:
    return f"user:{uid}:push_mute"


async def muted(uid: str) -> set[str]:
    out = set(await r.smembers(mute_key(uid)))
    if await r.hget(K.user(uid), "push_chat") == "0":
        out.add("chat")
    return {t for t in out if t in RULES and not RULES[t].get("fixed")}


async def recipients(tid: str, etype: str, uid: str) -> list[str]:
    who = RULES[etype]["who"]
    if who == "self":
        out = [uid] if uid else []
    else:
        members = await r.smembers(K.members(tid))
        out = [m for m in members if who == "all" or m != uid]
    if not RULES[etype].get("fixed"):  # 使用者可以個別關掉某一類
        out = [m for m in out if etype not in await muted(m)]
    return out


async def build_payload(f: dict) -> dict:
    tid, etype, uid = f["trip"], f["type"], f.get("uid") or ""
    rule = RULES[etype]
    trip_name = await r.hget(K.trip(tid), "name") or "行程"
    nick = (await r.hget(K.user(uid), "nickname") or await r.hget(K.user(uid), "username") or "") if uid else ""
    text = f.get("text", "")
    if etype == "msg":  # 快速訊息和聊天在鎖定畫面要分得出來（UX-58）
        title, body = f"{nick} 的快速訊息・{trip_name}", text
    elif etype == "chat":
        title, body = f"{nick} 在聊天室・{trip_name}", text
    elif rule["who"] == "self":
        title, body = f"{rule['title']}・{trip_name}", text
    else:
        title, body = f"{rule['title']}・{trip_name}", f"{nick}：{text}" if nick else text
    if etype == "kick":  # 被移出的人已經進不了行程頁，點通知回首頁並說明（UX-03）
        url = f"/?kicked={tid}&name={quote(trip_name)}"
    else:
        url = f"/trip?id={tid}"
    # 同一行程同一類收在同一則（聊天一直來只留最新），SOS 每次都要跳出來；
    # 解除 SOS 用原本那則 SOS 的 tag，把一直掛著的紅色通知蓋掉（UX-21）
    if etype == "sos":
        tag = f"{tid}-sos-{f.get('eid')}"
    elif etype == "sos_off" and f.get("sos"):
        tag = f"{tid}-sos-{f['sos']}"
    else:
        tag = f"{tid}-{etype}"
    return {"title": title, "body": body[:160], "url": url, "tag": tag, "renotify": True, "urgent": rule["urgent"]}


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
    # 最近一則的送達結果，設定卡顯示「最近一則：○○，送達 1／2 台」（UX-07）
    await r.hset(f"user:{uid}:push_last", mapping={"ts": int(time.time() * 1000), "title": payload.get("title", "")[:60],
                                                   "ok": ok, "total": len(codes)})
    await r.expire(f"user:{uid}:push_last", 30 * 86400)
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
        calm_type = rule.get("calm_as", etype)
        if rule["calm"] and uid and not await r.set(f"push:calm:{tid}:{uid}:{calm_type}", 1, nx=True, ex=rule["calm"]):
            continue
        if etype in GROUP_TYPES and uid and not await group_first(tid, etype, uid, f.get("text", "")):
            continue  # 視窗已經開了：先收著，到期時合併推一則
        payload = await build_payload(f)
        for to in await recipients(tid, etype, uid):
            if not await r.set(f"push:sent:{eid}:{to}", 1, nx=True, ex=86400):
                continue  # 這則已經推過（worker 重送）
            await send_to_user(to, payload)
    return [i for i, _ in msgs]


# ---------- 跨人合併（UX-41） ----------

async def group_first(tid: str, etype: str, uid: str, text: str) -> bool:
    """回傳 True＝這是 45 秒內第一則，照常立刻推；False＝已經有人在視窗裡，先排進清單。"""
    gkey, wkey = f"push:grp:{tid}:{etype}", f"push:grpwin:{tid}:{etype}"
    first = await r.set(wkey, 1, nx=True, px=GROUP_MS)
    if first:
        await r.delete(gkey)
    await r.rpush(gkey, json.dumps({"uid": uid, "text": text, "first": bool(first)}, ensure_ascii=False))
    await r.pexpire(gkey, GROUP_MS * 3)
    if not first:
        left = await r.pttl(wkey)
        await r.zadd(DUE, {f"{tid}|{etype}": int(time.time() * 1000) + max(left, 0)}, nx=True)
    return bool(first)


async def flush_groups():
    """worker 每 2 秒呼叫：到期的視窗合併成一則推出去（同一個 tag，會蓋掉第一則）。"""
    now = int(time.time() * 1000)
    for member in await r.zrangebyscore(DUE, "-inf", now):
        if not await r.zrem(DUE, member):
            continue  # 別的 worker 搶先處理了
        tid, etype = member.split("|", 1)
        gkey = f"push:grp:{tid}:{etype}"
        async with r.pipeline(transaction=True) as p:
            p.lrange(gkey, 0, -1)
            p.delete(gkey)
            rows, _ = await p.execute()
        items = [json.loads(x) for x in rows]
        seen, people = set(), []
        for it in items:
            if it["uid"] not in seen:
                seen.add(it["uid"])
                people.append(it)
        if len(people) < 2:
            continue  # 只有第一個人：第一則已經推過了
        first_uid = next((p["uid"] for p in people if p["first"]), None)
        trip_name = await r.hget(K.trip(tid), "name") or "行程"
        names = {p["uid"]: (await r.hget(K.user(p["uid"]), "nickname") or await r.hget(K.user(p["uid"]), "username") or "隊友")
                 for p in people}
        targets = set()
        for p in people:
            targets.update(await recipients(tid, etype, p["uid"]))
        for to in targets:
            subj = [p for p in people if not (RULES[etype]["who"] == "others" and p["uid"] == to)]
            if not [p for p in subj if p["uid"] != first_uid]:
                continue  # 對這個人來說沒有新的人（第一則已經收過）
            if len(subj) == 1:
                body = f"{names[subj[0]['uid']]}：{subj[0]['text']}"
            else:
                body = f"{len(subj)} 人{GROUP_VERB[etype]}：" + "、".join("你" if p["uid"] == to else names[p["uid"]] for p in subj)
            await send_to_user(to, {"title": f"{RULES[etype]['title']}・{trip_name}", "body": body[:160],
                                    "url": f"/trip?id={tid}", "tag": f"{tid}-{etype}", "renotify": True,
                                    "urgent": False})


async def flush_loop():
    while True:
        try:
            await flush_groups()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("合併推播失敗")
        await asyncio.sleep(2)


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
    chat: bool | None = None          # 舊版前端只送這個
    type: str | None = Field(default=None, max_length=20)
    on: bool | None = None


@router.get("/config")
async def config(endpoint: str | None = None, uid: str = Depends(current_uid)):
    """endpoint：這台裝置瀏覽器裡的訂閱網址，回傳伺服器上有沒有登記（UX-07：本機有、伺服器沒有就要重新登記）。"""
    m = await muted(uid)
    last = await r.hgetall(f"user:{uid}:push_last")
    types = [{"type": t, "title": RULES[t]["title"], "desc": DESC.get(t, ""), "fixed": bool(RULES[t].get("fixed")),
              "on": t not in m} for t in RULES]
    return {"enabled": bool(PUBLIC_KEY and PRIVATE_KEY), "public_key": PUBLIC_KEY,
            "devices": await r.hlen(subs_key(uid)), "chat": "chat" not in m,
            "registered": bool(endpoint) and bool(await r.hexists(subs_key(uid), sub_id(endpoint))),
            "types": types,
            "last": {"ts": int(last["ts"]), "title": last.get("title", ""), "ok": int(last.get("ok", 0)),
                     "total": int(last.get("total", 0))} if last.get("ts") else None}


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
    if body.type is None and body.chat is not None:
        body.type, body.on = "chat", body.chat
    if body.type not in RULES or body.on is None:
        raise HTTPException(400, "不認得的通知類型")
    if RULES[body.type].get("fixed"):
        raise HTTPException(400, f"「{RULES[body.type]['title']}」一定會推播，不能關")
    if body.on:
        await r.srem(mute_key(uid), body.type)
    else:
        await r.sadd(mute_key(uid), body.type)
    if body.type == "chat":
        await r.hset(K.user(uid), "push_chat", "1" if body.on else "0")
    return {"ok": True}


@router.post("/test")
async def test(uid: str = Depends(current_uid)):
    n = await send_to_user(uid, {"title": "騎跡通知測試", "body": "收到這則，騎車時的警示和訊息就會推到這台裝置。",
                                 "url": "/", "tag": "test", "renotify": True, "urgent": False})
    if not n:
        raise HTTPException(409, "沒有送出去：這個帳號還沒有開通知的裝置，或推播服務拒絕了")
    return {"ok": True, "sent": n}
