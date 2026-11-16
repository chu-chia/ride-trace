# 騎跡：給 AI agent 的工作守則

接手前先讀：

1. `README.md`：啟動方式、工具、Redis 用法、階段清單
2. `docs/records/` 裡日期最新的 `*-handoff.md`：上一位 agent 做到哪、踩過的坑、下一步
3. 原始規格：使用者的 `~/Downloads/騎跡_Redis專題規格.md`（v0.1；後來的決定以 handoff 為準）

## 專案定位

DBMS 課程的 Redis 個人專題。**重點是展示 Redis 的進階功能**，每加一個功能都要想「這裡用了哪個 Redis 特性、SQL 為什麼不方便」，並寫進 README 的 Redis 表格。

## 規則

- **回覆、文件、註解一律繁體中文**；程式碼、檔名、指令保留原文。
- **個人位置資料絕不進版控、絕不送到外部服務**：`data/` 整個在 `.gitignore`。GPX、軌跡 JSON、Valhalla 路網都在那裡。地圖比對只能用本機 Valhalla，不能用公開的 OSRM／Google。
- 測試帳號密碼放在 `data/本機帳號.md`（不進版控），不要寫進任何會 commit 的檔案。
- commit：標題用 `type: 繁中說明`（feat／fix／docs／refactor…），`git add` 明確列檔案，不要用 `git add -A`。
- **不要自己建立 GitHub／GitLab 遠端 repo**，由使用者建立後再推。
- 技術選擇可以自己決定；產品規則（功能要不要做、畫面怎麼呈現）有疑慮再問使用者。
- 改完要自己驗證：後端用 curl 打 API，前端用無頭 Chrome 截圖或 CDP 取值（作法見 handoff）。不要只說「應該可以了」。

## 結構速覽

```
docker-compose.yml   redis(6390) / api(8750) / valhalla(8752)
backend/app/         FastAPI：auth trips ingest live replay footprint
backend/tools/       import_gpx、extract_tracks、match_tracks、simulate
web/                 純 HTML＋ES module，MapLibre 5.24（unpkg）
data/                （不進版控）GPX 衍生資料、展示軌跡、Valhalla 路網
```

改 `backend/` 要重建：`docker compose up -d --build api`。`web/` 是掛載進容器的，改完重新整理即可（已設 no-cache）。
