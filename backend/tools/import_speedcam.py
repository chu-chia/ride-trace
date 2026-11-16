"""匯入警政署「測速執法設置點」（政府資料開放平臺 dataset 7320，每月更新）。

    uv run python -m tools.import_speedcam              # 下載最新 CSV 再匯入
    uv run python -m tools.import_speedcam --file x.csv # 用本機檔案

Redis：
- poi:speedcam          GEO：Worker 用 GEOSEARCH 找「前方 1 km」的測速點
- speedcam:{id}         Hash：地址、縣市、鄉鎮、速限、拍攝方向（解析成行進方位角）
- idx:speedcam          RediSearch 索引：縣市／鄉鎮（TAG）、速限（NUMERIC）、地址全文（中文斷詞）、位置（GEO）
- meta:speedcam         Hash：資料來源、筆數、更新時間（給後台顯示外部資料同步狀態）
"""
import argparse
import csv
import io
import os
import re
import time
import urllib.request

import redis

URL = ("https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/"
       "EA5E6FCD-B82D-43B7-A5CF-E9893253187E/resource/BF951322-3C88-45AB-A44A-5E6332C16B73/download")
DIRS = {"北": 0, "東北": 45, "東": 90, "東南": 135, "南": 180, "西南": 225, "西": 270, "西北": 315}
_D = "東北|東南|西北|西南|北|東|南|西"


def bearing_of(direct: str) -> int | None:
    """拍攝方向 → 被拍的車「往哪個方位騎」（度）。雙向、看不懂的回傳 None（任何方向都提醒）。
    例：北向南、北往南、往南、南向、南下 → 180；西南向東北 → 45；南北雙向 → None"""
    d = direct.replace("車道", "").replace("方向", "").strip()
    if not d or "雙向" in d or re.fullmatch(f"({_D})({_D})向", d):  # 「南北向」「東西向」也是雙向
        return None
    if d.startswith("南下"):
        return 180
    if d.startswith("北上"):
        return 0
    m = re.match(f"({_D})(?:向|往)({_D})", d)
    if m:
        return DIRS[m.group(2)]
    m = re.match(f"往({_D})", d) or re.match(f"({_D})向", d)
    if m:
        return DIRS[m.group(1)]
    return None


def norm(s: str) -> str:
    """台／臺統一成「臺」，搜尋「台14」也找得到「臺14線」。"""
    return s.replace("台", "臺")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file")
    ap.add_argument("--redis", default=os.environ.get("REDIS_URL", "redis://localhost:6390/0"))
    a = ap.parse_args()
    if a.file:
        raw = open(a.file, encoding="utf-8-sig").read()
    else:
        raw = urllib.request.urlopen(URL, timeout=60).read().decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(raw)))
    rows = [x for x in rows if x.get("Longitude") and x["Longitude"] != "經度"]
    r = redis.Redis.from_url(a.redis, decode_responses=True)

    try:
        r.execute_command("FT.DROPINDEX", "idx:speedcam")
    except redis.ResponseError:
        pass
    old = list(r.scan_iter("speedcam:[0-9]*", count=2000))
    p = r.pipeline(transaction=False)
    p.delete("poi:speedcam", *old) if old else p.delete("poi:speedcam")
    oneway = 0
    for i, x in enumerate(rows, 1):
        lon, lat = float(x["Longitude"]), float(x["Latitude"])
        b = bearing_of(x["direct"])
        oneway += b is not None
        p.geoadd("poi:speedcam", [lon, lat, i])
        p.hset(f"speedcam:{i}", mapping={
            "city": norm(x["CityName"]), "region": norm(x["RegionName"]), "addr": x["Address"], "addr_n": norm(x["Address"]),
            "dept": x["BranchNm"], "direct": x["direct"], "bearing": "" if b is None else b,
            "limit": int(x["limit"] or 0), "loc": f"{lon},{lat}", "lon": lon, "lat": lat,
        })
        if i % 500 == 0:
            p.execute()
    p.hset("meta:speedcam", mapping={"source": "警政署 測速執法設置點（data.gov.tw 7320）", "count": len(rows),
                                     "updated": int(time.time() * 1000)})
    p.execute()
    r.execute_command(
        "FT.CREATE", "idx:speedcam", "ON", "HASH", "PREFIX", "1", "speedcam:", "LANGUAGE", "chinese",
        "SCHEMA", "addr_n", "TEXT", "city", "TAG", "region", "TAG", "limit", "NUMERIC", "SORTABLE", "loc", "GEO")
    print(f"匯入 {len(rows)} 個測速點（單向 {oneway}、雙向或不明 {len(rows) - oneway}），已建立 idx:speedcam")


if __name__ == "__main__":
    main()
