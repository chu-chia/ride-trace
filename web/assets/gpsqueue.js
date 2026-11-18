// 網頁定位的送出佇列：每個點先進佇列（localStorage），再依序批次送到 /api/track/batch。
// 山區沒訊號時點會留在手機上，網路恢復後照時間順序補傳；頁面重新整理或被系統關掉也不會丟。
// 一定要「先補舊點、再送新點」：後端會略過比上一點舊的點（只更新足跡用的最後位置），順序錯了舊點就進不了軌跡。

const MAX_POINTS = 5000;   // 2.5 秒一點約 3.5 小時；超過就丟最舊的
const BATCH = 200;
const RETRY_MS = 5000;

export function gpsQueue(uid, { onChange } = {}) {
  const key = `qiji:gpsq:${uid}`;
  let items = [];
  try { items = JSON.parse(localStorage.getItem(key) || '[]'); } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  let pumping = false;
  let timer = null;
  let lastError = '';
  let sent = 0;
  let dup = false;  // 最近一批全部被後端略過：Traccar 正在回報（以 Traccar 為準）

  const save = () => { try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* 容量滿了就只留在記憶體 */ } };
  const notify = () => onChange?.({ pending: items.length, sent, error: lastError, dup });

  async function pump() {
    if (pumping) return;
    pumping = true;
    clearTimeout(timer);
    try {
      while (items.length) {
        const batch = items.slice(0, BATCH);
        let res;
        try {
          res = await fetch('/api/track/batch', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ points: batch }),
          });
        } catch {
          lastError = navigator.onLine === false ? '沒有網路' : '連不到伺服器';
          break;
        }
        if (res.status === 401) { lastError = '登入已過期，請重新登入（位置先留在手機上）'; break; }
        if (res.status >= 500 || res.status === 429 || res.status === 408) { lastError = `伺服器忙碌（${res.status}）`; break; }
        // 2xx：送出成功；其他 4xx：資料本身有問題，重送也沒用，丟掉免得卡住後面的點
        items.splice(0, batch.length);
        save();
        if (res.ok) {
          sent += batch.length; lastError = '';
          const body = await res.json().catch(() => ({}));
          dup = body.accepted > 0 && body.dup === body.accepted;
        } else lastError = `有 ${batch.length} 筆被拒收（${res.status}）`;
        notify();
      }
    } finally {
      pumping = false;
    }
    if (items.length) timer = setTimeout(pump, RETRY_MS);
    notify();
  }

  addEventListener('online', () => pump());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && items.length) pump(); });

  if (items.length) pump();   // 上次沒補完的（例如在山上重新整理過）

  return {
    push(pt) {
      items.push(pt);
      if (items.length > MAX_POINTS) items.splice(0, items.length - MAX_POINTS);
      save();
      notify();
      pump();
    },
    get pending() { return items.length; },
    flush: pump,
  };
}
