"""集合點／休息點：所有成員都能新增、修改、刪除（規格第 6 輪決定）。

Redis：
- trip:{id}:waypoints        GEO，member 是集合點 ID → Worker 用 GEOSEARCH 找「我附近有哪些集合點」
- trip:{id}:wp:{wid}         Hash：名稱、種類、半徑、座標、建立者
- trip:{id}:arrived:{wid}    Set：已經抵達的人（抵達通知只發一次）
- trip:{id}:allin:{wid}      全員到齊的旗標（只發一次）
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import events
from .auth import current_uid
from .db import K, r
from .trips import require_member

router = APIRouter(prefix="/api/trips")
KINDS = {"meet": "集合點", "rest": "休息點"}


class WaypointIn(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    kind: str = "meet"
    radius_m: int = Field(150, ge=30, le=2000)


class WaypointPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=30)
    lat: float | None = Field(None, ge=-90, le=90)
    lon: float | None = Field(None, ge=-180, le=180)
    kind: str | None = None
    radius_m: int | None = Field(None, ge=30, le=2000)


async def list_waypoints(tid: str) -> list[dict]:
    ids = sorted(await r.zrange(K.waypoints(tid), 0, -1), key=int)  # GEO 依 geohash 排序，改回建立順序
    live = await r.hget(K.trip(tid), "status") == "live"
    # 進行中：要等「還在騎的人」到齊；結束後：顯示「全部成員」裡有幾個到過
    total = await r.scard(K.active(tid) if live else K.members(tid))
    out = []
    for wid in ids:
        async with r.pipeline(transaction=False) as p:
            p.hgetall(K.wp(tid, wid))
            p.smembers(K.arrived(tid, wid))
            p.exists(K.allin(tid, wid))
            w, arrived, all_in = await p.execute()
        if not w:
            continue
        out.append({"id": wid, "name": w["name"], "kind": w.get("kind", "meet"), "radius_m": int(w.get("radius_m", 150)),
                    "lat": float(w["lat"]), "lon": float(w["lon"]), "by": w.get("by"),
                    "arrived": sorted(arrived, key=int), "total": total, "all_in": bool(all_in)})
    return out


async def broadcast(tid: str):
    await events.publish(tid, {"kind": "waypoints", "items": await list_waypoints(tid)})


@router.get("/{tid}/waypoints")
async def get_waypoints(tid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    return await list_waypoints(tid)


@router.post("/{tid}/waypoints")
async def add_waypoint(tid: str, body: WaypointIn, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    if body.kind not in KINDS:
        raise HTTPException(400, "種類只能是 meet 或 rest")
    wid = str(await r.incr(f"seq:wp:{tid}"))
    async with r.pipeline(transaction=True) as p:
        p.hset(K.wp(tid, wid), mapping={"name": body.name.strip(), "kind": body.kind, "radius_m": body.radius_m,
                                        "lat": body.lat, "lon": body.lon, "by": uid})
        p.geoadd(K.waypoints(tid), [body.lon, body.lat, wid])
        await p.execute()
    await events.emit(tid, "waypoint", uid, f"新增{KINDS[body.kind]}「{body.name.strip()}」", wid=wid)
    await broadcast(tid)
    return {"id": wid}


@router.patch("/{tid}/waypoints/{wid}")
async def edit_waypoint(tid: str, wid: str, body: WaypointPatch, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    w = await r.hgetall(K.wp(tid, wid))
    if not w:
        raise HTTPException(404, "找不到這個集合點")
    patch = body.model_dump(exclude_none=True)
    if "kind" in patch and patch["kind"] not in KINDS:
        raise HTTPException(400, "種類只能是 meet 或 rest")
    moved = "lat" in patch or "lon" in patch
    async with r.pipeline(transaction=True) as p:
        if patch:
            p.hset(K.wp(tid, wid), mapping=patch)
        if moved:
            lat, lon = patch.get("lat", float(w["lat"])), patch.get("lon", float(w["lon"]))
            p.geoadd(K.waypoints(tid), [lon, lat, wid])
            # 換位置後重新計算誰抵達
            p.delete(K.arrived(tid, wid), K.allin(tid, wid))
        await p.execute()
    await broadcast(tid)
    return {"ok": True}


@router.delete("/{tid}/waypoints/{wid}")
async def delete_waypoint(tid: str, wid: str, uid: str = Depends(current_uid)):
    await require_member(tid, uid)
    name = await r.hget(K.wp(tid, wid), "name")
    if name is None:
        raise HTTPException(404, "找不到這個集合點")
    async with r.pipeline(transaction=True) as p:
        p.zrem(K.waypoints(tid), wid)
        p.delete(K.wp(tid, wid), K.arrived(tid, wid), K.allin(tid, wid))
        await p.execute()
    await events.emit(tid, "waypoint", uid, f"刪除「{name}」")
    await broadcast(tid)
    return {"ok": True}

