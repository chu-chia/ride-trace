# 騎跡

機車車隊即時定位與回放系統（DBMS 課程 Redis 個人專題）。朋友約騎車時，每個人在地圖上即時看到彼此，系統全程記錄；另外有全年迷霧足跡地圖。

接手的 agent 請先讀 `AGENTS.md`。

目前進度：**M1 核心、M2 回放**（見下方「階段」）。

## 啟動

需要 Docker Desktop。

```bash
docker compose up -d --build      # Redis 8（6390）＋ API／網頁（8750）＋ Worker ＋ Valhalla（8752）
open http://localhost:8750
```

開發時也可以只開 Redis，用 uv 跑 API（改程式會自動重載）：

```bash
docker compose up -d redis
cd backend && uv venv --python 3.12 && uv pip install -e .
uv run uvicorn app.main:app --port 8750 --reload
```

手機要用網頁定位必須是 HTTPS，建議用 `tailscale serve` 或 Tailscale Funnel 開一個固定網址。

## 匯入足跡與展示用軌跡

個人位置資料一律放在 `data/`，已列在 `.gitignore`，**不要上傳**。

```bash
cd backend
# 1. 先在網頁註冊帳號，再把 GPX 匯入成這個帳號的全年足跡
uv run python -m tools.import_gpx ~/Downloads/xxx.gpx --user wei --reset
# 2. 切出展示用的真實騎乘片段（武嶺 4 段、北宜 1 段）到 data/tracks/
uv run python -m tools.extract_tracks ~/Downloads/xxx.gpx
```

## 地圖比對（軌跡貼合道路）

原始 GPS 約 10～13 秒一點，快的時候兩點相隔好幾百公尺，直線連起來會切過彎道。
`docker compose up -d valhalla` 會在本機建台灣路網（第一次約 3 分鐘，資料放 `data/valhalla/`），
然後把展示軌跡對到道路上（GPS 不會送到外部服務）：

```bash
cd backend
uv run python -m tools.match_tracks          # 比對 data/tracks/ 全部，原始點保留在 raw_points
```

重新執行 `extract_tracks` 會蓋掉比對結果，要再跑一次 `match_tracks`。

## GPS 模擬器

把真實騎乘片段當成多位隊友，走跟手機一樣的 `/api/track`。時間戳用「重播的時間」（1 倍速），所以 30 倍速跑完的行程，回放和摘要仍是真實的時長與速度。

```bash
cd backend
# 預設重播 10/26 台北→武嶺（加 --group wuling 換成 4 段清境→武嶺）
# 加入你在網頁建立的行程（你按「開始行程」後出發）
uv run python -m tools.simulate --group wuling --code ABC123
# 機器人自己開團並開始，印出邀請碼讓你加入觀看
uv run python -m tools.simulate --group wuling --create "武嶺日出團"
# 20 倍速；第 2 位在模擬第 600～900 秒斷訊（20 倍速下約 15 秒，不夠觸發失聯，要失聯請拉長）
uv run python -m tools.simulate --group wuling --code ABC123 --speed 20 --drop 2@600-3000
```

## Traccar Client 設定

在網頁「行程 → 回報」分頁可以看到：

- 伺服器網址：`https://<你的網址>/osmand`
- 裝置 ID：每個帳號一組隨機 ID（`/api/me/device`）

同時支援舊版 OsmAnd 協定（query string，速度單位是節）和新版 JSON 格式。

## Redis 用到的功能

| 功能 | 用在哪 |
|---|---|
| GEO | `trip:{id}:geo` 即時位置；`GEOSEARCH` 算隊友距離 |
| Pub/Sub | `trip:{id}:live` 位置與事件即時推到 WebSocket |
| Streams | `track:{trip}:{uid}` 軌跡、`trip:{id}:events` 事件、`footprint:{uid}` 全年足跡（ID 就是時間戳，`XRANGE` 依時間查） |
| TimeSeries | `ts:{trip}:{uid}:speed／alt` 速度與海拔（帶 trip／uid／kind 標籤，回放用 `TS.MRANGE … FILTER trip=… AGGREGATION avg` 一次取全隊）、`ts:sys:writes` 每秒寫入量 |
| TTL＋Keyspace Notification | `hb:{trip}:{uid}` 心跳 90 秒過期 → 失聯警示；`session:` 登入、`invite:` 邀請碼、`cache:lines:` 查詢快取 |
| Pipeline | 每筆 GPS 回報一次送出 10 個左右的指令；GPX 匯入每 5,000 點一批 |
| Transactions | 開始行程用 `WATCH`＋`MULTI/EXEC` 樂觀鎖 |
| Lua | 結束自己的紀錄：移出 active、最後一人時把行程改成 ended，原子完成 |
| Streams Consumer Group | `stream:ingest` 由獨立的 worker 容器 `XREADGROUP` 消費；group `stats` 算每人里程／極速／移動時間（`trip:{id}:stats:{uid}`）。處理完才 `XACK`，worker 當掉時用 `XAUTOCLAIM` 接手閒置 60 秒的訊息；`docker compose up -d --scale worker=2` 自動分攤。進度看 `GET /api/system/streams`（`XINFO GROUPS／CONSUMERS`） |
| Lua（冪等） | worker 更新統計時依 ts 去重，at-least-once 重送不會重算里程 |
| Set 運算 | 迷霧格子 `fog:{uid}:{日}:{時段}`，選日期範圍時在 Redis 裡 `SUNION` |

## 階段

- [x] **M1 核心**：帳號、開團／邀請碼／開始／結束、位置回報（網頁＋Traccar）、即時地圖（深色／衛星／淺色、3D 地形）、失聯偵測、GPX 匯入、模擬器、全年迷霧足跡
- [x] **M2 回放**：全隊同步、時間軸＋倍速（1～300×）、事件標記可跳轉、跟拍鏡頭（車頭朝上、3D）、依隊員／速度／海拔上色、海拔與速度曲線（TS.MRANGE）、整趟摘要
- [ ] M3 警示與互動：Worker（consumer group）、落隊、抵達、測速（RediSearch）、訊息、標註、SOS、Telegram
- [ ] M4 導航：Valhalla 機車路線、規劃頁、轉彎提示
- [ ] M5 戰情室、後台、點亮鄉鎮（GEOSHAPE）、熱力圖
- [ ] M6 部署、UML、簡報、影片
