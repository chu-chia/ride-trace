"""管理後台的測試工具：手動觸發推播、行程事件、外部資料更新，走跟真的一樣的流程。

行程事件用 events.emit() 寫進 trip:{id}:events（Streams）＋ Pub/Sub ＋ stream:notify，
所以畫面、回放、worker 的推播 group 都會收到。測試事件都帶 test=1，可以一鍵 XDEL 清掉。
"""
import json
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import events, push, traffic, weather
from .admin import require_admin
from .db import K, r

router = APIRouter(prefix="/api/admin/test")

# 可以手動觸發的事件：名稱、要不要指定「誰」、文字
EVENTS = {
    "sos":       ("SOS 求救", True, "發出 SOS 求救（測試）"),
    "lost":      ("失聯", True, "失聯：90 秒沒有回報位置（測試）"),
    "behind":    ("落隊", True, "落隊：沿路線落後全隊中心 2.4 km（測試）"),
    "stuck":     ("異常久停", True, "異常久停：已經停了 12 分鐘，附近沒有集合點或休息點（測試）"),
    "allin":     ("全員到齊", False, "全員到齊：集合點「武嶺停車場」（測試）"),
    "speedcam":  ("前方測速", True, "前方測速：台14甲線 清境農場前（速限 50）（測試）"),
    "offroute":  ("偏離路線", True, "偏離路線 240 m（測試）"),
    "msg":       ("快速訊息", True, "等我（測試）"),
    "chat":      ("聊天", True, "我到停車場了，大家慢慢來（測試）"),
    "roadevent": ("前方路況", False, ""),
    "weather":   ("前方降雨", False, "前方降雨｜南投縣仁愛鄉（約 25 分鐘後經過）15–18 時降雨機率 80%（測試）"),
}


async def nick(uid: str) -> str:
    u = await r.hmget(K.user(uid), "nickname", "username")
    return u[0] or u[1] or uid


@router.get("/info")
async def info(uid: str = Depends(require_admin)):
    # 有開通知的人
    users = []
    async for key in r.scan_iter("user:*:push"):
        u = key.split(":")[1]
        n = await r.hlen(key)
        if n:
            users.append({"uid": u, "name": await nick(u), "devices": n})
    users.sort(key=lambda x: (x["uid"] != uid, int(x["uid"])))
    # 行程：我參加的優先，其次進行中，最多 20 個
    seq = int(await r.get("seq:trip") or 0)
    trips = []
    for i in range(seq, 0, -1):
        tid = str(i)
        t = await r.hmget(K.trip(tid), "name", "status", "route")
        if not t[0]:
            continue
        members = sorted(await r.smembers(K.members(tid)), key=int)
        trips.append({"id": tid, "name": t[0], "status": t[1], "route": bool(t[2]), "mine": uid in members,
                      "members": [{"uid": m, "name": await nick(m), "devices": await r.hlen(push.subs_key(m))}
                                  for m in members]})
    # 預設選「我在裡面、還有別人」的行程：別人觸發的事件才會推到我的手機
    trips.sort(key=lambda x: (not x["mine"], len(x["members"]) < 2, x["status"] != "live", -int(x["id"])))
    month = time.strftime("%Y-%m")
    return {
        "me": uid, "push_enabled": bool(push.PRIVATE_KEY), "push_users": users, "trips": trips[:20],
        "events": {k: {"name": v[0], "who": v[1]} for k, v in EVENTS.items()},
        "tdx": {"enabled": traffic.enabled(), "calls": int(await r.hget(traffic.USAGE, month) or 0),
                "fresh_s": max(0, await r.ttl(traffic.FRESH)), "count": await r.zcard(traffic.GEO)},
        "cwa": {"enabled": weather.enabled(), "calls": int(await r.hget(weather.USAGE, month) or 0),
                "counties": list(weather.DATASET)},
    }


class PushIn(BaseModel):
    to: str | None = None


@router.post("/push")
async def test_push(body: PushIn, uid: str = Depends(require_admin)):
    to = body.to or uid
    n = await push.send_to_user(to, {"title": "騎跡通知測試", "body": f"這是從管理後台送給 {await nick(to)} 的測試通知。",
                                     "url": "/admin", "tag": "admintest", "renotify": True, "urgent": False})
    devices = await r.hlen(push.subs_key(to))
    return {"to": to, "name": await nick(to), "devices": devices, "sent": n}


class EventIn(BaseModel):
    trip: str
    type: str
    who: str | None = None


@router.post("/event")
async def test_event(body: EventIn, uid: str = Depends(require_admin)):
    if body.type not in EVENTS:
        raise HTTPException(400, "不支援的事件")
    tid = body.trip
    if not await r.exists(K.trip(tid)):
        raise HTTPException(404, "找不到行程")
    name, needs_who, text = EVENTS[body.type]
    who = body.who if needs_who else None
    if needs_who and (not who or not await r.sismember(K.members(tid), who)):
        raise HTTPException(400, "請選一位這個行程的成員")
    if body.type == "chat":
        ts = int(time.time() * 1000)
        eid = await r.xadd(f"trip:{tid}:chat", {"uid": who, "text": text, "ts": ts, "test": 1})
        await events.publish(tid, {"kind": "chat", "id": eid, "uid": who, "text": text, "ts": ts})
        await events.notify(tid, eid, "chat", who, text)
    else:
        if body.type == "roadevent":  # 拿一筆真的 TDX 事件當內容（沒有就用假的）
            x = None
            if await traffic.ensure_fresh():
                hits = await traffic.near(121.2, 24.1, 60000, count=1)  # 合歡山一帶
                x = hits[0][0] if hits else None
            text = (f"前方路況｜{x['road']} {x['title']}（測試）：{traffic.short(x)}" if x
                    else "前方路況｜台14甲 施工（測試）：翠峰至大禹嶺路段單線雙向管制")
        ev = await events.emit(tid, body.type, who, text, test=1)
        if body.type == "sos":  # 和真的 SOS 一樣記在 trip:{id}:sos，行程頁才會出現紅色橫幅
            await r.hset(K.sos(tid), who, ev["id"])
    # 會推給誰（照 push.RULES），以及他們有沒有開通知
    to = await push.recipients(tid, body.type, who or "")
    rec = [{"uid": u, "name": await nick(u), "devices": await r.hlen(push.subs_key(u))} for u in to]
    return {"type": body.type, "name": name, "who": await nick(who) if who else None, "text": text,
            "recipients": rec, "rule": push.RULES.get(body.type, {}).get("who")}


class TripIn(BaseModel):
    trip: str


@router.post("/cleanup")
async def cleanup(body: TripIn, uid: str = Depends(require_admin)):
    """刪掉這個行程裡帶 test=1 的事件與聊天。"""
    n = 0
    for key in (K.events(body.trip), f"trip:{body.trip}:chat"):
        ids = [i for i, f in await r.xrange(key) if f.get("test") == "1"]
        if ids:
            n += await r.xdel(key, *ids)
            if key == K.events(body.trip):  # 測試 SOS 的紅色橫幅一起解除
                for who, eid in (await r.hgetall(K.sos(body.trip))).items():
                    if eid in ids:
                        await r.hdel(K.sos(body.trip), who)
                        await events.publish(body.trip, {"kind": "sos_refresh"})
    return {"deleted": n}


@router.post("/tdx-refresh")
async def tdx_refresh(uid: str = Depends(require_admin)):
    if not traffic.enabled():
        raise HTTPException(409, ".env 沒有 TDX 金鑰")
    n = await traffic.refresh()
    await r.set(traffic.FRESH, 1, ex=traffic.FRESH_S)
    return {"count": n, "calls": int(await r.hget(traffic.USAGE, time.strftime("%Y-%m")) or 0)}


@router.get("/weather")
async def weather_now(county: str, uid: str = Depends(require_admin)):
    fc = await weather.county_forecast(county)
    if fc is None:
        raise HTTPException(409, "抓不到（沒有授權碼、縣市不對，或剛好有人在抓，稍後再試）")
    now = int(time.time() * 1000)
    rows = []
    for town, slots in fc.items():
        cur = next((s for s in slots if s[0] <= now < s[1]), None)
        nxt = [s[2] for s in slots if s[0] >= now][:3]
        rows.append({"town": town, "now": cur[2] if cur else None, "next": nxt,
                     "slot": f"{weather.tw(cur[0], '%H')}–{weather.tw(cur[1], '%H')} 時" if cur else ""})
    rows.sort(key=lambda x: -(x["now"] or 0))
    ttl = await r.ttl(f"cache:cwa:{county}")
    return {"county": county, "towns": rows, "cache_ttl": ttl,
            "calls": int(await r.hget(weather.USAGE, time.strftime("%Y-%m")) or 0)}
