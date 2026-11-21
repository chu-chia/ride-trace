"""管理後台維運工具；所有端點都經過管理員檢查。"""
import json
import math
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .admin import require_admin
from .auth import hash_pw
from .db import K, r
from .ingest import Fix, ingest

router = APIRouter(prefix="/api/admin/ops", dependencies=[Depends(require_admin)])
ID = re.compile(r"[1-9][0-9]*\Z")


def valid_id(value: str) -> str:
    if not ID.fullmatch(value):
        raise HTTPException(400, "ID 格式不合法")
    return value


async def get_trip(tid: str) -> dict:
    valid_id(tid)
    trip = await r.hgetall(K.trip(tid))
    if not trip:
        raise HTTPException(404, "找不到行程")
    return trip


async def get_user(uid: str) -> dict:
    valid_id(uid)
    user = await r.hgetall(K.user(uid))
    if not user:
        raise HTTPException(404, "找不到使用者")
    return user


def label(user: dict) -> str:
    return user.get("nickname") or user.get("username") or "—"


@router.get("/trips")
async def trips():
    seq = int(await r.get("seq:trip") or 0)
    out = []
    for number in range(seq, 0, -1):
        tid = str(number)
        trip = await r.hgetall(K.trip(tid))
        if not trip:
            continue
        owner = await r.hgetall(K.user(trip.get("owner", "")))
        out.append({"id": tid, "name": trip.get("name", ""), "status": trip.get("status", ""),
                    "owner": label(owner), "owner_uid": trip.get("owner"),
                    "members": await r.scard(K.members(tid)), "active": await r.scard(K.active(tid)),
                    "started": trip.get("started"), "ended_at": trip.get("ended_at"),
                    "created": trip.get("created")})
    return {"trips": out}


@router.post("/trips/{tid}/end")
async def end_trip(tid: str):
    from .trips import end_whole_trip
    trip = await get_trip(tid)
    if trip.get("status") != "live":
        raise HTTPException(409, "只有進行中的行程可以強制結束")
    await end_whole_trip(tid, "管理者強制結束")  # 重算每個人的統計（跟回放一致）並預熱回放
    return {"ok": True, "id": tid}


@router.post("/trips/{tid}/restart")
async def restart_trip(tid: str):
    from . import events
    trip = await get_trip(tid)
    if trip.get("status") != "ended":
        raise HTTPException(409, "只有已結束行程可以重新開始")
    from .trips import riders_of
    members = await riders_of(tid, await r.smembers(K.members(tid)))  # 只看的人不開始紀錄
    if not members:
        raise HTTPException(409, "行程沒有成員")
    conflicts = [uid for uid in members if (await r.get(K.active_trip(uid))) not in (None, tid)]
    if conflicts:
        raise HTTPException(409, f"成員已有其他進行中的行程：{', '.join(sorted(conflicts))}")
    async with r.pipeline(transaction=True) as p:
        p.hset(K.trip(tid), mapping={"status": "live", "started": int(time.time() * 1000)})
        p.hdel(K.trip(tid), "ended_at", "ended_reason")
        p.sadd(K.active(tid), *members)
        for uid in members:
            p.set(K.active_trip(uid), tid)
            p.hset(K.state(tid, uid), "status", "ok")
        await p.execute()
    await events.publish(tid, {"kind": "trip", "status": "live"})
    return {"ok": True, "id": tid, "active": len(members)}


@router.delete("/trips/{tid}")
async def delete_trip(tid: str):
    trip = await get_trip(tid)
    members = await r.smembers(K.members(tid))
    active = await r.smembers(K.active(tid))
    # SCAN 收齊行程專屬 key，涵蓋軌跡、時序、狀態、事件、集合點及旗標。
    patterns = [f"trip:{tid}:*", f"track:{tid}:*", f"ts:{tid}:*", f"hb:{tid}:*",
                f"seq:mark:{tid}", f"seq:wp:{tid}"]
    keys = {K.trip(tid)}
    for pattern in patterns:
        async for key in r.scan_iter(match=pattern, count=500):
            keys.add(key)
    # 路線是獨立 RedisJSON key，只刪沒有其他行程引用的路線。
    rid = trip.get("route")
    if rid:
        shared = False
        seq = int(await r.get("seq:trip") or 0)
        for number in range(1, seq + 1):
            if str(number) != tid and await r.hget(K.trip(str(number)), "route") == rid:
                shared = True
                break
        if not shared:
            keys.add(K.route(rid))
    async with r.pipeline(transaction=True) as p:
        for uid in members | active:
            p.zrem(K.user_trips(uid), tid)
            if await r.get(K.active_trip(uid)) == tid:
                p.delete(K.active_trip(uid))
        code = trip.get("invite")
        if code and await r.get(K.invite(code)) == tid:
            p.delete(K.invite(code))
        for key in keys:
            p.delete(key)
        await p.execute()
    return {"ok": True, "id": tid, "deleted_keys": len(keys)}


@router.get("/users")
async def users():
    seq = int(await r.get("seq:user") or 0)
    out = []
    for number in range(1, seq + 1):
        uid = str(number)
        user = await r.hgetall(K.user(uid))
        if user:
            out.append({"uid": uid, "username": user.get("username"), "nickname": label(user)})
    return {"users": out}


@router.get("/users/{uid}")
async def user_detail(uid: str):
    user = await get_user(uid)
    return {"uid": uid, "username": user.get("username"), "nickname": label(user),
            "last": await r.hgetall(K.last(uid)), "active_trip": await r.get(K.active_trip(uid)),
            "device_id": await r.get(K.user_device(uid))}


@router.delete("/users/{uid}/last")
async def clear_last(uid: str):
    await get_user(uid)
    return {"deleted": await r.delete(K.last(uid))}


@router.delete("/users/{uid}/active-trip")
async def clear_active_trip(uid: str):
    await get_user(uid)
    return {"deleted": await r.delete(K.active_trip(uid))}


class NicknameIn(BaseModel):
    nickname: str


@router.patch("/users/{uid}/nickname")
async def change_nickname(uid: str, body: NicknameIn):
    await get_user(uid)
    nickname = body.nickname.strip()
    if not nickname or len(nickname) > 12:
        raise HTTPException(400, "暱稱須為 1 到 12 字")
    await r.hset(K.user(uid), "nickname", nickname)
    return {"nickname": nickname}


class PasswordIn(BaseModel):
    password: str


@router.post("/users/{uid}/password")
async def reset_password(uid: str, body: PasswordIn):
    await get_user(uid)
    if len(body.password) < 6:
        raise HTTPException(400, "密碼至少 6 個字")
    await r.hset(K.user(uid), "pw", hash_pw(body.password))
    return {"ok": True}


class InjectIn(BaseModel):
    uid: str
    lat: float
    lon: float
    ts: int | None = None


@router.post("/inject")
async def inject_position(body: InjectIn):
    await get_user(body.uid)
    if not math.isfinite(body.lat) or not math.isfinite(body.lon):
        raise HTTPException(400, "座標不合法")
    return await ingest(body.uid, Fix(lat=body.lat, lon=body.lon, ts=body.ts, src="admin"))


@router.get("/redis")
async def inspect_redis(key: str | None = None, pattern: str | None = None):
    if bool(key) == bool(pattern):
        raise HTTPException(400, "請輸入 key 或 pattern 其中一項")
    if (key and len(key) > 256) or (pattern and len(pattern) > 256):
        raise HTTPException(400, "查詢字串太長")
    if key:
        names = [key] if await r.exists(key) else []
    else:
        names = []
        async for name in r.scan_iter(match=pattern, count=200):
            names.append(name)
            if len(names) >= 200:
                break
    items = []
    for name in names:
        typ = await r.type(name)
        ttl = await r.ttl(name)
        try:
            if typ == "hash":
                value = await r.hgetall(name)
            elif typ == "stream":
                value = list(reversed(await r.xrevrange(name, count=20)))
            elif typ == "zset":
                value = await r.zrange(name, 0, 99, withscores=True)
            elif typ == "set":
                value = await r.sscan(name, count=100)
                value = value[1][:100]
            elif typ == "string":
                value = await r.get(name)
            elif typ == "ReJSON-RL":
                value = json.loads(await r.execute_command("JSON.GET", name))
            elif typ == "list":
                value = await r.lrange(name, 0, 99)
            elif typ == "TSDB-TYPE":
                value = await r.execute_command("TS.REVRANGE", name, "-", "+", "COUNT", 20)
            else:
                value = "不支援預覽的資料型別"
        except Exception as exc:  # key 可能在 SCAN 後過期，或模組型別無法預覽
            value = f"讀取失敗：{type(exc).__name__}"
        items.append({"key": name, "type": typ, "ttl": ttl, "value": value})
    return {"items": items, "limit": 200}


@router.get("/system")
async def system_status():
    streams = []
    for name in (K.ingest, "stream:notify"):
        length = await r.xlen(name) if await r.exists(name) else 0
        try:
            groups = [{"name": g["name"], "lag": g.get("lag"), "pending": g["pending"]}
                      for g in await r.xinfo_groups(name)] if length else []
        except Exception:
            groups = []
        streams.append({"name": name, "length": length, "groups": groups})
    seq = int(await r.get("seq:trip") or 0)
    simulating = 0
    recent = int(time.time() * 1000) - 120_000
    for number in range(1, seq + 1):
        tid = str(number)
        if await r.hget(K.trip(tid), "status") != "live":
            continue
        for uid in await r.smembers(K.active(tid)):
            state = await r.hmget(K.state(tid, uid), "src", "seen")
            if state[0] == "sim" and state[1] and int(state[1]) >= recent:
                simulating += 1
                break
    info = await r.info("memory")
    return {"streams": streams, "simulating_trips": simulating,
            "dbsize": await r.dbsize(), "used_memory": info.get("used_memory"),
            "used_memory_human": info.get("used_memory_human")}
