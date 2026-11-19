// app 外殼快取 + 接收推播
const CACHE = 'nthu-lib-v8';
const CONFIG = 'nthu-lib-config';   // app 存放後端網址和通行碼，讓通知上的按鈕可以直接呼叫後端
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CONFIG).map(k => caches.delete(k))))
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

async function callApi(path, body) {
  const r = await (await caches.open(CONFIG)).match('config');
  const { api, token } = r ? await r.json() : {};
  if (!api) throw new Error('no config');
  const res = await fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': token || '' },
    body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

// 收到推播 → 顯示通知（預約提醒會一直留在畫面上直到你按掉）
self.addEventListener('push', e => {
  let d = { title: '圖書館提醒', body: '' };
  try { if (e.data) d = e.data.json(); } catch (_) { if (e.data) d.body = e.data.text(); }
  const opts = { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [100, 50, 100] };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }   // renotify 一定要搭配 tag，否則通知會被擋
  if (d.alert) {
    opts.data = { alert: d.alert };
    opts.requireInteraction = true;
    opts.vibrate = [400, 150, 400, 150, 400, 150, 800];
    opts.actions = [
      ...(d.alert.kind === 'at' ? [] : [{ action: 'checkin', title: '✅ 已報到' }]),
      { action: 'snooze', title: '⏰ 5 分鐘後再提醒' },
    ];
  }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || '圖書館提醒', opts),
    // app 正開著的話，直接跳出全螢幕提醒
    d.alert && clients.matchAll({ type: 'window' }).then(list =>
      list.filter(c => c.visibilityState === 'visible').forEach(c => c.postMessage({ type: 'alert', alert: d.alert }))),
  ]));
});

// 點通知 → 打開 app 並顯示全螢幕提醒；點通知上的按鈕 → 直接在背景處理
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alert = e.notification.data && e.notification.data.alert;

  if (alert && (e.action === 'checkin' || e.action === 'snooze')) {
    const done = e.action === 'checkin'
      ? (alert.bookingId ? callApi('/checkin', { id: alert.bookingId }) : Promise.resolve())
          .then(() => ['✅ 已記錄報到', '之後不會再提醒你報到了'])
      : callApi('/snooze', { alert, minutes: 5 }).then(() => ['⏰ 好，5 分鐘後再提醒你', alert.space || '']);
    e.waitUntil(done
      .catch(() => ['⚠️ 沒有成功', '請打開 app 再按一次'])
      .then(([title, body]) => self.registration.showNotification(title, { body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'action-result', silent: true }))
      .then(() => clients.matchAll({ type: 'window' })).then(list => list.forEach(c => c.postMessage({ type: 'refresh' }))));
    return;
  }

  const url = alert ? './?alert=' + encodeURIComponent(JSON.stringify(alert)) : './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    for (const c of list) {
      if ('focus' in c) {
        await c.focus();
        if (alert) c.postMessage({ type: 'alert', alert });
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
