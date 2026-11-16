"""繳交用的 Redis 資料庫匯出（輸出到 data/export/，不進版控）。

    # 建議：展示用的乾淨版本（去掉指定帳號的個人足跡、所有登入憑證與密碼雜湊）
    uv run python -m tools.export_redis --mode demo --private-user wei
    # 原封不動整個資料庫（含個人足跡，自己決定要不要交）
    uv run python -m tools.export_redis --mode full

demo 模式的做法：開一個暫時的 Redis 8 容器，把要留的 key 用 DUMP／RESTORE 複製過去
（TimeSeries、JSON 這些模組型別也能這樣搬），刪掉敏感欄位，重建 RediSearch 索引，SAVE 成 RDB 再拷出來。
產出的 dump.rdb 放進任何 Redis 8 的資料目錄就能直接載入。
"""
import argparse
import os
import subprocess
import time

import redis

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
OUT = os.path.join(ROOT, "data", "export")
SRC_CONTAINER = "qiji-redis-1"
TMP_CONTAINER = "qiji-export-tmp"
TMP_PORT = 6399

# 和匯入工具相同的索引定義（索引不是 key，搬 key 不會跟著過去）
INDEXES = [
    ["FT.CREATE", "idx:speedcam", "ON", "HASH", "PREFIX", "1", "speedcam:", "LANGUAGE", "chinese",
     "SCHEMA", "addr_n", "TEXT", "city", "TAG", "region", "TAG", "limit", "NUMERIC", "SORTABLE", "loc", "GEO"],
    ["FT.CREATE", "idx:poi", "ON", "HASH", "PREFIX", "1", "poi:", "LANGUAGE", "chinese",
     "SCHEMA", "name_n", "TEXT", "WEIGHT", "2", "kind", "TAG", "brand", "TEXT", "rank", "NUMERIC", "SORTABLE", "loc", "GEO"],
    ["FT.CREATE", "idx:townshape", "ON", "HASH", "PREFIX", "1", "townpart:", "SCHEMA", "code", "TAG", "shape", "GEOSHAPE", "FLAT"],
]


def sh(*cmd, check=True):
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def private_patterns(uid: str) -> list[str]:
    """個人位置與從它算出來的東西。"""
    return [f"footprint:{uid}", f"footprint:{uid}:*", f"fog:{uid}:*", f"heat:{uid}", f"ts:pace:{uid}:*",
            f"user:{uid}:towns", f"user:{uid}:townfirst", f"user:{uid}:last", f"cache:lines:{uid}:*",
            # 他在行程裡回報過的位置
            f"track:*:{uid}", f"trip:*:state:{uid}", f"trip:*:stats:{uid}", f"ts:*:{uid}:*", f"hb:*:{uid}"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["demo", "full"], default="demo")
    ap.add_argument("--private-user", action="append", default=[], help="這些帳號的個人足跡不匯出（可重複）")
    ap.add_argument("--redis", default=os.environ.get("REDIS_URL", "redis://localhost:6390/0"))
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")
    src = redis.Redis.from_url(a.redis)

    if a.mode == "full":
        src.bgsave()
        last = src.lastsave()
        while src.lastsave() == last:
            time.sleep(0.5)
        dst = os.path.join(OUT, f"qiji-full-{stamp}.rdb")
        sh("docker", "cp", f"{SRC_CONTAINER}:/data/dump.rdb", dst)
        print(f"完整匯出：{dst}（{os.path.getsize(dst) / 1e6:.1f} MB，含個人足跡）")
        return

    # 要排除的 key
    skip = set()
    for name in a.private_user:
        uid = src.get(f"username:{name}")
        if not uid:
            raise SystemExit(f"找不到帳號 {name}")
        for pat in private_patterns(uid.decode()):
            skip.update(src.scan_iter(pat, count=5000))
    # celltown 是「去過的格子 → 鄉鎮」快取，等於列出去過哪裡；stream:ingest 是工作佇列，含最近的位置
    for pat in ("session:*", "device:*", "user:*:device", "cache:*", "ratelimit:*", "celltown", "stream:ingest",
                "online:*", "camhit:*", "hazhit:*"):
        skip.update(src.scan_iter(pat, count=5000))

    sh("docker", "rm", "-f", TMP_CONTAINER, check=False)
    sh("docker", "run", "-d", "--name", TMP_CONTAINER, "-p", f"{TMP_PORT}:6379", "redis:8.2", "redis-server", "--save", "")
    dst_r = redis.Redis(port=TMP_PORT)
    for _ in range(50):
        try:
            dst_r.ping()
            break
        except redis.ConnectionError:
            time.sleep(0.2)
    copied = 0
    try:
        batch = []

        def flush():
            nonlocal copied
            p = src.pipeline(transaction=False)
            for k in batch:
                p.dump(k)
                p.pttl(k)
            res = p.execute()
            q = dst_r.pipeline(transaction=False)
            for i, k in enumerate(batch):
                data, ttl = res[2 * i], res[2 * i + 1]
                if data is not None:
                    q.restore(k, max(0, ttl), data, replace=True)
                    copied += 1
            q.execute()
            batch.clear()

        for k in src.scan_iter(count=5000):
            if k in skip:
                continue
            batch.append(k)
            if len(batch) >= 2000:
                flush()
        if batch:
            flush()
        # 即時位置 GEO 裡的個人成員
        private_uids = [src.get(f"username:{n}").decode() for n in a.private_user]
        for k in dst_r.scan_iter("trip:*:geo", count=5000):
            if private_uids:
                dst_r.zrem(k, *private_uids)
        # 密碼雜湊也拿掉（帳密塗銷）
        for k in dst_r.scan_iter("user:[0-9]*", count=5000):
            if dst_r.type(k) == b"hash":
                dst_r.hdel(k, "pw")
        for cmd in INDEXES:
            dst_r.execute_command(*cmd)
        dst_r.save()
        out = os.path.join(OUT, f"qiji-demo-{stamp}.rdb")
        sh("docker", "cp", f"{TMP_CONTAINER}:/data/dump.rdb", out)
        print(f"展示用匯出：{out}（{os.path.getsize(out) / 1e6:.1f} MB）")
        print(f"  複製 {copied} 個 key；排除 {len(skip)} 個（個人足跡、登入憑證、裝置 ID、快取），並移除所有密碼雜湊")
        print("  載入方式：把檔案改名成 dump.rdb 放進 Redis 8 的資料目錄後啟動")
    finally:
        sh("docker", "rm", "-f", TMP_CONTAINER, check=False)


if __name__ == "__main__":
    main()
