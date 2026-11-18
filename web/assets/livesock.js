// 行程頁與戰情室共用的 WebSocket：自動重連＋斷線橫幅。
// 伺服器每 15 秒沒別的訊息就送 {kind:'ping'}；超過 STALE_MS 什麼都沒收到，就當成連線已死（手機換基地台、
// 筆電睡眠時 onclose 可能根本不會觸發），主動關掉重連，並顯示「連線中斷，資料可能不是最新」。

const STALE_MS = 40_000;   // 這麼久沒收到任何訊息 → 視為斷線
const GRACE_MS = 3_000;    // 短暫重連（例如伺服器重啟）不要閃橫幅

const css = `
.qx-conn{position:fixed;z-index:45;top:max(10px,calc(env(safe-area-inset-top,0px) + 8px));left:50%;transform:translateX(-50%);
  width:min(440px,calc(100% - 24px));display:flex;align-items:center;gap:10px;padding:9px 10px 9px 14px;border-radius:14px;
  background:#ff9f0a;color:#1d1d1f;font:13px/1.35 system-ui,-apple-system,"PingFang TC",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.qx-conn[hidden]{display:none}
.qx-conn.ok{background:#30d158}
.qx-conn .dot{width:9px;height:9px;border-radius:50%;background:currentColor;flex:none;animation:qxconn 1s ease-in-out infinite alternate}
.qx-conn.ok .dot{animation:none}
.qx-conn .txt{flex:1;min-width:0;display:flex;flex-direction:column}
.qx-conn .txt b{font-weight:700;font-size:14px}
.qx-conn .txt small{font-size:12px;opacity:.85}
.qx-conn button{flex:none;white-space:nowrap;border:0;border-radius:999px;padding:6px 12px;background:rgba(0,0,0,.14);color:inherit;font:600 13px/1 inherit;cursor:pointer}
.qx-conn button[hidden]{display:none}
/* 手機：右側有地圖按鈕列，橫幅靠左、讓出右邊 */
@media (max-width:600px){.qx-conn{left:12px;right:64px;width:auto;transform:none}}
@keyframes qxconn{from{opacity:.35}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.qx-conn .dot{animation:none}}
`;

function ensureBanner() {
  let el = document.querySelector('.qx-conn');
  if (el) return el;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.append(st);
  el = document.createElement('div');
  el.className = 'qx-conn';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="txt"></span><button type="button">重連</button>';
  document.body.append(el);
  return el;
}

const agoText = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分鐘前` : `${Math.floor(s / 3600)} 小時前`;
};

/**
 * @param {string} path  例如 `/ws/trips/12`
 * @param {{onMessage:(msg:any)=>void, onForbidden?:()=>void}} opts
 */
export function liveSocket(path, { onMessage, onForbidden }) {
  const banner = ensureBanner();
  const txt = banner.querySelector('.txt');
  let ws = null;
  let lastMsg = 0;        // 最後一次收到任何訊息的時間
  let lastData = 0;       // 最後一次收到真資料（非 ping）的時間，顯示「最後更新」
  let downSince = 0;      // 斷線開始時間；0 = 連線正常
  let retry = 0;
  let timer = null;
  let stopped = false;
  let okTimer = null;

  function render() {
    if (!downSince) return;
    if (Date.now() - downSince < GRACE_MS) return;
    banner.classList.remove('ok');
    banner.hidden = false;
    banner.querySelector('button').hidden = false;
    const when = lastData ? `最後更新 ${agoText(lastData)} · ` : '';
    txt.innerHTML = `<b>${navigator.onLine === false ? '沒有網路' : '連線中斷'}，資料可能不是最新</b><small>${when}重新連線中…</small>`;
  }

  function markDown() {
    if (!downSince) downSince = Date.now();
    clearTimeout(okTimer);
    render();
  }

  function markUp() {
    const wasShown = !banner.hidden && !banner.classList.contains('ok');
    downSince = 0;
    retry = 0;
    if (wasShown) {
      banner.classList.add('ok');
      txt.innerHTML = '<b>已重新連線</b>';
      banner.querySelector('button').hidden = true;
      clearTimeout(okTimer);
      okTimer = setTimeout(() => { banner.hidden = true; banner.classList.remove('ok'); }, 2500);
    } else {
      banner.hidden = true;
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
  }

  function connect() {
    if (stopped) return;
    clearTimeout(timer);
    if (ws) { ws.onclose = ws.onmessage = ws.onerror = null; try { ws.close(); } catch { /* 已關 */ } }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}${path}`);
    ws = sock;
    lastMsg = Date.now();  // 給這次連線一個完整的 STALE_MS 等第一則訊息
    sock.onmessage = (e) => {
      lastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.kind === 'ping') return;
      lastData = lastMsg;
      if (msg.kind === 'snapshot' || downSince) markUp();
      onMessage(msg);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      if (e.code === 4403) { stopped = true; banner.hidden = true; onForbidden?.(); return; }
      markDown();
      // 1、2、4、8 秒…最多 15 秒
      schedule(Math.min(15_000, 1000 * 2 ** retry++));
    };
  }

  // 看門狗：太久沒訊息就重連；橫幅上的「最後更新」每秒刷新
  setInterval(() => {
    if (stopped) return;
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > STALE_MS) {
      markDown();
      connect();
    }
    render();
  }, 1000);

  banner.querySelector('button').onclick = () => { retry = 0; connect(); };
  // 網路恢復、從背景切回來：不用等退避計時，立刻重連
  addEventListener('online', () => { if (downSince) { retry = 0; connect(); } });
  addEventListener('offline', () => { markDown(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (downSince || Date.now() - lastMsg > STALE_MS)) { retry = 0; markDown(); connect(); }
  });

  connect();
  return { reconnect: () => { retry = 0; connect(); }, get connected() { return !downSince; } };
}
