// YAAM Remote service worker: shows push alerts from the desktop, opens the
// companion on tap, and keeps the installed app launchable offline. Served at
// /sw.js by remote.rs (hand-written, not bundled).
//
// Caching is deliberately narrow. Data (/api/*) is never cached: it is live
// state from the desktop. Only the app shell (one self-contained HTML page)
// and its icons are kept, network-first, so a launch while the desktop is
// asleep or off the network opens the app (which says "Desktop unreachable"
// and keeps queued messages) instead of a browser error page.

const SHELL = 'yaam-shell-v1'
const STATIC = ['/icon.png', '/icon-192.png', '/icon-maskable.png', '/apple-touch-icon.png', '/manifest.webmanifest']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(STATIC)).catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k)
  await self.clients.claim()
})()))

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') {
    // network first: a reachable desktop always serves the current app. The
    // shell is stored under '/' (its URL carries the connect token, which
    // must not become a cache key).
    e.respondWith((async () => {
      try {
        const res = await fetch(req)
        if (res.ok) {
          const copy = res.clone()
          e.waitUntil(caches.open(SHELL).then(c => c.put('/', copy)).catch(() => {}))
        }
        return res
      } catch (err) {
        const hit = await caches.match('/')
        if (hit) return hit
        throw err
      }
    })())
    return
  }
  if (STATIC.includes(url.pathname)) {
    e.respondWith(caches.match(url.pathname).then(hit => hit || fetch(req)))
  }
})

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
