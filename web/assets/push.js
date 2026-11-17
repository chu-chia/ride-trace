// Web Push：在這台裝置開／關通知。行程頁「回報」分頁的卡片用 mountPushCard()。
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

export async function enablePush(publicKey) {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? '通知被封鎖了，要到瀏覽器的網站設定裡改成允許' : '沒有允許通知');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
}

export async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

export async function mountPushCard(el) {
  if (!el) return;
  let cfg;
  try { cfg = await api('/api/push/config'); } catch { return; }
  const draw = async () => {
    const sub = supported() ? await currentSub().catch(() => null) : null;
    const on = !!sub && Notification.permission === 'granted';
    let state = '', action = '';
    if (!cfg.enabled) state = '伺服器還沒設定推播金鑰（.env 的 VAPID_*）。';
    else if (isIOS() && !standalone()) state = 'iPhone 要用「網頁 App」模式才能收通知：用 Safari 打開這個網址 →「分享 → 加入主畫面」，再從主畫面的騎跡圖示打開（上方不會有網址列），回到這裡開啟通知（iOS 16.4 以上）。';
    else if (!supported()) state = '這個瀏覽器不支援網頁推播。';
    else if (!window.isSecureContext) state = '要用 HTTPS 網址打開才能開通知。';
    else if (Notification.permission === 'denied') state = '通知被封鎖了，要到瀏覽器的網站設定裡改成允許。';
    else action = on
      ? '<button class="btn" id="pushTest">送一則測試</button><button class="btn" id="pushOff">關閉這台的通知</button>'
      : '<button class="btn primary" id="pushOn">開啟這台裝置的通知</button>';
    el.innerHTML = `
      <div class="eyebrow">通知（Web Push）</div>
      <div class="small muted">${on ? `這台裝置已開啟。螢幕鎖著、網頁沒開也會收到 SOS、落隊、失聯、全員到齊、前方測速、訊息。你的帳號共 ${cfg.devices} 台裝置。`
        : '開了之後，螢幕鎖著、網頁沒開也收得到 SOS、落隊、失聯、全員到齊、前方測速和隊友訊息。'}</div>
      ${state ? `<div class="small" style="color:var(--warn-ink)">${esc(state)}</div>` : ''}
      ${action ? `<div class="qx-inline">${action}</div>` : ''}
      ${on ? `<label class="push-row"><span>聊天訊息也推播</span><input type="checkbox" id="pushChat" ${cfg.chat ? 'checked' : ''}></label>` : ''}`;
  };
  el.addEventListener('click', async (e) => {
    const id = e.target.id;
    if (!['pushOn', 'pushOff', 'pushTest'].includes(id)) return;
    e.target.disabled = true;
    try {
      if (id === 'pushOn') { await enablePush(cfg.public_key); toast('通知已開啟', { icon: '鈴' }); }
      if (id === 'pushOff') { await disablePush(); toast('這台裝置不會再收到通知', { icon: '鈴' }); }
      if (id === 'pushTest') { await api('/api/push/test', { method: 'POST' }); toast('測試通知已送出，幾秒內會跳出來', { icon: '鈴' }); }
      cfg = await api('/api/push/config');
    } catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
    await draw();
  });
  el.addEventListener('change', async (e) => {
    if (e.target.id !== 'pushChat') return;
    try { await api('/api/push/prefs', { method: 'POST', body: { chat: e.target.checked } }); cfg.chat = e.target.checked; }
    catch (err) { toast(err.message, { icon: '!', color: '#ff3b30' }); }
  });
  await draw();
}
