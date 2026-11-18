"""從全年足跡算出「我在各種道路的實際平均速度」，規劃頁用來修正 Valhalla 太樂觀的預估時間。
地圖比對用本機 Valhalla（trace_attributes），位置資料不送到外部服務。

    uv run python -m tools.pace_profile --user wei --reset

做法：
1. XRANGE footprint:{uid} 讀出全年 GPS 點，間隔超過 5 分鐘就切成不同趟
2. 每趟丟給 Valhalla 對到道路上，得到每個點在哪一種道路（道路等級＋是不是市區）
3. 兩點之間在移動（5～150 km/h、間隔 60 秒內）才算，累加公尺數與秒數
4. 每趟每種道路寫一筆 TimeSeries：ts:pace:{uid}:{類別}:m／:s（標籤 uid、cat、kind）
   查詢用 TS.MRANGE … FILTER uid=… GROUPBY cat REDUCE sum，Redis 一次幫你把每一類加總；
   想看「最近三個月」只要換時間範圍，不用重算。
"""
import argparse
import os
import time

import httpx
import redis

from app.geo import haversine_m
from app.pace import category, curvy_flags
from app.redis_url import default_redis_url

VALHALLA = os.environ.get("VALHALLA_URL", "http://localhost:8752")
GAP_S = 300
CHUNK = 800        # 每次送給 Valhalla 的點數（trace 有距離上限）
REST_S = 180       # 連續靜止超過 3 分鐘算休息，不算進騎乘時間；短的（紅燈、塞車）要算
CAR_MOTORWAY_M = 2000  # 一趟走了 2 km 以上國道 → 是開車或搭車，整趟不算（機車不能上國道）


def rides(points):
    cur = []
    for p in points:
        if cur and (p[0] - cur[-1][0] > GAP_S * 1000 or haversine_m(cur[-1][1], cur[-1][2], p[1], p[2]) > 3000):
            yield cur
            cur = []
        cur.append(p)
    if cur:
        yield cur


def match(client, pts):
    body = {"shape": [{"lat": p[1], "lon": p[2]} for p in pts], "costing": "motorcycle", "shape_match": "map_snap",
            "filters": {"attributes": ["edge.road_class", "edge.density", "edge.length", "matched.edge_index"],
                        "action": "include"}}
    res = client.post(f"{VALHALLA}/trace_attributes", json=body, timeout=120)
    d = res.json()
    if "edges" not in d:
        return None
    return d["edges"], d.get("matched_points", [])


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
        old = list(r.scan_iter(f"ts:pace:{uid}:*"))
        if old:
            r.delete(*old)

    t0 = time.time()
    pts, last = [], "-"
    while True:
        batch = r.xrange(f"footprint:{uid}", min=last, max="+", count=20000)
        if last != "-":
            batch = batch[1:]
        if not batch:
            break
        for sid, f in batch:
            pts.append((int(sid.split("-")[0]), float(f["lat"]), float(f["lon"])))
        last = batch[-1][0]
    print(f"讀取足跡 {len(pts)} 點，{time.time() - t0:.0f} 秒")

    client = httpx.Client()
    total = {}
    n_rides = n_fail = n_car = 0
    p = r.pipeline(transaction=False)
    for ride in rides(pts):
        if len(ride) < 30:
            continue
        n_rides += 1
        acc, motorway_m = {}, 0.0
        curvy = curvy_flags([(p_[1], p_[2]) for p_ in ride])
        for s in range(0, len(ride) - 1, CHUNK):
            seg = ride[s:s + CHUNK + 1]
            m = match(client, seg)
            if not m:
                n_fail += 1
                continue
            edges, matched = m
            motorway_m += sum(e.get("length", 0) * 1000 for e in edges if e.get("road_class") == "motorway")
            # 先算每一小段，再把「連續靜止超過 3 分鐘」的休息時間挑掉
            steps = []
            for i in range(1, min(len(seg), len(matched))):
                ei = matched[i].get("edge_index")
                dt = (seg[i][0] - seg[i - 1][0]) / 1000
                d = haversine_m(seg[i - 1][1], seg[i - 1][2], seg[i][1], seg[i][2])
                if ei is None or ei >= len(edges) or dt <= 0 or dt > 60 or d / dt * 3.6 > 150:
                    steps.append(None)  # 斷訊、跳點：不算
                    continue
                steps.append((category(edges[ei], curvy[s + i]), d, dt, d / dt * 3.6 < 3))
            i = 0
            while i < len(steps):
                if steps[i] and steps[i][3]:  # 靜止：看這一串有多長
                    j, dur = i, 0.0
                    while j < len(steps) and steps[j] and steps[j][3]:
                        dur += steps[j][2]
                        j += 1
                    if dur > REST_S:
                        i = j
                        continue
                if steps[i]:
                    c, d, dt, _ = steps[i]
                    mm, ss = acc.get(c, (0.0, 0.0))
                    acc[c] = (mm + d, ss + dt)
                i += 1
        if motorway_m > CAR_MOTORWAY_M:
            n_car += 1
            continue
        ts = ride[0][0]
        for c, (mm, ss) in acc.items():
            for kind, v in (("m", mm), ("s", ss)):
                p.execute_command("TS.ADD", f"ts:pace:{uid}:{c}:{kind}", ts, round(v, 1), "ON_DUPLICATE", "SUM",
                                  "LABELS", "metric", "pace", "uid", uid, "cat", c, "kind", kind)
            tm, tsec = total.get(c, (0.0, 0.0))
            total[c] = (tm + mm, tsec + ss)
        if n_rides % 20 == 0:
            p.execute()
            print(f"  已處理 {n_rides} 趟…", flush=True)
    p.execute()
    print(f"完成：{n_rides} 趟（其中 {n_car} 趟走了國道，判定是開車或搭車，不算；比對失敗 {n_fail} 段），{time.time() - t0:.0f} 秒")
    for c, (mm, ss) in sorted(total.items(), key=lambda x: -x[1][0]):
        print(f"  {c:<20} {mm / 1000:8.1f} km  平均 {mm / ss * 3.6:5.1f} km/h")


if __name__ == "__main__":
    main()
