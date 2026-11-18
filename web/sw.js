// 騎跡 Service Worker：只負責收 Web Push、點通知開回行程頁。沒有攔截 fetch，不影響離線或快取行為。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
