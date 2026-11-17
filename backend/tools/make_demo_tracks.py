"""用本機 Valhalla 產生可供 tools.simulate 重播的展示軌跡。

在 backend/ 執行：
    uv run python -m tools.make_demo_tracks --preset zhongheng --riders 4 --seed 1
    uv run python -m tools.make_demo_tracks --preset nanheng --out /tmp/qiji-demo-test
"""

import argparse
import bisect
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.geo import haversine_m


# 途經點依序為（名稱、緯度、經度、已知海拔公尺）。
PRESETS = {
    "zhongheng": ("中橫", [
        ("埔里", 23.9667, 120.9687, 450), ("清境", 24.0670, 121.1680, 1750),
        ("武嶺", 24.1373, 121.2759, 3275), ("大禹嶺", 24.1814, 121.3108, 2565),
        ("天祥", 24.1803, 121.4925, 480), ("太魯閣", 24.1586, 121.6214, 60),
        ("花蓮", 23.9910, 121.6010, 15),
    ]),
    "nanheng": ("南橫", [
        ("甲仙", 23.0806, 120.5886, 300), ("寶來", 23.1069, 120.6997, 450),
        ("梅山", 23.2741, 120.8233, 900), ("埡口／大關山隧道", 23.2864, 120.9064, 2722),
        ("向陽", 23.2580, 120.9890, 2300), ("利稻", 23.1997, 121.0153, 1050), ("霧鹿", 23.1800, 121.0450, 800),
        ("池上", 23.1240, 121.2190, 260),
    ]),
    "beiyi": ("北宜", [
        ("新店", 24.9678, 121.5410, 30), ("坪林", 24.9372, 121.7110, 200),
        ("石牌縣界", 24.8960, 121.7350, 550), ("礁溪", 24.8270, 121.7700, 10),
    ]),
}

# OSM 把南橫埡口→向陽標成汽機車管制，Valhalla 會繞 350 km；這段改用行人模式取台20的線形，速度另以 38 km/h 估。
SHAPE_ONLY_LEGS = {("埡口／大關山隧道", "向陽")}

STARTED_AT = int(datetime(2026, 11, 15, 8, tzinfo=timezone(timedelta(hours=8))).timestamp() * 1000)


def decode_polyline6(encoded):
    """Valhalla 的 polyline6 解碼為（緯度、經度）。"""
    coords, values, index = [], [0, 0], 0
    while index < len(encoded):
        for axis in (0, 1):
            shift = value = 0
            while True:
                char = ord(encoded[index]) - 63
                index += 1
                value |= (char & 31) << shift
                shift += 5
                if char < 32:
                    break
            values[axis] += ~(value >> 1) if value & 1 else value >> 1
        coords.append((values[0] / 1_000_000, values[1] / 1_000_000))
    return coords


def route(client, waypoints):
    """逐段規劃，確保每個已知海拔的途經點都是獨立的距離邊界。"""
    legs = []
    for start, end in zip(waypoints, waypoints[1:]):
        shape_only = (start[0], end[0]) in SHAPE_ONLY_LEGS
        body = {
            "locations": [{"lat": p[1], "lon": p[2]} for p in (start, end)],
            "costing": "pedestrian" if shape_only else "motorcycle",
            "units": "kilometers",
        }
        if not shape_only:
            body["costing_options"] = {"motorcycle": {"use_highways": 0, "exclude_tolls": True, "use_trails": 0}}
        try:
            response = client.post("/route", json=body)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError(f"{start[0]} → {end[0]}：Valhalla 請求失敗：{exc}") from exc
        if "trip" not in data:
            raise RuntimeError(f"{start[0]} → {end[0]}：Valhalla 無法規劃路線：{data.get('error', data)}")
        for leg in data["trip"]["legs"]:
            shape = decode_polyline6(leg["shape"])
            if len(shape) < 2:
                raise RuntimeError(f"{start[0]} → {end[0]}：路線點數不足")
            legs.append((start, end, shape, [] if shape_only else leg.get("maneuvers", [])))
    return legs


def route_profile(legs):
    """把 maneuver 預估時間分攤到線形，並依各段行經距離內插高程。"""
    coords, distances, elevations, weights, boundaries = [], [], [], [], []
    for start, end, shape, maneuvers in legs:
        local = [0.0]
        for a, b in zip(shape, shape[1:]):
            local.append(local[-1] + haversine_m(*a, *b))
        if local[-1] < 1:
            raise RuntimeError(f"{start[0]} → {end[0]}：路線距離不足")
        # maneuver 的時間只決定相對快慢；全程速度再正規化到山路合理範圍。
        segment_seconds = [0.0] * (len(shape) - 1)
        for maneuver in maneuvers:
            first = max(0, min(len(segment_seconds), maneuver.get("begin_shape_index", 0)))
            last = max(first, min(len(segment_seconds), maneuver.get("end_shape_index", first)))
            length = local[last] - local[first]
            if length > 0 and maneuver.get("time", 0) > 0:
                for index in range(first, last):
                    segment_seconds[index] = maneuver["time"] * (local[index + 1] - local[index]) / length
        for index, coord in enumerate(shape):
            if coords and index == 0:
                continue
            coords.append(coord)
            distances.append((distances[-1] if distances else 0) + (local[index] - local[index - 1] if index else 0))
            f = local[index] / local[-1]
            elevations.append(start[3] + (end[3] - start[3]) * f)
            if index:
                # 欠缺 maneuver 時間的片段以 38 km/h 補足。
                weights.append(segment_seconds[index - 1] or (local[index] - local[index - 1]) / (38 / 3.6))
        boundaries.append(distances[-1])
    return coords, distances, elevations, weights, boundaries


def make_track(preset, rider_number, profile, rng):
    coords, distances, elevations, weights, boundaries = profile
    total = distances[-1]
    # 保留 Valhalla 各路段的相對速度；每位騎士再有自己的速度係數。
    rider_factor = rng.uniform(0.85, 1.15)
    target_kmh = rng.uniform(38, 40)
    scale = (total / (target_kmh / 3.6)) / sum(weights) / rider_factor
    stops = {}
    candidates = boundaries[:-1]
    if candidates:
        for distance in rng.sample(candidates, min(len(candidates), rng.randint(1, 3))):
            index = bisect.bisect_left(distances, distance)
            stops[index] = rng.randint(120, 480)
    # 起步延遲放在時間軸開頭，模擬器在 t=0 也能取得位置。
    delay = rng.randint(0, 90)
    # 休息也計入全程均速；必要時微調整體速度以落在山路展示的合理區間。
    minimum_moving = max(1, total / (44 / 3.6) - delay - sum(stops.values()))
    maximum_moving = max(minimum_moving, total / (30 / 3.6) - delay - sum(stops.values()))
    scale = min(max(scale, minimum_moving / sum(weights)), maximum_moving / sum(weights))
    moving_times = [0.0]
    for weight in weights:
        moving_times.append(moving_times[-1] + weight * scale)
    elapsed = [delay]
    for index in range(1, len(coords)):
        elapsed.append(elapsed[-1] + moving_times[index] - moving_times[index - 1] + stops.get(index - 1, 0))
    duration = math.ceil(elapsed[-1])
    phase = rng.uniform(0, 2 * math.pi)
    points = []
    for second in range(duration + 1):
        if second <= elapsed[0]:
            index, f = 0, 0.0
        else:
            index = min(len(coords) - 1, max(1, bisect.bisect_right(elapsed, second)))
            # 停留時間占這個區間的前段，停留時位置不動。
            previous = index - 1
            moving_start = elapsed[previous] + stops.get(previous, 0)
            span = max(0.001, elapsed[index] - moving_start)
            f = min(1.0, max(0.0, (second - moving_start) / span))
        if index == 0:
            lat, lon, ele = *coords[0], elevations[0]
            distance = 0.0
        else:
            previous = index - 1
            lat = coords[previous][0] + (coords[index][0] - coords[previous][0]) * f
            lon = coords[previous][1] + (coords[index][1] - coords[previous][1]) * f
            ele = elevations[previous] + (elevations[index] - elevations[previous]) * f
            distance = distances[previous] + (distances[index] - distances[previous]) * f
        # 只在高程上加低頻、低振幅雜訊，保持原道路線形。
        noise = 3 * math.sin(distance / 900 + phase) + 1.5 * math.sin(distance / 270 + phase / 2)
        points.append([second, round(lat, 6), round(lon, 6), round(ele + noise, 1)])
    raw_points = points[::10]
    if raw_points[-1] != points[-1]:
        raw_points.append(points[-1])
    track_id = f"{preset}-demo{rider_number}"
    return {"id": track_id, "group": preset, "label": f"{PRESETS[preset][0]} 騎士{rider_number}",
            "started_at": STARTED_AT, "points": points, "raw_points": raw_points, "matched": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", required=True, choices=PRESETS)
    parser.add_argument("--riders", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "data" / "tracks")
    parser.add_argument("--valhalla", default="http://localhost:8752")
    args = parser.parse_args()
    if args.riders < 1:
        parser.error("--riders 必須大於 0")
    parsed = urlparse(args.valhalla)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.username or parsed.password:
        parser.error("--valhalla 只能使用本機服務")
    with httpx.Client(base_url=args.valhalla, timeout=120) as client:
        profile = route_profile(route(client, PRESETS[args.preset][1]))
    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    for number in range(1, args.riders + 1):
        track = make_track(args.preset, number, profile, rng)
        path = args.out / f"{track['id']}.json"
        path.write_text(json.dumps(track, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"{path}：{profile[1][-1] / 1000:.2f} km、{track['points'][-1][0] / 60:.1f} 分鐘、"
              f"{len(track['points'])} 點（raw {len(track['raw_points'])} 點）")


if __name__ == "__main__":
    main()
