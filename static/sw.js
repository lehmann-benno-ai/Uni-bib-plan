const CACHE = 'room-finder-v5';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.json', '/icon.svg', '/icon-192.png', '/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Network first for the app shell (so updates show up immediately), cache as offline fallback.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request, { cache: 'no-cache' });
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request.mode === 'navigate' ? '/' : event.request, copy));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(event.request.mode === 'navigate' ? '/' : event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Room Finder', {
    body: msg.body || '',
    tag: msg.tag,
    renotify: Boolean(msg.tag),
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: msg.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        if ('navigate' in c && url !== '/') c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

// The browser rotated the push subscription: re-subscribe and tell the server to move the alert settings over.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    let key = event.oldSubscription?.options?.applicationServerKey;
    if (!key) key = (await (await fetch('/api/push/key')).json()).publicKey;
    const sub = event.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/resubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldEndpoint: event.oldSubscription?.endpoint, subscription: sub.toJSON() }),
    });
  })());
});
