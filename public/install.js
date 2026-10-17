// Registers the service worker that makes ämtli installable (sw.js). Every
// page script calls this; the CSP allows no inline script to do it once in
// the layout. A browser without service workers, or one that refuses, just
// has no offline page.

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
