"""測速照相：地圖顯示（GEOSEARCH）、條件查詢（RediSearch）、資料同步狀態。資料由 tools/import_speedcam 匯入。"""
import re

from fastapi import APIRouter, Depends, Query

from .auth import current_uid
from .db import r

router = APIRouter(prefix="/api/speedcam")
FIELDS = ("city", "region", "addr", "direct", "bearing", "limit", "lon", "lat")


def cam_dict(cid: str, h: dict, dist_m: float | None = None) -> dict:
    out = {"id": cid, **{k: h.get(k) for k in FIELDS}}
    out["limit"] = int(out["limit"] or 0)
    out["lon"], out["lat"] = float(out["lon"]), float(out["lat"])
    out["bearing"] = int(out["bearing"]) if out.get("bearing") not in (None, "") else None
    if dist_m is not None:
        out["dist_m"] = round(dist_m)
    return out


@router.get("/near")
async def near(lon: float, lat: float, km: float = Query(3, gt=0, le=30), uid: str = Depends(current_uid)):
    """地圖上顯示畫面附近的測速點：GEOSEARCH 由近到遠，最多 200 個。"""
    res = await r.geosearch("poi:speedcam", longitude=lon, latitude=lat, radius=km, unit="km",
                            withdist=True, sort="ASC", count=200)
    async with r.pipeline(transaction=False) as p:
        for cid, _ in res:
            p.hgetall(f"speedcam:{cid}")
        rows = await p.execute()
    return [cam_dict(cid, h, float(d) * 1000) for (cid, d), h in zip(res, rows) if h]


def _clean(s: str) -> str:
    """把 RediSearch 查詢語法的特殊字元換成空白，避免使用者輸入破壞查詢。"""
    return re.sub(r"[@{}\[\]()|\-~*:\"'<>!%$^&=+;,./\\]", " ", s).strip()


@router.get("/search")
async def search(q: str = "", city: str = "", min_limit: int = 0, max_limit: int = 200,
                 lon: float | None = None, lat: float | None = None, km: float = Query(0, ge=0, le=300),
                 uid: str = Depends(current_uid)):
    """RediSearch 條件查詢，例如：南投縣、速限 40～60、地址含「臺14」、我附近 20 km 內。
    SQL 要做到中文地址全文＋數值範圍＋地理範圍，通常得另外裝全文檢索和 GIS 擴充。"""
    parts = []
    words = _clean(q.replace("台", "臺"))
    if words:
        parts.append(" ".join(words.split()))
    if city.strip():
        parts.append("@city:{%s}" % _clean(city.replace("台", "臺")).replace(" ", "\\ "))
    if min_limit > 0 or max_limit < 200:
        parts.append(f"@limit:[{min_limit} {max_limit}]")
    if lon is not None and lat is not None and km > 0:
        parts.append(f"@loc:[{lon} {lat} {km} km]")
    query = " ".join(parts) or "*"
    res = await r.execute_command("FT.SEARCH", "idx:speedcam", query, "LIMIT", 0, 50, "SORTBY", "limit", "ASC",
                                  "DIALECT", 2)
    total, items = _parse(res)
    return {"query": query, "total": total, "items": [cam_dict(k.split(":", 1)[1], h) for k, h in items]}


def _parse(res):
    """FT.SEARCH 的回傳在 RESP2／RESP3 格式不同，兩種都處理。"""
    if isinstance(res, dict):  # RESP3
        return res.get("total_results", 0), [(x["id"], x.get("extra_attributes", {})) for x in res.get("results", [])]
    total, rest = res[0], res[1:]
    items = []
    for i in range(0, len(rest), 2):
        flat = rest[i + 1]
        items.append((rest[i], dict(zip(flat[::2], flat[1::2]))))
    return total, items


@router.get("/meta")
async def meta(uid: str = Depends(current_uid)):
    m = await r.hgetall("meta:speedcam")
    return {"source": m.get("source"), "count": int(m.get("count", 0)), "updated": int(m.get("updated", 0))}
