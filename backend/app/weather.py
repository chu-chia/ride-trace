"""天氣（規格 4.4「前方路段預報降雨」）：中央氣象署「臺灣各縣市鄉鎮未來 3 天天氣預報」的 3 小時降雨機率。

隱私：先在本機用 GEOSHAPE（idx:townshape）查出點在哪個鄉鎮，只向氣象署要「整個縣市」的預報，不送座標。

Redis：
- cache:cwa:{縣市}    String＋TTL 30 分鐘：該縣市各鄉鎮的降雨機率 {鄉鎮: [[開始ms, 結束ms, 機率], …]}
                      cache-aside：過期才去氣象署抓；同一縣市一次抓回所有鄉鎮
- lock:cwa:{縣市}     SET NX EX 20：同時過期時只讓一個人去抓
- cwa:usage           Hash：YYYY-MM → 本月呼叫次數
- meta:cwa            Hash：來源、更新時間（後台「外部資料同步」）
- celltown            Hash：格子 → 鄉鎮（和點亮鄉鎮共用的快取）
"""
import json
import logging
import os
import time
import zlib
from datetime import datetime, timedelta, timezone

import httpx

from .db import r
from .geo import cell_of
from .longterm import town_of_cell

log = logging.getLogger("qiji.weather")

API_KEY = os.environ.get("CWA_API_KEY", "")
# FAKE_EXTERNAL=1：不呼叫氣象署（有次數限制），改用固定規則產生的模擬預報（Demo、開發用）
FAKE = os.environ.get("FAKE_EXTERNAL", "") == "1"
URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-{id}"
# 各縣市「未來 3 天」鄉鎮預報的資料集代號（逐一實測確認過）
DATASET = {
    "宜蘭縣": "001", "桃園市": "005", "新竹縣": "009", "苗栗縣": "013", "彰化縣": "017", "南投縣": "021",
    "雲林縣": "025", "嘉義縣": "029", "屏東縣": "033", "臺東縣": "037", "花蓮縣": "041", "澎湖縣": "045",
    "基隆市": "049", "新竹市": "053", "嘉義市": "057", "臺北市": "061", "高雄市": "065", "新北市": "069",
    "臺中市": "073", "臺南市": "077", "連江縣": "081", "金門縣": "085",
}
CACHE_S = 1800
RAIN_POP = 60          # 降雨機率 ≥ 60% 才提醒
USAGE, META = "cwa:usage", "meta:cwa"
TW = timezone(timedelta(hours=8))  # 容器是 UTC；台灣沒有日光節約，固定 +8


def tw(ms: int, fmt: str = "%H:%M") -> str:
    return datetime.fromtimestamp(ms / 1000, TW).strftime(fmt)


def enabled() -> bool:
    return FAKE or bool(API_KEY)


_TOWNS: dict[str, list[str]] = {}


async def _fake(county: str) -> dict:
    """模擬預報：每個鄉鎮、每個 3 小時時段用名稱算一個固定的降雨機率（約兩成時段 ≥ 60%，會觸發前方降雨提醒）。"""
    if not _TOWNS:
        ids = list(await r.smembers("towns:all"))
        async with r.pipeline(transaction=False) as p:
            for i in ids:
                p.hmget(f"town:{i}", "name", "county")
            for name, c in await p.execute():
                if name and c:
                    _TOWNS.setdefault(c, []).append(name)
    block = 3 * 3600_000
    now = int(time.time() * 1000)
    start = (now + 8 * 3600_000) // block * block - 8 * 3600_000  # 台灣時間 0、3、6…點對齊
    out = {}
    for town in _TOWNS.get(county, []):
        rows = []
        for k in range(24):
            s0 = start + k * block
            h = zlib.crc32(f"{county}{town}{s0 // block}".encode())
            rows.append([s0, s0 + block, [0, 10, 10, 20, 20, 30, 30, 40, 70, 80][h % 10]])
        out[town] = rows
    return out


def _ms(s: str) -> int:
    return int(datetime.fromisoformat(s).timestamp() * 1000)


async def _fetch(county: str) -> dict:
    async with httpx.AsyncClient(timeout=20) as c:
        resp = await c.get(URL.format(id=DATASET[county]),
                           params={"Authorization": API_KEY, "format": "JSON", "ElementName": "3小時降雨機率"})
    await r.hincrby(USAGE, time.strftime("%Y-%m"), 1)
    resp.raise_for_status()
    out = {}
    for loc in resp.json()["records"]["Locations"][0]["Location"]:
        rows = []
        for we in loc["WeatherElement"]:
            for t in we["Time"]:
                v = (t.get("ElementValue") or [{}])[0].get("ProbabilityOfPrecipitation")
                if v not in (None, "", "-"):
                    rows.append([_ms(t["StartTime"]), _ms(t["EndTime"]), int(v)])
        out[loc["LocationName"]] = rows
    await r.hset(META, mapping={"source": "中央氣象署 鄉鎮 3 天預報（3 小時降雨機率）", "updated": int(time.time() * 1000)})
    await r.hincrby(META, "fetches", 1)
    return out


async def county_forecast(county: str) -> dict | None:
    """cache-aside：快取有就用；沒有就搶鎖去抓，沒搶到的這次先不判斷（下次再來）。"""
    if not enabled() or county not in DATASET:
        return None
    if FAKE:
        return await _fake(county)
    key = f"cache:cwa:{county}"
    hit = await r.get(key)
    if hit:
        return json.loads(hit)
    if not await r.set(f"lock:cwa:{county}", 1, nx=True, ex=20):
        return None
    try:
        data = await _fetch(county)
        await r.set(key, json.dumps(data, ensure_ascii=False), ex=CACHE_S)
        return data
    except Exception as e:  # noqa: BLE001
        log.warning("氣象署 %s 抓取失敗：%r", county, e)
        return None
    finally:
        await r.delete(f"lock:cwa:{county}")


async def town_at(lat: float, lon: float) -> tuple[str, str] | None:
    """(縣市, 鄉鎮)；用本機 GEOSHAPE＋格子快取。"""
    code = await town_of_cell(cell_of(lat, lon))
    if not code:
        return None
    name, county = await r.hmget(f"town:{code}", "name", "county")
    return (county, name) if name and county else None


async def rain_at(lat: float, lon: float, when_ms: int) -> dict | None:
    """這個位置在這個時間的降雨機率：{county, town, pop, start, end}。"""
    t = await town_at(lat, lon)
    if not t:
        return None
    fc = await county_forecast(t[0])
    rows = (fc or {}).get(t[1])
    if not rows:
        return None
    for s, e, pop in rows:
        if s <= when_ms < e:
            return {"county": t[0], "town": t[1], "pop": pop, "start": s, "end": e, "fake": FAKE}
    return None
