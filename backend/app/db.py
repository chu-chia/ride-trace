"""Redis 連線與 Lua script。所有 key 的命名都集中在 K。"""
import os

import redis.asyncio as aioredis

from app import geo
from app.redis_url import default_redis_url

REDIS_URL = default_redis_url()

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
    lagflag = staticmethod(lambda tid: f"trip:{tid}:lagflag")     # Hash uid → behind／ahead（目前在警示中）
    gap = staticmethod(lambda tid: f"trip:{tid}:gap")             # Hash uid → 與全隊中心的距離（km，負＝落後）
    waypoints = staticmethod(lambda tid: f"trip:{tid}:waypoints")   # GEO：集合點／休息點
    wp = staticmethod(lambda tid, wid: f"trip:{tid}:wp:{wid}")
    arrived = staticmethod(lambda tid, wid: f"trip:{tid}:arrived:{wid}")
    allin = staticmethod(lambda tid, wid: f"trip:{tid}:allin:{wid}")
    marks = staticmethod(lambda tid: f"trip:{tid}:marks")           # GEO：地圖標註
    mark = staticmethod(lambda tid, mid: f"trip:{tid}:mark:{mid}")
    sos = staticmethod(lambda tid: f"trip:{tid}:sos")               # Hash：uid → 還沒解除的 SOS 事件 ID
    route = staticmethod(lambda rid: f"route:{rid}")                # RedisJSON：路線
    progress = staticmethod(lambda tid: f"trip:{tid}:progress")     # Hash：uid → 沿路線里程（km）
    offroute = staticmethod(lambda tid: f"trip:{tid}:offroute")     # Hash：uid → 偏離路線中（只通知一次）
    stuck = staticmethod(lambda tid: f"trip:{tid}:stuck")           # Hash：異常久停中的人（只通知一次）
    lagchk = staticmethod(lambda tid: f"trip:{tid}:lagchk")       # 節流鎖：一個行程 2 秒判斷一次
    ingest = "stream:ingest"
    ts_writes = "ts:sys:writes"

    footprint = staticmethod(lambda uid: f"footprint:{uid}")
    fp_ver = staticmethod(lambda uid: f"fp:ver:{uid}")
    fp_geo = staticmethod(lambda uid: f"footprint:{uid}:geo")     # GEO：每個足跡點（成員＝Stream ID），熱力圖放大時 GEOSEARCH BYBOX
    fp_warm = staticmethod(lambda uid: f"fp:warm:{uid}")
    daykm = staticmethod(lambda uid: f"footprint:{uid}:daykm")
    fog = staticmethod(lambda uid, day, bucket: f"fog:{uid}:{day}:{bucket}")
    fog_all = staticmethod(lambda uid: f"fog:{uid}:all")
    cache_lines = staticmethod(lambda uid, ver, q: f"cache:lines:{uid}:{ver}:{q}")
    cache_cells = staticmethod(lambda uid, ver: f"cache:cells:{uid}:{ver}")
    cache_summary = staticmethod(lambda uid, ver: f"cache:summary:{uid}:{ver}")


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
# ARGV: ts(ms) lat lon kmh（沒有速度傳 -1） acc（沒有傳 -1） 然後是 STATS_RULE_ARGS 六個門檻
UPDATE_STATS_LUA = """
-- 與 geo.step() 同一套規則，門檻由 Python 傳入（ARGV[6..10]）。
-- ts/lat/lon 是「錨點」（上一個算進里程的點），lts 是最後處理過的時間戳（去重用）。
local ts, lat, lon, kmh, acc = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local MIN_MOVE, MAX_ACC, MAX_KMH, MAX_GAP, MOVING_KMH, MOVING_DT =
  tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10]), tonumber(ARGV[11])
local prev = redis.call('HMGET', KEYS[1], 'ts', 'lat', 'lon', 'lts')
local seen = tonumber(prev[4] or prev[1] or '0')
if prev[1] and seen >= ts then return 0 end
redis.call('HSET', KEYS[1], 'lts', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'points', 1)
-- 精度太差：不算里程、不當錨點、不更新極速
if acc >= 0 and acc > MAX_ACC then return 1 end
local move_anchor = true
if prev[1] then
  local dt = (ts - tonumber(prev[1])) / 1000
  local rad = math.pi / 180
  local p1, p2 = tonumber(prev[2]) * rad, lat * rad
  local dp, dl = p2 - p1, (lon - tonumber(prev[3])) * rad
  local a = math.sin(dp / 2) ^ 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ^ 2
  local d = 2 * 6371000 * math.asin(math.sqrt(math.min(1, a)))
  if dt > 0 and dt <= MAX_GAP and d / dt * 3.6 <= MAX_KMH then
    if d < math.max(MIN_MOVE, math.min(acc, MAX_ACC)) then
      move_anchor = false   -- 停車漂移：錨點不動，等真的移動再一起算
    else
      redis.call('HINCRBYFLOAT', KEYS[1], 'km', d / 1000)
      if dt <= MOVING_DT and d / dt * 3.6 >= MOVING_KMH then redis.call('HINCRBYFLOAT', KEYS[1], 'moving_s', dt) end
    end
  end
end
if kmh >= 0 and kmh <= MAX_KMH and kmh > tonumber(redis.call('HGET', KEYS[1], 'max_kmh') or '0') then
  redis.call('HSET', KEYS[1], 'max_kmh', kmh)
end
if move_anchor then redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'lat', ARGV[2], 'lon', ARGV[3]) end
return 1
"""
update_stats = r.register_script(UPDATE_STATS_LUA)
STATS_RULE_ARGS = [geo.MIN_MOVE_M, geo.MAX_ACC_M, geo.MAX_SPEED_KMH, geo.MAX_GAP_S, geo.MOVING_KMH, geo.MOVING_MAX_DT_S]


# Worker（alerts group）：落隊判斷（規格 7.4）。
# 有路線（ARGV[2]=1）：用「沿路線里程」（worker 把每個人投影到路線上算出來的），中位數當中心，差多少就是落後多少。
#   山路彎道多時直線距離會失真，沿路線才準。
# 沒路線：與全隊中心的直線距離，中心＝在線隊友座標的「中位數」（不用平均：落很後面的人會把平均拉過去）；
#   前後用「已騎里程」（stats group 算的）判斷，大家從同一個地方出發時就近似沿路線的進度。
# 只有兩個人時沒有中位數可言，以比較前面的那位當中心。全隊都停著不判斷（休息站裡走動不該警示）。
# 進入警示要超過門檻，解除要回到門檻 75% 以內（遲滯），避免在門檻附近一直跳。
# 「判斷＋改旗標」在同一個 Lua 裡完成，多個 worker 同時判斷同一個行程也只會發一次警示。
# KEYS: geo, lagflag, progress, 然後每人兩個：state, stats    ARGV: 門檻(公尺), 是否用路線(1/0), uid1…uidN
# 回傳：{uid, 帶正負號的距離(公尺，負＝落後), 轉換(0 無／1 落隊／2 衝太前面／3 跟上)} 攤平成一維
LAG_LUA = """
local thr = tonumber(ARGV[1])
local useRoute = ARGV[2] == '1'
local R, moving = {}, false
for n = 3, #ARGV do
  local uid = ARGV[n]
  local k = 2 * (n - 3) + 4
  local st = redis.call('HMGET', KEYS[k], 'status', 'speed')
  if st[1] == 'ok' then
    local pos = redis.call('GEOPOS', KEYS[1], uid)[1]
    local rk = useRoute and tonumber(redis.call('HGET', KEYS[3], uid)) or nil
    if pos and (rk or not useRoute) then
      local km = tonumber(redis.call('HGET', KEYS[k + 1], 'km') or '0')
      table.insert(R, {uid = uid, lon = tonumber(pos[1]), lat = tonumber(pos[2]), km = useRoute and rk or km})
      if (tonumber(st[2]) or 0) >= 2 then moving = true end
    end
  end
end
if #R < 2 then return {} end

local function median(field)
  local a = {}
  for _, r in ipairs(R) do table.insert(a, r[field]) end
  table.sort(a)
  local n = #a
  if n % 2 == 1 then return a[(n + 1) / 2] end
  return (a[n / 2] + a[n / 2 + 1]) / 2
end
local clat, clon, ckm = median('lat'), median('lon'), median('km')
if #R == 2 then
  local lead = R[1].km >= R[2].km and R[1] or R[2]
  clat, clon, ckm = lead.lat, lead.lon, lead.km
end
local kx, ky = 111320 * math.cos(math.rad(clat)), 110540

local out = {}
for _, r in ipairs(R) do
  local dist
  if useRoute then
    dist = math.abs(r.km - ckm) * 1000
  else
    local dx, dy = (r.lon - clon) * kx, (r.lat - clat) * ky
    dist = math.sqrt(dx * dx + dy * dy)
  end
  local ahead = r.km > ckm
  local flag = redis.call('HGET', KEYS[2], r.uid)
  local tr = 0
  if flag and dist < thr * 0.75 then
    redis.call('HDEL', KEYS[2], r.uid); tr = 3
  elseif not flag and moving and dist > thr then
    if ahead then redis.call('HSET', KEYS[2], r.uid, 'ahead'); tr = 2
    else redis.call('HSET', KEYS[2], r.uid, 'behind'); tr = 1 end
  end
  table.insert(out, r.uid); table.insert(out, math.floor((ahead and dist or -dist) + 0.5)); table.insert(out, tr)
end
return out
"""
check_lag = r.register_script(LAG_LUA)


# Worker（alerts group）：某人進入集合點半徑。
# SADD 回傳 1 才是「第一次抵達」；再檢查 active 的人是不是都在 arrived 裡（SDIFF 為空），
# 是的話用 SET NX 搶「全員到齊」旗標。全部在一個 script 裡，兩個 worker 同時處理最後兩個人也只會發一次。
# KEYS: arrived, active, allin    ARGV: uid
# 回傳：{是否第一次抵達, 是否剛好全員到齊}
ARRIVE_LUA = """
local new = redis.call('SADD', KEYS[1], ARGV[1])
local all = 0
if redis.call('SCARD', KEYS[2]) > 0 and #redis.call('SDIFF', KEYS[2], KEYS[1]) == 0 then
  if redis.call('SET', KEYS[3], '1', 'NX') then all = 1 end
end
return {new, all}
"""
arrive = r.register_script(ARRIVE_LUA)

# Worker（alerts group）：這個人的「警示時間游標」。點的 ts 比上一個處理過的新才回 1 並推進游標。
# 斷網補傳、Traccar 重送、多個 worker 搶著處理時，舊點會晚到；沿路線里程（progress）與久停起點（stop_since）
# 都只該被「更新的點」改寫，否則舊點會把里程拉回去造成落隊誤報、或把 stop_since 改成很久以前造成久停誤報。
# 放在 state hash 的 ats 欄位，行程重置時跟著 state 一起刪。
# KEYS: state    ARGV: ts（毫秒）
ADVANCE_LUA = """
local last = tonumber(redis.call('HGET', KEYS[1], 'ats') or '0')
local ts = tonumber(ARGV[1])
if ts > last then
  redis.call('HSET', KEYS[1], 'ats', ARGV[1])
  return 1
end
return 0
"""
advance_alert_ts = r.register_script(ADVANCE_LUA)
