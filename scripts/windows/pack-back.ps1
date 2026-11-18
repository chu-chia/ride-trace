# 騎跡：回 Mac 前，把 Windows 的 Redis 資料打包（說明見 README.md 第 5 節）
#   powershell -ExecutionPolicy Bypass -File .\pack-back.ps1 -Dest C:\ride-trace -Out C:\ride-trace-back
param(
  [string]$Dest = 'C:\ride-trace',
  [string]$Out = 'C:\ride-trace-back'
)
$ErrorActionPreference = 'Stop'
Push-Location $Dest
function rc { docker compose exec -T redis redis-cli --no-auth-warning @args }

Write-Host '== 停掉 api、worker（不再收新點）' -ForegroundColor Cyan
docker compose stop api worker

Write-Host '== BGREWRITEAOF＋SAVE' -ForegroundColor Cyan
rc BGREWRITEAOF | Out-Null
for ($i = 0; $i -lt 120; $i++) {
  if ((rc INFO persistence) -match 'aof_rewrite_in_progress:0') { break }
  Start-Sleep 1
}
rc SAVE | Out-Null
$keys = rc DBSIZE

New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$name = "redis-data-back-$(Get-Date -Format yyyyMMdd-HHmm).tar.gz"
docker run --rm -v qiji_redis-data:/data:ro -v "${Out}:/out" alpine sh -c "cd /data && tar czf /out/$name appendonlydir dump.rdb"
if ($LASTEXITCODE) { Pop-Location; throw '打包失敗' }
$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $Out $name)).Hash.ToLower()
[IO.File]::WriteAllText((Join-Path $Out "$name.sha256"), "$hash  $name`n", (New-Object Text.UTF8Encoding $false))
Pop-Location

Write-Host ''
Write-Host "完成：$Out\$name（Redis keys：$keys）" -ForegroundColor Green
Write-Host "傳回 Mac：tailscale file cp `"$Out\$name`" `"$Out\$name.sha256`" macbook-pro:" -ForegroundColor Yellow
Write-Host 'Mac 那邊：bash scripts/windows/restore-back.sh <檔案>。之後 Windows 這邊不要再啟動 api（資料已經交回 Mac）。'
