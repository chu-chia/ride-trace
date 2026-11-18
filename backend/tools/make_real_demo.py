"""用真人的一段真實騎乘當 Demo：他自己重播自己的紀錄，機器人走同一條真實路線但各自錯開。

在 backend/ 執行（Valhalla 要先跑起來）：
    uv run python -m tools.make_real_demo                     # 產生 data/tracks/zh314-*.json
    uv run python -m tools.make_real_demo --apply-trip 57     # 另外把行程 57 的路線、名稱換成這段真實路線

預設是 wei 在 2026-03-14 騎的中橫：12:55 埔里 → 清境 → 武嶺 → 大禹嶺 → 天祥 → 17:52 太魯閣牌樓。
1. XRANGE footprint:{uid} 取出那段時間的點（data/ 不進版控，位置資料不外流）
2. tools.match_tracks 用本機 Valhalla 貼到道路上，停車時間保留
3. 機器人（沿用 sim_zhonghengride1～4，暱稱「中橫 騎士N」）：同一條道路形狀，
   每段騎乘速度各自 ±12%、出發晚幾十秒；休息點會等真人出發前後一兩分鐘再走（隊伍在休息點重新集合），
   其中一位中途多停一次拍照，會觸發落隊／跟上。
跑 Demo：uv run python -m tools.simulate --group zh314 --trip 57 --speed 1 --interval 2 --loop
"""
import argparse
import json
import os
import random
import secrets
import sys
from datetime import datetime, timedelta, timezone

import httpx
import redis

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.geo import haversine_m  # noqa: E402
from app.redis_url import default_redis_url  # noqa: E402
from tools.match_tracks import match_track  # noqa: E402

TPE = timezone(timedelta(hours=8))
TRACKS = os.path.join(os.path.dirname(__file__), "..", "..", "data", "tracks")
# 路線途經點（規劃路線用；起終點用真實紀錄的第一點、最後一點）
VIA = [("清境", 24.0670, 121.1680), ("武嶺", 24.1373, 121.2759), ("大禹嶺", 24.1814, 121.3108), ("天祥", 24.1803, 121.4925)]
STOP_S, STOP_M = 60, 200   # 跟 match_tracks 一樣：60 秒以上、200 公尺內算停車


def tpe_ms(day: str, hm: str) -> int:
    return int(datetime.strptime(f"{day} {hm}", "%Y-%m-%d %H:%M").replace(tzinfo=TPE).timestamp() * 1000)


def read_footprint(rd, uid: str, a: int, b: int) -> list[list[float]]:
    pts = rd.xrange(f"footprint:{uid}", a, b)
    if not pts:
        sys.exit("這段時間沒有足跡")
    t0 = int(pts[0][0].split("-")[0])
    out = []
    for sid, f in pts:
        t = int(sid.split("-")[0])
        out.append([round((t - t0) / 1000, 2), float(f["lat"]), float(f["lon"]), float(f.get("ele") or 0)])
    return out, t0


def split_moves(pts):
    """回傳停車區段 [(到達 index, 出發 index)]：比對後停車是「同一位置、時間跳很多」的兩個點。"""
    stops = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if b[0] - a[0] > STOP_S and haversine_m(a[1], a[2], b[1], b[2]) < STOP_M:
            stops.append((i, i + 1))
    return stops


def cap_speed(pts, vmax_kmh=80):
    """隧道裡 GPS 會跳（台8 天祥→太魯閣隧道很多），比對後有幾段算出 100～300 km/h。
    超速的區間把時間拉長到 vmax，多出來的秒數從下一次休息扣掉（休息至少留 30 秒），整趟時間軸仍對得上真實紀錄。"""
    vmax = vmax_kmh / 3.6
    out = [list(pts[0])]
    debt = 0.0
    for a, b in zip(pts, pts[1:]):
        dt = b[0] - a[0]
        d = haversine_m(a[1], a[2], b[1], b[2])
        if dt > STOP_S and d < STOP_M:          # 休息：扣掉前面多花的時間
            cut = min(debt, max(0.0, dt - 30))
            dt -= cut
            debt -= cut
        elif d / max(dt, 0.01) > vmax:
            extra = d / vmax - dt
            dt += extra
            debt += extra
        out.append([round(out[-1][0] + dt, 2), b[1], b[2], b[3]])
    return out


def make_bot(me, stops, rnd: random.Random, photo: bool):
    """同一條道路形狀，時間重新分配。"""
    stop_at = {a: b for a, b in stops}
    t = rnd.uniform(20, 150)                       # 出發晚一點（之前停在起點：模擬器在第一點之前會往回外插）
    out = [[0.0, me[0][1], me[0][2], me[0][3]]]
    factor = rnd.uniform(0.88, 1.12)              # 這一段的速度倍率（>1 比較慢）
    # 拍照停留：挑最長的一段騎乘中間
    photo_i = None
    if photo:
        bounds = [0] + [b for _, b in stops] + [len(me) - 1]
        seg = max(zip(bounds, bounds[1:]), key=lambda s: me[s[1]][0] - me[s[0]][0])
        photo_i = (seg[0] + seg[1]) // 2
    i = 0
    while i < len(me):
        p = me[i]
        out.append([round(t, 2), p[1], p[2], p[3]])
        if i in stop_at:                           # 休息點：等真人出發前後一兩分鐘再走
            j = stop_at[i]
            depart = max(t + 45, me[j][0] + rnd.uniform(-60, 150))
            t = depart
            out.append([round(t, 2), me[j][1], me[j][2], me[j][3]])
            factor = rnd.uniform(0.88, 1.12)
            i = j
        if i == photo_i:
            t += rnd.uniform(240, 360)
            out.append([round(t, 2), p[1], p[2], p[3]])
        if i + 1 < len(me):
            t += max(0.2, (me[i + 1][0] - me[i][0]) * factor)
        i += 1
    # 時間嚴格遞增
    clean = [out[0]]
    for q in out[1:]:
        if q[0] > clean[-1][0]:
            clean.append(q)
    return clean


def temp_session(rd, uid: str) -> str:
    tok = "mkdemo_" + secrets.token_urlsafe(18)
    rd.set(f"session:{tok}", uid, ex=600)
    return tok


def apply_trip(rd, tid: str, uid: str, me, name: str, base: str, vehicle: str):
    """以建立者身分（臨時 session）呼叫 PUT /api/trips/{tid}/route，路線走真實紀錄經過的地點。"""
    owner = rd.hget(f"trip:{tid}", "owner")
    if owner != uid:
        sys.exit(f"行程 {tid} 的建立者不是這個帳號，不能改路線")
    pts = [{"lat": me[0][1], "lon": me[0][2], "name": "埔里"}] + \
          [{"lat": la, "lon": lo, "name": n} for n, la, lo in VIA] + \
          [{"lat": me[-1][1], "lon": me[-1][2], "name": "太魯閣"}]
    tok = temp_session(rd, uid)
    try:
        res = httpx.put(f"{base}/api/trips/{tid}/route", json={"points": pts, "vehicle": vehicle},
                        headers={"authorization": "Bearer " + tok}, timeout=60)
        res.raise_for_status()
    finally:
        rd.delete(f"session:{tok}")
    rd.hset(f"trip:{tid}", "name", name)
    route = rd.json().get(f"route:{rd.hget(f'trip:{tid}', 'route')}")
    coords = route["coords"]
    # 真實軌跡離規劃路線多遠（太遠會一直觸發「偏離路線」）
    worst, step = 0.0, max(1, len(me) // 400)
    for p in me[::step]:
        d = min(haversine_m(p[1], p[2], c[1], c[0]) for c in coords)
        worst = max(worst, d)
    print(f"行程 {tid}：名稱「{name}」、路線 {route['summary']['km']} km；真實軌跡離路線最遠 {worst:.0f} m")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="wei")
    ap.add_argument("--day", default="2026-03-14")
    ap.add_argument("--start", default="12:55")
    ap.add_argument("--end", default="17:53", help="台灣時間，含這一分鐘之前")
    ap.add_argument("--group", default="zh314")
    ap.add_argument("--bots", type=int, default=4)
    ap.add_argument("--seed", type=int, default=314)
    ap.add_argument("--valhalla", default=os.environ.get("VALHALLA_URL", "http://localhost:8752"))
    ap.add_argument("--apply-trip", metavar="行程編號", help="把這個行程的路線、名稱換成這段真實路線")
    ap.add_argument("--name", default="中部橫貫公路 埔里-武嶺-太魯閣")
    ap.add_argument("--vehicle", default="heavy")
    ap.add_argument("--base", default="http://localhost:8750")
    a = ap.parse_args()

    rd = redis.Redis.from_url(default_redis_url(), decode_responses=True)
    uid = rd.get(f"username:{a.user}")
    if not uid:
        sys.exit(f"找不到帳號 {a.user}")
    raw, t0 = read_footprint(rd, uid, tpe_ms(a.day, a.start), tpe_ms(a.day, a.end))
    km = sum(haversine_m(raw[i][1], raw[i][2], raw[i + 1][1], raw[i + 1][2]) for i in range(len(raw) - 1)) / 1000
    print(f"{a.user} {a.day} {a.start}～{a.end}：{len(raw)} 點、{km:.1f} km、{raw[-1][0] / 3600:.2f} 小時")

    os.makedirs(TRACKS, exist_ok=True)
    nick = rd.hget(f"user:{uid}", "nickname") or a.user
    me_path = os.path.join(TRACKS, f"{a.group}-0self.json")
    json.dump({"id": f"{a.group}-self", "group": a.group, "label": f"{nick} {a.day[2:].replace('-', '/')}", "self": a.user,
               "started_at": t0, "points": raw}, open(me_path, "w", encoding="utf-8"), ensure_ascii=False)
    match_track(me_path, a.valhalla)
    doc = json.load(open(me_path, encoding="utf-8"))
    me = doc["points"] = cap_speed(doc["points"])
    json.dump(doc, open(me_path, "w", encoding="utf-8"), ensure_ascii=False)
    stops = split_moves(me)
    print(f"休息 {len(stops)} 次：" + "、".join(f"{(me[b][0] - me[s][0]) / 60:.0f} 分" for s, b in stops))

    rnd = random.Random(a.seed)
    photo_bot = rnd.randrange(a.bots)
    for k in range(a.bots):
        pts = cap_speed(make_bot(me, stops, rnd, photo=k == photo_bot), 85)
        path = os.path.join(TRACKS, f"{a.group}-bot{k + 1}.json")
        # id 沿用 #57 原本的中橫機器人（sim_zhonghengrideN），帳號、暱稱、顏色都不變
        json.dump({"id": f"zhongheng-ride{k + 1}", "group": a.group, "label": f"中橫 騎士{k + 1}", "started_at": t0,
                   "matched": True, "points": pts}, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"  騎士{k + 1}：{pts[-1][0] / 3600:.2f} 小時{'（中途多停一次拍照）' if k == photo_bot else ''}")

    if a.apply_trip:
        apply_trip(rd, a.apply_trip, uid, me, a.name, a.base, a.vehicle)


if __name__ == "__main__":
    main()
