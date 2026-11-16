import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, footprint, ingest, live, replay, system, trips
from .db import r

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parents[2] / "web"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await r.ping()
    task = asyncio.create_task(live.expiry_listener())
    yield
    task.cancel()


app = FastAPI(title="騎跡 API", lifespan=lifespan)
for mod in (auth, trips, replay, ingest, live, footprint, system):
    app.include_router(mod.router)


@app.get("/api/health")
async def health():
    info = await r.info("server")
    return {"ok": True, "redis": info.get("redis_version")}


def page(file: str):
    async def handler():
        return FileResponse(WEB_DIR / file, headers={"Cache-Control": "no-cache"})
    return handler


PAGES = {"/": "index.html", "/login": "login.html", "/trip": "trip.html", "/replay": "replay.html", "/footprint": "footprint.html"}
for path, file in PAGES.items():
    app.add_api_route(path, page(file), include_in_schema=False)

class NoCacheStatic(StaticFiles):
    """前端檔案每次都向伺服器確認有沒有更新（用 ETag，沒改就回 304），改完重新整理就生效。"""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/assets", NoCacheStatic(directory=WEB_DIR / "assets"), name="assets")
