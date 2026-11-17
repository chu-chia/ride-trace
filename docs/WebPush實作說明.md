# Web Push 推播實作說明（騎跡專案的作法）

目標：網頁關著、手機鎖螢幕也收得到通知（SOS、落隊、聊天…），不用做原生 App、不用 Firebase SDK。用瀏覽器標準的 Web Push（VAPID）。

## 一、整體流程

1. 前端註冊 Service Worker，向瀏覽器要推播訂閱（subscription）
2. 前端把訂閱（endpoint＋p256dh＋auth）POST 給後端存起來
3. 後端有事件時，用 VAPID 私鑰簽章，把加密後的內容 POST 到該訂閱的 endpoint（Apple／Google／Mozilla 的推播服務）
4. 推播服務送到裝置，Service Worker 的 `push` 事件呼叫 `showNotification()` 顯示通知

## 二、金鑰（VAPID）

- 產生一組 P-256 EC 金鑰：公鑰（uncompressed point，base64url）給前端，私鑰（32 bytes，base64url）留在後端 `.env`
- Python：`cryptography` 的 `ec.generate_private_key(ec.SECP256R1())`
- 另外需要 `VAPID_SUBJECT`，填 `mailto:...` 或 `https://...`（Apple 會檢查格式）
- 換金鑰的話，所有舊訂閱都會失效

## 三、前端

1. `sw.js` 必須放在網站根目錄（`/sw.js`），scope 才涵蓋全站。後端回應加 `Service-Worker-Allowed: /`，content-type 用 `text/javascript`
2. `sw.js`：
   - `push` 事件：`e.data.json()` 取 `{title, body, url, tag}`，`self.registration.showNotification(title, { body, tag, icon, data: { url } })`，外面包 `e.waitUntil()`
   - `notificationclick` 事件：關閉通知，用 `clients.matchAll` 找已開的視窗並 focus，沒有就 `clients.openWindow(url)`
3. 開通知（一定要在使用者點按鈕的 click 裡觸發）：
   ```js
   const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
   await navigator.serviceWorker.ready;
   if (await Notification.requestPermission() !== 'granted') throw new Error('沒有允許通知');
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: base64urlToUint8Array(VAPID_PUBLIC_KEY),
   });
   await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
   ```
4. 關通知：`sub.unsubscribe()`，並通知後端刪除

## 四、iPhone 一定要注意

- iOS 16.4 以上才支援，而且**只有「加入主畫面」後以網頁 App 模式打開**才有 `PushManager`。在 Safari 分頁或 Chrome 裡都不行
- 要有 `manifest.webmanifest`（`"display": "standalone"`、icons 192／512），HTML 加 `<link rel="manifest">`、`<link rel="apple-touch-icon">`
- 用 **Safari** 的「分享 → 加入主畫面」最穩。Chrome 加的有時只是捷徑，打開還有網址列，就收不到
- 判斷是不是網頁 App 模式：`matchMedia('(display-mode: standalone)').matches || navigator.standalone`
- 必須 HTTPS（localhost 例外）。手機測試可以用 Tailscale serve 拿到 HTTPS 網址

## 五、後端（Python FastAPI＋Redis 為例）

- 套件：`pywebpush`（同步，用 `asyncio.to_thread` 包起來）
- 儲存：`user:{uid}:push` 用 Hash，key＝endpoint 的 sha1 前 16 碼，value＝訂閱 JSON。一個人可以有多台裝置
- API：`GET /api/push/config`（回傳公鑰）、`POST /api/push/subscribe`、`POST /api/push/unsubscribe`、`POST /api/push/test`
- 送出：
  ```python
  from pywebpush import webpush, WebPushException
  webpush(subscription_info=sub, data=json.dumps(payload),
          vapid_private_key=PRIVATE_KEY, vapid_claims={"sub": SUBJECT},
          ttl=600, headers={"Urgency": "high"})
  ```
  `vapid_claims` 每次都要給新的 dict（套件會改到它）
- 回應 404／410＝訂閱失效，從 Hash 刪掉
- payload 是端對端加密，推播服務看不到內容，但也不要放敏感資料（例如座標）

## 六、和業務事件串起來（不讓 API 被推播拖慢）

- 產生事件時另外 `XADD stream:notify {trip, eid, type, uid, text}`（`MAXLEN ~ 5000`）
- 背景 worker 用 Redis Streams consumer group `push`：`XREADGROUP` 讀 → 決定收件人 → 送出 → `XACK`
- 收件人規則表：例如 SOS、聊天推給「全隊除了本人」，測速只推給本人
- 去重：`SET push:sent:{事件ID}:{收件人} 1 NX EX 86400`，worker 重送也不會推兩次
- 冷卻：落隊這種會來回觸發的，`SET push:calm:{行程}:{人}:{類型} 1 NX EX 300`
- notification 的 `tag` 用「行程＋類型」，同類會合併成一則；SOS 每次都跳

## 七、除錯清單

- 送不到 → 先看後端存的訂閱 endpoint 網域：`web.push.apple.com`（iPhone）、`fcm.googleapis.com`（Chrome）。手機沒有 apple 那筆，就是手機根本沒訂閱成功
- 權限被拒（denied）→ 只能請使用者到網站設定改，程式沒辦法再跳詢問
- 自動化測試的瀏覽器分頁常常不會跳出權限詢問，要手動按
- 做一個後台「送測試推播」按鈕，回報推播服務收下幾台，很好除錯
