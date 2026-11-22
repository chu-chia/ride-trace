import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from html import escape
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import admin, admin_ops, admin_test, auth, chat, footprint, ingest, interact, live, longterm, pace, poi, push, replay, routes, speedcam, system, trips, waypoints
from .auth import token_from, uid_from_token
from .db import r

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parents[2] / "web"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await r.ping()
    await r.set("stat:ws", 0)  # 後台的 WebSocket 連線數：重開時舊連線都斷了，從 0 算起
    task = asyncio.create_task(live.expiry_listener())
    yield
    task.cancel()


app = FastAPI(title="騎跡 API", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
for mod in (auth, trips, replay, ingest, live, footprint, system, waypoints, speedcam, interact, routes, poi, pace, longterm, admin, admin_ops, admin_test, chat, push):
    app.include_router(mod.router)


@app.get("/api/health")
async def health():
    info = await r.info("server")
    return {"ok": True, "redis": info.get("redis_version"), "deploy": deployed()}


def deployed() -> dict | None:
    """Windows 自動部署（scripts/windows/autodeploy.ps1）寫的 web/deployed.json：現在跑的是哪個 commit、什麼時候部署的。
    Mac 開發機沒有這個檔，回 None。"""
    try:
        return json.loads((WEB_DIR / "deployed.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def page(file: str):
    async def handler():
        return FileResponse(WEB_DIR / file, headers={"Cache-Control": "no-cache"})
    return handler


def error_page(code: int, title: str, msg: str, actions: str = "") -> HTMLResponse:
    """給人看的錯誤頁（中文＋回首頁）。/api 底下仍回 JSON。"""
    html = (WEB_DIR / "error.html").read_text(encoding="utf-8")
    for k, v in {"code": str(code), "title": escape(title), "msg": escape(msg), "actions": actions}.items():
        html = html.replace("{{" + k + "}}", v)
    return HTMLResponse(html, status_code=code, headers={"Cache-Control": "no-cache"})


def wants_json(request: Request) -> bool:
    p = request.url.path
    return p.startswith("/api/") or p.startswith("/ws/") or "application/json" in request.headers.get("accept", "")


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    if wants_json(request) or exc.status_code != 404:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))
    return error_page(404, "找不到這個頁面", "網址可能打錯了，或這個頁面已經移走。")


@app.exception_handler(Exception)
async def server_error(request: Request, exc: Exception):
    # 沒接住的例外（uvicorn 會另外印出 traceback）：回中文訊息；前端 api() 會把 detail 顯示出來
    if wants_json(request):
        return JSONResponse({"detail": "伺服器發生錯誤，請稍後再試"}, status_code=500)
    return error_page(500, "伺服器發生錯誤", "請稍後再試一次。", '<a class="btn" href="">重新整理</a>')


async def admin_uid(request: Request):
    """後台：沒登入 → 登入頁；不是管理者 → 403 頁，後台的 HTML 和 JS 都不送出去。"""
    uid = await uid_from_token(token_from(request))
    if not uid:
        return None, RedirectResponse("/login?next=" + quote("/admin"), status_code=302)
    if not await admin.is_admin(uid):
        return uid, error_page(403, "沒有權限", "管理後台只有管理者可以使用。")
    return uid, None


@app.get("/admin", include_in_schema=False)
async def admin_page(request: Request):
    _, deny = await admin_uid(request)
    return deny or FileResponse(WEB_DIR / "admin.html", headers={"Cache-Control": "no-cache"})


def admin_asset(file: str):
    async def handler(request: Request):
        _, deny = await admin_uid(request)
        if deny:
            return JSONResponse({"detail": "只有管理者可以看後台"}, status_code=403)
        return FileResponse(WEB_DIR / "assets" / file, media_type="text/javascript", headers={"Cache-Control": "no-cache"})
    return handler


# 後台的 JS 只給管理者（要在下面 /assets 靜態檔 mount 之前註冊，才會先比對到）
for f in ("admin.js", "admin-test.js", "admin-ops.js"):
    app.add_api_route(f"/assets/{f}", admin_asset(f), include_in_schema=False)


@app.get("/me", include_in_schema=False)
async def me_page():
    # 舊網址：「我的紀錄」＝首頁的「我的行程」清單（鄉鎮足跡在 /footprint?tab=towns）
    return RedirectResponse("/#trips", status_code=302)


@app.get("/w/{tok}", include_in_schema=False)
async def watch_page(tok: str):
    """觀看連結（免登入看戰情室）：換成戰情室網址；連結失效時戰情室會顯示說明"""
    from .trips import watch_tid
    tid = await watch_tid(tok)
    return RedirectResponse(f"/war?id={tid or 0}&watch={quote(tok)}", status_code=302)


DEMO_TRIP = os.getenv("DEMO_TRIP", "57")


@app.get("/api/demo", include_in_schema=False)
async def demo_link():
    """首頁、關於頁的「看示範車隊」：Demo 行程（compose 的 demo 服務一直在跑的那趟）的觀看連結，不用登入。
    已經有有效的觀看連結就沿用（不會讓建立者發出去的連結失效）；沒有或 7 天到期了才產生一條新的。
    Demo 沒在跑（沒有 demo 標記、不是進行中）就回 null，前端不顯示入口。"""
    import secrets
    from .db import K, r
    t = await r.hgetall(K.trip(DEMO_TRIP))
    if not t or t.get("status") != "live" or not t.get("demo"):
        return {"url": None}
    tok = t.get("watch")
    if not tok or not await r.exists(K.watch(tok)):
        tok = secrets.token_urlsafe(12)
        async with r.pipeline(transaction=True) as p:
            p.set(K.watch(tok), DEMO_TRIP, ex=trips.WATCH_TTL)
            p.hset(K.trip(DEMO_TRIP), "watch", tok)
            await p.execute()
    return {"url": f"/w/{quote(tok)}", "name": t.get("name", "")}


PAGES = {"/war": "war.html", "/plan": "plan.html", "/": "index.html", "/login": "login.html", "/trip": "trip.html", "/replay": "replay.html", "/footprint": "footprint.html", "/about": "about.html", "/settings": "settings.html", "/nav": "trip.html"}  # /nav＝行程頁的導航模式
for path, file in PAGES.items():
    app.add_api_route(path, page(file), include_in_schema=False)

# Service Worker 要放在網站根目錄，scope 才能涵蓋所有頁面；manifest 給「加入主畫面」（iPhone 要這樣才收得到推播）
@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(WEB_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    return FileResponse(WEB_DIR / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


class NoCacheStatic(StaticFiles):
    """前端檔案每次都向伺服器確認有沒有更新（用 ETag，沒改就回 304），改完重新整理就生效。"""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


class VendorStatic(StaticFiles):
    """第三方套件（MapLibre 等）自架：路徑帶版本號，內容不會變，讓瀏覽器長期快取。
    不靠 CDN：在山上網路不穩時 CDN 掛掉不會拖垮行程頁的 SOS。"""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


app.mount("/assets", NoCacheStatic(directory=WEB_DIR / "assets"), name="assets")
app.mount("/vendor", VendorStatic(directory=WEB_DIR / "vendor"), name="vendor")
