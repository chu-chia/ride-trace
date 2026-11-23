"""網頁匯入足跡：上傳 GPX／KML／Google 時間軸 → 排進 Stream → worker 合併重建。

流程與 Redis：
1. API 收到檔案：`SET import:lock:{uid} {job} NX EX` 一個人同時只能有一個匯入；
   原始檔先放 `import:{job}:file`（String，1 小時 TTL，worker 讀完就刪）；
   進度放 `import:{job}`（Hash，7 天 TTL）；`LPUSH user:{uid}:imports` 留最近 20 筆。
2. `XADD stream:import`，worker 的 consumer group `import` 領取（處理完才 XACK）。
3. worker 把「原本的足跡＋新的點」依時間合併、去重（同一秒已經有點就不收），
   全部重算寫進暫存 key（`imp:{job}:…`），最後用 WATCH＋MULTI/EXEC 一次 RENAME 換上：
   - 換上之前如果有新的即時回報寫進足跡（WATCH 的 key 被改），交易會失敗，重新合併再試，
     騎車中匯入也不會弄丟剛回報的點；
   - 換的過程是原子的，畫面不會讀到「一半舊、一半新」的足跡。
   為什麼不直接 XADD：Stream 的 ID 必須遞增，比現有最後一筆舊的點根本加不進去，所以要重建。
4. `INCR fp:ver:{uid}`：足跡查詢快取的 key 帶版本號，舊快取自然失效。
"""
import asyncio
import io
import json
import logging
import secrets
import time
from collections import Counter, defaultdict

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Request
from redis.exceptions import WatchError

from .auth import current_uid
from .db import REDIS_URL, K, r
from .geo import CELL, bucket_of, cell_of, day_key, haversine_m, segment_cells, step
from .import_parse import ImportError_, parse_any

log = logging.getLogger("qiji.import")
router = APIRouter(prefix="/api/footprint")

STREAM = "stream:import"
GROUP = "import"
MAX_UPLOAD = 100 * 1024 * 1024    # 上傳最多 100 MB（ZIP 解開後最多 1 GB）
MAX_NEW_POINTS = 600_000           # 一次最多加 60 萬點（Google 多年的 Records.json 可能上百萬點）
FILE_TTL = 3600
JOB_TTL = 7 * 86400
LOCK_TTL = 1800
CHUNK = 5000

rb = aioredis.from_url(REDIS_URL, decode_responses=False)  # 原始檔是二進位，不能用 decode_responses 的連線讀


def jkey(job: str) -> str:
    return f"import:{job}"


def fkey(job: str) -> str:
    return f"import:{job}:file"


def lkey(uid: str) -> str:
    return f"import:lock:{uid}"


# 只有自己持有的鎖才刪（compare-and-delete），避免刪到下一個匯入的鎖
UNLOCK_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"


# ---------- API ----------

@router.post("/import")
async def upload(request: Request, uid: str = Depends(current_uid)):
    """前端直接 POST 檔案內容（不用 multipart），檔名放在 X-Filename。"""
    name = request.headers.get("x-filename", "upload")
    try:
        from urllib.parse import unquote
        name = unquote(name)[:200]
    except Exception:  # noqa: BLE001
        pass
    size = int(request.headers.get("content-length") or 0)
    if size > MAX_UPLOAD:
        raise HTTPException(413, "檔案超過 100 MB。Google 的 Records.json 很大時，可以先壓成 ZIP 再上傳。")
    job = secrets.token_hex(6)
    if not await r.set(lkey(uid), job, nx=True, ex=LOCK_TTL):
        raise HTTPException(409, "上一個檔案還在匯入中，等它完成再上傳下一個。")
    try:
        buf = io.BytesIO()
        async for chunk in request.stream():
            buf.write(chunk)
            if buf.tell() > MAX_UPLOAD:
                raise HTTPException(413, "檔案超過 100 MB。")
        data = buf.getvalue()
        if not data:
            raise HTTPException(400, "檔案是空的")
        now = int(time.time() * 1000)
        async with r.pipeline(transaction=True) as p:
            p.hset(jkey(job), mapping={"uid": uid, "name": name, "size": len(data), "status": "queued",
                                       "msg": "排隊中", "created": now})
            p.expire(jkey(job), JOB_TTL)
            p.lpush(f"user:{uid}:imports", job)
            p.ltrim(f"user:{uid}:imports", 0, 19)
            await p.execute()
        await rb.set(fkey(job), data, ex=FILE_TTL)
        await r.xadd(STREAM, {"job": job, "uid": uid}, maxlen=1000, approximate=True)
    except BaseException:
        await r.eval(UNLOCK_LUA, 1, lkey(uid), job)
        raise
    return {"job": job}


def job_view(job: str, h: dict) -> dict:
    out = {"job": job, **{k: h.get(k) for k in ("name", "status", "msg", "format")}}
    for k in ("size", "created", "finished", "total", "added", "dup", "skipped", "notime", "pct", "before", "after"):
        if h.get(k) not in (None, ""):
            out[k] = int(float(h[k]))
    return out


@router.get("/imports")
async def list_imports(uid: str = Depends(current_uid)):
    jobs = await r.lrange(f"user:{uid}:imports", 0, 19)
    async with r.pipeline(transaction=False) as p:
        for j in jobs:
            p.hgetall(jkey(j))
        rows = await p.execute()
    return {"imports": [job_view(j, h) for j, h in zip(jobs, rows) if h and h.get("uid") == uid]}


@router.get("/imports/{job}")
async def get_import(job: str, uid: str = Depends(current_uid)):
    h = await r.hgetall(jkey(job))
    if not h or h.get("uid") != uid:
        raise HTTPException(404, "找不到這個匯入")
    return job_view(job, h)


# ---------- worker ----------

async def progress(job: str, **f):
    await r.hset(jkey(job), mapping={k: v for k, v in f.items() if v is not None})


async def read_existing(uid: str) -> tuple[list, str]:
    """讀出目前的全部足跡，回傳 (點, 最後一筆的 Stream ID)。"""
    pts, last, last_id = [], "-", "0-0"
    while True:
        batch = await r.xrange(K.footprint(uid), min=last, max="+", count=20000)
        if last != "-":
            batch = batch[1:]
        if not batch:
            break
        for sid, f in batch:
            try:
                pts.append((int(sid.split("-")[0]), float(f["lat"]), float(f["lon"]), float(f.get("ele") or 0), True))
            except (KeyError, ValueError):
                continue
        last = last_id = batch[-1][0]
    return pts, last_id


def merge(existing: list, new: list) -> tuple[list, dict]:
    """依時間合併。原本的點全部保留；新的點同一秒已經有點就算重複，跳點（> 250 km/h）不收。"""
    secs = {p[0] // 1000 for p in existing}
    cand, dup = [], 0
    for ts, lat, lon, ele in new:
        s = ts // 1000
        if s in secs:
            dup += 1
            continue
        secs.add(s)
        cand.append((s * 1000, lat, lon, ele, False))  # 對齊到秒，Stream ID 才不會跟同一秒的其他點撞
    allp = sorted(existing + cand, key=lambda p: p[0])
    out, prev, added, skipped = [], None, 0, 0
    for p in allp:
        if not p[4] and prev:
            gap_s = (p[0] - prev[0]) / 1000
            if gap_s < 3600 and haversine_m(prev[1], prev[2], p[1], p[2]) / max(gap_s, 0.001) * 3.6 > 250:
                skipped += 1
                continue
        if not p[4]:
            added += 1
            if added > MAX_NEW_POINTS:
                skipped += 1
                continue
        out.append(p)
        prev = p
    return out, {"dup": dup, "skipped": skipped, "added": min(added, MAX_NEW_POINTS)}


def derive(pts: list) -> dict:
    """從整份足跡算出迷霧格子、每日里程、熱力圖格子計數、每格第一次出現的時間（純計算，丟到執行緒跑）。"""
    fog = defaultdict(set)
    daykm = defaultdict(float)
    heat = Counter()
    first = {}
    prev = anchor = None
    for ts, lat, lon, _ele, _old in pts:
        cur = (ts, lat, lon)
        fog[(day_key(ts), bucket_of(ts))] |= segment_cells(prev, cur)
        dist, _, anchor = step(anchor, cur)
        daykm[day_key(ts)] += dist / 1000
        c = cell_of(lat, lon)
        heat[c] += 1
        first.setdefault(c, ts)
        prev = cur
    return {"fog": fog, "daykm": daykm, "heat": heat, "first": first, "anchor": anchor}


async def towns_of(cells: list[str]) -> dict[str, str]:
    """格子 → 鄉鎮：先查 celltown 快取，沒有的用 GEOSHAPE 空間索引查（Pipeline 每批 1000）。"""
    out = dict(zip(cells, await r.hmget("celltown", cells))) if cells else {}
    todo = [c for c, v in out.items() if v is None]
    for s in range(0, len(todo), 1000):
        chunk = todo[s:s + 1000]
        async with r.pipeline(transaction=False) as q:
            for c in chunk:
                a, b = c.split(":")
                lat, lon = (int(a) + 0.5) * CELL, (int(b) + 0.5) * CELL
                q.execute_command("FT.SEARCH", "idx:townshape", "@shape:[CONTAINS $pt]", "PARAMS", 2, "pt",
                                  f"POINT({lon:.6f} {lat:.6f})", "RETURN", 1, "code", "LIMIT", 0, 1, "DIALECT", 3)
            res = await q.execute(raise_on_error=False)
        for c, x in zip(chunk, res):
            code = "-"
            if isinstance(x, dict):
                rows = x.get("results", [])
                code = rows[0]["id"].split(":")[1] if rows else "-"
            elif isinstance(x, list) and x and x[0]:
                code = x[1].split(":")[1]
            out[c] = code
        if chunk:
            await r.hset("celltown", mapping={c: out[c] for c in chunk})
    return out


async def write_tmp(job: str, uid: str, pts: list, d: dict, town_of: dict) -> dict[str, str]:
    """把重建好的資料寫進暫存 key，回傳 {暫存 key: 正式 key}。"""
    pre = f"imp:{job}:"
    swap: dict[str, str] = {}

    def tmp(real: str) -> str:
        swap[pre + real] = real
        return pre + real

    fp, geo, dk, fall, heat, towns, tfirst = (tmp(K.footprint(uid)), tmp(K.fp_geo(uid)), tmp(K.daykm(uid)),
                                              tmp(K.fog_all(uid)), tmp(f"heat:{uid}"), tmp(f"user:{uid}:towns"),
                                              tmp(f"user:{uid}:townfirst"))
    for i in range(0, len(pts), CHUNK):
        async with r.pipeline(transaction=False) as p:
            for ts, lat, lon, ele, _old in pts[i:i + CHUNK]:
                p.xadd(fp, {"lat": f"{lat:.7f}", "lon": f"{lon:.7f}", "ele": f"{ele:.1f}"}, id=f"{ts}-*")
                p.geoadd(geo, [lon, lat, str(ts)])
            await p.execute(raise_on_error=False)
        await progress(job, pct=40 + int(40 * (i + CHUNK) / max(1, len(pts))), msg="寫入足跡")
    async with r.pipeline(transaction=False) as p:
        all_cells = set()
        for (day, b), cells in d["fog"].items():
            if cells:
                p.sadd(tmp(K.fog(uid, day, b)), *cells)
                all_cells |= cells
        cl = list(all_cells)
        for i in range(0, len(cl), CHUNK):
            p.sadd(fall, *cl[i:i + CHUNK])
        if d["daykm"]:
            p.hset(dk, mapping={k: round(v, 4) for k, v in d["daykm"].items()})
        hl = list(d["heat"].items())
        for i in range(0, len(hl), CHUNK):
            p.zadd(heat, dict(hl[i:i + CHUNK]))
        tfirst_map = {}
        for c, ts in d["first"].items():
            code = town_of.get(c)
            if code and code != "-":
                tfirst_map[code] = min(tfirst_map.get(code, ts), ts)
        if tfirst_map:
            p.sadd(towns, *tfirst_map)
            p.hset(tfirst, mapping=tfirst_map)
        await p.execute()
    # 空的集合 Redis 不會建立 key，RENAME 會失敗：只換真的存在的
    async with r.pipeline(transaction=False) as p:
        keys = list(swap)
        for k in keys:
            p.exists(k)
        ex = await p.execute()
    return {k: swap[k] for k, e in zip(keys, ex) if e}


async def swap_in(uid: str, last_id: str, mapping: dict[str, str], last_pt, anchor) -> bool:
    """WATCH 足跡 Stream：從讀取到現在沒有新點寫入，才用 MULTI/EXEC 一次換上；有的話回傳 False 重來。"""
    old_fog = [k async for k in r.scan_iter(f"fog:{uid}:*", count=1000)]
    async with r.pipeline(transaction=True) as p:
        try:
            await p.watch(K.footprint(uid))
            now_last = await p.xrevrange(K.footprint(uid), count=1)
            if (now_last[0][0] if now_last else "0-0") != last_id:
                await p.unwatch()
                return False
            p.multi()  # 以下指令排進交易，EXEC 時一次執行（RENAME 會蓋掉原本的 key）
            new_reals = set(mapping.values())
            for k in old_fog:
                if k not in new_reals:
                    p.delete(k)
            for t, real in mapping.items():
                p.rename(t, real)
            for real in (K.footprint(uid), K.fp_geo(uid), K.daykm(uid), K.fog_all(uid),
                         f"heat:{uid}", f"user:{uid}:towns", f"user:{uid}:townfirst"):
                if real not in new_reals:
                    p.delete(real)
            if last_pt:
                p.hset(K.last(uid), mapping={"ts": last_pt[0], "lat": last_pt[1], "lon": last_pt[2],
                                             "ats": anchor[0], "alat": anchor[1], "alon": anchor[2]})
            p.incr(K.fp_ver(uid))
            await p.execute()
            return True
        except WatchError:
            return False


async def drop_tmp(job: str):
    keys = [k async for k in r.scan_iter(f"imp:{job}:*", count=1000)]
    for i in range(0, len(keys), 500):
        await r.delete(*keys[i:i + 500])


async def run_job(job: str, uid: str):
    h = await r.hgetall(jkey(job))
    if not h or h.get("status") in ("done", "error"):
        return  # 重送的訊息：已經做完
    # 多個 worker 時，XAUTOCLAIM 可能把還在跑的大檔交給別人：用 NX 鎖確保同一個工作只有一個在跑
    if not await r.set(f"import:run:{job}", 1, nx=True, ex=LOCK_TTL):
        return
    try:
        data = await rb.get(fkey(job))
        if data is None:
            raise ImportError_("檔案已過期（超過 1 小時沒處理），請重新上傳")
        await progress(job, status="parsing", msg="讀取檔案", pct=5)
        parsed = await asyncio.to_thread(parse_any, h.get("name", ""), data)
        new = parsed["points"]
        await progress(job, format=parsed["format"], total=len(new), notime=parsed["notime"], pct=15, msg="比對原本的足跡")
        if not new:
            raise ImportError_("檔案裡沒有帶時間的位置點" + (f"（{parsed['notime']} 個點沒有時間）" if parsed["notime"] else ""))
        for attempt in range(3):
            existing, last_id = await read_existing(uid)
            pts, st = await asyncio.to_thread(merge, existing, new)
            await progress(job, status="merging", dup=st["dup"], skipped=st["skipped"], added=st["added"],
                           before=len(existing), pct=25, msg="計算迷霧格子、里程、熱力圖")
            if not st["added"]:
                break
            d = await asyncio.to_thread(derive, pts)
            await progress(job, pct=35, msg="查詢經過的鄉鎮")
            town_of = await towns_of(list(d["heat"]))
            await progress(job, status="writing", pct=40, msg="寫入足跡")
            mapping = await write_tmp(job, uid, pts, d, town_of)
            last = pts[-1]
            if await swap_in(uid, last_id, mapping, last, d["anchor"]):
                break
            await drop_tmp(job)  # 期間有新的即時回報：重新合併
            await progress(job, msg=f"有新的回報寫入，重新合併（第 {attempt + 2} 次）")
        else:
            raise ImportError_("一直有新的位置回報寫入，請騎完再匯入")
        after = await r.xlen(K.footprint(uid))
        await progress(job, status="done", pct=100, after=after, finished=int(time.time() * 1000),
                       msg="完成" if st["added"] else "沒有新的點（都已經在足跡裡了）")
    except ImportError_ as e:
        await progress(job, status="error", msg=str(e), finished=int(time.time() * 1000))
    except Exception:  # noqa: BLE001
        log.exception("匯入失敗：job=%s", job)
        await progress(job, status="error", msg="匯入時發生錯誤，請稍後再試", finished=int(time.time() * 1000))
    finally:
        await drop_tmp(job)
        await r.delete(fkey(job), f"import:run:{job}")
        await r.eval(UNLOCK_LUA, 1, lkey(uid), job)
    if (await r.hget(jkey(job), "status")) == "done":
        from . import footprint
        try:
            await footprint.warm_all(uid)  # 先把首頁和足跡頁會用的資料算好
        except Exception:  # noqa: BLE001
            log.exception("匯入後預算足跡失敗")


async def handle_import(msgs: list[tuple[str, dict]]) -> list[str]:
    for _, f in msgs:
        if f.get("job") and f.get("uid"):
            await run_job(f["job"], f["uid"])
    return [i for i, _ in msgs]
