#!/usr/bin/env bash
# 騎跡：把 Windows 帶回來的 Redis 資料還原到 Mac（說明見 scripts/windows/README.md 第 5 節）
#   bash scripts/windows/restore-back.sh ~/Downloads/redis-data-back-20261119-0830.tar.gz
# 會先把 Mac 現在的 Redis 備份到 data/backup/，再整個換成 Windows 的資料。
set -euo pipefail
cd "$(dirname "$0")/../.."
F="${1:?用法：restore-back.sh <redis-data-back-*.tar.gz>}"
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
DIR="$(cd "$(dirname "$F")" && pwd)"; BASE="$(basename "$F")"
if [ -f "$F.sha256" ]; then (cd "$DIR" && shasum -a 256 -c "$BASE.sha256"); else echo "（沒有 .sha256，跳過校驗）"; fi

read -r -p "會停掉 Demo 模擬器與 api／worker／redis，並用 Windows 的資料覆蓋 Mac 的 Redis。輸入 yes 繼續：" ans
[ "$ans" = "yes" ] || { echo "已取消"; exit 1; }

pkill -f tools.simulate || true
docker compose stop api worker redis
mkdir -p data/backup
BK="redis-mac-before-restore-$(date +%Y%m%d-%H%M).tar.gz"
docker run --rm -v qiji_redis-data:/data:ro -v "$PWD/data/backup:/out" alpine tar czf "/out/$BK" -C /data .
echo "Mac 原本的資料備份在 data/backup/$BK"
docker run --rm -v qiji_redis-data:/data -v "$DIR:/in:ro" alpine sh -c "rm -rf /data/* && cd /data && tar xzf '/in/$BASE' && chown -R 999:999 /data"
docker compose up -d redis api worker
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:8750/api/health >/dev/null && break; sleep 2; done
echo "Redis keys：$(docker compose exec -T redis redis-cli --no-auth-warning DBSIZE)"
echo "完成。手機改回 https://macbook-pro.tail866fc3.ts.net:8443；要 Demo 再自己啟動模擬器（docs/records 交接第 10 節）。"
