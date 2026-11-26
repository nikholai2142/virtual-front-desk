'use strict';
// Service worker for call notifications (Web Push). It only handles push
// events and notification clicks; it does no caching.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function dashboardVisible() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.some((c) => c.visibilityState === 'visible' && c.focused);
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* ignore */ }
  event.waitUntil((async () => {
    if (data.type === 'call') {
      // The open dashboard already rings and pops up, so stay quiet then.
      if (await dashboardVisible()) return;
      await self.registration.showNotification(
        data.transferred ? `Transferred call: ${data.kiosk || 'kiosk'}` : `Incoming call: ${data.kiosk || 'kiosk'}`,
        {
          body: 'A guest is waiting. Tap to answer.' + (data.topic ? ` (${data.topic})` : ''),
          tag: `call-${data.callId}`,
          renotify: true,
          requireInteraction: true,
          icon: '/branding/app-icon-192.png',
          badge: '/branding/app-icon-192.png',
          data: { url: '/agent' },
          vibrate: [200, 100, 200, 100, 200],
        }
      );
    } else if (data.type === 'cancel') {
      // Replace the incoming-call notification with a short silent note, then clear it.
      const existing = await self.registration.getNotifications({ tag: `call-${data.callId}` });
      if (!existing.length) return;
      await self.registration.showNotification('Call no longer waiting', {
        body: data.text || 'Another agent took it.',
        tag: `call-${data.callId}`,
        silent: true,
        icon: '/branding/app-icon-192.png',
        data: { url: '/agent' },
      });
      await new Promise((r) => setTimeout(r, 4000));
      (await self.registration.getNotifications({ tag: `call-${data.callId}` })).forEach((n) => n.close());
    } else if (data.type === 'test') {
      await self.registration.showNotification('Test notification', {
        body: 'Call notifications are working on this device.',
        tag: 'vfd-test',
        icon: '/branding/app-icon-192.png',
        data: { url: '/agent' },
      });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find((c) => new URL(c.url).pathname.startsWith('/agent'));
    if (open) { await open.focus(); return; }
    await self.clients.openWindow('/agent');
  })());
});
