"""已結束行程的統計補算：用整條軌跡重算每個人的里程／移動時間／極速（跟回放摘要同一個 summarize）。

新行程在每個人結束紀錄時就會自動重算（replay.finalize_stats）；這支工具給改版前就結束的舊行程。

    uv run python -m tools.recompute_stats            # 只列出前後對照，不寫入
    uv run python -m tools.recompute_stats --apply    # 寫入，並清掉回放快取
    uv run python -m tools.recompute_stats --trip 62 --apply
"""
import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import replay  # noqa: E402
from app.db import K, r  # noqa: E402


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trip", action="append", help="只算這幾個行程（可重複）；預設全部已結束的")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    tids = a.trip or sorted({k.split(":")[1] async for k in r.scan_iter("trip:*", count=1000)
                             if k.count(":") == 1 and k.split(":")[1].isdigit()}, key=int)
    for tid in tids:
        if await r.hget(K.trip(tid), "status") != "ended":
            continue
        name = await r.hget(K.trip(tid), "name")
        print(f"#{tid} {name}")
        for uid in sorted(await r.smembers(K.members(tid)), key=int):
            pts = await replay._points(tid, uid)
            if not pts:
                continue
            old = await r.hmget(K.stats(tid, uid), "km", "moving_s", "max_kmh")
            s = replay.summarize(pts)
            nick = await r.hget(K.user(uid), "nickname")
            f = lambda v, d=2: "–" if v is None else f"{float(v):.{d}f}"
            print(f"  {nick:12s} 里程 {f(old[0])} → {s['km']:.2f} km   移動 {f(old[1], 0)} → {s['moving_ms'] / 1000:.0f} s   極速 {f(old[2], 1)} → {s['max_kmh']:.1f} km/h")
            if a.apply:
                await replay.finalize_stats(tid, uid)
        if a.apply:
            await r.delete(f"cache:replay:{tid}")
    if not a.apply:
        print("\n（只是預覽，加 --apply 才會寫入）")


if __name__ == "__main__":
    asyncio.run(main())
