// Web Push：在這台裝置開／關通知。行程頁「更多 → 裝置與通知」、設定頁、後台都用 mountPushCard()。
import { api, esc, toast } from '/assets/common.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

// 訂閱有時會卡住（推播服務連不上、權限視窗被瀏覽器擋掉），15 秒還沒好就放棄，按鈕不會一直灰著（UX-50）
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

export function enablePush(publicKey) {
  return withTimeout(doEnable(publicKey), 15000, '開啟通知逾時：推播服務沒有回應，請確認網路後再按一次');
}

async function doEnable(publicKey) {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知被封鎖了，要到瀏覽器的網站設定裡改成允許' : '沒有允許通知');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
}

// 登出用：先拿這台的推播網址交給 /api/logout 一起刪，登出後再取消瀏覽器的訂閱（UX-06）
export async function pushEndpoint() {
  try { return (supported() ? (await currentSub())?.endpoint : null) || null; } catch { return null; }
}
export async function dropLocalPush() {
  try { const sub = supported() ? await currentSub() : null; if (sub) await sub.unsubscribe(); } catch { /* 沒有訂閱 */ }
}

export async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

// iPhone 用瀏覽器開（不是主畫面 App）時收不到推播：畫三個步驟，不要只丟一段說明（UX-32）
const IOS_STEPS = `<div class="small" style="color:var(--warn-ink)">iPhone 要從主畫面的騎跡 App 打開才收得到通知（iOS 16.4 以上）：</div>
  <ol class="push-steps">
    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg><span>在 Safari 按下方的「分享」</span></li>
    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg><span>往下滑，選「加入主畫面」→「新增」</span></li>
    <li><svg viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" style="fill:#d9500f"/><path d="M5 19c3-1 4-6 8-7s5 2 8-5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="21" cy="7" r="2.6" fill="#fff"/></svg><span>從主畫面的「騎跡」圖示打開，回到這張卡片按「開啟通知」</span></li>
  </ol>`;

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分鐘前` : s < 86400 ? `${Math.round(s / 3600)} 小時前` : new Date(ts).toLocaleDateString('zh-TW');
};

export async function mountPushCard(el) {
  if (!el) return;
  let cfg, sub = null;
  // 帶這台的 endpoint 去問伺服器有沒有登記：本機有訂閱、伺服器沒有（被清掉、過期）就自動重新登記一次（UX-07）
  const load = async () => {
    sub = supported() ? await currentSub().catch(() => null) : null;
    cfg = await api('/api/push/config' + (sub ? '?endpoint=' + encodeURIComponent(sub.endpoint) : ''));
    if (sub && !cfg.registered && cfg.enabled && Notification.permission === 'granted') {
      try {
        await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
        cfg = await api('/api/push/config?endpoint=' + encodeURIComponent(sub.endpoint));
      } catch { /* 下面會顯示「重新開啟」 */ }
    }
  };
  try { await load(); } catch { return; }
  const draw = () => {
    const local = !!sub && Notification.permission === 'granted';
    const on = local && cfg.registered;
    let state = '', action = '';
    if (!cfg.enabled) state = '伺服器還沒設定推播金鑰（.env 的 VAPID_*）。';
    else if (isIOS() && !standalone()) state = 'ios';
    else if (!supported()) state = '這個瀏覽器不支援網頁推播。';
    else if (!window.isSecureContext) state = '要用 HTTPS 網址打開才能開通知。';
    else if (Notification.permission === 'denied') state = '通知被封鎖了，要到瀏覽器的網站設定裡改成允許。';
    else if (local && !cfg.registered) state = '這台裝置的通知沒有登記在伺服器上，現在收不到。請按「重新開啟」。';
    if (!state || (local && !cfg.registered)) action = on
      ? '<button class="btn" id="pushTest">送一則測試</button><button class="btn" id="pushOff">關閉這台的通知</button>'
      : `<button class="btn primary" id="pushOn">${local ? '重新開啟' : '開啟這台裝置的通知'}</button>`;
    const types = (cfg.types || []).filter((t) => t.type !== 'sos_off');
    const last = cfg.last
      ? `最近一則：「${esc(cfg.last.title)}」，${ago(cfg.last.ts)}，送達 ${cfg.last.ok}／${cfg.last.total} 台${cfg.last.total && !cfg.last.ok ? '（都沒送到，可以按「送一則測試」檢查）' : ''}`
      : '這個帳號還沒有收過推播。';
    el.innerHTML = `
      <div class="eyebrow">通知（Web Push）</div>
      <div class="small muted">${on ? `這台裝置已開啟，螢幕鎖著、網頁沒開也收得到。你的帳號共 ${cfg.devices} 台裝置。`
        : `開了之後，螢幕鎖著、網頁沒開也收得到下面這 ${types.length} 種通知。`}</div>
      ${state === 'ios' ? IOS_STEPS : state ? `<div class="small" style="color:var(--warn-ink)">${esc(state)}</div>` : ''}
      ${action ? `<div class="qx-inline">${action}</div>` : ''}
      ${on ? `<div class="small muted">${last}</div>` : ''}
      <details class="push-types"${on ? '' : ' open'}><summary class="small">會推播哪些事（${types.filter((t) => t.on).length}／${types.length} 種開著）</summary>
        ${types.map((t) => `<label class="push-row"><span>${esc(t.title)}<span class="small muted" style="display:block">${esc(t.desc)}${t.fixed ? '・一定會推' : ''}</span></span>`
          + `<input type="checkbox" data-ptype="${esc(t.type)}" ${t.on ? 'checked' : ''} ${t.fixed || !on ? 'disabled' : ''}></label>`).join('')}
      </details>`;
  };
  el.addEventListener('click', async (e) => {
    const id = e.target.id;
    if (!['pushOn', 'pushOff', 'pushTest'].includes(id)) return;
    e.target.disabled = true;
    try {
      if (id === 'pushOn') { await enablePush(cfg.public_key); toast('通知已開啟', { icon: '鈴' }); }
      if (id === 'pushOff') { await disablePush(); toast('這台裝置不會再收到通知', { icon: '鈴' }); }
      if (id === 'pushTest') { await api('/api/push/test', { method: 'POST' }); toast('測試通知已送出，幾秒內會跳出來', { icon: '鈴' }); }
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    try { await load(); } catch { /* 保留上一次的狀態 */ }
    draw();
  });
  el.addEventListener('change', async (e) => {
    const type = e.target.dataset?.ptype;
    if (!type) return;
    try {
      await api('/api/push/prefs', { method: 'POST', body: { type, on: e.target.checked } });
      const t = cfg.types.find((x) => x.type === type);
      if (t) t.on = e.target.checked;
      const sum = el.querySelector('.push-types summary');
      const types = cfg.types.filter((x) => x.type !== 'sos_off');
      if (sum) sum.textContent = `會推播哪些事（${types.filter((x) => x.on).length}／${types.length} 種開著）`;
    } catch (err) { e.target.checked = !e.target.checked; toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
  draw();
}
