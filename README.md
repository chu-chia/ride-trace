# 騎跡

機車車隊即時定位與回放系統（DBMS 課程 Redis 個人專題）。朋友約騎車時，每個人在地圖上即時看到彼此，有落隊、失聯、集合點、SOS 等警示；系統全程記錄可以整隊回放；另外還有全年足跡、點亮全台鄉鎮、熱力圖，以及給電腦大螢幕的戰情室和管理後台。

接手的 agent 請先讀 `AGENTS.md`。架構圖與 UML 在 `docs/架構與UML.md`，部署在 `docs/部署.md`，繳交清單在 `docs/繳交清單.md`。

目前進度：**M1～M5 完成**，另外補上 Web Push 推播與文字聊天室；M6 文件已備好，部署、簡報、影片待使用者處理（見下方「階段」）。

## 啟動

需要 Docker Desktop。

```bash
cp .env.example .env              # 第一次：設定 REDIS_PASSWORD（必填）、模擬器機器人密碼、管理者帳號
docker compose up -d --build      # Redis 8（127.0.0.1:6390，要密碼）＋ API／網頁（8750）＋ Worker ＋ Valhalla（127.0.0.1:8752）
open http://localhost:8750
```

開發時也可以只開 Redis，用 uv 跑 API（改程式會自動重載）：

```bash
docker compose up -d redis valhalla
cd backend && uv venv --python 3.12 && uv pip install -e .
uv run uvicorn app.main:app --port 8750 --reload
uv run python -m app.worker        # 另開一個終端機跑 worker
```

手機網頁定位必須是 HTTPS，見 `docs/部署.md`（Tailscale）。

Redis 有密碼且只綁本機：`docker compose exec redis redis-cli …` 不用打密碼（容器內設了 `REDISCLI_AUTH`）；主機上的 `tools/` 會自動從 `.env` 讀 `REDIS_PASSWORD`。

## 頁面

| 網址 | 內容 |
|---|---|
| `/login` | 帳號登入（登入頁背景是台灣經典路線巡航） |
| `/` | 首頁：我的足跡、進行中的行程、開團／加入、我的行程 |
| `/trip?id=` | 騎乘頁：即時地圖、隊友、事件、邀請 QR、回報設定與推播通知；左下集合點／測速／訊息（快速訊息＋聊天室）／標註／SOS／路線、全隊進度條、轉彎提示 |
| `/plan?trip=` | 規劃路線：搜尋地點加停靠點、機車／重機／汽車、1～3 條方案、依你的速度估時間、沿路線找加油站等、**沿途路況**（TDX）與**沿途天氣**（氣象署，依預計經過時間）、Google Maps 匯入（選用） |
| `/replay?id=` | 回放：全隊同步、時間軸＋事件、跟拍鏡頭、速度與海拔曲線、整趟摘要 |
| `/war?id=` | 戰情室（電腦大螢幕）：3D 自動運鏡、隊員卡片牆、事件流、進度條＋海拔剖面 |
| `/footprint` | 全年足跡地圖（迷霧、日期範圍、一天中的時段、逐月播放） |
| `/me` | 我的紀錄：點亮全台鄉鎮、熱力圖、累計統計、各種路的實際速度 |
| `/admin` | 管理後台（`ADMIN_USERS`）：Redis 狀態、線上人數、每秒寫入與 Pub/Sub、Worker 進度、外部資料同步 |

## 資料準備（都在本機處理）

個人位置資料一律放在 `data/`，已列在 `.gitignore`，**不要上傳**。

```bash
cd backend
# 1. 先在網頁註冊帳號，再把 GPX 匯入成這個帳號的全年足跡
uv run python -m tools.import_gpx ~/Downloads/xxx.gpx --user wei --reset
# 2. 切出展示用的真實騎乘片段（武嶺 4 段、北宜 1 段、台北→武嶺）到 data/tracks/，再對到道路上
uv run python -m tools.extract_tracks ~/Downloads/xxx.gpx
uv run python -m tools.match_tracks
# 3. 公開資料：測速照相（警政署）、地名與 POI、鄉鎮界線（本機 OSM 檔，Valhalla 第一次啟動時下載）
uv run python -m tools.import_speedcam
uv run --with osmium python -m tools.import_poi
uv run --with osmium --with shapely python -m tools.import_towns
# 4. 用全年足跡算：熱力圖＋點亮鄉鎮、各種路的實際速度（之後 worker 會即時更新前者）
uv run python -m tools.build_longterm --user wei --reset
uv run python -m tools.pace_profile --user wei --reset
```

Valhalla（`docker compose up -d valhalla`）第一次會下載台灣 OSM（約 330 MB）建路網，約 3～30 分鐘，資料放 `data/valhalla/`。地圖比對、路線計算、個人速度都只用本機 Valhalla，GPS 不會送到外部服務。

## GPS 模擬器

把真實騎乘片段當成多位隊友，走跟手機一樣的 `/api/track`。時間戳用「重播的時間」（1 倍速），所以 30 倍速跑完的行程，回放和摘要仍是真實的時長與速度。機器人密碼在 `.env` 的 `SIM_BOT_PASSWORD`。

```bash
cd backend
uv run python -m tools.simulate --group wuling --code ABC123              # 加入你建立的行程（你按開始後出發）
uv run python -m tools.simulate --group wuling --create "武嶺日出團"        # 機器人自己開團並開始
uv run python -m tools.simulate --group beiyi --create "北宜" --speed 20   # 北宜路線（沿途有測速照相）
uv run python -m tools.simulate --group wuling --code ABC123 --speed 20 --drop 2@600-3000   # 第 2 位斷訊（失聯）
```

測完記得 `pkill -f tools.simulate`，並把測試行程收掉（`HSET trip:{id} status ended`、刪 `trip:{id}:active` 和指向它的 `user:*:active_trip`）。

## Traccar Client 設定

在網頁「行程 → 回報」分頁可以看到伺服器網址（`https://<你的網址>/osmand`）和每個帳號一組的裝置 ID。同時支援舊版 OsmAnd 協定（query string，速度單位是節）和新版 JSON 格式。原生 App 可以在背景回報，騎車時建議用它而不是網頁定位。

Traccar Client 的 **SOS 按鈕**（送出 `alarm=sos`）會走跟網頁 SOS 一樣的流程：事件＋全隊推播＋紅色橫幅，重送不會重複發；解除要在網頁按「解除求救」。

## 前方路況（交通部 TDX）

`.env` 填 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`（tdx.transportdata.tw 會員中心 → 資料服務 → API 金鑰），`docker compose up -d api worker`。用的是「省道即時性道路事件」（施工、事故、管制、落石、活動）。來源偶爾經緯度寫反、或里程換算失敗被放在台1線 0K（臺北車站前），程式會校正或略過。後台「外部資料同步」看得到筆數與本月呼叫次數。

## 天氣（中央氣象署）

`.env` 填 `CWA_API_KEY`（opendata.cwa.gov.tw → 取得授權碼）。用「臺灣各縣市鄉鎮未來 3 天天氣預報」的 3 小時降雨機率（F-D0047-001～085，一個縣市一份）。位置先在本機用 GEOSHAPE 換成鄉鎮，只向氣象署要整個縣市的預報，座標不會送出去。

## 模擬資料與 Demo 循環

- `.env` 設 `FAKE_EXTERNAL=1`：天氣（氣象署）與路況（TDX）都不呼叫外部 API，改用固定規則產生的模擬資料（文字會標「模擬資料」），不消耗次數。真的出去騎之前改回空白並 `docker compose up -d api worker`。
- Demo 循環：`cd backend && nohup uv run python -u -m tools.simulate --group zhongheng --trip 57 --speed 1 --interval 2 --loop > ../data/sim-demo.log 2>&1 &`。每一圈開始前清掉這趟的即時資料（與機器人的個人足跡）再重跑，跑完休息 30 秒再來；行程會標 `demo=1`，**demo 行程的事件不推播**。停止：`pkill -f tools.simulate`。

## 推播通知（Web Push）

1. 產生金鑰貼進 `.env`：`cd backend && uv run --with cryptography python -m tools.gen_vapid`（`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`；`VAPID_SUBJECT` 填 `mailto:` 或 `https:`），再 `docker compose up -d api worker`。
2. 每台裝置在行程頁「回報」分頁按「開啟這台裝置的通知」。電腦用 `localhost` 或 HTTPS 都可以；手機一定要 HTTPS（見 `docs/部署.md`）。
3. **iPhone**：要先用 Safari「分享 → 加入主畫面」，從主畫面打開騎跡再開通知（iOS 16.4 以上）。Android Chrome 直接開就好。

推給誰：SOS、失聯、異常久停、快速訊息、聊天推給全隊（不含本人）；落隊、全員到齊推給全隊；前方測速、偏離路線只推給本人。聊天可以在同一張卡片關掉。推播內容由瀏覽器金鑰端對端加密，推播服務看不到，也不放座標。

## Redis 用到的功能

> 每一項都寫了「為什麼用 Redis、SQL 為什麼不方便」的理由在程式註解裡。

### 即時與事件

| 功能 | 用在哪 |
|---|---|
| GEO | `trip:{id}:geo` 即時位置，`GEOSEARCH` 算隊友距離；`tdx:roadev:geo` 省道事件（前方路況、沿途路況）；`trip:{id}:waypoints` 集合點、`trip:{id}:marks` 標註、`poi:speedcam` 測速、`poi:geo:{種類}` 加油站等；`footprint:{uid}:geo` 每個足跡點，熱力圖放大時 `GEOSEARCH … BYBOX` 只取畫面內的點（`tools.build_fpgeo` 補舊資料） |
| Pub/Sub | `trip:{id}:live` 位置與事件即時推到 WebSocket（行程頁、戰情室） |
| Streams | `track:{trip}:{uid}` 軌跡、`trip:{id}:events` 事件、`trip:{id}:chat` 聊天（`XREVRANGE` 往回翻頁）、`footprint:{uid}` 全年足跡（ID 就是時間戳，`XRANGE` 依時間查） |
| Streams Consumer Group | 每筆回報 `XADD stream:ingest`；獨立 worker 容器 `XREADGROUP`：group `stats`（里程、極速、熱力圖、點亮鄉鎮）、group `alerts`（落隊、抵達、測速、路況、沿路線進度、偏離路線、異常久停）；要推播的事件另外 `XADD stream:notify`，group `push` 送 Web Push。處理完才 `XACK`，worker 當掉時 `XAUTOCLAIM` 接手閒置 60 秒的訊息；`docker compose up -d --scale worker=2` 自動分攤 |
| TTL＋Keyspace Notification | `hb:{trip}:{uid}` 心跳 90 秒過期 → 失聯警示；`session:` 登入、`invite:` 邀請碼 24 小時 |
| Pipeline | 每筆 GPS 回報一次送出十幾個指令；匯入工具每 5,000 筆一批；沿路線找 POI 一次送出上百個 `GEOSEARCH` |
| Transactions | 開始行程用 `WATCH`＋`MULTI/EXEC` 樂觀鎖 |

### 原子判斷（Lua、NX）

| 功能 | 用在哪 |
|---|---|
| Lua：結束紀錄 | 移出 active、最後一人時把行程改成 ended，原子完成 |
| Lua：冪等統計 | worker 更新里程時依 ts 去重，at-least-once 重送不會重算 |
| Lua：落隊 | 有路線用「沿路線里程」中位數當中心（山路髮夾彎直線只差 400 m、沿路線落後 3 km 也抓得到），沒路線用座標中位數＋已騎里程；判斷＋改旗標在同一個 script，多個 worker 也只警示一次 |
| Lua：聊天已讀 | `trip:{id}:chatread` 記每個人讀到的 Stream ID，比大小後只往前推；未讀數＝`XRANGE (已讀ID +` 數別人發的 |
| Lua：抵達／全員到齊 | `SADD` 回傳 1 才通知抵達；`SDIFF active arrived` 為空＋`SET NX` 判斷全員到齊 |
| `SET NX EX`／`NX PX` | 測速提醒去重（15 分鐘）、坑洞提醒去重、快速訊息限流（2 秒）、聊天限流（1 秒）、落隊判斷節流（每行程 2 秒一次）、推播去重（`push:sent:{事件}:{收件人}`，worker 重送不會推兩次）、推播冷卻（落隊 5 分鐘只推一次） |
| `HSETNX`／`HDEL` | 偏離路線／回到路線、異常久停／恢復移動，回傳值保證只通知一次 |

### 查詢與分析

| 功能 | 用在哪 |
|---|---|
| RediSearch：測速 | `idx:speedcam`：縣市 TAG＋速限 NUMERIC＋地址中文全文＋位置 GEO，「南投縣、速限 40～60、地址含臺14、我附近 20 km」一個查詢 |
| RediSearch：地點搜尋 | `idx:poi`：本機 OSM 的 10.5 萬筆地名與 POI，中文斷詞＋前綴；`FT.SUGADD／FT.SUGGET`（含 FUZZY）打字自動完成 |
| RediSearch：GEOSHAPE | `idx:townshape`：全台 368 個鄉鎮市區多邊形，`FT.SEARCH "@shape:[CONTAINS $pt]"` 查一個點在哪個鄉鎮 → 點亮鄉鎮（SQL 通常得裝 PostGIS） |
| RedisJSON | `route:{id}` 整條路線（途經點、幾千個座標、累計里程、轉彎指示）；`JSON.GET … $.summary` 只取需要的部分 |
| TimeSeries | `ts:{trip}:{uid}:speed／alt`（回放 `TS.MRANGE … FILTER trip=… AGGREGATION avg`）；`ts:pace:{uid}:{類別}:m／s` 個人在各種路的距離與時間（`TS.MRANGE … GROUPBY cat REDUCE sum`）；`ts:sys:writes`、`ts:sys:pubsub`、`ts:sys:push` 後台每秒寫入、訊息量、推播數 |
| Sorted Set | `heat:{uid}` 熱力圖格子計數（`ZINCRBY`，`ZREVRANGE` 就是最常去的地方）；`online:report` 線上人數（`ZCOUNT` 最近 2 分鐘） |
| Set 運算 | 迷霧格子 `fog:{uid}:{日}:{時段}`，選日期範圍時 `SUNION`；`user:{uid}:towns` 點亮的鄉鎮（`SADD` 回傳 1 = 第一次點亮）；`SDIFF` 算誰還沒到集合點 |
| Hash 快取 | `celltown` 格子 → 鄉鎮（同一格不必每次都查空間索引）；`cache:` 查詢結果 TTL 快取 |
| `INCR` 版本快取＋`SET NX EX` 防抖 | 新足跡用 `fp:ver:{uid}` 原子遞增，足跡查詢快取 key 帶版本、舊版 7 天後自動清理；worker 用 `fp:warm:{uid}` 60 秒鎖合併大量更新並預算全期間資料。SQL 需自行維護版本、快取失效與跨 worker 防抖機制 |
| SCAN＋TYPE／TTL | 管理後台「維運工具」逐批列出行程相關 key、唯讀檢視 Redis 型別與剩餘效期；SQL 需跨多張表及系統目錄才能取得同樣的資料概況 |
| cache-aside＋TTL（外部 API） | 交通部 TDX 每月只有 3 點（4,500 次）：`cache:tdx:roadev` 120 秒過期才再抓全台省道事件，`SET lock:tdx:roadev NX EX 30` 只讓一個 worker 去抓（防 cache stampede），重建時寫暫存 key 再 `MULTI`＋`RENAME` 一次換上；`cache:tdx:token` 存 OAuth token；`tdx:usage` 記本月呼叫次數。沒有進行中的行程、沒人開規劃頁時完全不呼叫；氣象署鄉鎮預報同樣 cache-aside（`cache:cwa:{縣市}` 30 分鐘，一次抓回整個縣市） |

## 階段

- [x] **M1 核心**：帳號、開團／邀請碼／開始／結束、位置回報（網頁＋Traccar）、即時地圖（深色／衛星／淺色、3D 地形）、失聯偵測、GPX 匯入、模擬器、全年迷霧足跡
- [x] **M2 回放**：全隊同步、時間軸＋倍速（1～300×）、事件標記可跳轉、跟拍鏡頭、依隊員／速度／海拔上色、海拔與速度曲線（TS.MRANGE）、整趟摘要
- [x] **M3 警示與互動**：Worker（consumer group）、落隊、抵達與全員到齊、前方測速（RediSearch）、快速訊息、地圖標註與前方路況、SOS、異常久停；**Web Push 推播**（SOS、落隊、失聯、全員到齊、前方測速、偏離路線、訊息，鎖螢幕也收得到）、**文字聊天室**（未讀數、往回翻頁、回放看得到）、**前方路況**（交通部 TDX 省道即時事件：有路線時沿路線前方 5 km、沒路線時行進方向 3 km，全隊通知一次）、**前方降雨**（氣象署鄉鎮預報：前方 0～50 km 預計經過時降雨機率 ≥ 60% 就通知）
- [x] **M4 導航**：規劃頁（地點搜尋、聰明插入停靠點、沿路線找）、Valhalla 路線（機車不走國道與快速道路／重機不走國道但國道3甲例外、可走快速道路／汽車）、1～3 條方案、依個人速度估時間、Google Maps 匯入（選用）、全隊進度條、轉彎提示、偏離路線、路線版落隊
- [x] **M5 長期紀錄與大螢幕**：點亮全台鄉鎮（GEOSHAPE）、熱力圖、累計統計、戰情室、管理後台
- [ ] **M6 繳交**：架構圖與 UML、部署說明、簡報大綱、影片腳本、繳交清單與 Redis 匯出工具已備好（`docs/`）；實際部署、簡報、錄影、上傳 GitHub 由使用者進行

## 沒有做的（規格有、但這次不做）

- Telegram 推播（已有 Web Push，先不做）
- Google 登入（使用者決定用帳號密碼）
