#!/usr/bin/env bash
# 把騎跡打包成「Windows 正式機」第一次設定用的資料夾（data/export/windows-pack-日期/，data/ 不進版控）。
# 內含 .env 與 Redis 資料（帳號、個人足跡），屬於私人資料：只用 Tailscale／USB 傳，用完刪掉。
#
#   bash scripts/windows/pack.sh
#
# 產出：
#   env.txt            專案根目錄 .env（Windows 那邊改名成 .env）
#   redis-data.tar.gz  Redis volume 的 /data（AOF＋RDB），先 BGREWRITEAOF 確保一致
#   valhalla.tar       data/valhalla（台灣路網，已建好，不用重算）
#   tracks.tar.gz      data/tracks（模擬器軌跡，Demo 用，可不用）
#   deploy-token.txt   GitHub 唯讀 token（fine-grained：Contents、Actions 唯讀）（data/windows/deploy-token.txt）
#   README.md／setup.ps1／autodeploy.ps1／pack-back.ps1  給 Windows 那邊的 agent（從 scripts/windows/ 複製）
#   SHA256SUMS
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="data/export/windows-pack-$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"
rc() { docker compose exec -T redis redis-cli --no-auth-warning "$@"; }

echo "1/5 程式碼：Windows 直接從 GitHub clone，不打包（目前 main：$(git rev-parse --short origin/main 2>/dev/null)）"

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

echo "5/5 說明、deploy token 與校驗碼"
cp scripts/windows/README.md scripts/windows/setup.ps1 scripts/windows/autodeploy.ps1 scripts/windows/pack-back.ps1 "$OUT/"
# GitHub 唯讀 token（Windows clone／自動部署用），放在 data/windows/deploy-token.txt，格式「帳號 token」
[ -f data/windows/deploy-token.txt ] || { echo "缺 data/windows/deploy-token.txt"; exit 1; }
cp data/windows/deploy-token.txt "$OUT/"
(cd "$OUT" && shasum -a 256 env.txt deploy-token.txt redis-data.tar.gz valhalla.tar tracks.tar.gz > SHA256SUMS)
du -sh "$OUT"
echo "完成：$OUT"
# 包成一個 tar 方便用 Tailscale 傳。COPYFILE_DISABLE：不要把 macOS 的 ._* 附加檔包進去（Windows 解壓會報錯）
(cd data/export && COPYFILE_DISABLE=1 tar cf "$(basename "$OUT").tar" "$(basename "$OUT")")
echo "傳到 Windows：tailscale file cp $OUT.tar node:   （傳完刪掉 $OUT.tar）"
