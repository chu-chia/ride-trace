# Redis 功能對照

每一個 Redis 功能用在系統的哪裡、為什麼選 Redis。程式註解裡也都寫了「SQL 為什麼不方便」的理由。

> 每一項都寫了「為什麼用 Redis、SQL 為什麼不方便」的理由在程式註解裡。

## 即時與事件

| 功能 | 用在哪 |
|---|---|
| GEO | `trip:{id}:geo` 即時位置，`GEOSEARCH` 算隊友距離；`tdx:roadev:geo` 省道事件（前方路況、沿途路況）；`trip:{id}:waypoints` 集合點、`trip:{id}:marks` 標註、`poi:speedcam` 測速、`poi:geo:{種類}` 加油站等；`footprint:{uid}:geo` 每個足跡點，熱力圖放大時 `GEOSEARCH … BYBOX` 只取畫面內的點（`tools.build_fpgeo` 補舊資料） |
| Pub/Sub | `trip:{id}:live` 位置與事件即時推到 WebSocket（行程頁、戰情室）。行程**開始前**的點也會更新 `trip:{id}:geo` 與狀態 Hash（`EXPIRE` 10 分鐘、不設心跳）並廣播，集合時隊友、戰情室就互相看得到；但不寫軌跡、TimeSeries、統計，也不交給 worker 判斷警示，按開始那一刻才開始記錄（10 分鐘內有回報的人位置留著並開始算心跳） |
| Streams | `track:{trip}:{uid}` 軌跡、`trip:{id}:events` 事件、`trip:{id}:chat` 聊天（`XREVRANGE` 往回翻頁）、`footprint:{uid}` 全年足跡（ID 就是時間戳，`XRANGE` 依時間查） |
| Streams Consumer Group | 每筆回報 `XADD stream:ingest`；獨立 worker 容器 `XREADGROUP`：group `stats`（里程、極速、熱力圖、點亮鄉鎮）、group `alerts`（落隊、抵達、測速、路況、沿路線進度、偏離路線、異常久停）；要推播的事件另外 `XADD stream:notify`，group `push` 送 Web Push。處理完才 `XACK`，worker 當掉時 `XAUTOCLAIM` 接手閒置 60 秒的訊息；`docker compose up -d --scale worker=2` 自動分攤 |
| TTL＋Keyspace Notification | `hb:{trip}:{uid}` 心跳 90 秒過期 → 失聯警示；`session:` 登入、`invite:` 邀請碼 24 小時 |
| Pipeline | 每筆 GPS 回報一次送出十幾個指令；匯入工具每 5,000 筆一批；沿路線找 POI 一次送出上百個 `GEOSEARCH` |
| Transactions | 開始行程用 `WATCH`＋`MULTI/EXEC` 樂觀鎖；踢人用 `MULTI/EXEC` 一次移出成員、GEO、心跳，並 `SADD trip:{id}:kicked`（被移出的人重開行程頁時顯示「你已被移出」，用邀請碼加回來時 `SREM`） |

## 原子判斷（Lua、NX）

| 功能 | 用在哪 |
|---|---|
| Lua：結束紀錄 | 移出 active、最後一人時把行程改成 ended，原子完成 |
| Lua：冪等統計 | worker 更新里程時依 ts 去重，at-least-once 重送不會重算 |
| Lua：落隊 | 有路線用「沿路線里程」中位數當中心（山路髮夾彎直線只差 400 m、沿路線落後 3 km 也抓得到），沒路線用座標中位數＋已騎里程；判斷＋改旗標在同一個 script，多個 worker 也只警示一次 |
| Lua：聊天已讀 | `trip:{id}:chatread` 記每個人讀到的 Stream ID，比大小後只往前推；未讀數＝`XRANGE (已讀ID +` 數別人發的 |
| Lua：抵達／全員到齊 | `SADD` 回傳 1 才通知抵達；`SDIFF active arrived` 為空＋`SET NX` 判斷全員到齊 |
| `SET NX EX`／`NX PX` | 測速提醒去重（15 分鐘）、坑洞提醒去重、快速訊息限流（2 秒）、聊天限流（1 秒）、落隊判斷節流（每行程 2 秒一次）、推播去重（`push:sent:{事件}:{收件人}`，worker 重送不會推兩次）、推播冷卻（落隊 5 分鐘只推一次，超前共用同一把）、推播合併視窗（`push:grpwin:{trip}:{類型}` NX PX 45 秒：失聯／落隊／久停第一則立刻推，視窗內其他人先 `RPUSH push:grp:…`，到期由 `push:due`（Sorted Set，score＝到期時間）`ZRANGEBYSCORE`＋`ZREM` 搶到的 worker 合併成「3 人失聯：A、B、C」）、註冊速率限制（`rl:register:{IP}` `INCR`＋`EXPIRE`，10 分鐘 10 次） |
| `HSETNX`／`HDEL` | 偏離路線／回到路線、異常久停／恢復移動，回傳值保證只通知一次 |

## 查詢與分析

| 功能 | 用在哪 |
|---|---|
| RediSearch：測速 | `idx:speedcam`：縣市 TAG＋速限 NUMERIC＋地址中文全文＋位置 GEO，「南投縣、速限 40～60、地址含臺14、我附近 20 km」一個查詢 |
| RediSearch：地點搜尋 | `idx:poi`：本機 OSM 的 15.6 萬筆地名與 POI（地名、車站、景點、學校、醫院、公所、機車行、公廁、充電站、廟宇、湖泊、橋、老街、超市、銀行…共 40 類），中文斷詞＋前綴；`FT.SUGADD／FT.SUGGET`（含 FUZZY，6.1 萬個名稱）打字自動完成；直接打種類名稱（「機車行」「公廁」）＝`@kind:{moto} @loc:[經度 緯度 30 km]` 找附近這一類 |
| RediSearch：GEOSHAPE | `idx:townshape`：全台 368 個鄉鎮市區多邊形，`FT.SEARCH "@shape:[CONTAINS $pt]"` 查一個點在哪個鄉鎮 → 點亮鄉鎮（SQL 通常得裝 PostGIS） |
| RedisJSON | `route:{id}` 整條路線（途經點、幾千個座標、累計里程、轉彎指示）；`JSON.GET … $.summary` 只取需要的部分 |
| RedisJSON＋TTL：個人路線 | 偏離全隊路線 10 秒，前端呼叫 `POST /api/trips/{id}/reroute`，從目前位置（含車頭方向）用本機 Valhalla 重算到下一個停靠點，存 `trip:{id}:navroute:{uid}`（6 小時自動過期）；worker 每點只用 `JSON.GET … $.created` 確認還在不在，換新的才讀 `$.coords $.cum_km`。走個人路線時全隊里程用「個人路線走了幾成」換算到 `team_from_km～team_to_km`，落隊／超前不會因為走別條路亂跳；騎到停靠點或騎回原路就 `DEL` 接回全隊路線；全隊路線改了用 `SCAN MATCH trip:{id}:navroute:*` 一次作廢 |
| Streams：路線紀錄 | 建立者騎到一半改路線時，舊的 `route:{rid}` 不刪，只用 `JSON.SET … $.replaced` 標上被換掉的時間；每次換路線 `XADD trip:{id}:routes`（Stream ID＝換上的毫秒時間，欄位 rid／誰改的／km）。回放用 `XRANGE` 依時間讀出「哪段時間走哪條」，播放到哪裡就把那時的路線畫成藍色、其他畫灰色虛線。改完後背景工作讀每個騎士的 `trip:{id}:state:{uid}`（位置、車頭方向），離新路線 150 m 以上的人（例如已經過了分岔口）先 `HSETNX` 占住偏離標記避免誤報，再各自算一條接回新路線的個人路線 |
| TimeSeries | `ts:{trip}:{uid}:speed／alt`（回放 `TS.MRANGE … FILTER trip=… AGGREGATION avg`）；`ts:pace:{uid}:{類別}:m／s` 個人在各種路的距離與時間（`TS.MRANGE … GROUPBY cat REDUCE sum`）；`ts:sys:writes`、`ts:sys:pubsub`、`ts:sys:push` 後台每秒寫入、訊息量、推播數 |
| Sorted Set | `heat:{uid}` 熱力圖格子計數（`ZINCRBY`，`ZREVRANGE` 就是最常去的地方）；`online:report` 線上人數（`ZCOUNT` 最近 2 分鐘） |
| Set 運算 | 迷霧格子 `fog:{uid}:{日}:{時段}`，選日期範圍時 `SUNION`；`user:{uid}:towns` 點亮的鄉鎮（`SADD` 回傳 1 = 第一次點亮）；`SDIFF` 算誰還沒到集合點 |
| Hash 快取 | `celltown` 格子 → 鄉鎮（同一格不必每次都查空間索引）；`cache:` 查詢結果 TTL 快取 |
| `INCR` 版本快取＋`SET NX EX` 防抖 | 新足跡用 `fp:ver:{uid}` 原子遞增，足跡查詢快取 key 帶版本、舊版 7 天後自動清理；worker 用 `fp:warm:{uid}` 60 秒鎖合併大量更新並預算全期間資料。SQL 需自行維護版本、快取失效與跨 worker 防抖機制 |
| SCAN＋TYPE／TTL | 管理後台「維運工具」逐批列出行程相關 key、唯讀檢視 Redis 型別與剩餘效期；SQL 需跨多張表及系統目錄才能取得同樣的資料概況 |
| cache-aside＋TTL（外部 API） | 交通部 TDX 每月只有 3 點（4,500 次）：`cache:tdx:roadev` 120 秒過期才再抓全台省道事件，`SET lock:tdx:roadev NX EX 30` 只讓一個 worker 去抓（防 cache stampede），重建時寫暫存 key 再 `MULTI`＋`RENAME` 一次換上；`cache:tdx:token` 存 OAuth token；`tdx:usage` 記本月呼叫次數。沒有進行中的行程、沒人開規劃頁時完全不呼叫；氣象署鄉鎮預報同樣 cache-aside（`cache:cwa:{縣市}` 30 分鐘，一次抓回整個縣市） |
