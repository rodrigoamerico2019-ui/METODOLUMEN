// =========================================================
//  LÚMEN — Service Worker (PWA)
//  Recebe notificações push mesmo com o app fechado e
//  mantém a casca do app disponível offline.
// =========================================================
const CACHE = 'lumen-v1';
const SHELL = ['/', '/index.html', '/logo.png', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// rede primeiro; se cair, serve a casca do cache (API nunca é cacheada)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('/')))
  );
});

// ===== PUSH: a notificação chega aqui, mesmo com o app fechado =====
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'Lúmen';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Você tem uma nova mensagem.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'lumen',
    data: { url: data.url || '/' },
    vibrate: [120, 60, 120]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
      return clients.openWindow(url);
    })
  );
});
