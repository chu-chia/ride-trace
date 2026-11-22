# 騎跡：Windows 自動部署（工作排程器每分鐘跑一次，說明見 README.md）
# 遠端（origin，GitHub）的 main 有新 commit、而且 GitHub Actions 的 CI 通過，就更新 C:\ride-trace：
#   - 只改到 web/（掛載進容器）→ 不用重建，重新整理就是新版
#   - 改到 backend/、docker-compose.yml → docker compose up -d --build
# 寫 web\deployed.json（commit、時間、成功與否），手機在「設定」最下面看得到版本。
# CI 還在跑：下一分鐘再看；CI 沒過：不部署、舊版繼續跑，deployed.json 記 blocked（設定頁會顯示）。
# origin 不是 GitHub（例如以前的 GitLab）就不檢查 CI，直接部署。
# 沒有新 commit 時只做健康檢查：服務沒在跑就 docker compose up -d（開機後 Docker 慢起來的情況）。
param([string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$LogDir = 'C:\ride-trace-deploy'
New-Item -ItemType Directory -Force $LogDir | Out-Null
$Log = Join-Path $LogDir 'deploy.log'
function Log($m) { Add-Content -Path $Log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -Encoding UTF8 }
# 記錄檔超過 2 MB 就換一個
if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 2MB) { Move-Item -Force $Log "$Log.1" }

# 同一時間只跑一個（上一次還在建置時，下一分鐘的排程直接跳過）
$mutex = New-Object Threading.Mutex($false, 'Global\RideTraceAutodeploy')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  Set-Location $Root
  docker info *> $null
  if ($LASTEXITCODE) { exit 0 }  # Docker Desktop 還沒起來，下一分鐘再說

  function Healthy { try { return (Invoke-WebRequest 'http://127.0.0.1:8750/api/health' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { return $false } }

  git fetch --quiet origin main 2>&1 | Out-Null
  if ($LASTEXITCODE) { Log 'git fetch 失敗（網路或 deploy token）'; exit 0 }
  $head = (git rev-parse HEAD).Trim()
  $remote = (git rev-parse origin/main).Trim()

  if ($head -eq $remote) {
    $vf = Join-Path $Root 'web\deployed.json'
    if (-not (Test-Path $vf)) {  # 剛裝好：先把目前的版本寫上去
      $subject = (git -c i18n.logOutputEncoding=UTF-8 log -1 --format=%s HEAD).Trim()
      $info = @{ commit = $head; subject = $subject; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); rebuilt = $false; ok = $true; error = '' }
      [IO.File]::WriteAllText($vf, ($info | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
      Log "寫入目前版本 $($head.Substring(0,7))"
    }
    if (-not (Healthy)) {
      Log '服務沒有回應，docker compose up -d'
      docker compose up -d 2>&1 | Out-Null
    }
    exit 0
  }

  # CI 閘門：查 GitHub 上這個 commit 的 check-runs（名稱 ci）。token 用 origin 網址裡的那組（唯讀）
  $url = (git remote get-url origin).Trim()
  if ($url -match '^https://(?:[^:@/]+:(?<tok>[^@/]+)@)?github\.com/(?<slug>[^/]+/[^/]+?)(?:\.git)?$') {
    $hdr = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'ride-trace-autodeploy' }
    if ($Matches.tok) { $hdr.Authorization = "Bearer $($Matches.tok)" }
    try {
      $runs = (Invoke-RestMethod "https://api.github.com/repos/$($Matches.slug)/commits/$remote/check-runs?check_name=ci" -Headers $hdr -TimeoutSec 15).check_runs
    } catch { Log "查 CI 狀態失敗：$($_.Exception.Message)"; exit 0 }
    $run = $runs | Sort-Object { $_.started_at } -Descending | Select-Object -First 1
    if (-not $run -or $run.status -ne 'completed') { exit 0 }  # 還沒開始或還在跑，下一分鐘再看
    if ($run.conclusion -ne 'success') {
      $vf = Join-Path $Root 'web\deployed.json'
      $cur = $null; try { $cur = Get-Content $vf -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
      if ($cur -and $cur.blocked -and $cur.blocked.commit -eq $remote) { exit 0 }  # 已經記過了
      $subject = (git -c i18n.logOutputEncoding=UTF-8 log -1 --format=%s $remote).Trim()
      Log "CI 沒過（$($run.conclusion)），不部署 $($remote.Substring(0,7)) $subject：$($run.html_url)"
      if ($cur) {
        $cur | Add-Member -Force -NotePropertyName blocked -NotePropertyValue @{ commit = $remote; subject = $subject; conclusion = $run.conclusion; url = $run.html_url }
        [IO.File]::WriteAllText($vf, ($cur | ConvertTo-Json -Compress -Depth 4), (New-Object Text.UTF8Encoding $false))
      }
      exit 0
    }
  }

  $files = @(git diff --name-only $head $remote)
  $subject = (git -c i18n.logOutputEncoding=UTF-8 log -1 --format=%s $remote).Trim()
  Log "更新 $($head.Substring(0,7)) → $($remote.Substring(0,7))（$($files.Count) 個檔案）$subject"
  git reset --hard --quiet $remote
  $rebuild = [bool]($files | Where-Object { $_ -match '^(backend/|docker-compose\.yml)' })
  $ok = $true; $err = ''
  if ($rebuild) {
    Log '後端有改：docker compose up -d --build'
    $out = docker compose up -d --build 2>&1
    if ($LASTEXITCODE) { $ok = $false; $err = '建置失敗'; Log ($out | Select-Object -Last 30 | Out-String) }
  }

  # 寫版本檔（UTF-8 無 BOM），再確認 api 回得出這個 commit
  $info = @{ commit = $remote; subject = $subject; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); rebuilt = $rebuild; ok = $ok; error = $err }
  [IO.File]::WriteAllText((Join-Path $Root 'web\deployed.json'), ($info | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  if ($ok) {
    $ok = $false
    for ($i = 0; $i -lt 90; $i++) {
      try {
        $h = Invoke-RestMethod 'http://127.0.0.1:8750/api/health' -TimeoutSec 5
        if ($h.deploy.commit -eq $remote) { $ok = $true; break }
      } catch {}
      Start-Sleep 2
    }
    if (-not $ok) {
      $info.ok = $false; $info.error = 'api 3 分鐘內沒有就緒'
      [IO.File]::WriteAllText((Join-Path $Root 'web\deployed.json'), ($info | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
      Log ((docker compose logs --tail 40 api 2>&1) | Out-String)
    }
  }
  Log ($(if ($ok) { "完成 $($remote.Substring(0,7))" } else { "失敗：$($info.error)" }))
} finally {
  $mutex.ReleaseMutex()
}
