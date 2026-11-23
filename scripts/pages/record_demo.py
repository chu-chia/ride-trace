"""錄製報告網頁的展示資料（report/demo-data/）：在 Mac 本機跑一趟真的騎乘，記下每一頁的 API 回應與 WebSocket 訊息。

做法：
1. 建一個展示用帳號 demo_wei（暱稱嘉瑋），開一團「中部橫貫公路」，路線與集合點複製 Mac 上的行程 57。
2. 模擬器用 3/14 中橫的真實軌跡（自己那條改成 demo_wei，不寫進 wei 的足跡），30 倍速跑完全程（約 10 分鐘）。
   行程成員只有機器人和 demo_wei，沒有人訂閱推播，不會推到任何手機。
3. 無頭瀏覽器以 demo_wei 開行程頁、戰情室，記下全部 API 回應與 WebSocket 訊息；中途再開首頁、規劃頁。
4. 以 wei 開足跡頁與回放頁（南橫 48、北宜 55），足跡只留格子等級的資料（見 sanitize）。

用法（repo 根目錄，Mac 的 redis／api／worker／valhalla 要開著）：
    python3 scripts/pages/record_demo.py            # 全部重錄
    python3 scripts/pages/record_demo.py --static   # 只重錄足跡與回放（不跑模擬器）
    python3 scripts/pages/record_demo.py --live     # 只重錄即時行程（錄製期間不要重啟 api／worker）
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "report" / "demo-data"
BASE = "http://127.0.0.1:8750"
PERSONA = "demo_wei"
SRC_TRIP = "57"          # 路線、集合點從這個行程複製
REPLAYS = ["48", "55"]   # 回放頁：南橫、北宜
SPEED = 30
CELL = 0.0015


def rcli(*args) -> str:
    out = subprocess.run(["docker", "compose", "exec", "-T", "redis", "redis-cli", *map(str, args)],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return out.strip()


def session_for(username: str) -> str:
    uid = rcli("GET", f"username:{username}")
    if not uid:
        sys.exit(f"找不到帳號 {username}")
    tok = "demorec_" + secrets.token_urlsafe(12)
    rcli("SET", f"session:{tok}", uid, "EX", 7200)
    return tok


def api(method: str, path: str, tok: str, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {tok}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} → {e.code} {e.read()[:200]!r}")


# ---------- 去除不該公開的資料 ----------

DROP = re.compile(r"^/api/(me/device|push/|admin/|me/heat/detail)")
POST_OK = {"/api/poi/along", "/api/routes/preview"}  # 這幾支 POST 其實是查詢，展示時要有資料


def snap(v: float) -> float:
    return round((int(v // CELL) + 0.5) * CELL, 6)


def snap_lines(geo):
    """軌跡線吸附到格子中心（約 160 m），連續重複的點合併：看起來還是線，但精度跟格子一樣、沒有時間。"""
    def fix(line):
        out = []
        for lon, lat, *_ in line:
            p = [snap(lon), snap(lat)]
            if not out or out[-1] != p:
                out.append(p)
        return out
    g = geo.get("geometry") if isinstance(geo, dict) else None
    if g and g.get("type") == "MultiLineString":
        g["coordinates"] = [fix(l) for l in g["coordinates"] if len(l) > 1]
    elif g and g.get("type") == "LineString":
        g["coordinates"] = fix(g["coordinates"])
    return geo


def sanitize(path: str, body):
    if path.startswith("/api/footprint/lines"):
        return snap_lines(body)
    if path == "/api/footprint/summary" and isinstance(body, dict) and isinstance(body.get("days"), dict):
        # 不露出哪幾天騎車：每個月只保留「騎了幾天、總里程」，日期改成從 1 號開始連續排，每天平均分配
        per = {}
        for d, km in body["days"].items():
            n, tot = per.get(d[:6], (0, 0.0))
            per[d[:6]] = (n + 1, tot + km)
        days = {}
        for m, (n, tot) in sorted(per.items()):
            for i in range(n):
                days[f"{m}{i + 1:02d}"] = round(tot / n, 2)
        body["days"] = days
        for k in ("first_ts", "last_ts"):
            if isinstance(body.get(k), int):
                body[k] = body[k] // 86_400_000 * 86_400_000
    if isinstance(body, dict):
        body.pop("device_id", None)
    return body


# ---------- 錄製 ----------

class Recorder:
    def __init__(self):
        self.http: dict[str, dict] = {}
        self.ws: dict[str, list] = {}
        self.t0 = int(time.time() * 1000)

    def attach(self, page, ws_too=False):
        page.on("response", lambda res: asyncio.ensure_future(self.on_response(res)))
        if ws_too:
            page.on("websocket", self.on_ws)

    async def on_response(self, res):
        url = res.url
        if "/api/" not in url:
            return
        u = urllib.parse.urlsplit(url)
        if DROP.match(u.path):
            return
        method = res.request.method
        key = f"{method} {u.path}{'?' + u.query if u.query else ''}"
        if method == "POST":
            if u.path not in POST_OK:
                return
            try:
                kind = json.loads(res.request.post_data or "{}").get("kind")
            except ValueError:
                kind = None
            key = f"POST {u.path}" + (f"#{kind}" if kind else "")
        elif method != "GET":
            return
        if key in self.http:
            return
        try:
            body = await res.json()
        except Exception:  # noqa: BLE001
            return
        self.http[key] = {"status": res.status, "body": sanitize(u.path, body)}

    def on_ws(self, ws):
        path = urllib.parse.urlsplit(ws.url).path
        frames = self.ws.setdefault(path, [])
        if frames:
            return  # 同一個路徑只錄第一條連線
        ws.on("framereceived", lambda p: frames.append([int(time.time() * 1000) - self.t0, p if isinstance(p, str) else p.decode()]))

    def dump(self, name: str, extra: dict | None = None):
        OUT.mkdir(parents=True, exist_ok=True)
        data = {"t0": self.t0, "http": self.http, **(extra or {})}
        (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  寫入 {name}.json：{len(self.http)} 個 API、{sum(len(v) for v in self.ws.values())} 則 WS")


async def open_page(ctx, path: str, rec: Recorder, wait_ms=8000, ws_too=False, actions=None):
    pg = await ctx.new_page()
    rec.attach(pg, ws_too)
    await pg.goto(BASE + path)
    await pg.wait_for_timeout(wait_ms)
    if actions:
        await actions(pg)
    return pg


async def ctx_for(browser, tok: str, w=1600, h=900):
    c = await browser.new_context(viewport={"width": w, "height": h}, color_scheme="dark")
    await c.add_cookies([{"name": "qiji_session", "value": tok, "url": BASE}])
    return c


async def record_static(browser):
    tok = session_for("wei")
    ctx = await ctx_for(browser, tok)
    rec = Recorder()

    async def tabs(pg):
        for t in ("towns", "heat", "stats"):
            await pg.click(f'#tabs [data-t="{t}"]', force=True)
            await pg.wait_for_timeout(4000)
    await open_page(ctx, "/footprint", rec, 10000, actions=tabs)
    rec.dump("footprint")  # 足跡相關的資料：足跡頁用，首頁的足跡卡片也用
    for tid in REPLAYS:
        r = Recorder()
        await open_page(ctx, f"/replay?id={tid}", r, 10000)
        r.dump(f"replay-{tid}")
    await ctx.close()
    rcli("DEL", f"session:{tok}")


def ensure_persona() -> str:
    if not rcli("GET", f"username:{PERSONA}"):
        pw = secrets.token_urlsafe(16)
        req = urllib.request.Request(BASE + "/api/register", method="POST",
                                     data=json.dumps({"username": PERSONA, "password": pw}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    uid = rcli("GET", f"username:{PERSONA}")
    # 上一次 30 倍速錄製留下的「最後位置」時間在未來，新的點會被當成舊資料丟掉：每次錄之前清掉
    keys = [f"user:{uid}:last", f"footprint:{uid}", f"footprint:{uid}:geo", f"footprint:{uid}:daykm", f"fog:{uid}:all", f"heat:{uid}"]
    keys += rcli("--scan", "--pattern", f"fog:{uid}:*").split()
    keys += [f"user:{uid}:trips", f"user:{uid}:active_trip"]  # 首頁只列這次錄的行程
    rcli("DEL", *keys)
    tok = session_for(PERSONA)
    api("PATCH", "/api/me", tok, {"nickname": "嘉瑋", "color": "#5ac8fa"})
    return tok


def make_trip(tok: str) -> tuple[str, str]:
    t = api("POST", "/api/trips", tok, {"name": "中部橫貫公路 埔里-武嶺-太魯閣"})
    tid, code = str(t["id"]), t["invite"]
    rid = rcli("HGET", f"trip:{SRC_TRIP}", "route")
    if rid:
        rcli("HSET", f"trip:{tid}", "route", rid, "lag_km", 1.0)
    # demo=1：後端只在示範行程接受 sim-self（模擬器代替真人重播）的點，展示帳號才會出現在地圖上；示範行程也不推播
    rcli("HSET", f"trip:{tid}", "demo", 1)
    rcli("COPY", f"trip:{SRC_TRIP}:waypoints", f"trip:{tid}:waypoints", "REPLACE")
    for k in rcli("--scan", "--pattern", f"trip:{SRC_TRIP}:wp:*").split():
        rcli("COPY", k, k.replace(f"trip:{SRC_TRIP}:", f"trip:{tid}:", 1), "REPLACE")
    print(f"行程 {tid}（邀請碼 {code}），路線 {rid}")
    return tid, code


def tracks_copy() -> str:
    d = tempfile.mkdtemp(prefix="demo-tracks-")
    for f in sorted((ROOT / "data" / "tracks").glob("zh314-*.json")):
        t = json.loads(f.read_text(encoding="utf-8"))
        if t.get("self"):
            t["self"], t["label"] = PERSONA, "嘉瑋"
        (Path(d) / f.name).write_text(json.dumps(t), encoding="utf-8")
    return d


async def record_live(browser):
    tok = ensure_persona()
    tid, code = make_trip(tok)
    tdir = tracks_copy()
    sim = subprocess.Popen(["uv", "run", "python", "-m", "tools.simulate", "--group", "zh314", "--code", code,
                            "--tracks", tdir, "--speed", str(SPEED), "--interval", "1"],
                           cwd=ROOT / "backend", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(8)  # 等機器人加入
    api("POST", f"/api/trips/{tid}/start", tok, {})
    live = Recorder()
    ctx = await ctx_for(browser, tok)
    await open_page(ctx, f"/trip?id={tid}", live, 3000, ws_too=True)
    war = Recorder()
    war.t0 = live.t0
    await open_page(ctx, f"/war?id={tid}", war, 3000)
    await asyncio.sleep(150)  # 騎一段再錄首頁和規劃頁（隊伍散開、有事件）
    wei = session_for("wei")
    ended = [t for t in api("GET", "/api/trips", wei) if str(t.get("id")) in REPLAYS]  # 首頁「我的行程」加上南橫、北宜（可以點去回放）
    rcli("DEL", f"session:{wei}")
    for name, path in (("index", "/"), (f"plan-{tid}", f"/plan?trip={tid}")):
        r = Recorder()
        await open_page(ctx, path, r, 8000)
        if name == "index":
            lst = r.http.get("GET /api/trips")
            if lst and isinstance(lst["body"], list):
                lst["body"] += ended
            for k in [k for k in r.http if re.match(r"GET /api/(footprint|me/(heat|towns|stats|pace))", k)]:
                del r.http[k]  # 首頁的足跡卡片用 wei 的（footprint.json），不用展示帳號的
        r.dump(name)
    print("等模擬器跑完…")
    while sim.poll() is None:
        await asyncio.sleep(5)
    await asyncio.sleep(5)
    live.dump(f"trip-{tid}", {"ws": live.ws, "tid": tid})
    war.dump(f"war-{tid}", {"tid": tid})
    (OUT / "live.json").write_text(json.dumps({"tid": tid}), encoding="utf-8")
    for old in OUT.glob("*-*.json"):  # 上一次錄的行程檔
        m = re.match(r"(trip|war|plan)-(\d+)\.json$", old.name)
        if m and m.group(2) != tid:
            old.unlink()
    await ctx.close()
    shutil.rmtree(tdir, ignore_errors=True)
    rcli("DEL", f"session:{tok}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--static", action="store_true", help="只錄足跡與回放")
    ap.add_argument("--live", action="store_true", help="只錄即時行程（不重錄足跡與回放）")
    a = ap.parse_args()
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=metal"])
        if not a.live:
            await record_static(b)
        if not a.static:
            await record_live(b)
        await b.close()


if __name__ == "__main__":
    asyncio.run(main())
