# 騎跡：給 AI agent 的工作守則

接手前先讀：

1. `README.md`（專案介紹）與 `docs/開發者指南.md`（啟動方式、工具、階段清單）
2. `docs/records/` 裡日期最新的 `*-handoff.md`：上一位 agent 做到哪、踩過的坑、下一步
3. 原始規格：使用者的 `~/Downloads/騎跡_Redis專題規格.md`（v0.1；後來的決定以 handoff 為準）

## 專案定位

DBMS 課程的 Redis 個人專題。**重點是展示 Redis 的進階功能**，每加一個功能都要想「這裡用了哪個 Redis 特性、SQL 為什麼不方便」，並寫進 `docs/Redis功能對照.md`（README 只放摘要表，重要的才加進去）。

## 規則

- **回覆、文件、註解一律繁體中文**；程式碼、檔名、指令保留原文。
- **個人位置資料絕不進版控、絕不送到外部服務**：`data/` 整個在 `.gitignore`。GPX、軌跡 JSON、Valhalla 路網都在那裡。地圖比對只能用本機 Valhalla，不能用公開的 OSRM／Google。
- 測試帳號密碼放在 `data/本機帳號.md`（不進版控），不要寫進任何會 commit 的檔案。
- commit：標題用 `type: 繁中說明`（feat／fix／docs／refactor…），`git add` 明確列檔案，不要用 `git add -A`。
- 遠端：`origin` = `https://github.com/chu-chia/ride-trace`（私人，2026-11-22 建立，課程規定用 GitHub；Windows 正式機從這裡部署）。`gitlab` = `https://gitlab.com/jerry.20070419/ride-trace`（舊的，保留不動，不再推）。不要再另外建立其他遠端 repo。推之前確認沒有密碼、金鑰、`data/` 的內容。
- **先在 Mac 給使用者看，確認後才上 Windows**（2026-11-22 使用者定的）：改動做在分支上，Mac 的 docker 跑這個分支（`web/` 是掛載的，改完重新整理就好；改 `backend/` 要重建 api），請使用者用 iPhone 開 `https://macbook-pro.tail866fc3.ts.net:8443` 看。使用者說可以才合併、推 `main`（推 `main`＝Windows 自動部署）。Mac 的 Redis 是舊資料，只能看畫面，不要拿來真的騎。
- CI：`.github/workflows/ci.yml`（語法檢查＋`scripts/ci/smoke.py` 冒煙測試）。推到 `main` 後 Windows 只部署 CI 通過的 commit，所以推完要看 `gh run list -L1` 有沒有過；沒過就修，不要放著。
- 技術選擇可以自己決定；產品規則（功能要不要做、畫面怎麼呈現）有疑慮再問使用者。
- 改完要自己驗證：後端用 curl 打 API，前端用無頭 Chrome 截圖或 CDP 取值（作法見 handoff）。不要只說「應該可以了」。

## 結構速覽

```
docker-compose.yml   redis(6390) / api(8750) / valhalla(8752)
backend/app/         FastAPI：auth trips ingest live replay footprint
backend/tools/       import_gpx、extract_tracks、match_tracks、simulate
web/                 純 HTML＋ES module，MapLibre 5.24（自架在 web/vendor/，不靠 CDN；地圖掛掉時 mapbase.js 換成替身，SOS 等功能照常）
data/                （不進版控）GPX 衍生資料、展示軌跡、Valhalla 路網
```

改 `backend/` 要重建：`docker compose up -d --build api`。`web/` 是掛載進容器的，改完重新整理即可（已設 no-cache）。
