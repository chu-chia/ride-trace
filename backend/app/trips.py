"""行程：開團、邀請碼、加入、開始、結束自己的紀錄、踢人。"""
import asyncio
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from typing import Literal

from pydantic import BaseModel
from redis.exceptions import ResponseError, WatchError

from . import events
from .auth import PALETTE, current_uid, public_user, uid_from_token, token_from
from .db import K, end_record, r
from .geo import is_rough
from .worker import LAG_DEFAULT_KM, stats_dict

router = APIRouter(prefix="/api/trips")
INVITE_TTL = 24 * 3600
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TPE = timezone(timedelta(hours=8))  # 台灣沒有日光節約，固定 +8，不靠容器裡的 tzdata


def now_ms():
    return int(time.time() * 1000)


async def trip_or_404(tid: str) -> dict:
    t = await r.hgetall(K.trip(tid))
    if not t:
        raise HTTPException(404, "找不到這個行程")
    t["id"] = tid
    return t


Role = Literal["rider", "viewer", "car"]
ROLE_NAME = {"rider": "騎士", "viewer": "只看", "car": "後援車"}


async def riders_of(tid: str, members) -> set[str]:
    """會回報位置的人（騎士＋後援車）：只看的人不進 active、不分享位置"""
    roles = await r.hgetall(K.role(tid))
    return {m for m in members if roles.get(m) != "viewer"}


WATCH_TTL = 7 * 24 * 3600  # 觀看連結最長 7 天（行程結束就提早失效）


def watch_token(request: Request) -> str | None:
    return request.headers.get("x-qiji-watch") or request.query_params.get("watch")


async def watch_tid(tok: str | None) -> str | None:
    """觀看連結對應的行程；連結不存在、被換掉、或行程已結束都回 None"""
    if not tok or len(tok) > 64:
        return None
    tid = await r.get(K.watch(tok))
    if not tid or await r.hget(K.trip(tid), "watch") != tok or await r.hget(K.trip(tid), "status") == "ended":
        return None
    return tid


async def reader(tid: str, request: Request) -> str:
    """看得到這個行程的人：登入的成員回 uid；拿觀看連結的人回空字串（不登入、只能看）"""
    tok = watch_token(request)
    if tok:
        if await watch_tid(tok) == tid:
            return ""
        raise HTTPException(403, "觀看連結已失效")
    uid = await current_uid(request)
    await trip_or_404(tid)
    await require_member(tid, uid)
    return uid


async def uid_or_watch(request: Request) -> str:
    """不綁行程的查詢（沿途天氣路況）：登入的人或拿有效觀看連結的人都可以"""
    if await watch_tid(watch_token(request)):
        return ""
    return await current_uid(request)


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


def default_name() -> str:
    """名稱留空：用台灣日期，不會每一趟都叫「臨時開團」（UX-44）。"""
    d = datetime.now(TPE)
    return f"{d.month}/{d.day}（{'一二三四五六日'[d.weekday()]}）臨時開團"


def dedupe_colors(members: list[dict]) -> None:
    """同一趟有人撞色：依加入順序（uid 小的優先）保留原色，後面的人在這趟改用還沒人用的顏色（UX-09）。
    只改這趟顯示的顏色，帳號設定不動；own_color 留著原本的顏色。"""
    own = {m["color"] for m in members}
    used = set()
    for m in members:
        if m["color"] in used:
            free = next((c for c in PALETTE if c not in own and c not in used), None)
            if free:
                m["own_color"], m["color"] = m["color"], free
        used.add(m["color"])


class CreateIn(BaseModel):
    name: str


@router.post("")
async def create_trip(body: CreateIn, uid: str = Depends(current_uid)):
    name = body.name.strip()[:30] or default_name()
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
    role: Role = "rider"


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
    if new:  # 已經是成員又點一次邀請連結：不改原本的身分
        if body.role == "rider":
            await r.hdel(K.role(tid), uid)
        else:
            await r.hset(K.role(tid), uid, body.role)
    if t["status"] == "live" and await r.hget(K.role(tid), uid) != "viewer":
        await leave_old_active(uid, await r.get(K.active_trip(uid)), tid)
        await r.sadd(K.active(tid), uid)
        await r.set(K.active_trip(uid), tid)
    if new:
        u = await public_user(uid)
        team = [await public_user(m) for m in sorted(await r.smembers(K.members(tid)), key=int)]
        dedupe_colors(team)
        u = next((m for m in team if m["uid"] == uid), u)
        u["role"] = await r.hget(K.role(tid), uid) or "rider"
        await events.emit(tid, "join", uid, "加入行程" if u["role"] == "rider" else f"加入行程（{ROLE_NAME[u['role']]}）")
        await events.publish(tid, {"kind": "member", "user": u})
    return await trip_detail(tid, uid)


@router.get("/invite/{code}")
async def invite_preview(code: str):
    """邀請連結的登入頁用（還沒登入）：只回行程名、團主暱稱、狀態、人數，讓人知道自己要加入哪一團（UX-43）。
    拿得到邀請碼的人本來就能加入，所以不必登入；成員名單、位置都不回。"""
    tid = await r.get(K.invite(code.strip().upper()))
    t = await r.hgetall(K.trip(tid)) if tid else None
    if not t:
        raise HTTPException(404, "邀請碼不存在或已過期")
    owner = await public_user(t["owner"]) if t.get("owner") else None
    return {"name": t.get("name", ""), "owner": owner["nickname"] if owner else "", "status": t.get("status"),
            "member_count": await r.scard(K.members(tid))}


@router.get("/{tid}")
async def get_trip(tid: str, uid: str = Depends(reader)):
    # reader 先分出「行程不存在」（404）和「不是成員」（403），前端顯示不同的錯誤畫面；觀看連結 uid＝""
    return await trip_detail(tid, uid)


@router.post("/{tid}/watch")
async def new_watch(tid: str, uid: str = Depends(current_uid)):
    """建立者產生（或換一條新的）觀看連結：知道連結就能免登入看戰情室，舊連結立刻失效；行程結束也失效"""
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以產生觀看連結")
    if t.get("status") == "ended":
        raise HTTPException(409, "行程已經結束")
    tok = secrets.token_urlsafe(12)
    async with r.pipeline(transaction=True) as p:
        if t.get("watch"):
            p.delete(K.watch(t["watch"]))
        p.set(K.watch(tok), tid, ex=WATCH_TTL)
        p.hset(K.trip(tid), "watch", tok)
        await p.execute()
    return {"watch": tok}


@router.delete("/{tid}/watch")
async def stop_watch(tid: str, uid: str = Depends(current_uid)):
    t = await trip_or_404(tid)
    if t.get("owner") != uid:
        raise HTTPException(403, "只有建立者可以停用觀看連結")
    if t.get("watch"):
        await r.delete(K.watch(t["watch"]))
        await r.hdel(K.trip(tid), "watch")
    return {"watch": None}


async def trip_detail(tid: str, uid: str) -> dict:
    t = await trip_or_404(tid)
    member_ids = sorted(await r.smembers(K.members(tid)), key=int)
    active = await r.smembers(K.active(tid))
    roles = await r.hgetall(K.role(tid))
    members = []
    for m in member_ids:
        u = await public_user(m)
        u["active"] = m in active
        u["role"] = roles.get(m, "rider")
        u["state"] = await r.hgetall(K.state(tid, m))
        u["stats"] = stats_dict(await r.hmget(K.stats(tid, m), "km", "max_kmh", "moving_s"))
        members.append(u)
    dedupe_colors(members)
    t["members"] = members
    t["me"] = uid
    t["is_owner"] = bool(uid) and t.get("owner") == uid
    if not uid:  # 觀看連結：只能看，不給邀請碼（不然拿到觀看連結的人可以自己加入）
        t.pop("invite", None)
    if not t["is_owner"]:
        t.pop("watch", None)
    elif t.get("watch") and not await r.exists(K.watch(t["watch"])):
        t.pop("watch", None)  # 7 天到期
    t["invite_valid"] = bool(t.get("invite")) and bool(await r.exists(K.invite(t["invite"])))
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
                members = await riders_of(tid, await p.smembers(K.members(tid)))  # 只看的人不開始紀錄
                if not members:
                    raise HTTPException(409, "至少要有一位騎士才能開始")
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
    await adopt_pre_positions(tid, members)
    await events.emit(tid, "start", uid, "行程開始")
    await events.publish(tid, {"kind": "trip", "status": "live"})
    return await trip_detail(tid, uid)


async def adopt_pre_positions(tid: str, members: set[str]):
    """開始那一刻：開始前 10 分鐘內有回報的人，即時位置留著（圖釘不會消失），改成正式狀態並開始算心跳；
    太久沒回報（狀態 Hash 已過期）的人從 GEO 移除，免得舊位置被拿去算落隊。軌跡、統計從這一刻才開始。"""
    from .ingest import heartbeat_s
    now = now_ms()
    async with r.pipeline(transaction=False) as p:
        for m in members:
            p.hmget(K.state(tid, m), "pre", "seen", "speed")
        rows = await p.execute()
    async with r.pipeline(transaction=False) as p:
        for m, (pre, seen, speed) in zip(members, rows):
            if pre and seen:
                hb = heartbeat_s(float(speed) if speed else None)
                p.persist(K.state(tid, m))
                p.hdel(K.state(tid, m), "pre")
                p.hset(K.state(tid, m), "hbs", hb)
                p.set(K.hb(tid, m), now, ex=max(5, hb - (now - int(seen)) // 1000))
            else:
                p.zrem(K.geo(tid), m)
        await p.execute()


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


class RoleIn(BaseModel):
    role: Role


@router.post("/{tid}/role")
async def set_role(tid: str, body: RoleIn, uid: str = Depends(current_uid)):
    """改自己的身分：騎士／只看（後援、家人，不出現在地圖和名單上）／後援車（分享位置，但不算名次、落隊、到齊）。
    進行中改成「只看」＝停止自己的紀錄；從「只看」改回騎士或後援車＝加入 active 開始回報。"""
    t = await trip_or_404(tid)
    await require_member(tid, uid)
    old = await r.hget(K.role(tid), uid) or "rider"
    if body.role == old:
        return await trip_detail(tid, uid)
    if body.role == "viewer" and t.get("status") == "live" and await r.sismember(K.active(tid), uid):
        rest = await riders_of(tid, await r.smembers(K.active(tid)) - {uid})
        if not rest:
            raise HTTPException(409, "你是最後一位在騎的人，改成只看行程就會結束；要結束請按「結束行程」")
    if body.role == "rider":
        await r.hdel(K.role(tid), uid)
    else:
        await r.hset(K.role(tid), uid, body.role)
    if t.get("status") == "live":
        if body.role == "viewer":
            async with r.pipeline(transaction=True) as p:
                p.srem(K.active(tid), uid)
                p.zrem(K.geo(tid), uid)
                p.hdel(K.lagflag(tid), uid)
                p.hdel(K.gap(tid), uid)
                p.delete(K.hb(tid, uid))
                await p.execute()
            if await r.get(K.active_trip(uid)) == tid:
                await r.delete(K.active_trip(uid))
        elif old == "viewer":
            await leave_old_active(uid, await r.get(K.active_trip(uid)), tid)
            await r.sadd(K.active(tid), uid)
            await r.set(K.active_trip(uid), tid)
        if body.role == "car":
            await r.hdel(K.lagflag(tid), uid)
            await r.hdel(K.gap(tid), uid)
    elif body.role == "viewer":
        await r.zrem(K.geo(tid), uid)  # 開始前分享的即時位置也拿掉
    await events.emit(tid, "role", uid, f"身分改成「{ROLE_NAME[body.role]}」")
    team = [await public_user(m) for m in sorted(await r.smembers(K.members(tid)), key=int)]
    dedupe_colors(team)
    u = next(m for m in team if m["uid"] == uid)
    u["role"] = body.role
    u["active"] = await r.sismember(K.active(tid), uid)
    await events.publish(tid, {"kind": "member", "user": u})
    return await trip_detail(tid, uid)


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
        p.hdel(K.role(tid), body.uid)
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
