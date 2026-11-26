// YAAM Remote service worker: shows push alerts from the desktop and opens
// the companion on tap. Served at /sw.js by remote.rs (hand-written, not
// bundled). It never caches or proxies requests: the companion is live data
// from the desktop, and a stale cached shell would only mislead.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let msg = {}
  try { msg = e.data ? e.data.json() : {} } catch { msg = { body: e.data ? e.data.text() : '' } }
  const title = msg.title || 'YAAM'
  // every push must show a notification (iOS revokes the subscription of a
  // worker that stays silent), so even an unreadable one gets a generic alert
  e.waitUntil(self.registration.showNotification(title, {
    body: msg.body || 'An agent needs you',
    tag: msg.tag || undefined,
    renotify: Boolean(msg.tag),
    icon: '/icon.png',
    badge: '/icon.png',
    data: { open: msg.open || '' },
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const open = (e.notification.data && e.notification.data.open) || ''
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find(w => new URL(w.url).origin === self.location.origin)
    if (win) {
      // an open companion navigates in place (keeps its token and pairing)
      win.postMessage({ type: 'yaam-open', open })
      return win.focus()
    }
    // cold start: the page re-applies its remembered connect token itself
    const url = new URL('/', self.location.origin)
    if (open) url.searchParams.set('open', open)
    return self.clients.openWindow(url.toString())
  })())
})
