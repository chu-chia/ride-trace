"""帳號密碼登入。Session 存在 Redis，用 TTL 自動過期。"""
import hashlib
import hmac
import re
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from .db import K, r

router = APIRouter(prefix="/api")
SESSION_TTL = 30 * 24 * 3600
COOKIE = "qiji_session"
PALETTE = ["#0a84ff", "#ff9f0a", "#30d158", "#bf5af2", "#ff375f", "#5ac8fa", "#ffd60a", "#64d2ff", "#ac8e68", "#ff6482"]


def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        _, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
        return hmac.compare_digest(got.hex(), h)
    except ValueError:
        return False


async def public_user(uid: str) -> dict:
    u = await r.hmget(K.user(uid), "username", "nickname", "color")
    return {"uid": uid, "username": u[0], "nickname": u[1] or u[0], "color": u[2] or PALETTE[0]}


def token_from(request) -> str | None:
    tok = request.cookies.get(COOKIE)
    if not tok:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            tok = auth[7:].strip()
    if not tok:
        tok = request.query_params.get("token")
    return tok


async def uid_from_token(tok: str | None) -> str | None:
    if not tok:
        return None
    return await r.get(K.session(tok))


async def current_uid(request: Request) -> str:
    uid = await uid_from_token(token_from(request))
    if not uid:
        raise HTTPException(401, "請先登入")
    return uid


class RegisterIn(BaseModel):
    username: str
    password: str
    nickname: str | None = None
    color: str | None = None


class LoginIn(BaseModel):
    username: str
    password: str


async def _new_session(resp: Response, uid: str) -> str:
    tok = secrets.token_urlsafe(24)
    await r.set(K.session(tok), uid, ex=SESSION_TTL)
    resp.set_cookie(COOKIE, tok, max_age=SESSION_TTL, httponly=True, samesite="lax")
    return tok


@router.post("/register")
async def register(body: RegisterIn, resp: Response):
    name = body.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9_]{3,20}", name):
        raise HTTPException(400, "帳號只能用 3 到 20 個英文小寫、數字或底線")
    if len(body.password) < 6:
        raise HTTPException(400, "密碼至少 6 個字")
    uid = str(await r.incr("seq:user"))
    # SET NX：帳號已存在就失敗，順便擋掉同時註冊同一個帳號
    if not await r.set(K.username(name), uid, nx=True):
        raise HTTPException(409, "這個帳號已經有人用了")
    color = body.color if body.color in PALETTE else PALETTE[int(uid) % len(PALETTE)]
    await r.hset(K.user(uid), mapping={
        "username": name,
        "nickname": (body.nickname or name).strip()[:12],
        "color": color,
        "pw": hash_pw(body.password),
        "created": int(time.time() * 1000),
    })
    tok = await _new_session(resp, uid)
    return {"user": await public_user(uid), "token": tok}


@router.post("/login")
async def login(body: LoginIn, resp: Response):
    uid = await r.get(K.username(body.username.strip().lower()))
    pw = await r.hget(K.user(uid), "pw") if uid else None
    if not uid or not pw or not check_pw(body.password, pw):
        raise HTTPException(401, "帳號或密碼不對")
    tok = await _new_session(resp, uid)
    return {"user": await public_user(uid), "token": tok}


@router.post("/logout")
async def logout(request: Request, resp: Response):
    tok = token_from(request)
    if tok:
        await r.delete(K.session(tok))
    resp.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/me")
async def me(uid: str = Depends(current_uid)):
    u = await public_user(uid)
    u["active_trip"] = await r.get(K.active_trip(uid))
    return u


class ProfileIn(BaseModel):
    nickname: str | None = None
    color: str | None = None


@router.patch("/me")
async def update_me(body: ProfileIn, uid: str = Depends(current_uid)):
    patch = {}
    if body.nickname and body.nickname.strip():
        patch["nickname"] = body.nickname.strip()[:12]
    if body.color in PALETTE:
        patch["color"] = body.color
    if patch:
        await r.hset(K.user(uid), mapping=patch)
    return await public_user(uid)


@router.get("/me/palette")
async def palette(uid: str = Depends(current_uid)):
    """設定頁的頭像顏色選項（跟註冊時能選的一樣）。"""
    return {"colors": PALETTE}


class PasswordIn(BaseModel):
    old: str
    new: str


@router.post("/me/password")
async def change_password(body: PasswordIn, uid: str = Depends(current_uid)):
    if not check_pw(body.old, await r.hget(K.user(uid), "pw") or ""):
        raise HTTPException(400, "目前的密碼不對")
    if len(body.new) < 6:
        raise HTTPException(400, "新密碼至少 6 個字")
    if body.new == body.old:
        raise HTTPException(400, "新密碼和目前的一樣")
    await r.hset(K.user(uid), "pw", hash_pw(body.new))
    return {"ok": True}


@router.get("/me/device")
async def my_device(uid: str = Depends(current_uid)):
    """Traccar Client 用的裝置 ID：隨機產生，對應到使用者，避免別人冒充回報。"""
    tok = await r.get(K.user_device(uid))
    if not tok:
        tok = "qj" + secrets.token_hex(5)
        await r.set(K.device(tok), uid)
        await r.set(K.user_device(uid), tok)
    return {"device_id": tok}
