"""地圖比對：把展示軌跡的 GPS 點對到真實道路上（用本機的 Valhalla，資料不外流）。

原始 GPS 大約 10～13 秒一點，車速快的時候兩點相隔好幾百公尺，直線連起來會切過彎道。
比對後改用道路的實際形狀，並依原本的時間把時間戳分配到每個道路頂點，
模擬器重播時就會沿著道路走。

用法（在 backend/ 底下，Valhalla 要先跑起來）：
    uv run python -m tools.match_tracks            # 比對 data/tracks/ 底下全部
    uv run python -m tools.match_tracks taipei-20261026
原始點會保留在 raw_points，可以重跑。
"""
import argparse
import glob
import json
import math
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.geo import haversine_m  # noqa: E402

TRACKS = os.path.join(os.path.dirname(__file__), "..", "..", "data", "tracks")
CHUNK = 120


def decode6(s: str):
    """Valhalla 的 encoded polyline（精度 1e6）。"""
    coords, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        coords.append((lat / 1e6, lon / 1e6))
    return coords


def project(p, a, b):
    """點 p 投影到線段 ab，回傳 (比例 0～1, 距離公尺)。用局部平面近似就夠了。"""
    k = math.cos(math.radians(a[0]))
    ax, ay, bx, by, px, py = a[1] * k, a[0], b[1] * k, b[0], p[1] * k, p[0]
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    f = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    q = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
    return f, haversine_m(p[0], p[1], q[0], q[1])


def match_chunk(client, base, pts):
    body = {
        "shape": [{"lat": p[1], "lon": p[2]} for p in pts],
        # 比對只是找出實際走過的路，不套機車路權（國道6號等快速道路也要對得上）
        "costing": "auto",
        "shape_match": "map_snap",
        "filters": {"attributes": ["shape", "matched.point", "matched.type"], "action": "include"},
    }
    r = client.post(base + "/trace_attributes", json=body, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(r.text[:300])
    data = r.json()
    shape = decode6(data["shape"])
    cum = [0.0]
    for i in range(1, len(shape)):
        cum.append(cum[-1] + haversine_m(*shape[i - 1], *shape[i]))
    # 每個原始點在道路形狀上的位置（往前找，不回頭）
    anchors, seg = [], 0
    for p, mp in zip(pts, data["matched_points"]):
        if mp.get("type") == "unmatched":
            continue
        q = (mp["lat"], mp["lon"])
        best = (float("inf"), seg, 0.0)
        for j in range(seg, min(len(shape) - 1, seg + 400)):
            f, d = project(q, shape[j], shape[j + 1])
            if d < best[0]:
                best = (d, j, f)
            if d < 1 and best[0] < 1:
                break
        _, j, f = best
        dist = cum[j] + (cum[j + 1] - cum[j]) * f if len(shape) > 1 else 0
        if anchors and dist < anchors[-1][0]:
            continue
        seg = j
        anchors.append((dist, p[0], p[3]))
    if len(anchors) < 2:
        return [list(p) for p in pts]
    out = []
    k = 0
    for i, (lat, lon) in enumerate(shape):
        d = cum[i]
        while k < len(anchors) - 2 and anchors[k + 1][0] < d:
            k += 1
        (d0, t0, e0), (d1, t1, e1) = anchors[k], anchors[k + 1]
        f = 0.0 if d1 == d0 else max(0.0, min(1.0, (d - d0) / (d1 - d0)))
        out.append([round(t0 + (t1 - t0) * f, 2), round(lat, 6), round(lon, 6), round(e0 + (e1 - e0) * f, 1)])
    return out


def match_track(path, base):
    t = json.load(open(path, encoding="utf-8"))
    raw = t.get("raw_points") or t["points"]
    out = []
    with httpx.Client() as c:
        for s in range(0, len(raw) - 1, CHUNK):
            chunk = raw[s:s + CHUNK + 1]
            try:
                part = match_chunk(c, base, chunk)
            except Exception as e:  # noqa: BLE001
                print(f"  第 {s} 點起比對失敗，保留原始點：{e}")
                part = [list(p) for p in chunk]
            for p in part:
                if out and p[0] <= out[-1][0]:
                    continue
                out.append(p)
    # 停留時間：比對後的道路頂點只有「經過」的時間，原始點裡停在原地的時段要補回去
    stops = [(raw[i][0], raw[i + 1][0]) for i in range(len(raw) - 1)
             if raw[i + 1][0] - raw[i][0] > 60 and haversine_m(raw[i][1], raw[i][2], raw[i + 1][1], raw[i + 1][2]) < 200]
    for a, b in stops:
        idx = next((i for i, p in enumerate(out) if p[0] >= a), None)
        if idx is None:
            continue
        p = out[idx]
        later = [q for q in out[idx + 1:] if q[0] > b]
        out = out[:idx + 1] + [[b, p[1], p[2], p[3]]] + later
    dist = sum(haversine_m(out[i - 1][1], out[i - 1][2], out[i][1], out[i][2]) for i in range(1, len(out)))
    t["raw_points"] = raw
    t["points"] = out
    t["matched"] = True
    json.dump(t, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{t['id']}：原始 {len(raw)} 點 → 道路 {len(out)} 點、{dist / 1000:.1f} km、停車 {len(stops)} 次")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--valhalla", default=os.environ.get("VALHALLA_URL", "http://localhost:8752"))
    a = ap.parse_args()
    files = sorted(glob.glob(os.path.join(TRACKS, "*.json")))
    if a.ids:
        files = [f for f in files if os.path.basename(f)[:-5] in a.ids]
    for f in files:
        match_track(f, a.valhalla)


if __name__ == "__main__":
    main()
