// Service Worker for cross-tab communication (tab switching via notifications)

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// 处理来自页面的消息
self.addEventListener('message', async (event) => {
  // 查找匹配的 tab
  if (event.data.type === 'FIND_TAB') {
    const { cwd } = event.data;

    const allClients = await clients.matchAll({ type: 'window' });
    const found = allClients.some((client) => {
      const url = new URL(client.url);
      const clientCwd = url.searchParams.get('cwd');
      return clientCwd === cwd;
    });

    event.ports[0].postMessage({ found });
  }
});

// 处理通知点击
self.addEventListener('notificationclick', async (event) => {
  event.notification.close();

  const { cwd, sessionId } = event.notification.data || {};
  if (!cwd) return;

  // 构建目标 URL
  let targetUrl = `/?cwd=${encodeURIComponent(cwd)}`;
  if (sessionId) {
    targetUrl += `&sessionId=${encodeURIComponent(sessionId)}`;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(async (allClients) => {
      // 查找匹配 cwd 的 tab
      for (const client of allClients) {
        const url = new URL(client.url);
        const clientCwd = url.searchParams.get('cwd');
        if (clientCwd === cwd) {
          // 先 focus 目标 tab
          await client.focus();

          // 如果有 sessionId，发消息切换 session
          if (sessionId) {
            // 延迟一点让 tab 切换完成，再发消息切换 session
            await new Promise(resolve => setTimeout(resolve, 300));
            const channel = new BroadcastChannel('session-switch');
            channel.postMessage({ targetCwd: cwd, sessionId });
            channel.close();
          }
          return;
        }
      }

      // 没找到，打开新 tab
      clients.openWindow(targetUrl);
    })
  );
});
