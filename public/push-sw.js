// Push-only Service Worker for the mobile (/m) Web Push feature.
//
// Deliberately has NO fetch/install caching — it does not make Cockpit work
// offline (which the app explicitly does not want). Its sole job is to receive
// background push events and route notification taps to the right session.

// Localize the action button + fallback body using the device locale (the SW
// runs on the user's device, so navigator.language is the right source).
var IS_ZH = (self.navigator && self.navigator.language || 'en').toLowerCase().indexOf('zh') === 0;
var VIEW_LABEL = IS_ZH ? '查看' : 'View';
var DONE_LABEL = IS_ZH ? '任务完成' : 'Task finished';

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Cockpit', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Cockpit';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || DONE_LABEL,
      data: payload.data || {},
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-96x96.png',
      tag: payload.data && payload.data.sessionId ? `session-${payload.data.sessionId}` : undefined,
      actions: [{ action: 'open', title: VIEW_LABEL }],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let url = '/m';
  if (data.cwd && data.sessionId) {
    url = `/m?cwd=${encodeURIComponent(data.cwd)}&sessionId=${encodeURIComponent(data.sessionId)}`;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find(Boolean);
      if (win) {
        win.focus();
        if ('navigate' in win) win.navigate(url);
        return;
      }
      return self.clients.openWindow(url);
    }),
  );
});
