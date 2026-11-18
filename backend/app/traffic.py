"""前方路況（規格 4.4、6.3）：交通部 TDX「省道即時性道路事件」（施工、事故、管制、落石、活動…）。

TDX 每月只有 3 點（基礎服務 1,500 次／點），所以用 cache-aside：
需要時才查 Redis，資料過期才去 TDX 抓一次全台資料，騎乘中的「前方有沒有事件」都在 Redis 裡判斷，
GPS 不會送到外部服務。沒有進行中的行程、也沒人打開規劃頁時，完全不呼叫 TDX。

Redis：
- cache:tdx:token     String＋TTL：OAuth token（client credentials，24 小時，提早 10 分鐘過期）
- cache:tdx:roadev    String＋TTL 120 秒：資料還新鮮的旗標；過期才再打 TDX
- lock:tdx:roadev     SET NX EX 30：快取剛過期時多個 worker 同時發現，只讓一個去抓（防 cache stampede）
- tdx:roadev:geo      GEO：事件位置
- tdx:roadev:info     Hash：事件 ID → JSON（標題、說明、道路、類型、時間）
                      重建時先寫暫存 key，再用 MULTI＋RENAME 一次換上，讀的人不會讀到一半的資料
- tdx:usage           Hash：YYYY-MM → 本月呼叫次數（後台顯示用量）
- meta:tdx            Hash：來源、筆數、更新時間（後台「外部資料同步」）
"""
import json
import logging
import os
import re
import time

import httpx

from .db import r

log = logging.getLogger("qiji.traffic")

CLIENT_ID = os.environ.get("TDX_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("TDX_CLIENT_SECRET", "")
TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
LIVE_URL = "https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/Highway"  # TDX 的 Highway＝省道

# FAKE_EXTERNAL=1：不呼叫 TDX（每月只有 3 點），改用幾筆固定的模擬事件（Demo、開發用）
FAKE = os.environ.get("FAKE_EXTERNAL", "") == "1"
FAKE_EVENTS = [  # (ID, 經度, 緯度, 道路, 類型, 標題, 說明)
    ("FAKE-1", 121.4953, 24.1825, "台8線", 6, "落石", "天祥附近落石，單線通行"),
    ("FAKE-2", 121.3095, 24.1745, "台8線", 2, "道路施工", "大禹嶺路段施工，交通管制"),
    ("FAKE-3", 121.2763, 24.1372, "台14甲線", 5, "濃霧", "武嶺一帶濃霧，能見度低"),
    ("FAKE-4", 121.1580, 24.0230, "台14線", 2, "道路施工", "霧社路段路面整修"),
    ("FAKE-5", 121.7110, 24.9370, "台9線", 4, "交通管制", "北宜公路坪林段假日管制"),
    ("FAKE-6", 120.9930, 23.2450, "台20線", 4, "交通管制", "南橫向陽路段夜間封閉"),
]

FRESH_S = 120          # 來源每 5 分鐘更新，2 分鐘快取已經夠即時
FAIL_COOLDOWN_S = 60   # 抓失敗也冷卻一下，避免一直重打
TOKEN, FRESH, LOCK = "cache:tdx:token", "cache:tdx:roadev", "lock:tdx:roadev"
GEO, INFO, USAGE, META = "tdx:roadev:geo", "tdx:roadev:info", "tdx:usage", "meta:tdx"

# TDX EventType（依實際資料觀察）
TYPE_NAME = {1: "交通事故", 2: "施工", 3: "壅塞", 4: "管制", 5: "天候", 6: "災害", 7: "活動", 8: "異常告警"}
POINT_RE = re.compile(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)")


def enabled() -> bool:
    return FAKE or bool(CLIENT_ID and CLIENT_SECRET)


async def _load_fake():
    async with r.pipeline(transaction=True) as p:
        p.delete(GEO, INFO)
        for eid, lon, lat, road, typ, title, desc in FAKE_EVENTS:
            p.geoadd(GEO, (lon, lat, eid))
            p.hset(INFO, eid, json.dumps({"id": eid, "lon": lon, "lat": lat, "type": typ, "type_name": TYPE_NAME[typ],
                                          "title": title, "desc": f"{desc}（模擬資料）", "road": road, "dir": "",
                                          "start": None, "updated": None, "source": "模擬資料"}, ensure_ascii=False))
        p.hset(META, mapping={"source": "模擬資料（FAKE_EXTERNAL=1，不呼叫 TDX）", "count": len(FAKE_EVENTS),
                              "updated": int(time.time() * 1000)})
        p.set(FRESH, 1, ex=3600)
        await p.execute()


async def _count_call():
    await r.hincrby(USAGE, time.strftime("%Y-%m"), 1)


async def _token(c: httpx.AsyncClient) -> str:
    tok = await r.get(TOKEN)
    if tok:
        return tok
    resp = await c.post(TOKEN_URL, data={"grant_type": "client_credentials", "client_id": CLIENT_ID,
                                         "client_secret": CLIENT_SECRET})
    resp.raise_for_status()
    d = resp.json()
    await r.set(TOKEN, d["access_token"], ex=max(60, int(d.get("expires_in", 3600)) - 600))
    return d["access_token"]


def _parse(e: dict) -> dict | None:
    m = POINT_RE.search(e.get("Positions") or "")
    if not m:
        return None
    lon, lat = float(m.group(1)), float(m.group(2))
    if 20 <= lon <= 27 and 118 <= lat <= 123:  # 來源偶爾把經緯度寫反（POINT (24.65 120.80)）
        lon, lat = lat, lon
    if not (118 <= lon <= 123 and 20 <= lat <= 27):
        return None
    loc = next(iter((e.get("Location") or {}).values()), {}) or {}
    # 里程換算失敗的事件會被放在公路起點（台1線 0K＝臺北車站前）；里程明明在很遠的地方就是座標錯了，略過
    km = re.match(r"(\d+)K", loc.get("StartKM") or "")
    if abs(lon - 121.5150) < 0.003 and abs(lat - 25.0469) < 0.003 and (not km or int(km.group(1)) > 3):
        return None
    return {
        "id": e["EventID"], "lon": lon, "lat": lat,
        "type": e.get("EventType"), "type_name": TYPE_NAME.get(e.get("EventType"), "路況"),
        "title": e.get("EventTitle") or TYPE_NAME.get(e.get("EventType"), "路況"),
        "desc": (e.get("Description") or "").strip(), "road": loc.get("Road", ""),
        "dir": loc.get("Direction", ""), "start": e.get("EffectiveTime"), "updated": e.get("LastUpdateTime"),
        "source": e.get("Source", ""),
    }


async def refresh():
    """抓全台省道即時事件，重建 GEO＋Hash。"""
    async with httpx.AsyncClient(timeout=20) as c:
        tok = await _token(c)
        resp = await c.get(LIVE_URL, params={"$format": "JSON"}, headers={"authorization": f"Bearer {tok}"})
        await _count_call()
        if resp.status_code == 401:  # token 被撤銷或過期：清掉，下次重拿
            await r.delete(TOKEN)
        resp.raise_for_status()
        raw = resp.json().get("LiveEvents") or []
    items = [x for x in map(_parse, raw) if x]
    tmp_geo, tmp_info = f"{GEO}:tmp", f"{INFO}:tmp"
    async with r.pipeline(transaction=False) as p:
        p.delete(tmp_geo, tmp_info)
        for x in items:
            p.geoadd(tmp_geo, (x["lon"], x["lat"], x["id"]))
            p.hset(tmp_info, x["id"], json.dumps(x, ensure_ascii=False))
        await p.execute()
    async with r.pipeline(transaction=True) as p:  # MULTI/EXEC：兩個 key 一起換上
        if items:
            p.rename(tmp_geo, GEO)
            p.rename(tmp_info, INFO)
        else:
            p.delete(GEO, INFO)
        p.hset(META, mapping={"source": "交通部 TDX 省道即時性道路事件", "count": len(items),
                              "updated": int(time.time() * 1000)})
        await p.execute()
    log.info("TDX 省道即時事件更新：%d 筆", len(items))
    return len(items)


async def ensure_fresh() -> bool:
    """cache-aside：快取還新鮮直接用；過期就搶鎖，搶到的去抓，沒搶到的先用舊資料。"""
    if not enabled():
        return False
    if await r.exists(FRESH):
        return True
    if FAKE:
        await _load_fake()
        return True
    if not await r.set(LOCK, 1, nx=True, ex=30):
        return bool(await r.exists(GEO))
    try:
        await refresh()
        await r.set(FRESH, 1, ex=FRESH_S)
    except Exception as e:  # noqa: BLE001
        log.warning("TDX 抓取失敗：%r", e)
        await r.set(FRESH, 1, ex=FAIL_COOLDOWN_S)
    finally:
        await r.delete(LOCK)
    return bool(await r.exists(GEO))


async def near(lon: float, lat: float, radius_m: float, count: int = 20) -> list[tuple[dict, float]]:
    hits = await r.geosearch(GEO, longitude=lon, latitude=lat, radius=radius_m, unit="m", withdist=True,
                             sort="ASC", count=count)
    if not hits:
        return []
    infos = await r.hmget(INFO, [h[0] for h in hits])
    return [(json.loads(i), float(d)) for (_, d), i in zip(hits, infos) if i]


def short(x: dict, n: int = 70) -> str:
    d = re.sub(r"\s+", " ", x["desc"])
    return d if len(d) <= n else d[:n] + "…"
