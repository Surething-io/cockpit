// Service Worker for tab switching via notifications

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// 处理来自页面的消息
self.addEventListener('message', async (event) => {
  if (event.data.type === 'FIND_TAB') {
    const { cwd } = event.data;

    // 查找所有打开的 tab
    const allClients = await clients.matchAll({ type: 'window' });
    const found = allClients.some((client) => {
      const url = new URL(client.url);
      const clientCwd = url.searchParams.get('cwd');
      return clientCwd === cwd;
    });

    // 通过 MessageChannel 返回结果
    event.ports[0].postMessage({ found });
  }
});

// 处理通知点击
self.addEventListener('notificationclick', async (event) => {
  event.notification.close();

  const { cwd, sessionId } = event.notification.data || {};
  if (!cwd) return;

  const targetUrl = `/?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`;

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(async (allClients) => {
      // 查找匹配 cwd 的 tab
      for (const client of allClients) {
        const url = new URL(client.url);
        const clientCwd = url.searchParams.get('cwd');
        if (clientCwd === cwd) {
          // 找到了，focus 并导航到正确的 sessionId
          await client.focus();
          client.navigate(targetUrl);
          return;
        }
      }

      // 没找到，打开新 tab
      clients.openWindow(targetUrl);
    })
  );
});
