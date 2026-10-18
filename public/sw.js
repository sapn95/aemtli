// The service worker, served at /sw.js so that its scope is the whole site.
// The server puts `const VERSION = "<version>";` in front of this file, so a
// release is a new worker, and the new worker drops the caches of the old.
//
// It keeps as little as it can. Pages and everything under /api/ hold
// personal data and are sent no-store, so it never caches them, and it
// leaves the chat's event stream alone. What it keeps is the versioned
// static files, which never change under their URL, and one small page to
// show when a page cannot be fetched.

const CACHE = `aemtli-${VERSION}`;
const OFFLINE = `/static/offline.html?v=${VERSION}`;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, `/static/app.css?v=${VERSION}`])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('aemtli-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // The network always; the offline page only when there is none. A
    // redirect to the Access login passes through as it came.
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE).then(page => page ?? Response.error())));
    return;
  }
  if (url.pathname.startsWith('/static/') && url.searchParams.get('v') === VERSION) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const kept = await cache.match(request);
      if (kept) return kept;
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(request, fresh.clone());
      return fresh;
    }));
  }
});

// A push from ämtli (see webpush.mjs): a title, a line, and the page a tap
// opens. Only pages of this site are opened; anything else opens the
// dashboard.
self.addEventListener('push', event => {
  let data;
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'ämtli', body: event.data?.text() ?? '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'ämtli', {
    body: data.body ?? '',
    icon: `/static/icons/icon-192.png?v=${VERSION}`,
    badge: `/static/icons/badge-96.png?v=${VERSION}`,
    data: { url: data.url ?? '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = new URL('/', self.location.origin);
  try {
    const url = new URL(event.notification.data?.url ?? '/', self.location.origin);
    if (url.origin === self.location.origin) target = url;
  } catch {
    // Not a URL: the dashboard.
  }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    // navigate() works only on a page this worker controls; else a new one.
    if (open) return open.focus().then(w => w.navigate(target.href)).catch(() => self.clients.openWindow(target.href));
    return self.clients.openWindow(target.href);
  }));
});
