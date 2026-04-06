import { createServer } from 'http';
import { exec } from 'child_process';
import { networkInterfaces, homedir } from 'os';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import next from 'next';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.COCKPIT_ROOT = __dirname;

const dev = process.env.COCKPIT_ENV === 'dev';
const port = parseInt(process.env.PORT || (dev ? '3456' : '3457'), 10);

process.title = dev ? 'cockpit-dev' : 'cockpit';
process.env.COCKPIT_PORT = String(port);

// ============================================
// 进程生命周期防护
// 父进程死亡后 stdout/stderr 管道断裂，Next.js 的 uncaughtException handler
// 会尝试 console.log 报错 → 写 stdout → EPIPE → 再次触发 handler → CPU 死循环
// 在管道错误升级为 uncaughtException 之前拦截，直接退出
// ============================================
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});
process.on('SIGHUP', () => process.exit(0));

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const upgradeHandler = app.getUpgradeHandler();
  const { handleUpgrade, broadcastToGlobalState, handleBrowserApi, handleTerminalApi } = await import(dev ? './src/lib/wsServer.ts' : './dist/wsServer.mjs');
  const { scheduledTaskManager } = await import(dev ? './src/lib/scheduledTasks.ts' : './dist/scheduledTasks.mjs');

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

  // COCKPIT_HOST: 默认 127.0.0.1（本地），云沙盒等场景设为 0.0.0.0
  const host = process.env.COCKPIT_HOST || '127.0.0.1';
  server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log(`> Ready on ${url}`);

    // 写入 server.json 供 CLI 子命令读取端口
    try {
      const cockpitDir = join(homedir(), '.cockpit');
      mkdirSync(cockpitDir, { recursive: true });
      writeFileSync(join(cockpitDir, 'server.json'), JSON.stringify({ pid: process.pid, port }, null, 2));
    } catch {}

    // prod 模式自动打开浏览器（--no-open 禁用）
    if (!dev && !process.env.COCKPIT_NO_OPEN) {
      const openProject = process.env.COCKPIT_OPEN_PROJECT;
      const openUrl = openProject ? `${url}/?cwd=${encodeURIComponent(openProject)}` : url;
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${openUrl}`);
    }
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
      // 注入客户端真实 IP，供 /api/review/identify 使用
      const clientIp = req.socket.remoteAddress || '';
      req.headers['x-forwarded-for'] = clientIp;
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
