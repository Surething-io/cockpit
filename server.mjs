import { createServer } from 'http';
import { networkInterfaces, homedir } from 'os';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
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

  server.listen(port, '127.0.0.1', () => {
    console.log(`> Ready on http://localhost:${port}`);

    // 写入 server.json 供 CLI 子命令读取端口
    try {
      const cockpitDir = join(homedir(), '.cockpit');
      mkdirSync(cockpitDir, { recursive: true });
      writeFileSync(join(cockpitDir, 'server.json'), JSON.stringify({ pid: process.pid, port }, null, 2));
    } catch {}
  });

  // ============================================
  // Share Server - LAN 分享评审服务
  // 路由白名单：仅开放 /review/* 和相关资源
  // ============================================
  const sharePort = port + 1000; // dev 3456→4456, prod 3457→4457

  const SHARE_ALLOWED_PREFIXES = ['/review/', '/api/review', '/_next/', '/fonts/', '/icons/'];
  const SHARE_ALLOWED_EXACT = ['/favicon.ico'];

  function isShareAllowed(url) {
    const pathname = url.split('?')[0];
    if (SHARE_ALLOWED_EXACT.includes(pathname)) return true;
    return SHARE_ALLOWED_PREFIXES.some(p => pathname.startsWith(p));
  }

  function getLanIPs() {
    const interfaces = networkInterfaces();
    const ips = [];
    for (const iface of Object.values(interfaces)) {
      for (const alias of iface || []) {
        if (alias.family === 'IPv4' && !alias.internal) {
          ips.push(alias.address);
        }
      }
    }
    return ips;
  }

  const shareServer = createServer((req, res) => {
    if (isShareAllowed(req.url || '')) {
      handle(req, res);
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
    }
  });

  shareServer.listen(sharePort, '0.0.0.0', () => {
    const lanIPs = getLanIPs();
    if (lanIPs.length > 0) {
      lanIPs.forEach(ip => console.log(`> Share on http://${ip}:${sharePort}`));
    } else {
      console.log(`> Share on http://0.0.0.0:${sharePort}`);
    }
  });

  shareServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`> Share server port ${sharePort} in use, skipping`);
    } else {
      console.error('Share server error:', err.message);
    }
  });
});
