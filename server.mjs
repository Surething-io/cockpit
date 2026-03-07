import { createServer } from 'http';
import next from 'next';

const dev = process.env.COCKPIT_ENV === 'dev';
const port = parseInt(process.env.PORT || (dev ? '3456' : '3457'), 10);

process.title = dev ? 'cockpit-dev' : 'cockpit';
process.env.COCKPIT_PORT = String(port);

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const upgradeHandler = app.getUpgradeHandler();
  const { handleUpgrade, broadcastToGlobalState, handleBrowserApi, handleTerminalApi } = await import('./src/lib/wsServer.ts');
  const { scheduledTaskManager } = await import('./src/lib/scheduledTasks.ts');

  // 初始化定时任务管理器
  scheduledTaskManager.setOnTaskFired((task) => {
    broadcastToGlobalState({ type: 'task-fired', taskId: task.id, cwd: task.cwd, tabId: task.tabId, sessionId: task.sessionId });
  });
  await scheduledTaskManager.init(port);

  const server = createServer(async (req, res) => {
    // /api/browser/* 必须在自定义 server 中处理（与 WS 共享 BrowserBridge 内存）
    if (req.url?.startsWith('/api/browser/') && req.method === 'POST') {
      const handled = await handleBrowserApi(req, res);
      if (handled) return;
    }
    if (req.url?.startsWith('/api/terminal/') && req.method === 'POST') {
      const handled = await handleTerminalApi(req, res);
      if (handled) return;
    }
    handle(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!handleUpgrade(req, socket, head)) {
      upgradeHandler(req, socket, head);
    }
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
