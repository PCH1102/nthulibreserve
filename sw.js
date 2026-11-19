// app 外殼快取 + 接收推播
const CACHE = 'nthu-lib-v6';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 先回快取讓 app 立刻開啟，同時在背景抓新版
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    })
  );
});

// 收到推播 → 顯示通知
self.addEventListener('push', e => {
  let d = { title: '圖書館提醒', body: '' };
  try { if (e.data) d = e.data.json(); } catch (_) { if (e.data) d.body = e.data.text(); }
  const opts = { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [100, 50, 100] };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }   // renotify 一定要搭配 tag，否則通知會被擋
  e.waitUntil(self.registration.showNotification(d.title || '圖書館提醒', opts));
});

// 點通知 → 打開 app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow('./');
  }));
});
