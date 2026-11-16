"""從個人 GPX 切出展示用的真實騎乘片段，給模擬器重播。

用法：uv run python -m tools.extract_tracks <檔案.gpx> [--out ../data/tracks]

為了隱私，北宜那段會裁掉頭尾（可能是住處附近）。輸出檔放在 data/，不進版控。
"""
import argparse
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.geo import TPE, haversine_m  # noqa: E402
from tools.import_gpx import parse_gpx  # noqa: E402

QINGJING = (24.0670, 121.1680)   # 清境（台14甲起點附近）
WULING = (24.1373, 121.2759)     # 武嶺

# 時間是台灣時間。武嶺四趟都是「清境 → 武嶺」上坡；北宜是宜蘭 → 新店。
SEGMENTS = [
    {"id": "wuling-20251212", "group": "wuling", "label": "武嶺 25/12/12", "start": "2025-12-12 05:19", "end": "2025-12-12 05:55", "from": QINGJING, "to": WULING},
    {"id": "wuling-20260314", "group": "wuling", "label": "武嶺 26/03/14", "start": "2026-03-14 12:55", "end": "2026-03-14 14:14", "from": QINGJING, "to": WULING},
    {"id": "wuling-20260722", "group": "wuling", "label": "武嶺 26/07/22", "start": "2026-07-22 04:45", "end": "2026-07-22 05:16", "from": QINGJING, "to": WULING},
    {"id": "wuling-20261026", "group": "wuling", "label": "武嶺 26/10/26", "start": "2026-10-26 03:48", "end": "2026-10-26 04:28", "from": QINGJING, "to": WULING},
    # 10/26 從台北出發一路騎上武嶺（約 270 km、4 小時多，中途停 5 次）。頭裁 1 km（出發點可能是住處）。
    {"id": "taipei-20261026", "group": "taipei", "label": "台北出發 10/26", "start": "2026-10-26 00:13", "end": "2026-10-26 04:40", "to": WULING, "trim_head_m": 1000},
    {"id": "beiyi-20260315", "group": "beiyi", "label": "北宜 26/03/15", "start": "2026-03-15 16:06", "end": "2026-03-15 17:48", "trim_head_m": 500, "trim_tail_m": 1000},
]


def ms(s: str) -> int:
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TPE).timestamp() * 1000)


def trim_by_distance(pts, head_m, tail_m):
    def cut(seq, m):
        acc = 0.0
        for i in range(1, len(seq)):
            acc += haversine_m(seq[i - 1][1], seq[i - 1][2], seq[i][1], seq[i][2])
            if acc >= m:
                return seq[i:]
        return seq
    pts = cut(pts, head_m) if head_m else pts
    pts = list(reversed(cut(list(reversed(pts)), tail_m))) if tail_m else pts
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gpx")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "data", "tracks"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    pts = parse_gpx(a.gpx)
    for seg in SEGMENTS:
        t0, t1 = ms(seg["start"]), ms(seg["end"])
        sel = [p for p in pts if t0 <= p[0] <= t1]
        if "from" in seg:
            i = next((k for k, p in enumerate(sel) if haversine_m(p[1], p[2], *seg["from"]) < 800), 0)
            sel = sel[i:]
        if "to" in seg:
            j = next((k for k, p in enumerate(sel) if haversine_m(p[1], p[2], *seg["to"]) < 250), len(sel) - 1)
            sel = sel[:j + 1]
        sel = trim_by_distance(sel, seg.get("trim_head_m", 0), seg.get("trim_tail_m", 0))
        if len(sel) < 10:
            print(f"{seg['id']}：點太少，略過")
            continue
        base = sel[0][0]
        dist = sum(haversine_m(sel[k - 1][1], sel[k - 1][2], sel[k][1], sel[k][2]) for k in range(1, len(sel)))
        out = {
            "id": seg["id"], "group": seg["group"], "label": seg["label"],
            "started_at": base,
            "points": [[round((p[0] - base) / 1000, 1), round(p[1], 6), round(p[2], 6), round(p[3], 1)] for p in sel],
        }
        with open(os.path.join(a.out, seg["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        print(f"{seg['id']}：{len(sel)} 點、{dist / 1000:.1f} km、{(sel[-1][0] - base) / 60000:.0f} 分鐘、"
              f"海拔 {min(p[3] for p in sel):.0f}–{max(p[3] for p in sel):.0f} m")


if __name__ == "__main__":
    main()
