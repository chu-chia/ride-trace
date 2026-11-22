"""CI 冒煙測試：對剛啟動的 api（http://127.0.0.1:8750）走一遍最基本的流程。
註冊 → 建行程 → 開始 → 回報位置 → 讀行程、回放 → 各頁面能打開。任何一步失敗就 exit 1。
只用標準函式庫，GitHub Actions 的 runner 直接跑：python3 scripts/ci/smoke.py"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8750"
TOKEN = None


def call(method, path, body=None, expect=200):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            code, raw = res.status, res.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    if code != expect:
        sys.exit(f"失敗：{method} {path} 回 {code}（預期 {expect}）：{raw[:300].decode(errors='replace')}")
    print(f"  OK {method} {path} {code}")
    try:
        return json.loads(raw)
    except ValueError:
        return raw


for _ in range(60):  # 等 api 起來
    try:
        if call("GET", "/api/health")["redis"]:
            break
    except (SystemExit, OSError):  # 還沒起來：連線被拒／被重設
        pass
    time.sleep(2)
else:
    sys.exit("失敗：api 2 分鐘內沒有就緒")

for page in ("/", "/login", "/settings", "/assets/app.css", "/assets/common.js"):
    call("GET", page)

user = f"ci{int(time.time()) % 100000}"
TOKEN = call("POST", "/api/register", {"username": user, "password": "ci-test-pw"})["token"]
call("GET", "/api/trips", expect=200)
trip = call("POST", "/api/trips", {"name": "CI 測試"})
tid = trip.get("id") or trip.get("trip", {}).get("id")
if not tid:
    sys.exit(f"失敗：建立行程沒有回傳 id：{str(trip)[:300]}")
call("POST", f"/api/trips/{tid}/start", {})
now = int(time.time() * 1000)
for i in range(3):
    res = call("POST", "/api/track", {"lat": 25.04 + i * 0.0005, "lon": 121.56, "speed": 8, "acc": 5, "ts": now + i * 2000})
    if str(res.get("trip")) != str(tid):
        sys.exit(f"失敗：回報位置沒有進行程 {tid}：{res}")
call("GET", f"/api/trips/{tid}")
call("POST", f"/api/trips/{tid}/end", {})
print("冒煙測試通過")
