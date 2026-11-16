"""地理計算：距離、迷霧格子、時段分類。匯入工具和即時回報共用。"""
import math
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))
CELL = 0.0015            # 迷霧格子大小（度），約 150～170 公尺
INTERP_STEP_M = 80       # 兩點之間每 80 公尺補一個格子，避免沿路出現斷點
MAX_INTERP_GAP_S = 180   # 兩點相隔超過 3 分鐘就不補（可能是斷訊或搭車）
MAX_INTERP_DIST_M = 3000
MAX_SPEED_KMH = 250      # 超過視為飛機或資料跳點

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
    第二個回傳值是這段要算進里程的公尺數（跳點或飛機回傳 0）。"""
    ts, lat, lon = cur
    if prev is None:
        return {cell_of(lat, lon)}, 0.0
    pts, plat, plon = prev
    dist = haversine_m(plat, plon, lat, lon)
    dt_s = max(0.001, (ts - pts) / 1000)
    if dist / dt_s * 3.6 > MAX_SPEED_KMH:
        return {cell_of(lat, lon)}, 0.0
    cells = {cell_of(lat, lon)}
    if dt_s <= MAX_INTERP_GAP_S and dist <= MAX_INTERP_DIST_M:
        n = int(dist // INTERP_STEP_M)
        for i in range(1, n + 1):
            f = i / (n + 1)
            cells.add(cell_of(plat + (lat - plat) * f, plon + (lon - plon) * f))
        return cells, dist
    # 間隔太久：只記這個點，里程仍然算進去（例如休息後換地方）
    return cells, dist if dt_s <= 3600 else 0.0
