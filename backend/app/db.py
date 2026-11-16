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
    stats = staticmethod(lambda tid, uid: f"trip:{tid}:stats:{uid}")
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


# Worker（stats group）：更新一個人的里程／極速／移動時間。
# 依 ts 去重：比上次處理過的還舊（重送或亂序）就直接略過，所以 at-least-once 重送不會重算里程。
# ARGV: ts(ms) lat lon kmh（沒有速度傳 -1）
UPDATE_STATS_LUA = """
local ts, lat, lon, kmh = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local prev = redis.call('HMGET', KEYS[1], 'ts', 'lat', 'lon')
if prev[1] and tonumber(prev[1]) >= ts then return 0 end
if prev[1] then
  local dt = (ts - tonumber(prev[1])) / 1000
  local rad = math.pi / 180
  local p1, p2 = tonumber(prev[2]) * rad, lat * rad
  local dp, dl = p2 - p1, (lon - tonumber(prev[3])) * rad
  local a = math.sin(dp / 2) ^ 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ^ 2
  local d = 2 * 6371000 * math.asin(math.sqrt(math.min(1, a)))
  -- 超過 250 km/h 視為跳點；間隔超過 1 小時不算（斷訊很久後換地方）
  if dt <= 3600 and d / dt * 3.6 <= 250 then
    redis.call('HINCRBYFLOAT', KEYS[1], 'km', d / 1000)
    if dt <= 60 and d / dt * 3.6 >= 5 then redis.call('HINCRBYFLOAT', KEYS[1], 'moving_s', dt) end
  end
end
if kmh >= 0 and kmh <= 250 and kmh > tonumber(redis.call('HGET', KEYS[1], 'max_kmh') or '0') then
  redis.call('HSET', KEYS[1], 'max_kmh', kmh)
end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'lat', ARGV[2], 'lon', ARGV[3])
redis.call('HINCRBY', KEYS[1], 'points', 1)
return 1
"""
update_stats = r.register_script(UPDATE_STATS_LUA)
