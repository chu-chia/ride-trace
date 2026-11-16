"""個人騎乘速度（依道路類別）：tools/pace_profile 從全年足跡算出來寫進 TimeSeries，這裡讀出來修正預估時間。"""
import time

from fastapi import APIRouter, Depends

from .auth import current_uid
from .db import r

router = APIRouter(prefix="/api/me")
URBAN_DENSITY = 8
CAT_NAME = {"expressway": "快速道路", "primary": "省道等主要道路", "secondary": "縣道等次要道路", "local": "一般道路"}
_cache: dict[str, tuple[float, dict]] = {}


CURVY_WINDOW_M = 750   # 前後各 750 m（共約 1.5 km）
CURVY_RATIO = 1.3      # 路徑長／直線距離 超過 1.3 算彎路（山路髮夾彎、產業道路）


def category(edge: dict, curvy: bool = False) -> str:
    """道路類別＝道路等級 × 市區／郊區 × 是否彎路。彎路分開算，山路才不會被平地省道的速度稀釋。"""
    rc = edge.get("road_class", "other")
    group = ("expressway" if rc in ("motorway", "trunk") else "primary" if rc == "primary"
             else "secondary" if rc in ("secondary", "tertiary") else "local")
    return f"{group}_{'urban' if edge.get('density', 0) >= URBAN_DENSITY else 'rural'}{'_curvy' if curvy else ''}"


def curvy_flags(latlon: list[tuple[float, float]]) -> list[bool]:
    """每個點：前後各約 750 m 的路徑長度 ÷ 兩端直線距離 > 1.3 就算彎路。"""
    from .geo import haversine_m
    n = len(latlon)
    cum = [0.0]
    for a, b in zip(latlon, latlon[1:]):
        cum.append(cum[-1] + haversine_m(a[0], a[1], b[0], b[1]))
    out, lo, hi = [], 0, 0
    for i in range(n):
        while cum[i] - cum[lo] > CURVY_WINDOW_M:
            lo += 1
        hi = max(hi, i)
        while hi + 1 < n and cum[hi + 1] - cum[i] <= CURVY_WINDOW_M:
            hi += 1
        path = cum[hi] - cum[lo]
        straight = haversine_m(latlon[lo][0], latlon[lo][1], latlon[hi][0], latlon[hi][1])
        out.append(path > 400 and straight > 0 and path / straight > CURVY_RATIO)
    return out


async def _sum_by_cat(uid: str, kind: str, since_ms: int | str = "-") -> dict[str, float]:
    """TS.MRANGE＋GROUPBY cat REDUCE sum：Redis 把同一類的所有趟加總；AGGREGATION 用超大 bucket 收成一個值。"""
    res = await r.execute_command("TS.MRANGE", since_ms, "+", "AGGREGATION", "sum", 10 ** 13,
                                  "FILTER", "metric=pace", f"uid={uid}", f"kind={kind}", "GROUPBY", "cat", "REDUCE", "sum")
    out = {}
    if isinstance(res, dict):  # RESP3
        items = [(k, v[-1] if isinstance(v, (list, tuple)) else v.get("samples", [])) for k, v in res.items()]
    else:
        items = [(row[0], row[2]) for row in res]
    for key, samples in items:
        cat = key.split("=", 1)[1] if "=" in key else key
        out[cat] = sum(float(s[1]) for s in samples)
    return out


async def get_pace(uid: str) -> dict[str, dict]:
    """回傳 {類別: {km, kmh}}，60 秒快取。"""
    hit = _cache.get(uid)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    try:
        m, s = await _sum_by_cat(uid, "m"), await _sum_by_cat(uid, "s")
    except Exception:  # noqa: BLE001  還沒算過（沒有任何 series）
        m, s = {}, {}
    pace = {c: {"km": round(m[c] / 1000, 1), "kmh": round(m[c] / s[c] * 3.6, 1)} for c in m if s.get(c)}
    if pace:
        tm, ts = sum(m.values()), sum(s.values())
        pace["all"] = {"km": round(tm / 1000, 1), "kmh": round(tm / ts * 3.6, 1)}
    _cache[uid] = (time.time(), pace)
    return pace


def kmh_for(pace: dict, cat: str, fallback: float) -> float:
    """資料夠（≥ 5 km）就用該類；不夠就放寬：同道路＋同彎直（不分市郊）→ 同道路 → 全部平均 → Valhalla 的速度。
    平均用「總距離 ÷ 總時間」，不是各類速度直接平均。"""
    if cat in pace and pace[cat]["km"] >= 5:
        return pace[cat]["kmh"]
    group, curvy = cat.split("_")[0], cat.endswith("_curvy")
    for pick in (lambda k: k.startswith(group + "_") and k.endswith("_curvy") == curvy,
                 lambda k: k.startswith(group + "_")):
        same = [v for k, v in pace.items() if k != "all" and pick(k)]
        km = sum(v["km"] for v in same)
        if km >= 5:
            return km / sum(v["km"] / v["kmh"] for v in same)
    return pace["all"]["kmh"] if "all" in pace else fallback


@router.get("/pace")
async def my_pace(uid: str = Depends(current_uid)):
    pace = await get_pace(uid)
    rows = []
    for cat, v in sorted(pace.items(), key=lambda x: -x[1]["km"]):
        if cat == "all":
            continue
        g, u, *c = cat.split("_")
        rows.append({"cat": cat, "name": f"{CAT_NAME.get(g, g)}（{'市區' if u == 'urban' else '郊區'}{'・彎路' if c else ''}）", **v})
    return {"overall": pace.get("all"), "rows": rows}
