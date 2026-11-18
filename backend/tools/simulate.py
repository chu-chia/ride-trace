"""GPS 模擬器：把真實騎乘片段當成多位隊友，即時回報給騎跡。

每位隊友是一個機器人帳號（sim_ 開頭），走的是跟手機一模一樣的 /api/track。

例子（在 backend/ 底下）：
    # 加入你在網頁建立的行程，你按「開始行程」後就會出發
    uv run python -m tools.simulate --group wuling --code ABC123

    # 機器人自己開團並開始，印出邀請碼讓你用網頁加入觀看
    uv run python -m tools.simulate --group wuling --create "武嶺日出團"

    # 20 倍速；第 2 位在第 600 秒斷訊到第 900 秒（會觸發失聯→恢復）
    uv run python -m tools.simulate --group wuling --code ABC123 --speed 20 --drop 2@600-900

    # Demo 模式：同一個行程（用編號指定，已結束也可以）無限重播；每一圈開始前把這趟的即時資料清掉、重新開始
    uv run python -m tools.simulate --group zhongheng --trip 57 --speed 1 --interval 2 --loop

    # 中橫真實版（tools.make_real_demo 產生）：真人帳號重播自己 3/14 的紀錄＋3 個機器人
    uv run python -m tools.simulate --group zh314 --trip 57 --speed 1 --interval 2 --loop

軌跡檔有 "self": "帳號" 的是「真人重播自己」：不用密碼登入（直接在 Redis 開一個臨時 session），
回報標成 src=sim-self，只進 demo 行程、不寫個人足跡；暱稱、顏色、足跡都不動。
"""
import argparse
import asyncio
import bisect
import glob
import json
import math
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.geo import bearing_deg, haversine_m  # noqa: E402
from app.redis_url import default_redis_url  # noqa: E402

COLORS = ["#ff9f0a", "#30d158", "#bf5af2", "#ff375f", "#5ac8fa", "#ffd60a"]
def _env(name: str, default: str = "") -> str:
    """先看環境變數，再看專案根目錄的 .env（不進版控）。"""
    if os.environ.get(name):
        return os.environ[name]
    path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            k, _, v = line.strip().partition("=")
            if k == name:
                return v.strip()
    return default


# 機器人帳號的密碼放在 .env 的 SIM_BOT_PASSWORD（範例見 .env.example），不寫在程式碼裡
BOT_PASSWORD = _env("SIM_BOT_PASSWORD")
if not BOT_PASSWORD:
    raise SystemExit("請在專案根目錄的 .env 設定 SIM_BOT_PASSWORD（參考 .env.example）")


class Rider:
    def __init__(self, track: dict, idx: int):
        self.t = track
        self.idx = idx
        self.pts = track["points"]
        self.times = [p[0] for p in self.pts]
        self.dur = self.times[-1]
        self.self_user = track.get("self")  # 真人帳號重播自己的舊紀錄
        self.username = self.self_user or "sim_" + track["id"].replace("-", "")[:16]
        self.nickname = track["label"]
        self.src = "sim-self" if self.self_user else "sim"
        self.client: httpx.AsyncClient | None = None
        self.done = False
        self.batt = 92 - idx * 7

    def at(self, s: float):
        s = max(0.0, min(self.dur, s))
        i = max(1, bisect.bisect_left(self.times, s))
        i = min(i, len(self.pts) - 1)
        a, b = self.pts[i - 1], self.pts[i]
        span = max(0.001, b[0] - a[0])
        f = (s - a[0]) / span
        lat = a[1] + (b[1] - a[1]) * f
        lon = a[2] + (b[2] - a[2]) * f
        ele = a[3] + (b[3] - a[3]) * f
        # 速度、方向用前後各 5 秒的位置算：道路頂點很密，單一線段的時間差太小會算出離譜的速度
        if s - 5 < 0 or s + 5 > self.dur:
            return lat, lon, ele, 0.0, None
        p0, p1 = self._pos(s - 5), self._pos(s + 5)
        dist = haversine_m(*p0, *p1)
        speed = dist / 10
        heading = bearing_deg(*p0, *p1) if dist > 3 else None
        return lat, lon, ele, speed, heading

    def _pos(self, s: float):
        i = min(len(self.pts) - 1, max(1, bisect.bisect_left(self.times, s)))
        a, b = self.pts[i - 1], self.pts[i]
        f = (s - a[0]) / max(0.001, b[0] - a[0])
        return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f


SELF_SESSION_S = 8 * 86400


def self_session(username: str) -> str:
    """真人帳號：不碰密碼，直接開一個 8 天的臨時 session（每圈重開，Demo 一直跑也不會過期）。"""
    import secrets
    import redis
    rd = redis.Redis.from_url(default_redis_url(), decode_responses=True)
    uid = rd.get(f"username:{username}")
    if not uid:
        sys.exit(f"找不到帳號 {username}")
    tok = "simself_" + secrets.token_urlsafe(18)
    rd.set(f"session:{tok}", uid, ex=SELF_SESSION_S)
    return tok


def drop_session(tok: str):
    import redis
    redis.Redis.from_url(default_redis_url(), decode_responses=True).delete(f"session:{tok}")


async def ensure_login(base: str, rd: Rider):
    c = httpx.AsyncClient(base_url=base, timeout=15)
    if rd.self_user:
        c.headers["authorization"] = "Bearer " + self_session(rd.self_user)
        rd.client = c
        return
    res = await c.post("/api/login", json={"username": rd.username, "password": BOT_PASSWORD})
    if res.status_code == 401:
        res = await c.post("/api/register", json={"username": rd.username, "password": BOT_PASSWORD,
                                                 "nickname": rd.nickname[:12], "color": COLORS[rd.idx % len(COLORS)]})
    res.raise_for_status()
    c.headers["authorization"] = "Bearer " + res.json()["token"]
    await c.patch("/api/me", json={"nickname": rd.nickname[:12], "color": COLORS[rd.idx % len(COLORS)]})
    rd.client = c


def reset_trip(tid: str, lap: int, bot_names: list[str], self_names: list[str] = ()):
    """Demo 循環：把行程的即時資料清掉、重新變成進行中，機器人重新出發。
    機器人的個人足跡也一起清（不然每一圈 4 個人各十幾萬點，Redis 會一直長大）；只清 sim_ 開頭的帳號。
    真人帳號（self_names）只放回這趟的 active，個人資料完全不動；他正在別的進行中行程時不搶過來。"""
    import redis
    rd = redis.Redis.from_url(default_redis_url(), decode_responses=True)
    if not rd.exists(f"trip:{tid}"):
        sys.exit(f"找不到行程 {tid}")
    uids = []
    for name in bot_names:
        uid = rd.get(f"username:{name}")
        if uid and name.startswith("sim_"):
            uids.append(uid)
    selves = []
    for name in self_names:
        uid = rd.get(f"username:{name}")
        cur = uid and rd.get(f"user:{uid}:active_trip")
        if uid and (not cur or cur == tid or rd.hget(f"trip:{cur}", "status") != "live"):
            selves.append(uid)
        elif uid:
            print(f"\n{name} 正在行程 {cur}，這一圈不加入 Demo")
    keys = set()
    for pat in (f"track:{tid}:*", f"ts:{tid}:*", f"hb:{tid}:*", f"trip:{tid}:state:*", f"trip:{tid}:stats:*",
                f"trip:{tid}:arrived:*", f"trip:{tid}:allin:*", f"roadevt:{tid}:*", f"wxevt:{tid}:*",
                f"roadevchk:{tid}:*", f"wxchk:{tid}:*", f"push:calm:{tid}:*"):
        keys.update(rd.scan_iter(pat, count=1000))
    keys.update(f"trip:{tid}:{k}" for k in ("geo", "progress", "lagflag", "gap", "sos", "offroute", "stuck",
                                              "lagchk", "events", "active"))
    keys.add(f"cache:replay:{tid}")
    for uid in uids:
        keys.update({f"footprint:{uid}", f"footprint:{uid}:geo", f"footprint:{uid}:daykm", f"heat:{uid}",
                     f"user:{uid}:last", f"user:{uid}:towns", f"user:{uid}:townfirst", f"fp:ver:{uid}"})
        keys.update(rd.scan_iter(f"fog:{uid}:*", count=1000))
        keys.update(rd.scan_iter(f"cache:*:{uid}:*", count=1000))
    p = rd.pipeline(transaction=True)
    for i in range(0, len(keys), 500):
        p.delete(*list(keys)[i:i + 500])
    now = int(time.time() * 1000)
    p.hset(f"trip:{tid}", mapping={"status": "live", "started": now, "demo": 1, "demo_lap": lap})
    p.hdel(f"trip:{tid}", "ended_at")
    riders = uids + selves
    if riders:
        p.sadd(f"trip:{tid}:members", *riders)
        p.sadd(f"trip:{tid}:active", *riders)
        for uid in riders:
            p.zadd(f"user:{uid}:trips", {tid: now})
    for uid in riders:
        p.set(f"user:{uid}:active_trip", tid)
    p.xadd(f"trip:{tid}:events", {"type": "start", "uid": "", "text": f"Demo 第 {lap} 圈開始", "ts": now})
    p.execute()
    rd.publish(f"trip:{tid}:live", json.dumps({"kind": "trip", "status": "live"}))
    print(f"\n行程 {tid} 已重置（Demo 第 {lap} 圈），清掉 {len(keys)} 個 key")


def parse_drops(items):
    out = {}
    for it in items or []:
        who, rng = it.split("@")
        a, _, b = rng.partition("-")
        out[int(who)] = (float(a), float(b) if b else math.inf)
    return out


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="taipei", help="taipei（10/26 台北→武嶺，預設）、wuling（4 段清境→武嶺）、beiyi、zh314（中橫 3/14 真實版）")
    ap.add_argument("--tracks", default=os.path.join(os.path.dirname(__file__), "..", "..", "data", "tracks"))
    ap.add_argument("--base", default="http://localhost:8750")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--code", help="加入這個邀請碼的行程")
    g.add_argument("--create", metavar="名稱", help="機器人自己開團並開始")
    g.add_argument("--trip", help="Demo 循環用：直接指定行程編號（配 --loop）")
    ap.add_argument("--speed", type=float, default=10, help="倍速，預設 10 倍")
    ap.add_argument("--interval", type=float, default=0.3, help="每幾秒（真實時間）回報一次；越短，地圖上移動越順")
    ap.add_argument("--drop", action="append", help="第 N 位（從 1 起算）在模擬秒數 A 到 B 之間不回報，例如 2@600-900")
    ap.add_argument("--loop", action="store_true", help="Demo：跑完自動重置行程再跑，無限循環（要配 --code）")
    a = ap.parse_args()
    if bool(a.loop) != bool(a.trip):
        sys.exit("--loop 和 --trip 要一起用（指定要循環的行程編號）")

    files = sorted(glob.glob(os.path.join(a.tracks, f"{a.group}-*.json")))
    if not files:
        sys.exit(f"找不到 {a.group} 的軌跡，請先執行 tools.extract_tracks")
    riders = [Rider(json.load(open(f, encoding="utf-8")), i) for i, f in enumerate(files)]
    drops = parse_drops(a.drop)
    await asyncio.gather(*(ensure_login(a.base, rd) for rd in riders))

    lead = next((rd.client for rd in riders if not rd.self_user), riders[0].client)  # 開團／查狀態用機器人
    if a.create:
        res = await lead.post("/api/trips", json={"name": a.create})
        res.raise_for_status()
        code, tid = res.json()["invite"], res.json()["id"]
        for rd in riders[1:]:
            (await rd.client.post("/api/trips/join", json={"code": code})).raise_for_status()
        print(f"行程 {tid} 已建立，邀請碼：{code}（在網頁輸入就能加入觀看）")
        (await lead.post(f"/api/trips/{tid}/start")).raise_for_status()
    elif a.trip:
        tid = a.trip  # 機器人由 reset_trip 直接放進行程（行程可能已結束、邀請碼也可能過期）
    else:
        tid = None
        code = a.code.strip().upper()
        for rd in riders:
            res = await rd.client.post("/api/trips/join", json={"code": code})
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text)
                sys.exit(f"加入行程失敗（{code}）：{detail}\n"
                         "邀請碼是 6 碼英數字，在首頁「我的行程」列表或行程頁的「邀請」分頁可以看到。")
            tid = res.json()["id"]
        print(f"{len(riders)} 位模擬隊友已加入行程 {tid}")
        while not a.loop and (await lead.get(f"/api/trips/{tid}")).json()["status"] == "planned":
            print("等建立者在網頁按「開始行程」…", end="\r")
            await asyncio.sleep(2)

    for i, rd in enumerate(riders, 1):
        print(f"  {i}. {rd.nickname}：{rd.dur / 60:.0f} 分鐘、{len(rd.pts)} 點")
    print(f"開始重播（{a.speed:g} 倍速），Ctrl+C 停止")

    lap = 0
    while True:
        lap += 1
        if a.loop:
            reset_trip(tid, lap, [rd.username for rd in riders if not rd.self_user],
                       [rd.username for rd in riders if rd.self_user])
            for rd in riders:
                if rd.self_user:  # 每圈換新的臨時 session（舊的刪掉），Demo 跑幾週也不會過期
                    old = rd.client.headers["authorization"].removeprefix("Bearer ")
                    rd.client.headers["authorization"] = "Bearer " + self_session(rd.self_user)
                    drop_session(old)
                rd.done = False
                rd.batt = 92 - rd.idx * 7
        await run_lap(a, tid, riders, drops)
        if not a.loop:
            break
        print("\n這一圈跑完，30 秒後重新開始")
        await asyncio.sleep(30)


async def run_lap(a, tid, riders, drops):
    t0 = time.monotonic()
    wall0 = int(time.time() * 1000)
    longest = max(rd.dur for rd in riders)
    while True:
        s = (time.monotonic() - t0) * a.speed
        # 時間戳用「重播的時間」（1 倍速），回放和整趟摘要才會是真實的時長與速度
        now_ms = wall0 + int(s * 1000)
        posts = []
        for i, rd in enumerate(riders, 1):
            if rd.done:
                continue
            if s >= rd.dur:
                rd.done = True
                posts.append(rd.client.post(f"/api/trips/{tid}/end"))
                print(f"\n{rd.nickname} 抵達終點，結束紀錄")
                continue
            d = drops.get(i)
            if d and d[0] <= s < d[1]:
                continue
            lat, lon, ele, spd, hd = rd.at(s)
            rd.batt = max(5, rd.batt - 0.002 * a.speed)
            body = {"lat": lat, "lon": lon, "alt": ele, "speed": spd, "heading": hd, "acc": 6,
                    "batt": round(rd.batt), "ts": now_ms, "src": rd.src}
            posts.append(rd.client.post("/api/track", json=body))
        if posts:
            res = await asyncio.gather(*posts, return_exceptions=True)
            bad = [x for x in res if isinstance(x, Exception) or x.status_code >= 400]
            if bad:
                print("\n回報失敗：", bad[0] if isinstance(bad[0], Exception) else bad[0].text)
        print(f"模擬時間 {int(s // 60):3d}:{int(s % 60):02d} / {int(longest // 60)}:{int(longest % 60):02d}", end="\r")
        if all(rd.done for rd in riders):
            break
        await asyncio.sleep(a.interval)
    print("\n全部重播完畢")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已停止")
