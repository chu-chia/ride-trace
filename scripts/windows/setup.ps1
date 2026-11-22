# 騎跡：把 Windows 設成正式機（只要做一次，說明見 README.md）
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Pack C:\ride-trace-pack
# 做的事：從 GitLab clone 程式碼 → 放 .env、路網、Redis 資料 → 啟動 → Tailscale serve → 註冊每分鐘的自動部署排程
param(
  [Parameter(Mandatory = $true)][string]$Pack,
  [string]$Dest = 'C:\ride-trace',
  [string]$Repo = 'gitlab.com/jerry.20070419/ride-trace.git'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Step($m) { Write-Host "== $m" -ForegroundColor Cyan }
$Pack = (Resolve-Path $Pack).Path

Step '1/9 檢查工具'
foreach ($c in 'git', 'docker') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "找不到 $c，先安裝（見 README 第 1 節）" } }
docker info *> $null
if ($LASTEXITCODE) { throw 'Docker Desktop 沒在跑，先打開它' }

Step '2/9 檢查校驗碼'
foreach ($line in Get-Content (Join-Path $Pack 'SHA256SUMS')) {
  if (-not $line.Trim()) { continue }
  $hash, $file = $line -split '\s+', 2
  $file = $file.TrimStart('*')
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $Pack $file)).Hash.ToLower()
  if ($got -ne $hash.ToLower()) { throw "$file 校驗碼不符，檔案可能沒傳完整" }
  Write-Host "  OK $file"
}

Step '3/9 從 GitLab clone 程式碼（唯讀 deploy token）'
$user, $tok = ((Get-Content (Join-Path $Pack 'deploy-token.txt') -Raw).Trim() -split '\s+', 2)
if ((Test-Path $Dest) -and -not (Test-Path (Join-Path $Dest '.git'))) {
  # 以前「暫時接手」解壓出來的資料夾：整個改名保留，路網等一下直接搬過來用
  $old = "$Dest-old-$(Get-Date -Format yyyyMMdd-HHmm)"
  Write-Host "  $Dest 不是 git 資料夾，改名成 $old 保留"
  Push-Location $Dest; docker compose down 2>&1 | Out-Null; Pop-Location
  Rename-Item $Dest $old
}
if (-not (Test-Path $Dest)) {
  git -c core.autocrlf=false clone "https://${user}:${tok}@$Repo" $Dest
  if ($LASTEXITCODE) { throw 'git clone 失敗（deploy token 或網路）' }
}
Push-Location $Dest
git config core.autocrlf false
git fetch origin main; git reset --hard origin/main
Pop-Location

Step '4/9 .env（FAKE_EXTERNAL 清空＝真實天氣、路況）'
$lines = Get-Content (Join-Path $Pack 'env.txt') -Encoding UTF8 | ForEach-Object { $_ -replace '^FAKE_EXTERNAL=.*', 'FAKE_EXTERNAL=' }
[IO.File]::WriteAllText((Join-Path $Dest '.env'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))

Step '5/9 Valhalla 路網與模擬軌跡'
New-Item -ItemType Directory -Force (Join-Path $Dest 'data') | Out-Null
tar -xf (Join-Path $Pack 'valhalla.tar') -C (Join-Path $Dest 'data')
if ($LASTEXITCODE) { throw 'valhalla.tar 解壓失敗' }
tar -xzf (Join-Path $Pack 'tracks.tar.gz') -C (Join-Path $Dest 'data')

Step '6/9 Redis 資料（volume qiji_redis-data）'
$vol = 'qiji_redis-data'
if (docker volume ls -q --filter "name=^$vol$") {
  $n = docker run --rm -v "${vol}:/data" alpine sh -c 'ls -A /data | wc -l'
  if ([int]$n -gt 0) {
    $ans = Read-Host "$vol 裡已經有資料（以前在 Windows 騎的紀錄）。用 Mac 給的資料覆蓋嗎？輸入 yes 繼續"
    if ($ans -ne 'yes') { throw '已取消，沒有改動 Redis 資料' }
  }
  Push-Location $Dest; docker compose stop redis api worker 2>&1 | Out-Null; Pop-Location
} else {
  docker volume create --label com.docker.compose.project=qiji --label com.docker.compose.volume=redis-data $vol | Out-Null
}
docker run --rm -v "${vol}:/data" -v "${Pack}:/pack:ro" alpine sh -c 'rm -rf /data/* && cd /data && tar xzf /pack/redis-data.tar.gz && chown -R 999:999 /data'
if ($LASTEXITCODE) { throw 'Redis 資料還原失敗' }

Step '7/9 啟動（第一次要建置映像，幾分鐘）'
Push-Location $Dest
docker compose up -d --build
if ($LASTEXITCODE) { Pop-Location; throw 'docker compose 啟動失敗' }
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:8750/api/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break } } catch {}
  Start-Sleep 2
}
if (-not $ok) { docker compose logs --tail 40 api; Pop-Location; throw 'api 3 分鐘內沒有就緒' }
Write-Host ('  Redis keys：' + (docker compose exec -T redis redis-cli DBSIZE))
Pop-Location

Step '8/9 Tailscale serve（手機走 https://<這台>.tail866fc3.ts.net:8443）'
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
& $ts serve --bg --https=8443 http://127.0.0.1:8750
& $ts serve status

Step '9/9 註冊自動部署排程（每分鐘、登入後在背景跑）'
$script = Join-Path $Dest 'scripts\windows\autodeploy.ps1'
$psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
# conhost --headless：不跳黑色視窗（Windows 11、新版 Windows 10）。不支援的話改直接跑 powershell -WindowStyle Hidden
$test = Start-Process conhost.exe -ArgumentList '--headless', 'cmd.exe', '/c', 'exit 0' -PassThru -Wait -ErrorAction SilentlyContinue
$action = if ($test -and $test.ExitCode -eq 0) { New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe $psArgs" }
          else { New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-WindowStyle Hidden $psArgs" }
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
# Docker Desktop 跑在登入的使用者底下，所以排程也用這個使用者、登入時才跑（鎖定畫面沒關係，登出就不行）
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'RideTrace 自動部署' -Action $action -Trigger $every, $logon -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'RideTrace 自動部署'
Start-Sleep 8
Get-Content 'C:\ride-trace-deploy\deploy.log' -Tail 5 -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '完成。之後 Mac 推到 GitLab 的 main，這台一分鐘內自動更新。記錄在 C:\ride-trace-deploy\deploy.log' -ForegroundColor Green
