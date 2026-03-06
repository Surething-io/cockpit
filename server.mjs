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
  const { handleUpgrade, broadcastToGlobalState } = await import('./src/lib/wsServer.ts');
  const { scheduledTaskManager } = await import('./src/lib/scheduledTasks.ts');

  // 初始化定时任务管理器
  scheduledTaskManager.setOnTaskFired((task) => {
    broadcastToGlobalState({ type: 'task-fired', taskId: task.id, cwd: task.cwd, tabId: task.tabId, sessionId: task.sessionId });
  });
  await scheduledTaskManager.init(port);

  const server = createServer((req, res) => {
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
