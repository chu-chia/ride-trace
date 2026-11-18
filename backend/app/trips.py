"""行程：開團、邀請碼、加入、開始、結束自己的紀錄、踢人。"""
import asyncio
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from redis.exceptions import ResponseError, WatchError

from . import events
from .auth import current_uid, public_user
from .db import K, end_record, r
from .geo import is_rough
from .worker import LAG_DEFAULT_KM, stats_dict

router = APIRouter(prefix="/api/trips")
INVITE_TTL = 24 * 3600
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def now_ms():
    return int(time.time() * 1000)


async def trip_or_404(tid: str) -> dict:
    t = await r.hgetall(K.trip(tid))
    if not t:
        raise HTTPException(404, "找不到這個行程")
    t["id"] = tid
    return t


async def require_member(tid: str, uid: str):
    if not await r.sismember(K.members(tid), uid):
        if await r.sismember(K.kicked(tid), uid) or await kicked_by_events(tid, uid):
            raise HTTPException(403, "你已被建立者移出這個行程")
        raise HTTPException(403, "你不是這個行程的成員")


async def kicked_by_events(tid: str, uid: str) -> bool:
    """舊行程（還沒有 trip:{id}:kicked）：從事件 Stream 倒著找這個人最後一筆是「移出」還是「加入」。只在被拒絕時才查。"""
    for _, f in await r.xrevrange(K.events(tid), count=2000):
        if f.get("uid") == uid and f.get("type") in ("kick", "join"):
            return f["type"] == "kick"
    return False


class CreateIn(BaseModel):
    name: str


@router.post("")
async def create_trip(body: CreateIn, uid: str = Depends(current_uid)):
    name = body.name.strip()[:30] or "臨時開團"
    tid = str(await r.incr("seq:trip"))
    for _ in range(10):
        code = "".join(secrets.choice(CODE_CHARS) for _ in range(6))
        # SET NX＋EX：邀請碼不重複，24 小時後自動失效
        if await r.set(K.invite(code), tid, nx=True, ex=INVITE_TTL):
            break
    else:
        raise HTTPException(500, "產生邀請碼失敗，請再試一次")
    ts = now_ms()
    async with r.pipeline(transaction=True) as p:
        p.hset(K.trip(tid), mapping={"name": name, "owner": uid, "status": "planned", "invite": code, "created": ts})
        p.sadd(K.members(tid), uid)
        p.zadd(K.user_trips(uid), {tid: ts})
        await p.execute()
    await events.emit(tid, "create", uid, f"建立行程「{name}」")
    return await trip_detail(tid, uid)


@router.get("")
async def my_trips(uid: str = Depends(current_uid)):
    ids = await r.zrevrange(K.user_trips(uid), 0, 49)
    out = []
    for tid in ids:
        t = await r.hgetall(K.trip(tid))
        if not t:
            continue
        t["id"] = tid
        t["member_count"] = await r.scard(K.members(tid))
        out.append(t)
    return out


class JoinIn(BaseModel):
    code: str


@router.post("/join")
async def join_trip(body: JoinIn, uid: str = Depends(current_uid)):
    code = body.code.strip().upper()
    tid = await r.get(K.invite(code))
    if not tid:
        raise HTTPException(404, "邀請碼不存在或已過期")
    t = await trip_or_404(tid)
    if t["status"] == "ended":
        raise HTTPException(409, "這個行程已經結束")
    new = await r.sadd(K.members(tid), uid)
    await r.srem(K.kicked(tid), uid)  # 被移出後又用邀請碼加回來
    await r.zadd(K.user_trips(uid), {tid: now_ms()})
    if t["status"] == "live":
        await leave_old_active(uid, await r.get(K.active_trip(uid)), tid)
        await r.sadd(K.active(tid), uid)
        await r.set(K.active_trip(uid), tid)
    if new:
        u = await public_user(uid)
        await events.emit(tid, "join", uid, "加入行程")
        await events.publish(tid, {"kind": "member", "user": u})
    return await trip_detail(tid, uid)


@router.get("/{tid}")
async def get_trip(tid: str, uid: str = Depends(current_uid)):
    await trip_or_404(tid)  # 先分出「行程不存在」（404）和「不是成員」（403），前端顯示不同的錯誤畫面
    await require_member(tid, uid)
    return await trip_detail(tid, uid)


async def trip_detail(tid: str, uid: str) -> dict:
    t = await trip_or_404(tid)
    member_ids = sorted(await r.smembers(K.members(tid)), key=int)
    active = await r.smembers(K.active(tid))
    members = []
    for m in member_ids:
        u = await public_user(m)
        u["active"] = m in active
        u["state"] = await r.hgetall(K.state(tid, m))
        u["stats"] = stats_dict(await r.hmget(K.stats(tid, m), "km", "max_kmh", "moving_s"))
        members.append(u)
    t["members"] = members
    t["me"] = uid
    t["is_owner"] = t.get("owner") == uid
    t["invite_valid"] = bool(await r.exists(K.invite(t.get("invite", ""))))
    t["lag_km"] = float(t.get("lag_km") or LAG_DEFAULT_KM)
    t["gaps"] = {k: float(v) for k, v in (await r.hgetall(K.gap(tid))).items()}
    t["flags"] = await r.hgetall(K.lagflag(tid))
    return t


@router.post("/{tid}/start")
async def start_trip(tid: str, uid: str = Depends(current_uid)):
    """只有建立者能開始。用 WATCH＋MULTI/EXEC 做樂觀鎖：
    如果有人在檢查狀態之後改了行程，交易會失敗並重試。"""
    key = K.trip(tid)
    async with r.pipeline(transaction=True) as p:
        while True:
            try:
                await p.watch(key, K.members(tid))
                owner, status = await p.hmget(key, "owner", "status")
                if owner is None:
                    raise HTTPException(404, "找不到這個行程")
                if owner != uid:
                    raise HTTPException(403, "只有建立者可以開始行程")
                if status != "planned":
                    raise HTTPException(409, "行程已經開始或結束了")
                members = await p.smembers(K.members(tid))
                olds = {m: await r.get(K.active_trip(m)) for m in members}
                p.multi()
                p.hset(key, mapping={"status": "live", "started": now_ms()})
                p.sadd(K.active(tid), *members)
                for m in members:
                    p.set(K.active_trip(m), tid)
                await p.execute()
                break
            except WatchError:
                continue
    for m, old in olds.items():
        await leave_old_active(m, old, tid)
    await events.emit(tid, "start", uid, "行程開始")
    await events.publish(tid, {"kind": "trip", "status": "live"})
    return await trip_detail(tid, uid)


@router.post("/{tid}/end")
async def end_my_record(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return await finish_record(tid, uid)


@router.post("/{tid}/finish")
async def finish_whole_trip(tid: str, uid: str = Depends(current_uid)):
    """建立者結束整趟行程（UX-10）：不用等每個人都按「我騎完了」。"""
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以結束整趟行程")
    if t.get("status") != "live":
        raise HTTPException(409, "只有進行中的行程可以結束")
    await end_whole_trip(tid, "建立者結束行程", uid)
    return {"ok": True, "ended": True}


async def end_whole_trip(tid: str, reason: str, by: str | None = None):
    """一次結束整趟行程：所有人的紀錄一起停、行程變 ended（建立者結束、管理者強制結束共用）。"""
    members = await r.smembers(K.members(tid))
    active = await r.smembers(K.active(tid))
    olds = {m: await r.get(K.active_trip(m)) for m in members | active}
    async with r.pipeline(transaction=True) as p:
        p.hset(K.trip(tid), mapping={"status": "ended", "ended_at": now_ms(), "ended_reason": reason})
        p.delete(K.active(tid))
        for m, old in olds.items():
            if old == tid:
                p.delete(K.active_trip(m))
            p.delete(K.hb(tid, m))
            if m in active:
                p.hset(K.state(tid, m), "status", "done")
        await p.execute()
    await events.emit(tid, "end", by, "結束整趟行程" if by else reason)
    await events.publish(tid, {"kind": "trip", "status": "ended"})
    from . import replay  # replay 也 import trips，放這裡避免循環
    asyncio.create_task(replay.warm(tid))  # 重算每個人的統計（跟回放一致）並預熱回放


async def leave_old_active(uid: str, old: str | None, new_tid: str):
    """一個人同時只會在一個行程裡回報。加入／開始新行程前，把他從舊行程的 active 移出（等同在舊行程按「結束紀錄」），
    不然舊行程會因為他永遠是 live、他的心跳不再續期而被當成失聯，全員到齊也永遠等不到他。"""
    if old and old != new_tid:
        await finish_record(old, uid, "加入其他行程，自動結束這趟的紀錄")


async def finish_record(tid: str, uid: str, text: str = "結束自己的紀錄") -> dict:
    last_ts = await events.last_fix_ts(tid, uid)
    removed, left, ended = await end_record(
        keys=[K.active(tid), K.trip(tid), K.hb(tid, uid), K.active_trip(uid)],
        args=[uid, tid, now_ms()],
    )
    from . import replay  # replay 也 import trips，放這裡避免循環
    if removed:
        # 用整條軌跡重算這個人的里程／移動時間／極速，跟回放摘要一致
        if await replay.finalize_stats(tid, uid):
            await events.publish(tid, {"kind": "stats", "uid": uid, **stats_dict(await r.hmget(K.stats(tid, uid), "km", "max_kmh", "moving_s"))})
        await r.hset(K.state(tid, uid), "status", "done")
        await events.emit(tid, "stop", uid, text, ts=last_ts)
        await events.publish(tid, {"kind": "status", "uid": uid, "status": "done"})
    if ended:
        fixes = [await events.last_fix_ts(tid, m) for m in await r.smembers(K.members(tid))]
        fixes = [x for x in fixes if x]
        reason = "全員結束紀錄，行程自動結束" if text == "結束自己的紀錄" else "最後一位騎士加入其他行程，行程自動結束"
        await r.hset(K.trip(tid), "ended_reason", reason)  # 回放、首頁顯示行程為什麼結束
        await events.emit(tid, "end", None, reason, ts=max(fixes) if fixes else None)
        await events.publish(tid, {"kind": "trip", "status": "ended"})
        asyncio.create_task(replay.warm(tid))
    return {"left": left, "ended": bool(ended)}


class SettingsIn(BaseModel):
    lag_km: float


@router.patch("/{tid}/settings")
async def update_settings(tid: str, body: SettingsIn, uid: str = Depends(current_uid)):
    """建立者調整落隊門檻（規格 4.4：預設 2 km，可調整）。"""
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以調整")
    if not 0.5 <= body.lag_km <= 20:
        raise HTTPException(400, "落隊門檻要在 0.5～20 km 之間")
    await r.hset(K.trip(tid), "lag_km", body.lag_km)
    await events.publish(tid, {"kind": "settings", "lag_km": body.lag_km})
    return {"lag_km": body.lag_km}


class KickIn(BaseModel):
    uid: str


@router.post("/{tid}/kick")
async def kick(tid: str, body: KickIn, uid: str = Depends(current_uid)):
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以踢人")
    if body.uid == uid:
        raise HTTPException(400, "不能踢自己")
    async with r.pipeline(transaction=True) as p:
        p.srem(K.members(tid), body.uid)
        p.srem(K.active(tid), body.uid)
        p.zrem(K.geo(tid), body.uid)
        p.hdel(K.lagflag(tid), body.uid)
        p.hdel(K.gap(tid), body.uid)
        p.delete(K.hb(tid, body.uid))
        p.zrem(K.user_trips(body.uid), tid)
        p.sadd(K.kicked(tid), body.uid)   # 被移出的人重開行程頁時，錯誤畫面寫「你已被移出」而不是「不是成員」
        await p.execute()
    if await r.get(K.active_trip(body.uid)) == tid:
        await r.delete(K.active_trip(body.uid))
    await events.emit(tid, "kick", body.uid, "被建立者移出行程")
    await events.publish(tid, {"kind": "kicked", "uid": body.uid})
    return {"ok": True}


@router.get("/{tid}/nearby")
async def nearby(tid: str, uid: str = Depends(current_uid)):
    """GEOSEARCH：以我為中心，列出隊友距離（由近到遠）。"""
    await require_member(tid, uid)
    if await r.geopos(K.geo(tid), uid) == [None]:
        return {"me": uid, "items": []}
    try:
        res = await r.geosearch(K.geo(tid), member=uid, radius=1000, unit="km", withdist=True, sort="ASC")
    except ResponseError:
        # geopos 和 geosearch 之間這個人剛好被移出 GEO（結束紀錄、被踢）：Redis 回「找不到成員」，當成還沒有位置
        return {"me": uid, "items": []}
    return {"me": uid, "items": [{"uid": m, "km": float(d)} for m, d in res if m != uid]}


@router.get("/{tid}/snapshot")
async def snapshot(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return await build_snapshot(tid, uid)


async def former_people(members: list[dict], evs: list[dict]) -> dict:
    """事件裡出現、但已經不是成員的人（被移出）：補上暱稱和顏色，回放、事件列表才不會沒有名字。"""
    have = {m["uid"] for m in members}
    out = {}
    for e in evs:
        u = e.get("uid")
        if u and u not in have and u not in out:
            pu = await public_user(u)
            if pu.get("nickname"):
                out[u] = {"nickname": pu["nickname"], "color": pu["color"]}
    return out


async def build_snapshot(tid: str, uid: str) -> dict:
    detail = await trip_detail(tid, uid)
    raw = await r.xrevrange(K.events(tid), count=40)
    detail["events"] = [events.event_from_stream(i, f) for i, f in reversed(raw)]
    detail["people"] = await former_people(detail["members"], detail["events"])
    trails = {}
    for m in detail["members"]:
        rows = await r.xrevrange(K.track(tid, m["uid"]), count=600)
        trails[m["uid"]] = [[float(f["lon"]), float(f["lat"])] for _, f in reversed(rows) if not is_rough(f.get("acc"))]
    detail["trails"] = trails
    return detail
