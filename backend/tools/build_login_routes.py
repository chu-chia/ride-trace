"""產生登入頁背景用的「台灣經典騎車路線」：用本機 Valhalla 依途經點算出沿著道路的線形。

這是公開道路資料，不是任何人的軌跡，可以進版控。
輸出 web/assets/login-routes.json：[{name, road, from, to, km, coords:[[lon,lat],…]}]

用法（在 backend/ 底下，Valhalla 要先跑在 8752）：
    python -m tools.build_login_routes
"""
import json
import os

import httpx

VALHALLA = os.environ.get("VALHALLA_URL", "http://localhost:8752")
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "web", "assets", "login-routes.json")

# 途經點（lat, lon）只是用來把路線「拉」到指定的道路上
ROUTES = [
    {"name": "北宜公路", "road": "台 9 線", "from": "新店", "to": "頭城",
     "via": [(24.9677, 121.5410), (24.9370, 121.7110), (24.8590, 121.8230)]},
    {"name": "北部橫貫公路", "road": "台 7 線", "from": "大溪", "to": "棲蘭",
     "via": [(24.8830, 121.2870), (24.6800, 121.3900), (24.6500, 121.4720), (24.6390, 121.5020)]},
    {"name": "東北角海岸", "road": "台 2 線", "from": "基隆", "to": "頭城",
     "via": [(25.1300, 121.7400), (25.0160, 121.9450), (24.8590, 121.8230)]},
    {"name": "蘇花公路", "road": "台 9 線", "from": "蘇澳", "to": "花蓮",
     "via": [(24.5950, 121.8510), (24.4630, 121.8000), (24.3000, 121.7550), (23.9920, 121.6010)]},
    {"name": "合歡山武嶺", "road": "台 14 甲線", "from": "埔里", "to": "武嶺",
     "via": [(23.9650, 120.9680), (24.0560, 121.1620), (24.1370, 121.2760)]},
    {"name": "阿里山公路", "road": "台 18 線", "from": "嘉義", "to": "阿里山",
     "via": [(23.4800, 120.4490), (23.4430, 120.6040), (23.5100, 120.8050)]},
    {"name": "南部橫貫公路", "road": "台 20 線", "from": "甲仙", "to": "池上",
     "via": [(23.0830, 120.5880), (23.2726, 120.8307), (23.2516, 120.9880), (23.1720, 121.0440), (23.1000, 121.2200)],
     # 埡口一段在 OSM 標成管制通行，不忽略會繞 300 多公里；這裡只是畫線，不是導航
     "ignore_access": True},
]


def decode(s: str, prec: int = 6) -> list[list[float]]:
    """Valhalla 的 polyline6 解碼成 [[lon, lat], …]"""
    out, idx, lat, lon, f = [], 0, 0, 0, 10 ** prec
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        out.append([round(lon / f, 5), round(lat / f, 5)])
    return out


def simplify(pts: list[list[float]], tol: float = 0.0004) -> list[list[float]]:
    """Douglas–Peucker，度為單位；登入頁只是背景，留彎道形狀就好"""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        best, bi = 0.0, -1
        for i in range(a + 1, b):
            x, y = pts[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def main() -> None:
    out = []
    with httpx.Client(timeout=60) as c:
        for r in ROUTES:
            body = {
                "locations": [{"lat": la, "lon": lo, "type": "through" if 0 < i < len(r["via"]) - 1 else "break"}
                              for i, (la, lo) in enumerate(r["via"])],
                "costing": "motorcycle",
                # 台灣機車不能上國道
                "costing_options": {"motorcycle": {"use_highways": 0.0, "ignore_access": r.get("ignore_access", False)}},
                "units": "kilometers",
            }
            res = c.post(f"{VALHALLA}/route", json=body)
            res.raise_for_status()
            trip = res.json()["trip"]
            coords = []
            for leg in trip["legs"]:
                coords += decode(leg["shape"])
            coords = simplify(coords)
            km = round(trip["summary"]["length"])
            print(f"{r['name']:8s} {km:4d} km  {len(coords):4d} 點")
            out.append({k: r[k] for k in ("name", "road", "from", "to")} | {"km": km, "coords": coords})
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("寫入", os.path.normpath(OUT), os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
