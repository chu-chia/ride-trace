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
    if (wins[0] && 'navigate' in wins[0]) { await wins[0].navigate(url); return wins[0].focus(); }
    return self.clients.openWindow(url);
  })());
});
