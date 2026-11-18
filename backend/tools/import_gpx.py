"""把 GPX 匯入成某個帳號的全年足跡。

用法（在 backend/ 底下）：
    uv run python -m tools.import_gpx <檔案.gpx> --user wei [--reset]

寫入的 key：
    footprint:{uid}              Stream，ID = 時間戳，給 XRANGE 依時間查軌跡
    fog:{uid}:{YYYYMMDD}:{時段}   Set，那一天那個時段去過的格子
    fog:{uid}:all                Set，全部去過的格子
    footprint:{uid}:daykm        Hash，每天的里程
全部用 Pipeline 分批送出。
"""
import argparse
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime

import redis

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.redis_url import default_redis_url  # noqa: E402
from app.db import K  # noqa: E402
from app.geo import bucket_of, day_key, haversine_m, segment_cells, step  # noqa: E402

PT = re.compile(
    r'<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*>(.*?)</trkpt>', re.S)
ELE = re.compile(r"<ele>([-\d.]+)</ele>")
TIME = re.compile(r"<time>([^<]+)</time>")


def parse_gpx(path: str):
    text = open(path, encoding="utf-8").read()
    pts = []
    for m in PT.finditer(text):
        body = m.group(3)
        t = TIME.search(body)
        if not t:
            continue
        ts = int(datetime.fromisoformat(t.group(1).replace("Z", "+00:00")).timestamp() * 1000)
        e = ELE.search(body)
        pts.append((ts, float(m.group(1)), float(m.group(2)), float(e.group(1)) if e else 0.0))
    pts.sort()
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gpx")
    ap.add_argument("--user", required=True, help="騎跡帳號（要先註冊）")
    ap.add_argument("--reset", action="store_true", help="先清掉這個帳號原本的足跡")
    ap.add_argument("--redis", default=default_redis_url())
    a = ap.parse_args()

    r = redis.Redis.from_url(a.redis, decode_responses=True)
    uid = r.get(K.username(a.user.lower()))
    if not uid:
        sys.exit(f"找不到帳號 {a.user}，請先在網頁註冊")

    if a.reset:
        n = 0
        for key in [K.footprint(uid), K.daykm(uid), K.fog_all(uid), K.last(uid), K.fp_geo(uid)]:
            n += r.delete(key)
        for key in r.scan_iter(f"fog:{uid}:*", count=1000):
            n += r.delete(key)
        for key in r.scan_iter(f"cache:lines:{uid}:*", count=1000):
            r.delete(key)
        print(f"已清除 {n} 個舊 key")

    t0 = time.time()
    pts = parse_gpx(a.gpx)
    print(f"讀到 {len(pts):,} 個點，{time.time() - t0:.1f} 秒")

    fog = defaultdict(set)
    daykm = defaultdict(float)
    prev = anchor = None
    kept = skipped = 0
    pipe = r.pipeline(transaction=False)
    last_ts = None
    for ts, lat, lon, ele in pts:
        if ts == last_ts:
            continue
        if prev:
            gap_s = (ts - prev[0]) / 1000
            if gap_s < 3600 and haversine_m(prev[1], prev[2], lat, lon) / max(gap_s, 0.001) * 3.6 > 250:
                # 速度不合理（飛機、資料跳點）：不寫入，也不當作下一點的起點
                skipped += 1
                continue
        cells = segment_cells(prev, (ts, lat, lon))
        dist, _, anchor = step(anchor, (ts, lat, lon))
        day, b = day_key(ts), bucket_of(ts)
        fog[(day, b)] |= cells
        daykm[day] += dist / 1000
        pipe.xadd(K.footprint(uid), {"lat": f"{lat:.7f}", "lon": f"{lon:.7f}", "ele": f"{ele:.1f}"}, id=f"{ts}-*")
        pipe.geoadd(K.fp_geo(uid), [lon, lat, str(ts)])
        kept += 1
        prev = (ts, lat, lon)
        last_ts = ts
        if kept % 5000 == 0:
            pipe.execute(raise_on_error=False)
            pipe = r.pipeline(transaction=False)
            print(f"  已寫入 {kept:,} 點", end="\r")
    pipe.execute(raise_on_error=False)

    pipe = r.pipeline(transaction=False)
    all_cells = set()
    for (day, b), cells in fog.items():
        pipe.sadd(K.fog(uid, day, b), *cells)
        all_cells |= cells
    cl = list(all_cells)
    for i in range(0, len(cl), 5000):
        pipe.sadd(K.fog_all(uid), *cl[i:i + 5000])
    for day, km in daykm.items():
        pipe.hincrbyfloat(K.daykm(uid), day, round(km, 4))
    if prev:
        pipe.hset(K.last(uid), mapping={"ts": prev[0], "lat": prev[1], "lon": prev[2],
                                        "ats": anchor[0], "alat": anchor[1], "alon": anchor[2]})
    pipe.incr(K.fp_ver(uid))
    pipe.execute()

    print(f"\n完成：寫入 {kept:,} 點、略過 {skipped:,} 個不合理的點（飛機或跳點）")
    print(f"  {len(daykm)} 天有紀錄、{len(all_cells):,} 個迷霧格子、總里程 {sum(daykm.values()):,.0f} km")
    print(f"  Redis 記憶體：{r.info('memory')['used_memory_human']}，花費 {time.time() - t0:.1f} 秒")


if __name__ == "__main__":
    main()
