"""系統狀態：Worker（consumer group）的消費進度，給展示和除錯用。"""
from fastapi import APIRouter, Depends

from .auth import current_uid
from .db import K, r

router = APIRouter(prefix="/api/system")


@router.get("/streams")
async def streams(uid: str = Depends(current_uid)):
    """XINFO GROUPS／CONSUMERS＋XPENDING：每個 group 讀到哪、落後幾筆、還沒 ACK 的有幾筆。"""
    info = await r.xinfo_stream(K.ingest)
    groups = []
    for g in await r.xinfo_groups(K.ingest):
        consumers = await r.xinfo_consumers(K.ingest, g["name"])
        groups.append({
            "name": g["name"],
            "last_delivered": g["last-delivered-id"],
            "lag": g.get("lag"),
            "pending": g["pending"],
            "consumers": [{"name": c["name"], "pending": c["pending"], "idle_ms": c["idle"]} for c in consumers],
        })
    return {"stream": K.ingest, "length": info["length"], "last_id": info["last-generated-id"], "groups": groups}
