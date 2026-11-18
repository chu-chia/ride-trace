"""地理計算：距離、迷霧格子、時段分類。匯入工具和即時回報共用。"""
import math
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))
CELL = 0.0015            # 迷霧格子大小（度），約 150～170 公尺
INTERP_STEP_M = 80       # 兩點之間每 80 公尺補一個格子，避免沿路出現斷點
MAX_INTERP_GAP_S = 180   # 兩點相隔超過 3 分鐘就不補（可能是斷訊或搭車）
MAX_INTERP_DIST_M = 3000
MAX_SPEED_KMH = 250      # 超過視為飛機或資料跳點
ALT_MIN_M, ALT_MAX_M = -100, 4500   # 台灣最高 3952 m；超出這個範圍的海拔當成 GPS 雜訊

# 里程／移動時間的共用規則（即時足跡 ingest、行程統計 Lua、回放摘要都用這一份）
MIN_MOVE_M = 3           # 離上一個「錨點」不到 max(3 m, 這點的精度) 不算里程：停車時 GPS 漂移不灌里程
MAX_ACC_M = 50           # 精度差於 50 公尺的點：只更新目前位置，不算里程、不畫軌跡
MAX_GAP_S = 3600         # 斷訊超過 1 小時後換地方，不算里程
MOVING_KMH = 5           # 這段平均速度 ≥ 5 km/h 才算「移動時間」
MOVING_MAX_DT_S = 60     # 兩點相隔超過 60 秒就不算移動時間（可能是休息）

BUCKETS = ("dawn", "day", "dusk", "night")
BUCKET_NAME = {"dawn": "清晨 4–8 點", "day": "白天 8–17 點", "dusk": "傍晚 17–20 點", "night": "夜間 20–4 點"}


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def is_rough(acc) -> bool:
    """精度太差（例如室內、隧道剛出來）的點。acc 沒給（舊資料、模擬器）視為可用。"""
    try:
        return acc is not None and acc != "" and float(acc) > MAX_ACC_M
    except (TypeError, ValueError):
        return False


def min_move_m(acc) -> float:
    """位移小於定位誤差半徑就分不出是移動還是漂移。"""
    try:
        a = float(acc) if acc not in (None, "") else 0.0
    except (TypeError, ValueError):
        a = 0.0
    return max(MIN_MOVE_M, min(a, MAX_ACC_M))


def step(anchor, cur, acc=None):
    """里程累計的一步。anchor／cur 是 (ts_ms, lat, lon)；anchor 是上一個「算進里程」的點，acc 是 cur 的精度（公尺）。
    回傳 (這步算進里程的公尺, 算進移動時間的秒數, 新的 anchor)。
    位移不到 min_move_m(acc) 時 anchor 不動，等真的移動了再一起算，慢速前進也不會被吃掉。
    db.py 的 UPDATE_STATS_LUA 是同一套規則的 Lua 版，門檻由這裡的常數傳進去。"""
    if anchor is None:
        return 0.0, 0.0, cur
    dt = (cur[0] - anchor[0]) / 1000
    if dt <= 0:
        return 0.0, 0.0, anchor
    d = haversine_m(anchor[1], anchor[2], cur[1], cur[2])
    if dt > MAX_GAP_S or d / dt * 3.6 > MAX_SPEED_KMH:
        return 0.0, 0.0, cur       # 跳點或斷訊太久：不算，從這裡重新起算
    if d < min_move_m(acc):
        return 0.0, 0.0, anchor
    moving = dt if dt <= MOVING_MAX_DT_S and d / dt * 3.6 >= MOVING_KMH else 0.0
    return d, moving, cur


def cell_of(lat, lon):
    return f"{math.floor(lat / CELL)}:{math.floor(lon / CELL)}"


def local_dt(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, TPE)


def day_key(ts_ms):
    return local_dt(ts_ms).strftime("%Y%m%d")


def bucket_of(ts_ms):
    h = local_dt(ts_ms).hour
    if 4 <= h < 8:
        return "dawn"
    if 8 <= h < 17:
        return "day"
    if 17 <= h < 20:
        return "dusk"
    return "night"


def segment_cells(prev, cur):
    """回傳從 prev 到 cur 經過的格子（含 cur）。prev/cur 是 (ts_ms, lat, lon)。
    里程不在這裡算，見 step()。"""
    ts, lat, lon = cur
    if prev is None:
        return {cell_of(lat, lon)}
    pts, plat, plon = prev
    dist = haversine_m(plat, plon, lat, lon)
    dt_s = max(0.001, (ts - pts) / 1000)
    cells = {cell_of(lat, lon)}
    if dist / dt_s * 3.6 > MAX_SPEED_KMH:
        return cells
    if dt_s <= MAX_INTERP_GAP_S and dist <= MAX_INTERP_DIST_M:
        n = int(dist // INTERP_STEP_M)
        for i in range(1, n + 1):
            f = i / (n + 1)
            cells.add(cell_of(plat + (lat - plat) * f, plon + (lon - plon) * f))
    return cells
