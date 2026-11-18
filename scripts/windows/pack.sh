#!/usr/bin/env bash
# 把騎跡打包成「Windows 暫時接手」用的資料夾（data/export/windows-pack-日期/，data/ 不進版控）。
# 內含 .env 與 Redis 資料（帳號、個人足跡），屬於私人資料：只用 Tailscale／USB 傳，用完刪掉。
#
#   bash scripts/windows/pack.sh
#
# 產出：
#   code.tar.gz        git archive HEAD（只有版控內的程式碼，不含 .env、data/）
#   env.txt            專案根目錄 .env（Windows 那邊改名成 .env）
#   redis-data.tar.gz  Redis volume 的 /data（AOF＋RDB），先 BGREWRITEAOF 確保一致
#   valhalla.tar       data/valhalla（台灣路網，已建好，不用重算）
#   tracks.tar.gz      data/tracks（模擬器軌跡，Demo 用，可不用）
#   README.md／restore.ps1／pack-back.ps1  給 Windows 那邊的 agent（從 scripts/windows/ 複製）
#   SHA256SUMS
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="data/export/windows-pack-$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"
rc() { docker compose exec -T redis redis-cli --no-auth-warning "$@"; }

echo "1/5 程式碼（$(git rev-parse --short HEAD)）"
git archive --format=tar.gz -o "$OUT/code.tar.gz" HEAD
git rev-parse HEAD > "$OUT/COMMIT"
[ -n "$(git status --porcelain --untracked-files=no)" ] && echo "  注意：有未 commit 的修改，沒有包進去"

echo "2/5 .env"
cp .env "$OUT/env.txt"

echo "3/5 Redis（BGREWRITEAOF 後打包 /data）"
rc BGREWRITEAOF >/dev/null
for _ in $(seq 1 120); do
  [ "$(rc INFO persistence | tr -d '\r' | awk -F: '/^aof_rewrite_in_progress/{print $2}')" = "0" ] && break
  sleep 1
done
rc SAVE >/dev/null
docker compose exec -T redis sh -c 'cd /data && tar czf - appendonlydir dump.rdb' > "$OUT/redis-data.tar.gz"
echo "  keys: $(rc DBSIZE | tr -d '\r')"

echo "4/5 Valhalla 路網（約 1 GB）"
tar cf "$OUT/valhalla.tar" -C data valhalla
tar czf "$OUT/tracks.tar.gz" -C data tracks

echo "5/5 說明與校驗碼"
cp scripts/windows/README.md scripts/windows/restore.ps1 scripts/windows/pack-back.ps1 "$OUT/"
(cd "$OUT" && shasum -a 256 code.tar.gz env.txt redis-data.tar.gz valhalla.tar tracks.tar.gz > SHA256SUMS)
du -sh "$OUT"
echo "完成：$OUT"
