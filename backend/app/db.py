"""Redis 連線與 Lua script。所有 key 的命名都集中在 K。"""
import os

import redis.asyncio as aioredis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6390/0")

r: aioredis.Redis = aioredis.from_url(REDIS_URL, decode_responses=True)


class K:
    """Key 命名規則（對應規格 7.1）。"""
    user = staticmethod(lambda uid: f"user:{uid}")
    username = staticmethod(lambda name: f"username:{name}")
    session = staticmethod(lambda tok: f"session:{tok}")
    device = staticmethod(lambda tok: f"device:{tok}")
    user_device = staticmethod(lambda uid: f"user:{uid}:device")
    user_trips = staticmethod(lambda uid: f"user:{uid}:trips")
    active_trip = staticmethod(lambda uid: f"user:{uid}:active_trip")
    last = staticmethod(lambda uid: f"user:{uid}:last")

    trip = staticmethod(lambda tid: f"trip:{tid}")
    invite = staticmethod(lambda code: f"invite:{code}")
    members = staticmethod(lambda tid: f"trip:{tid}:members")
    active = staticmethod(lambda tid: f"trip:{tid}:active")
    geo = staticmethod(lambda tid: f"trip:{tid}:geo")
    state = staticmethod(lambda tid, uid: f"trip:{tid}:state:{uid}")
    hb = staticmethod(lambda tid, uid: f"hb:{tid}:{uid}")
    track = staticmethod(lambda tid, uid: f"track:{tid}:{uid}")
    events = staticmethod(lambda tid: f"trip:{tid}:events")
    live = staticmethod(lambda tid: f"trip:{tid}:live")
    ts_speed = staticmethod(lambda tid, uid: f"ts:{tid}:{uid}:speed")
    ts_alt = staticmethod(lambda tid, uid: f"ts:{tid}:{uid}:alt")
    ingest = "stream:ingest"
    ts_writes = "ts:sys:writes"

    footprint = staticmethod(lambda uid: f"footprint:{uid}")
    daykm = staticmethod(lambda uid: f"footprint:{uid}:daykm")
    fog = staticmethod(lambda uid, day, bucket: f"fog:{uid}:{day}:{bucket}")
    fog_all = staticmethod(lambda uid: f"fog:{uid}:all")
    cache_lines = staticmethod(lambda uid, q: f"cache:lines:{uid}:{q}")


# 結束自己的紀錄：移出 active，最後一個人離開時把行程標成 ended。
# 用 Lua 確保「移除＋檢查是否為空＋改狀態」是原子操作，兩人同時按也不會漏掉。
END_RECORD_LUA = """
local removed = redis.call('SREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[3])
if redis.call('GET', KEYS[4]) == ARGV[2] then redis.call('DEL', KEYS[4]) end
local left = redis.call('SCARD', KEYS[1])
if left == 0 and redis.call('HGET', KEYS[2], 'status') == 'live' then
  redis.call('HSET', KEYS[2], 'status', 'ended', 'ended_at', ARGV[3])
  return {removed, left, 1}
end
return {removed, left, 0}
"""
end_record = r.register_script(END_RECORD_LUA)
