"""檢查 report/demo-data/ 有沒有不該公開的東西（發布前跑）：
- 裝置 ID、登入 token、密碼雜湊、推播訂閱
- 私人行程（不在允許清單裡的行程編號）
- 足跡資料比格子（0.0015 度）更精確的座標
有問題就 exit 1。"""
import json
import re
import sys
from pathlib import Path

D = Path(__file__).resolve().parents[2] / "report" / "demo-data"
CELL = 0.0015
BAD_KEYS = {"device_id", "pw", "password", "token", "endpoint", "p256dh", "auth"}
problems = []


def walk(v, path, fn):
    if isinstance(v, dict):
        for k, x in v.items():
            fn(k, x, path)
            walk(x, f"{path}.{k}", fn)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            walk(x, f"{path}[{i}]", fn)


live = json.loads((D / "live.json").read_text())["tid"]
allowed = {str(live), "48", "55"}
for f in sorted(D.glob("*.json")):
    data = json.loads(f.read_text(encoding="utf-8"))
    raw = f.read_text(encoding="utf-8")
    for tok in re.findall(r"(demorec_|simself_|claudetest_)[A-Za-z0-9_-]+", raw):
        problems.append(f"{f.name}: 出現 session token {tok}")

    def check(k, x, path, fname=f.name):
        if k in BAD_KEYS:
            problems.append(f"{fname}: 欄位 {k}（{path}）")
    walk(data, f.name, check)
    for key in data.get("http", {}):
        for tid in re.findall(r"/api/trips/(\d+)", key):
            if tid not in allowed:
                problems.append(f"{f.name}: 有私人行程 {tid}（{key}）")
    if f.name == "index.json":
        for t in data["http"].get("GET /api/trips", {}).get("body", []):
            if str(t.get("id")) not in allowed:
                problems.append(f"index.json: 行程清單有 {t.get('id')} {t.get('name')}")
    if f.name == "footprint.json":
        for key, rec in data["http"].items():
            if "/api/footprint/lines" in key:
                coords = rec["body"]["geometry"]["coordinates"]
                for line in coords[:2000]:
                    for lon, lat in line:
                        if abs((lon / CELL - 0.5) - round(lon / CELL - 0.5)) > 1e-3 or abs((lat / CELL - 0.5) - round(lat / CELL - 0.5)) > 1e-3:
                            problems.append(f"footprint.json: 軌跡線座標沒吸附到格子 {lon},{lat}")
                            break
            if "/api/me/heat/detail" in key:
                problems.append("footprint.json: 有熱力圖原始點 /api/me/heat/detail")

if problems:
    print("\n".join(dict.fromkeys(problems)))
    sys.exit(1)
print(f"展示資料檢查通過（{len(list(D.glob('*.json')))} 個檔案）")
