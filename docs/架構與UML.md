# 騎跡：架構與 UML

圖都用 Mermaid 寫，GitHub 會直接畫出來；要放進簡報可以貼到 <https://mermaid.live> 匯出 PNG／SVG。

---

## 1. 系統架構

```mermaid
flowchart LR
  subgraph 手機
    TC[Traccar Client<br>背景回報 GPS]
    WEB[網頁<br>騎乘頁／規劃頁]
  end
  subgraph 電腦
    WAR[戰情室]
    ADM[管理後台]
    ME[我的紀錄／足跡]
  end
  subgraph Docker
    API[FastAPI<br>REST＋WebSocket]
    WK1[Worker ×N<br>consumer group]
    R[(Redis 8<br>GEO・Streams・Pub/Sub<br>TimeSeries・RediSearch・JSON)]
    VH[Valhalla<br>本機台灣路網]
  end
  TC -- HTTPS /osmand --> API
  WEB -- HTTPS /api/track --> API
  WEB & WAR & ADM & ME -- REST／WebSocket --> API
  API -- Pipeline 寫入<br>XADD stream:ingest --> R
  R -- Pub/Sub trip:{id}:live --> API
  R -- XREADGROUP --> WK1
  WK1 -- 警示、統計、點亮鄉鎮 --> R
  API -- 算路線／對到道路 --> VH
  WK1 -. 不需要 .- VH
```

公開資料都在本機匯入，查詢不送到外部服務：警政署測速執法設置點、OpenStreetMap（路網、地名與 POI、鄉鎮界線）。

## 2. 部署圖

```mermaid
flowchart TB
  subgraph dev["使用者裝置"]
    P1[手機瀏覽器]
    P2[Traccar Client]
    PC[電腦瀏覽器（戰情室）]
  end
  subgraph host["主機（Mac／雲端 VM）"]
    TS[Tailscale serve／Funnel<br>固定 https://xxx.ts.net]
    subgraph dc["docker compose"]
      A[api :8750<br>uvicorn]
      W[worker ×1～N]
      RD[(redis :6379<br>AOF everysec＋RDB)]
      V[valhalla :8002]
    end
    VOL[(named volume redis-data)]
    DATA[(./data<br>路網、個人資料，不進版控)]
  end
  P1 & P2 & PC -- HTTPS --> TS --> A
  A <--> RD
  W <--> RD
  A --> V
  RD --- VOL
  V --- DATA
```

## 3. 用例圖

```mermaid
flowchart LR
  rider((騎士))
  owner((建立者))
  viewer((戰情室觀看者))
  admin((管理者))
  rider --> u1[加入行程（邀請碼／QR）]
  rider --> u2[回報位置（網頁／Traccar）]
  rider --> u3[看隊友位置與距離]
  rider --> u4[收到警示：落隊、失聯、抵達、前方測速、路況、異常久停]
  rider --> u5[快速訊息、地圖標註、SOS]
  rider --> u6[新增集合點／休息點]
  rider --> u7[回放整趟]
  rider --> u8[全年足跡、點亮鄉鎮、熱力圖、統計]
  owner --> u9[開團、開始行程、移出隊友]
  owner --> u10[規劃路線：搜尋地點、停靠點、交通工具、方案]
  owner --> u11[調整落隊門檻]
  owner -.繼承.-> rider
  viewer --> u12[大螢幕看全隊：卡片牆、事件流、進度＋海拔]
  admin --> u13[看 Redis 狀態、線上人數、寫入量、Worker 進度]
```

## 4. 循序圖：一筆位置回報

```mermaid
sequenceDiagram
  autonumber
  participant P as 手機（Traccar）
  participant A as API
  participant R as Redis
  participant W as Worker（alerts／stats）
  participant B as 其他隊友瀏覽器
  P->>A: GET /osmand?id=…&lat=…&lon=…
  A->>R: Pipeline：GET active_trip、HMGET last …
  A->>R: Pipeline：XADD footprint／track、GEOADD geo、HSET state、TS.ADD 速度海拔、SET hb EX 90、XADD stream:ingest、PUBLISH live、TS.INCRBY 寫入量
  R-->>B: Pub/Sub → WebSocket {kind: pos}
  R-->>W: XREADGROUP（alerts、stats 各拿一份）
  W->>R: Lua update_stats（ts 去重）／ZINCRBY heat／FT.SEARCH GEOSHAPE → SADD towns
  W->>R: 投影到路線 → HSET progress；GEOSEARCH 集合點／測速／標註；Lua 落隊
  W->>R: XADD trip:{id}:events＋PUBLISH（只有狀態改變時）
  R-->>B: Pub/Sub → WebSocket {kind: event}
  W->>R: XACK
  Note over R: 90 秒沒有回報 → hb key 過期 → Keyspace Notification → API 標記失聯並廣播
```

## 5. 循序圖：規劃路線

```mermaid
sequenceDiagram
  participant U as 建立者（規劃頁）
  participant A as API
  participant R as Redis
  participant V as Valhalla
  U->>A: GET /api/poi/suggest?q=武嶺
  A->>R: FT.SUGGET sug:poi（FUZZY）
  U->>A: POST /api/routes/preview {停靠點, 交通工具}
  A->>V: /route（motorcycle＋exclude_tolls＋use_highways，alternates）
  A->>V: /trace_attributes（每段道路等級：國道／快速道路／彎路）
  A->>R: TS.MRANGE ts:pace:{uid}:* GROUPBY cat REDUCE sum（個人速度）
  A-->>U: 1～3 條方案（距離、一般估計、依你的速度、路權警告）
  U->>A: POST /api/poi/along {加油站, 取樣點}
  A->>R: Pipeline × N：GEOSEARCH poi:geo:fuel
  U->>A: PUT /api/trips/{id}/route
  A->>R: JSON.SET route:{rid}、HSET trip route、XADD events、PUBLISH
```

## 6. 活動圖：騎乘中的警示判斷（worker alerts group）

```mermaid
flowchart TD
  s([收到 stream:ingest 一筆]) --> t{在行程中？}
  t -- 否 --> e([XACK])
  t -- 是 --> p[投影到路線 → 沿路線里程、離路線距離]
  p --> o{離路線 > 150 m？}
  o -- 是 --> o1[HSETNX offroute → 第一次才發「偏離路線」]
  o -- 否 --> a
  o1 --> a[GEOSEARCH 集合點：進入半徑？]
  a -- 是 --> a1[Lua：SADD 抵達；SDIFF 為空＋SET NX → 全員到齊]
  a -- 否 --> c
  a1 --> c[GEOSEARCH 前方 1 km 測速：扇形＋橫向＋拍攝方向]
  c --> c1{SET camhit NX EX 900}
  c1 -- 成功 --> c2[只推給本人：前方測速]
  c1 -- 已提醒過 --> h
  c2 --> h[GEOSEARCH 前方 300 m 坑洞／落石]
  h --> k[靜止超過 10 分鐘且不在集合點？→ HSETNX stuck]
  k --> l{這個行程 2 秒內算過落隊？SET NX PX}
  l -- 沒有 --> l1[Lua：中位數中心 → 落隊／超前／跟上]
  l -- 算過 --> e
  l1 --> e
```

## 7. 狀態圖：行程與隊員

```mermaid
stateDiagram-v2
  [*] --> planned: 開團（邀請碼 SET NX EX 24h）
  planned --> live: 建立者開始（WATCH＋MULTI）
  live --> ended: 最後一位結束紀錄（Lua）
  ended --> [*]
```

```mermaid
stateDiagram-v2
  [*] --> 尚未回報
  尚未回報 --> 騎乘中: 第一筆位置
  騎乘中 --> 停車: 速度 < 5 km/h
  停車 --> 騎乘中
  停車 --> 異常久停: 靜止 > 10 分鐘且不在集合點
  異常久停 --> 騎乘中: 速度 > 3 m/s
  騎乘中 --> 失聯: hb key 90 秒過期
  停車 --> 失聯
  失聯 --> 騎乘中: 恢復回報
  騎乘中 --> 已結束: 結束自己的紀錄
  停車 --> 已結束
  已結束 --> [*]
```

## 8. Redis 資料模型（key 一覽）

```mermaid
classDiagram
  class 使用者 {
    user:｛uid｝ Hash
    username:｛name｝ String
    session:｛token｝ String TTL 30 天
    user:｛uid｝:trips Sorted Set
    user:｛uid｝:active_trip String
  }
  class 行程 {
    trip:｛id｝ Hash（status、owner、route、lag_km）
    trip:｛id｝:members Set
    trip:｛id｝:active Set
    trip:｛id｝:geo GEO
    trip:｛id｝:state:｛uid｝ Hash
    trip:｛id｝:events Stream
    trip:｛id｝:live Pub/Sub 頻道
    track:｛id｝:｛uid｝ Stream
    ts:｛id｝:｛uid｝:speed／alt TimeSeries
    hb:｛id｝:｛uid｝ String TTL 90 秒
  }
  class 警示與互動 {
    stream:ingest Stream＋2 個 consumer group
    trip:｛id｝:stats:｛uid｝ Hash
    trip:｛id｝:lagflag／gap Hash
    trip:｛id｝:waypoints GEO＋wp:｛wid｝ Hash
    trip:｛id｝:arrived:｛wid｝ Set
    trip:｛id｝:marks GEO＋mark:｛mid｝ Hash
    trip:｛id｝:sos Hash
    trip:｛id｝:progress Hash
    trip:｛id｝:offroute／stuck Hash
  }
  class 路線 {
    route:｛rid｝ JSON
  }
  class 公開資料 {
    poi:speedcam GEO＋speedcam:｛id｝ Hash
    idx:speedcam RediSearch
    poi:｛id｝ Hash＋idx:poi＋sug:poi
    poi:geo:｛種類｝ GEO
    townpart:｛rid｝:｛n｝ Hash＋idx:townshape GEOSHAPE
    town:｛rid｝ Hash
  }
  class 長期紀錄 {
    footprint:｛uid｝ Stream
    fog:｛uid｝:｛日｝:｛時段｝ Set
    heat:｛uid｝ Sorted Set
    user:｛uid｝:towns Set
    celltown Hash
    ts:pace:｛uid｝:｛類別｝:m／s TimeSeries
  }
  class 系統 {
    ts:sys:writes／pubsub TimeSeries
    online:report Sorted Set
    stat:ws String
    meta:* Hash
  }
  使用者 "1" --> "*" 行程
  行程 "1" --> "0..1" 路線
  行程 --> 警示與互動
  使用者 --> 長期紀錄
```
