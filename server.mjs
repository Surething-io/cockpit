import { createServer } from 'http';
import { exec, execSync } from 'child_process';
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
//
// 1) 父进程死亡后 stdout/stderr 管道断裂，Next.js 的 uncaughtException handler
//    会尝试 console.log 报错 → 写 stdout → EPIPE → 再次触发 handler → CPU 死循环
//    在管道错误升级为 uncaughtException 之前拦截，直接退出。
//
// 2) Next.js 在 dev 模式下会在自己的子进程里跑 `next-server` worker（turbopack）。
//    如果父进程被异常杀掉（npm reinstall、Ctrl+C 后 npm 包了一层、IDE 杀任务等），
//    next-server 子进程不会跟着死，而是会失去父进程后**重新绑定到 next 自带的默认
//    端口 3000**，然后把后续 `npm run dev` 卡死（Next 通过 .next/dev/logs 检测到
//    "已有 dev server 在跑"而拒绝再启）。所以父进程退出前必须显式杀掉所有直接子进程。
// ============================================
let _cleanupRan = false;
function killChildren() {
  if (_cleanupRan) return;
  _cleanupRan = true;
  if (process.platform === 'win32') {
    // Windows: 走 wmic 列出子 PID 再逐个 taskkill /F /T，避免 /T 把自己也带走
    try {
      const out = execSync(`wmic process where (ParentProcessId=${process.pid}) get ProcessId /value`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = (out.match(/ProcessId=(\d+)/g) || []).map(s => s.split('=')[1]).filter(Boolean);
      for (const pid of pids) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    } catch {}
    return;
  }
  // POSIX: pkill -P 只杀直接子进程，不递归（next-server 等都是直接子进程，足够）
  // pkill 在没有匹配到任何进程时返回 1，不当作错误
  try { execSync(`pkill -TERM -P ${process.pid}`, { stdio: 'ignore' }); } catch {}
}

// 正常退出路径（包括所有的 process.exit() 调用）—— Node 保证此 handler 同步执行
process.on('exit', killChildren);

// 信号路径 —— 先杀子进程再退出，并让 shell 看到正确的退出码
const cleanupAndExit = (code) => () => { killChildren(); process.exit(code); };
process.on('SIGINT',  cleanupAndExit(130));
process.on('SIGTERM', cleanupAndExit(143));
process.on('SIGQUIT', cleanupAndExit(131));
process.on('SIGHUP',  cleanupAndExit(0));

// 未捕获异常 —— 不能让 Next.js 的默认 handler 再走 console.log 触发 EPIPE 死循环
process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException:', err); } catch {}
  killChildren();
  process.exit(1);
});

// stdout/stderr 管道断裂 → 立刻退出（exit handler 会顺手清子进程）
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});

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
