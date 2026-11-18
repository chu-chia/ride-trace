# 騎跡（RideTrace）：Windows 暫時接手說明

> 給 Windows 這台（Tailscale 名稱 `node`，「中心電腦」）上的 agent 看。
> **這只是暫時的**：主機仍是使用者的 MacBook（`~/development/ride-trace`，git 只在 Mac 上，沒有遠端）。
> Mac 闔上不能跑的時候（例如回家路上要實測），由 Windows 暫時提供服務；回來後把 Redis 資料搬回 Mac。

## 0. 先知道的規則

- **不要在 Windows 上改程式碼或 commit**。`code.tar.gz` 是 Mac 某個 commit 的快照（見 `COMMIT`），改了也帶不回去。發現 bug 記下來，回 Mac 再修。
- **同一時間只有一邊是正本**。Windows 在跑的期間，所有新資料（使用者騎的軌跡、行程）只在 Windows 的 Redis。回來後用 `pack-back.ps1` 把 Redis 打包帶回 Mac，Mac 那段時間的資料會被蓋掉（Mac 那邊只有 Demo 模擬資料，沒關係）。
- **包裡有機密**：`env.txt`（Redis 密碼、VAPID 私鑰、TDX／氣象署金鑰、機器人密碼）與 `redis-data.tar.gz`（帳號、使用者一整年的個人 GPS 足跡）。不要上傳到任何雲端、不要貼到聊天、不要 commit。用完刪掉。
- 回覆使用者一律用繁體中文。

## 1. 需要的東西

- Docker Desktop（WSL2 後端），設定成登入時自動啟動；Resources 記憶體至少 6 GB（Valhalla 路網要 1～2 GB）。
- Tailscale 已登入同一個 tailnet（這台就是 `node.tail866fc3.ts.net`）。
- Windows 電源設定：插電時「永不睡眠」。使用者在路上時這台不能睡。
- PowerShell 5 以上（內建的 `tar.exe` 可以解 `.tar.gz`）。

## 2. 還原（第一次，或 Mac 給了新的包）

把整個 `windows-pack-日期` 資料夾放到例如 `C:\ride-trace-pack`，然後：

```powershell
cd C:\ride-trace-pack
powershell -ExecutionPolicy Bypass -File .\restore.ps1 -Pack C:\ride-trace-pack -Dest C:\ride-trace
```

`restore.ps1` 做的事（失敗時可以照著手動做）：

1. 用 `SHA256SUMS` 檢查檔案沒壞。
2. 解 `code.tar.gz` 到 `C:\ride-trace`，`env.txt` 複製成 `C:\ride-trace\.env`。
3. 解 `valhalla.tar`、`tracks.tar.gz` 到 `C:\ride-trace\data\`（路網已建好，不會重新下載）。
4. 建 Docker volume `qiji_redis-data`（compose 專案名固定是 `qiji`），把 `redis-data.tar.gz` 解進去並 `chown 999:999`（redis 映像的使用者）。**如果 volume 已存在且有資料，腳本會停下來問**，不要直接覆蓋。
5. `.env` 的 `FAKE_EXTERNAL` 改成空白（要真實天氣、路況；Mac 上 Demo 時是 1）。
6. `docker compose up -d --build redis api worker valhalla`。
7. 等 `http://127.0.0.1:8750/api/health` 回 200。
8. `tailscale serve --bg --https=8443 http://127.0.0.1:8750`。

**不要啟動模擬器**（`tools.simulate`）。Demo 行程 #57 在 Windows 上會停在還原當下的狀態，隊友會陸續變「失聯」，這是正常的（Demo 行程不推播）。

## 3. 驗證

- `docker compose ps`：redis healthy、api、worker、valhalla 都是 Up。
- `curl http://127.0.0.1:8750/api/health`
- `docker compose exec redis redis-cli DBSIZE` 應該跟 Mac 打包時印的 keys 數差不多（Mac 打包時有印）。
- 用另一台 Tailscale 裝置開 `https://node.tail866fc3.ts.net:8443`，能看到登入頁。

## 4. 告訴使用者手機要改的地方

網址從 `https://macbook-pro.tail866fc3.ts.net:8443` 換成 **`https://node.tail866fc3.ts.net:8443`**：

1. iPhone Safari 開新網址登入（帳號 `wei`，密碼使用者自己知道，不要問、不要找）。
2. 主畫面的舊圖示是舊網址：用新網址重新「加入主畫面」。
3. 推播要重新訂閱（新網址是不同網站）。
4. Traccar Client 的伺服器網址改成 `https://node.tail866fc3.ts.net:8443/osmand`（設定頁「Traccar Client」區塊會顯示正確網址）。
5. 真的要騎：**開一個新行程**並按「開始行程」。不要用 Demo #57（Demo 行程只收模擬器的點，真實回報不會進去）。

## 5. 回 Mac 之前：把資料打包帶回

```powershell
powershell -ExecutionPolicy Bypass -File C:\ride-trace-pack\pack-back.ps1 -Dest C:\ride-trace -Out C:\ride-trace-back
```

它會 `BGREWRITEAOF`＋`SAVE`、停掉 api／worker（不再收新點）、把 volume 打包成 `redis-data-back-日期.tar.gz`＋校驗碼。把這個檔案交給 Mac（`tailscale file cp <檔案> macbook-pro:` 或 USB）。
Mac 那邊用 `scripts/windows/restore-back.sh <檔案>` 還原。

還原到 Mac 之後，Windows 這邊：`docker compose down`（保留 volume 也可以，下次會被新包覆蓋前會問）、`tailscale serve --https=8443 off`。

## 6. 常見問題

- **api 起不來，log 說 REDIS_PASSWORD**：`.env` 沒放對位置，要在 `C:\ride-trace\.env`（跟 `docker-compose.yml` 同一層）。
- **Redis 載入後 DBSIZE 是 0**：volume 名稱不對（要 `qiji_redis-data`），或檔案權限不是 999。
- **Valhalla 一直在下載／建圖**：`data\valhalla\` 沒解好（要有 `valhalla_tiles.tar`、`file_hashes.txt`），重新解 `valhalla.tar`。路線規劃與地圖比對要等它好；即時定位、行程頁不需要它。
- **CRLF**：程式碼是 `git archive` 出來的，保持 LF，不要用會轉換換行的工具重新存檔。
- **8750 被占用**：`netstat -ano | findstr 8750` 找出程式；不要改 compose 的 port（手機網址、Traccar 都靠 8443→8750）。
