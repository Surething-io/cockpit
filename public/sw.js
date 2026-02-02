// Service Worker for global state management and tab switching

// 全局状态缓存
let globalStateCache = { sessions: [] };
let pollInterval = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
  // 激活后启动轮询
  startPolling();
});

// 启动轮询
function startPolling() {
  if (pollInterval) return;

  // 立即获取一次
  fetchGlobalState();

  // 每 3 秒轮询
  pollInterval = setInterval(fetchGlobalState, 3000);
}

// 获取全局状态并广播
async function fetchGlobalState() {
  try {
    const response = await fetch('/api/global-state');
    if (response.ok) {
      const newState = await response.json();

      // 检查是否有变化（简单比较 JSON）
      const oldJson = JSON.stringify(globalStateCache);
      const newJson = JSON.stringify(newState);

      if (oldJson !== newJson) {
        globalStateCache = newState;
        // 广播给所有 tab
        broadcastState();
      }
    }
  } catch {
    // 忽略网络错误
  }
}

// 广播状态给所有 tab
async function broadcastState() {
  const allClients = await clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    client.postMessage({
      type: 'GLOBAL_STATE_UPDATE',
      state: globalStateCache,
    });
  }
}

// 处理来自页面的消息
self.addEventListener('message', async (event) => {
  // 获取当前全局状态
  if (event.data.type === 'GET_GLOBAL_STATE') {
    // 确保轮询已启动
    startPolling();

    // 立即返回缓存的状态
    event.ports[0].postMessage({
      type: 'GLOBAL_STATE_UPDATE',
      state: globalStateCache,
    });
    return;
  }

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
    return;
  }

  // 强制刷新状态（用于状态更新后立即获取最新）
  if (event.data.type === 'REFRESH_GLOBAL_STATE') {
    await fetchGlobalState();
    return;
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
          // 先 focus 目标 tab
          await client.focus();
          // 延迟一点让 tab 切换完成，再发消息切换 session
          await new Promise(resolve => setTimeout(resolve, 300));
          const channel = new BroadcastChannel('session-switch');
          channel.postMessage({ targetCwd: cwd, sessionId });
          channel.close();
          return;
        }
      }

      // 没找到，打开新 tab
      clients.openWindow(targetUrl);
    })
  );
});
