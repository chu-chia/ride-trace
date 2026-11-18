import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import admin, admin_ops, admin_test, auth, chat, footprint, ingest, interact, live, longterm, pace, poi, push, replay, routes, speedcam, system, trips, waypoints
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
    return {"ok": True, "redis": info.get("redis_version")}


def page(file: str):
    async def handler():
        return FileResponse(WEB_DIR / file, headers={"Cache-Control": "no-cache"})
    return handler


PAGES = {"/admin": "admin.html", "/war": "war.html", "/me": "me.html", "/plan": "plan.html", "/": "index.html", "/login": "login.html", "/trip": "trip.html", "/replay": "replay.html", "/footprint": "footprint.html", "/about": "about.html"}
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
