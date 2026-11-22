// 騎跡 Service Worker：收 Web Push、點通知開回行程頁；換頁沒有網路時回一張離線頁（以前是瀏覽器的恐龍頁）。
// 只攔「開網頁」（navigate），而且一律先走網路；不快取任何檔案，不影響平常更新。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const OFFLINE_HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111214">
<title>沒有網路 · 騎跡</title><style>
html,body{margin:0;height:100%;background:#111214;color:#f2f2f7;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif}
main{min-height:100%;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:max(24px,env(safe-area-inset-top)) 24px 32px;max-width:460px;margin:0 auto;box-sizing:border-box}
h1{font-size:24px;margin:0}p{margin:0;color:#aeaeb2}b{color:#f2f2f7}
button{margin-top:8px;height:52px;border:0;border-radius:14px;background:#d9500f;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.sos{font-size:14px;padding:12px 14px;border-radius:12px;background:#2c2c2e}
</style></head><body><main>
<h1>現在沒有網路</h1>
<p>這一頁要連上網路才能打開。<b>已經開著的行程頁不受影響</b>：沒送出的位置和訊息會先存在手機，網路恢復後自動補傳。</p>
<p class="sos">要求救而沒有網路時，請直接撥 <b>112</b>（沒有 SIM 卡、沒有訊號也能撥）。</p>
<button type="button" onclick="location.reload()">重新連線</button>
<p style="font-size:13px">網路一恢復就會自動重新載入。</p>
</main><script>addEventListener('online',()=>location.reload())</script></body></html>`;

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '騎跡', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!(d.tag && d.renotify),
    requireInteraction: !!d.urgent,           // SOS 不會自己消失
    vibrate: d.urgent ? [400, 120, 400, 120, 400] : [150],
    icon: '/assets/icon-192.png',
    badge: '/assets/badge.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find((c) => c.url === url);
    if (same) return same.focus();
    // 已經開著同一個行程（不同分頁、帶不同參數）就切過去；其他頁面不要直接導走（UX-51：可能在看回放、填表單），另開一個
    const target = new URL(url);
    const tid = target.searchParams.get('id');
    const sameTrip = tid && wins.find((c) => {
      const u = new URL(c.url);
      return u.pathname === target.pathname && u.searchParams.get('id') === tid;
    });
    if (sameTrip) return sameTrip.focus();
    return self.clients.openWindow(url);
  })());
});
