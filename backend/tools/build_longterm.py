"""用全年足跡一次算出熱力圖與點亮的鄉鎮（之後由 worker 即時更新）。

    uv run python -m tools.build_longterm --user wei --reset
"""
import argparse
import os
import time
from collections import Counter

import redis

from app.geo import CELL, cell_of
from app.redis_url import default_redis_url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--redis", default=default_redis_url())
    a = ap.parse_args()
    r = redis.Redis.from_url(a.redis, decode_responses=True)
    uid = r.get(f"username:{a.user}")
    if not uid:
        raise SystemExit(f"找不到使用者 {a.user}")
    if a.reset:
        r.delete(f"heat:{uid}", f"user:{uid}:towns", f"user:{uid}:townfirst")
    t0 = time.time()
    counts, first = Counter(), {}
    last = "-"
    while True:
        batch = r.xrange(f"footprint:{uid}", min=last, max="+", count=20000)
        if last != "-":
            batch = batch[1:]
        if not batch:
            break
        for sid, f in batch:
            ts = int(sid.split("-")[0])
            c = cell_of(float(f["lat"]), float(f["lon"]))
            counts[c] += 1
            first.setdefault(c, ts)
        last = batch[-1][0]
    print(f"足跡 {sum(counts.values())} 點、{len(counts)} 個格子，{time.time() - t0:.0f} 秒")

    # 熱力圖：ZINCRBY（Pipeline 每 5000 筆送一次）
    p = r.pipeline(transaction=False)
    for i, (c, n) in enumerate(counts.items(), 1):
        p.zincrby(f"heat:{uid}", n, c)
        if i % 5000 == 0:
            p.execute()
    p.execute()

    # 鄉鎮：每個格子中心點查 GEOSHAPE（有快取的跳過）
    cells = list(counts)
    cached = r.hmget("celltown", cells) if cells else []
    todo = [c for c, v in zip(cells, cached) if v is None]
    for s in range(0, len(todo), 1000):
        chunk = todo[s:s + 1000]
        q = r.pipeline(transaction=False)
        for c in chunk:
            a_, b_ = c.split(":")
            lat, lon = (int(a_) + 0.5) * CELL, (int(b_) + 0.5) * CELL
            q.execute_command("FT.SEARCH", "idx:townshape", "@shape:[CONTAINS $pt]", "PARAMS", 2, "pt",
                              f"POINT({lon:.6f} {lat:.6f})", "RETURN", 1, "code", "LIMIT", 0, 1, "DIALECT", 3)
        res = q.execute()
        w = r.pipeline(transaction=False)
        for c, x in zip(chunk, res):
            if isinstance(x, dict):  # RESP3
                rows = x.get("results", [])
                code = rows[0]["id"].split(":")[1] if rows else "-"
            else:
                code = x[1].split(":")[1] if x and x[0] else "-"
            w.hset("celltown", c, code)
        w.execute()
    town_of = dict(zip(cells, r.hmget("celltown", cells)))
    town_first = {}
    for c in cells:
        code = town_of.get(c)
        if code and code != "-":
            town_first[code] = min(town_first.get(code, first[c]), first[c])
    if town_first:
        r.sadd(f"user:{uid}:towns", *town_first)
        r.hset(f"user:{uid}:townfirst", mapping=town_first)
    total = r.scard("towns:all")
    print(f"點亮 {len(town_first)} / {total} 個鄉鎮（查了 {len(todo)} 個格子），{time.time() - t0:.0f} 秒")


if __name__ == "__main__":
    main()
