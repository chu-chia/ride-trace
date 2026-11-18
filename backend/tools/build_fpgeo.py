"""把現有的足跡 Stream 補進 footprint:{uid}:geo（熱力圖放大用），只需要跑一次；之後 ingest／import_gpx 會自己寫。

    uv run python -m tools.build_fpgeo
"""
import time

import redis

from app.redis_url import default_redis_url


def main():
    r = redis.Redis.from_url(default_redis_url(), decode_responses=True)
    t0 = time.time()
    for key in r.scan_iter("footprint:*", count=1000, _type="stream"):
        uid = key.split(":")[1]
        geo = f"footprint:{uid}:geo"
        r.delete(geo)
        n, cursor = 0, "-"
        while True:
            rows = r.xrange(key, min=cursor, count=10_000)
            if not rows:
                break
            p = r.pipeline(transaction=False)
            for rid, f in rows:
                try:
                    p.geoadd(geo, [float(f["lon"]), float(f["lat"]), rid.split("-")[0]])
                except (KeyError, ValueError):
                    continue
            p.execute(raise_on_error=False)
            n += len(rows)
            ms, seq = rows[-1][0].split("-")
            cursor = f"{ms}-{int(seq) + 1}"
            if len(rows) < 10_000:
                break
        print(f"uid {uid}：{n:,} 點 → {r.zcard(geo):,} 個 GEO 成員")
    print(f"完成，{time.time() - t0:.1f} 秒")


if __name__ == "__main__":
    main()
