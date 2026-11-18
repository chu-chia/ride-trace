# 騎跡：在 Windows 上從 Mac 給的包還原並啟動（說明見 README.md）
#   powershell -ExecutionPolicy Bypass -File .\restore.ps1 -Pack C:\ride-trace-pack -Dest C:\ride-trace
param(
  [Parameter(Mandatory = $true)][string]$Pack,
  [Parameter(Mandatory = $true)][string]$Dest
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "== $m" -ForegroundColor Cyan }
$Pack = (Resolve-Path $Pack).Path

Step '1/8 檢查校驗碼'
foreach ($line in Get-Content (Join-Path $Pack 'SHA256SUMS')) {
  if (-not $line.Trim()) { continue }
  $hash, $file = $line -split '\s+', 2
  $file = $file.TrimStart('*')
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $Pack $file)).Hash.ToLower()
  if ($got -ne $hash.ToLower()) { throw "$file 校驗碼不符，檔案可能沒傳完整" }
  Write-Host "  OK $file"
}

Step '2/8 解開程式碼與 .env'
New-Item -ItemType Directory -Force $Dest | Out-Null
tar -xzf (Join-Path $Pack 'code.tar.gz') -C $Dest
if ($LASTEXITCODE) { throw 'code.tar.gz 解壓失敗' }
# 5/8 一起做：FAKE_EXTERNAL 清空（要真實天氣、路況）。寫成 UTF-8 無 BOM、LF，docker compose 才讀得對
$lines = Get-Content (Join-Path $Pack 'env.txt') | ForEach-Object { $_ -replace '^FAKE_EXTERNAL=.*', 'FAKE_EXTERNAL=' }
[IO.File]::WriteAllText((Join-Path $Dest '.env'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))

Step '3/8 解開 Valhalla 路網與模擬軌跡'
New-Item -ItemType Directory -Force (Join-Path $Dest 'data') | Out-Null
tar -xf (Join-Path $Pack 'valhalla.tar') -C (Join-Path $Dest 'data')
if ($LASTEXITCODE) { throw 'valhalla.tar 解壓失敗' }
tar -xzf (Join-Path $Pack 'tracks.tar.gz') -C (Join-Path $Dest 'data')

Step '4/8 Redis volume qiji_redis-data'
$vol = 'qiji_redis-data'
if (docker volume ls -q --filter "name=^$vol$") {
  $n = docker run --rm -v "${vol}:/data" alpine sh -c 'ls -A /data | wc -l'
  if ([int]$n -gt 0) {
    $ans = Read-Host "$vol 裡已經有資料（可能是上次在 Windows 騎的紀錄，還沒帶回 Mac）。確定要覆蓋嗎？輸入 yes 繼續"
    if ($ans -ne 'yes') { throw '已取消，沒有改動 Redis 資料' }
  }
  Push-Location $Dest; docker compose stop redis api worker; Pop-Location
} else {
  docker volume create --label com.docker.compose.project=qiji --label com.docker.compose.volume=redis-data $vol | Out-Null
}
docker run --rm -v "${vol}:/data" -v "${Pack}:/pack:ro" alpine sh -c 'rm -rf /data/* && cd /data && tar xzf /pack/redis-data.tar.gz && chown -R 999:999 /data'
if ($LASTEXITCODE) { throw 'Redis 資料還原失敗' }

Step '6/8 啟動 docker compose（第一次要建置映像，幾分鐘）'
Push-Location $Dest
docker compose up -d --build redis api worker valhalla
if ($LASTEXITCODE) { Pop-Location; throw 'docker compose 啟動失敗' }

Step '7/8 等 api 就緒'
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:8750/api/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break } } catch {}
  Start-Sleep 2
}
if (-not $ok) { docker compose logs --tail 40 api; Pop-Location; throw 'api 3 分鐘內沒有就緒' }
Write-Host ("  Redis keys：" + (docker compose exec -T redis redis-cli --no-auth-warning DBSIZE))
Pop-Location

Step '8/8 Tailscale serve（手機走 https://node.tail866fc3.ts.net:8443）'
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
& $ts serve --bg --https=8443 http://127.0.0.1:8750
& $ts serve status

Write-Host ''
Write-Host '完成。手機改開 https://node.tail866fc3.ts.net:8443（主畫面圖示、推播、Traccar 網址都要換，見 README 第 4 節）' -ForegroundColor Green
Write-Host '不要啟動模擬器；回 Mac 前跑 pack-back.ps1。' -ForegroundColor Yellow
