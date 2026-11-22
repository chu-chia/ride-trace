# 騎跡（RideTrace）：Windows 正式機說明

> 給 Windows 這台（Tailscale 名稱 `node`，「中心電腦」）上的 agent 看。
> 2026-11-22 起，**Windows 是正式機**：使用者手機連這台，資料（Redis）的正本在這台。
> Mac 只用來開發：Mac 上的 agent 把改好的程式推到 GitLab 的 `main`，這台每分鐘自動抓下來部署，使用者在現場用手機測。

```
Mac（開發）── git push main ──> GitLab（私人 jerry.20070419/ride-trace）
                                    │  每分鐘 git fetch（唯讀 deploy token）
                                    ▼
                    Windows node：C:\ride-trace（docker compose）
                                    │  tailscale serve 8443 → 8750
                                    ▼
                    使用者 iPhone：https://node.tail866fc3.ts.net:8443
```

## 0. 規則

- **不要在 Windows 上改程式碼或 commit**。`C:\ride-trace` 每次部署都會 `git reset --hard origin/main`，改了會被蓋掉。發現 bug 記下來告訴使用者，交給 Mac 那邊修。
- **機密不要外流**：`.env`（Redis 密碼、VAPID 私鑰、TDX／氣象署金鑰、機器人密碼）、`deploy-token.txt`、Redis 資料（帳號、使用者一整年的 GPS 足跡）。不要上傳到任何雲端、不要貼到聊天、不要印出來。設定完把打包資料夾刪掉。
- **不要啟動模擬器**（`tools.simulate`），除非使用者要求。
- 回覆使用者一律用繁體中文。

## 1. 需要的東西（先確認、沒有就裝）

- **Git for Windows**（`git --version`）。
- **Docker Desktop**（WSL2 後端）：設定裡打開「登入時啟動」；Resources 記憶體至少 6 GB（Valhalla 路網要 1～2 GB）。
- **Tailscale** 已登入同一個 tailnet（這台是 `node.tail866fc3.ts.net`）。
- **電源**：插電時「永不睡眠」、「永不關閉硬碟」。使用者在外面測試時這台不能睡。
- **使用者要保持登入**（鎖定畫面可以，登出不行）：Docker Desktop 和自動部署排程都跑在登入的使用者底下。重開機後要有人登入，或設定自動登入（問使用者要不要）。

## 2. 第一次設定

Mac 會給一個 `windows-pack-日期` 資料夾（用 `tailscale file cp` 傳過來，在「下載」資料夾）。放到 `C:\ride-trace-pack`，然後在**一般權限**的 PowerShell 跑：

```powershell
cd C:\ride-trace-pack
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -Pack C:\ride-trace-pack
```

`setup.ps1` 做的事（失敗時可以照著手動做）：

1. 檢查 git、docker。
2. 用 `SHA256SUMS` 檢查檔案沒壞。
3. 用 `deploy-token.txt`（格式「帳號 token」，唯讀）從 GitLab clone 到 `C:\ride-trace`，並設 `core.autocrlf=false`（保持 LF）。如果 `C:\ride-trace` 已經存在但不是 git 資料夾（以前「暫時接手」解壓的），會先 `docker compose down` 再改名成 `C:\ride-trace-old-日期` 保留。
4. `env.txt` → `C:\ride-trace\.env`（UTF-8 無 BOM、LF；`FAKE_EXTERNAL` 清空＝真實天氣、路況）。
5. 解 `valhalla.tar`、`tracks.tar.gz` 到 `C:\ride-trace\data\`（路網已建好，不會重新下載）。
6. Redis volume `qiji_redis-data`（compose 專案名固定是 `qiji`）：解 `redis-data.tar.gz` 進去並 `chown 999:999`。**volume 已經有資料時會停下來問**，要先問使用者，不要自己回答 yes。
7. `docker compose up -d --build`，等 `http://127.0.0.1:8750/api/health` 回 200。
8. `tailscale serve --bg --https=8443 http://127.0.0.1:8750`。
9. 工作排程器註冊「RideTrace 自動部署」：每分鐘＋登入時，背景跑 `scripts\windows\autodeploy.ps1`。

### 設定完的驗證

- `docker compose ps`：redis（healthy）、api、worker、valhalla 都是 Up。
- `docker compose exec redis redis-cli DBSIZE`：跟 Mac 打包時印的 keys 數差不多。
- `Invoke-RestMethod http://127.0.0.1:8750/api/health`：`deploy.commit` 是 GitLab main 最新的 commit。
- `Get-ScheduledTask 'RideTrace 自動部署'`：State 是 Ready／Running；`C:\ride-trace-deploy\deploy.log` 有「寫入目前版本」。
- 用另一台 Tailscale 裝置開 `https://node.tail866fc3.ts.net:8443`，看得到登入頁。
- 都好了就刪掉 `C:\ride-trace-pack`（裡面有機密），也清掉「下載」資料夾裡傳過來的檔案。

## 3. 自動部署怎麼運作（autodeploy.ps1）

- 每分鐘 `git fetch origin main`。沒有新 commit：只檢查 api 有沒有回應，沒有就 `docker compose up -d`（例如重開機後 Docker 比較慢起來）。
- 有新 commit：`git reset --hard origin/main`，然後看改了哪些檔案：
  - 只有 `web/`：容器是掛載 `web/` 的，不用重建，手機重新整理就是新版。
  - 有 `backend/` 或 `docker-compose.yml`：`docker compose up -d --build`（約 1～3 分鐘）。
- 寫 `web\deployed.json`（commit、說明、時間、成功與否），再確認 `/api/health` 回的 commit 是新的。
- 記錄在 `C:\ride-trace-deploy\deploy.log`。同一時間只會跑一個（上一次還在建置時，下一分鐘跳過）。
- 使用者手機的「設定」最下面會顯示「版本 xxxxxxx・時間・說明」；失敗時是紅字「部署失敗（原因）」。

## 4. 告訴使用者手機要改的地方

網址從 `https://macbook-pro.tail866fc3.ts.net:8443` 換成 **`https://node.tail866fc3.ts.net:8443`**：

1. iPhone Safari 開新網址登入（帳號 `wei`，密碼使用者自己知道，不要問、不要找）。
2. 主畫面的舊圖示是舊網址：用新網址重新「加入主畫面」。
3. 推播要重新訂閱（新網址是不同網站）。
4. Traccar Client 的伺服器網址改成 `https://node.tail866fc3.ts.net:8443/osmand`（設定頁「Traccar Client」區塊會顯示正確網址）。
5. 真的要騎：**開一個新行程**並按「開始行程」。不要用 Demo #57（Demo 行程只收模擬器的點，真實回報不會進去）。

## 5. 常見問題

- **部署沒發生**：看 `C:\ride-trace-deploy\deploy.log`。「git fetch 失敗」＝網路或 deploy token 失效（`cd C:\ride-trace; git fetch origin main` 看錯誤）。排程沒在跑：`Get-ScheduledTaskInfo 'RideTrace 自動部署'` 看 LastRunTime／LastTaskResult；使用者登出了就不會跑。
- **建置失敗**：log 裡有 `docker compose` 最後 30 行。通常是 Mac 那邊的程式問題：把錯誤告訴使用者，不要在這台改程式。
- **api 起不來，log 說 REDIS_PASSWORD**：`.env` 要在 `C:\ride-trace\.env`（跟 `docker-compose.yml` 同一層）。
- **Redis 載入後 DBSIZE 是 0**：volume 名稱不對（要 `qiji_redis-data`），或檔案權限不是 999。
- **Valhalla 一直在下載／建圖**：`data\valhalla\` 沒解好（要有 `valhalla_tiles.tar`、`file_hashes.txt`），重新解 `valhalla.tar`。路線規劃與地圖比對要等它好；即時定位、行程頁不需要它。
- **CRLF**：`git config core.autocrlf` 必須是 false。不要用會轉換換行的工具重新存檔。
- **8750 被占用**：`netstat -ano | findstr 8750` 找出程式；不要改 compose 的 port（手機網址、Traccar 都靠 8443→8750）。
- **跳出黑色視窗**：這台不支援 `conhost --headless`，`setup.ps1` 會自動改用 `powershell -WindowStyle Hidden`（仍可能閃一下）。

## 6. 要把正本搬回 Mac 時（目前沒有這個計畫）

```powershell
powershell -ExecutionPolicy Bypass -File C:\ride-trace\scripts\windows\pack-back.ps1 -Dest C:\ride-trace -Out C:\ride-trace-back
```

先停用排程（`Disable-ScheduledTask 'RideTrace 自動部署'`）。它會停掉 api／worker、打包 Redis，把檔案交給 Mac（`tailscale file cp <檔案> macbook-pro:`），Mac 那邊用 `scripts/windows/restore-back.sh <檔案>` 還原。
