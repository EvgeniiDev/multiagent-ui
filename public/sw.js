// No fetch handler or offline transcript cache: pages always use the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title || 'Multiagent UI', {
    body: payload.body || 'Open Multiagent UI to continue.',
    icon: '/pwa-192.png',
    tag: payload.tag,
    data: { url: payload.url || '/chat' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/chat', self.location.origin);
  if (target.origin !== self.location.origin || target.pathname !== '/chat') return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = windows.find(client => client.url === target.href);
    if (same) return same.focus();
    // Avoid navigating an unrelated open chat with an active draft.
    return self.clients.openWindow(target.href);
  })());
});
