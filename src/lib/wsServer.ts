import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import { watch, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn, execSync } from 'child_process';
import * as nodePty from 'node-pty';
import { fileWatcher, type FileEvent } from './fileWatcher';
import { GLOBAL_STATE_FILE, readJsonFile, getTerminalHistoryPath, getTerminalOutputPath } from './paths';
import { readFile } from 'fs/promises';
import { getLastUserMessage } from './global-state';
import { registerCommand, finalizeCommand, getRunningCommands, getRunningCommand, getRegistrySize, getAllProjectCwds } from './terminal/RunningCommandRegistry';
import { registerBrowser, unregisterBrowser, resolvePendingRequest, getBrowserByShortId, createPendingRequest, sendCommandToBrowser, listBrowsers } from './browser/BrowserBridge';
import { getTerminalByShortId, listTerminals, addOutputListener, addExitListener, registerTerminal, unregisterTerminal, getTerminalShortId } from './terminal/TerminalBridge';
import { randomUUID } from 'crypto';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
  lastUserMessage?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

const HEARTBEAT_INTERVAL = 30000;

// 追踪所有 global-state WS 客户端，用于广播定时任务通知
const globalStateClients = new Set<WebSocket>();

/**
 * 向所有 global-state 客户端广播消息
 */
export function broadcastToGlobalState(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const ws of globalStateClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const { pathname, query } = parse(req.url || '', true);

  if (pathname === '/ws/watch') {
    handleFileWatch(ws, query.cwd as string);
  } else if (pathname === '/ws/global-state') {
    handleGlobalState(ws);
  } else if (pathname === '/ws/terminal') {
    handleTerminal(ws, query.projectCwd as string);
  } else if (pathname === '/ws/browser') {
    handleBrowser(ws, query.fullId as string);
  } else if (pathname === '/ws/terminal-follow') {
    handleTerminalFollow(ws, query.id as string);
  }
});

/**
 * 处理 HTTP upgrade 请求，仅接受 /ws/ 路径
 * 返回 true 表示已处理，false 表示不属于 ws 路径
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const { pathname } = parse(req.url || '', true);

  if (pathname === '/ws/watch' || pathname === '/ws/global-state' || pathname === '/ws/terminal' || pathname === '/ws/browser' || pathname === '/ws/terminal-follow') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  return false;
}

/**
 * /ws/watch?cwd=... — 文件变更监听
 */
function handleFileWatch(ws: WebSocket, cwd: string): void {
  if (!cwd) {
    ws.close(4400, 'Missing cwd parameter');
    return;
  }

  const send = (events: FileEvent[]) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watch', data: events }));
    }
  };

  const unsubscribe = fileWatcher.subscribe(cwd, send);

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  ws.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
}

/**
 * /ws/global-state — 全局状态监听
 */
function handleGlobalState(ws: WebSocket): void {
  globalStateClients.add(ws);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const sendState = async () => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
      state.sessions.sort((a, b) => b.lastActive - a.lastActive);
      const recentSessions = state.sessions.slice(0, 15);

      const sessionsWithLastMessage = await Promise.all(
        recentSessions.map(async (session) => {
          // isLoading 时 state.json 已有最新 lastUserMessage（chat route 写入），无需读 transcript
          if (session.isLoading && session.lastUserMessage) {
            return session;
          }
          const lastUserMessage = await getLastUserMessage(session.cwd, session.sessionId);
          return { ...session, lastUserMessage };
        })
      );

      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'global-state', data: { sessions: sessionsWithLastMessage } }));
    } catch (err) {
      if (!closed) console.error('Global state watch error:', err);
    }
  };

  // 立即推送一次
  sendState();

  // 监听 state.json
  const dir = dirname(GLOBAL_STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(GLOBAL_STATE_FILE, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sendState, 200);
    });
    watcher.on('error', (error) => {
      console.error('Global state file watcher error:', error);
    });
  } catch {
    try {
      watcher = watch(dir, (_, filename) => {
        if (filename === 'state.json') {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(sendState, 200);
        }
      });
    } catch (err) {
      console.error('Global state dir watcher error:', err);
    }
  }

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  ws.on('close', () => {
    closed = true;
    globalStateClients.delete(ws);
    if (watcher) watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(heartbeat);
  });
}

// ========== Terminal ==========

/**
 * 获取进程的所有后代进程 PID（深度优先，叶子进程在前）
 */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  function collect(parentPid: number) {
    try {
      const result = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
      const childPids = result.split('\n').filter(Boolean).map(Number);
      for (const childPid of childPids) {
        collect(childPid);
        descendants.push(childPid);
      }
    } catch { /* no children */ }
  }
  collect(pid);
  return descendants;
}

/**
 * /ws/terminal?projectCwd=... — Terminal 命令执行与 stdin 交互
 *
 * 客户端 → 服务端消息：
 *   { type: 'exec', commandId, command, cwd, tabId, env? }
 *   { type: 'stdin', commandId, data }
 *   { type: 'attach', commandId }
 *   { type: 'interrupt', pid }
 *   { type: 'running' }       — 查询正在运行的命令列表
 *
 * 服务端 → 客户端消息：
 *   { type: 'pid', commandId, pid }
 *   { type: 'stdout', commandId, data }
 *   { type: 'stderr', commandId, data }
 *   { type: 'exit', commandId, code }
 *   { type: 'error', commandId, error }
 *   { type: 'running', commands: [...] }
 */
function handleTerminal(ws: WebSocket, projectCwd: string): void {
  if (!projectCwd) {
    ws.close(4400, 'Missing projectCwd parameter');
    return;
  }

  let closed = false;

  // 每个命令的输出监听器清理函数
  const cleanupMap = new Map<string, () => void>();

  const send = (msg: Record<string, unknown>) => {
    if (!closed && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  /**
   * 为子进程挂载输出 + 退出监听（pipe 模式）
   * WS 断开时清理监听（进程继续运行）
   */
  function attachPipeListeners(commandId: string, child: import('child_process').ChildProcess) {
    // 先清理旧监听
    const oldCleanup = cleanupMap.get(commandId);
    if (oldCleanup) oldCleanup();

    const onStdout = (data: Buffer) => {
      send({ type: 'stdout', commandId, data: data.toString() });
    };
    const onStderr = (data: Buffer) => {
      send({ type: 'stderr', commandId, data: data.toString() });
    };
    const pid = child.pid;
    const onClose = async (code: number | null) => {
      const exitCode = code ?? 0;
      send({ type: 'exit', commandId, code: exitCode });
      try { await finalizeCommand(commandId, exitCode, pid); } catch (e) { console.error('[ws/terminal] finalize error:', e); }
      cleanupMap.delete(commandId);
    };
    const onError = async (error: Error) => {
      send({ type: 'error', commandId, error: error.message });
      try { await finalizeCommand(commandId, 1, pid); } catch (e) { console.error('[ws/terminal] finalize error:', e); }
      cleanupMap.delete(commandId);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('close', onClose);
    child.on('error', onError);

    const cleanup = () => {
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('close', onClose);
      child.off('error', onError);
    };
    cleanupMap.set(commandId, cleanup);
  }

  /**
   * 为 PTY 进程挂载输出 + 退出监听
   * PTY 模式下 stdout/stderr 合并为单一 data 流
   */
  function attachPtyListeners(commandId: string, pty: import('node-pty').IPty) {
    // 先清理旧监听
    const oldCleanup = cleanupMap.get(commandId);
    if (oldCleanup) oldCleanup();

    const dataDisposable = pty.onData((data: string) => {
      send({ type: 'stdout', commandId, data });
    });

    const ptyPid = pty.pid;
    const exitDisposable = pty.onExit(async ({ exitCode }) => {
      send({ type: 'exit', commandId, code: exitCode });
      try { await finalizeCommand(commandId, exitCode, ptyPid); } catch (e) { console.error('[ws/terminal] finalize error:', e); }
      cleanupMap.delete(commandId);
    });

    const cleanup = () => {
      dataDisposable.dispose();
      exitDisposable.dispose();
    };
    cleanupMap.set(commandId, cleanup);
  }

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const type = msg.type as string;

    if (type === 'exec') {
      const { commandId, command, cwd, tabId, env, usePty, cols, rows } = msg as {
        commandId: string; command: string; cwd: string; tabId: string;
        env?: Record<string, string>;
        usePty?: boolean;
        cols?: number;
        rows?: number;
      };

      if (!commandId || !command || !cwd || !tabId) {
        send({ type: 'error', commandId: commandId || '', error: 'Missing required parameters' });
        return;
      }

      // 构建最小环境（不继承 Next.js dev server 污染）
      const childEnv: Record<string, string | undefined> = {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        CLICOLOR: '1',
        CLICOLOR_FORCE: '1',
        PYTHONUNBUFFERED: '1',
        npm_config_color: 'always',
        ...env,
      };

      try {
        const userShell = process.env.SHELL || '/bin/zsh';

        if (usePty) {
          // PTY 模式：使用 node-pty 创建伪终端
          // 适用于需要 TTY 的交互式命令（claude、vim、htop 等）
          // node-pty env 必须全部为 string（不能有 undefined），且需要 PATH
          const ptyEnv: Record<string, string> = {
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          };
          for (const [k, v] of Object.entries(childEnv)) {
            if (v !== undefined) ptyEnv[k] = v;
          }
          const ptyProcess = nodePty.spawn(userShell, ['--login', '-c', command], {
            name: 'xterm-256color',
            cols: cols || 120,
            rows: rows || 30,
            cwd,
            env: ptyEnv,
          });

          // node-pty 需要一个 dummy ChildProcess 以兼容 attach 逻辑
          // 创建一个不做任何事的占位 ChildProcess
          const dummyChild = spawn('true', [], { stdio: 'ignore' });

          registerCommand({
            commandId,
            command,
            cwd,
            projectCwd,
            tabId,
            pid: ptyProcess.pid,
            process: dummyChild,
            ptyProcess,
            usePty: true,
            timestamp: new Date().toISOString(),
          });
          send({ type: 'pid', commandId, pid: ptyProcess.pid });
          attachPtyListeners(commandId, ptyProcess);
        } else {
          // Pipe 模式：传统 spawn（默认）
          const child = spawn(userShell, ['--login', '-c', command], {
            cwd,
            env: childEnv as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          });

          if (child.pid) {
            registerCommand({
              commandId,
              command,
              cwd,
              projectCwd,
              tabId,
              pid: child.pid,
              process: child,
              timestamp: new Date().toISOString(),
            });
            send({ type: 'pid', commandId, pid: child.pid });
            attachPipeListeners(commandId, child);
          } else {
            send({ type: 'error', commandId, error: 'Failed to spawn process' });
          }
        }
      } catch (e) {
        send({ type: 'error', commandId, error: (e as Error).message });
      }

    } else if (type === 'stdin') {
      const { commandId, data } = msg as { commandId: string; data: string };
      const cmd = getRunningCommand(commandId);
      if (!cmd) return;

      if (cmd.usePty && cmd.ptyProcess) {
        // PTY 模式：直接写入 PTY，控制字符由 PTY 自行处理
        try { cmd.ptyProcess.write(data); } catch { /* already exited */ }
      } else {
        // Pipe 模式：控制字符需要转为真实信号/操作
        if (data === '\x03' && cmd.pid) {
          // Ctrl+C → SIGINT（发给进程组）
          try { process.kill(-cmd.pid, 'SIGINT'); } catch {
            try { process.kill(cmd.pid, 'SIGINT'); } catch { /* already exited */ }
          }
        } else if (data === '\x1a' && cmd.pid) {
          // Ctrl+Z → SIGTSTP
          try { process.kill(cmd.pid, 'SIGTSTP'); } catch { /* already exited */ }
        } else if (data === '\x04') {
          // Ctrl+D → 关闭 stdin（发送 EOF）
          try { cmd.process.stdin?.end(); } catch { /* already closed */ }
        } else if (cmd.process.stdin?.writable) {
          cmd.process.stdin.write(data);
        }
      }

    } else if (type === 'attach') {
      const { commandId } = msg as { commandId: string };
      const cmd = getRunningCommand(commandId);
      if (!cmd) {
        send({ type: 'error', commandId, error: 'Command not found or already finished' });
        return;
      }

      // 发送 pid
      send({ type: 'pid', commandId, pid: cmd.pid });

      // 发送已缓冲的全部输出
      const buffered = cmd.outputLines.join('\n') + (cmd.outputPartial ? '\n' + cmd.outputPartial : '');
      if (buffered) {
        send({ type: 'stdout', commandId, data: buffered });
      }

      // 挂载 WS 转发监听（旧的已被前一个 WS 断开时清理）
      if (cmd.usePty && cmd.ptyProcess) {
        attachPtyListeners(commandId, cmd.ptyProcess);
      } else {
        attachPipeListeners(commandId, cmd.process);
      }

    } else if (type === 'interrupt') {
      const { pid } = msg as { pid: number };
      if (!pid) return;

      const descendants = getDescendantPids(pid);
      const allPids = [...descendants, pid];

      // SIGTERM
      for (const p of allPids) {
        try { process.kill(p, 'SIGTERM'); } catch { /* ignore */ }
      }
      // 1s 后 SIGKILL
      setTimeout(() => {
        for (const p of allPids) {
          try { process.kill(p, 0); process.kill(p, 'SIGKILL'); } catch { /* already exited */ }
        }
      }, 1000);

    } else if (type === 'resize') {
      // PTY 模式下调整终端尺寸
      const { commandId, cols, rows } = msg as { commandId: string; cols: number; rows: number };
      const cmd = getRunningCommand(commandId);
      if (cmd?.usePty && cmd.ptyProcess) {
        try { cmd.ptyProcess.resize(cols, rows); } catch { /* already exited */ }
      }

    } else if (type === 'running') {
      const commands = getRunningCommands(projectCwd);
      if (commands.length === 0) {
        const size = getRegistrySize();
        const cwds = getAllProjectCwds();
        console.warn(`[ws/terminal] running query: 0 commands for projectCwd="${projectCwd}", registry total=${size}, cwds=${JSON.stringify(cwds)}`);
      }
      send({ type: 'running', commands });
    }
  });

  ws.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    // 清理所有输出监听（但不杀进程，允许 re-attach）
    for (const cleanup of cleanupMap.values()) {
      cleanup();
    }
    cleanupMap.clear();
  });
}

// ========== Terminal CLI HTTP API ==========

/**
 * 从磁盘读取已结束命令的输出（JSONL 历史 + 独立 outputFile）
 */
async function readFinishedOutput(projectCwd: string, tabId: string, commandId: string): Promise<{ output: string; exitCode: number } | undefined> {
  try {
    const historyPath = getTerminalHistoryPath(projectCwd, tabId);
    const content = await readFile(historyPath, 'utf-8');
    for (const line of content.trim().split('\n').reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry.id === commandId) {
          let output = entry.output || '';
          if (entry.outputFile) {
            try { output = await readFile(entry.outputFile, 'utf-8'); } catch { /* file missing */ }
          }
          return { output, exitCode: entry.exitCode ?? 0 };
        }
      } catch { /* invalid line */ }
    }
  } catch { /* history file not found */ }
  return undefined;
}

/**
 * 处理 /api/terminal/<action> 请求
 * 与 handleBrowserApi 同一模式，在 server.mjs 中拦截。
 */
export async function handleTerminalApi(req: IncomingMessage, res: import('http').ServerResponse): Promise<boolean> {
  const { pathname } = parse(req.url || '', true);
  const match = pathname?.match(/^\/api\/terminal\/([a-z]+)$/);
  if (!match || req.method !== 'POST') return false;

  const action = match[1];

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: { id?: string; data?: string };
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }

  const sendJson = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (action === 'list') {
    sendJson(200, { ok: true, data: listTerminals(getRunningCommand) });
    return true;
  }

  // register：用户点击 shortId 标识时按需注册
  if (action === 'register') {
    const { tabId, commandId, command, projectCwd } = body as { tabId?: string; commandId?: string; command?: string; projectCwd?: string };
    if (!tabId || !commandId || !command) { sendJson(400, { ok: false, error: 'Missing tabId/commandId/command' }); return true; }
    const shortId = registerTerminal(tabId, commandId, command, projectCwd);
    sendJson(200, { ok: true, data: { shortId } });
    return true;
  }

  // unregister：取消注册
  if (action === 'unregister') {
    const { commandId } = body as { commandId?: string };
    if (!commandId) { sendJson(400, { ok: false, error: 'Missing commandId' }); return true; }
    unregisterTerminal(commandId);
    sendJson(200, { ok: true });
    return true;
  }

  const { id } = body;
  if (!id) { sendJson(400, { ok: false, error: 'Missing terminal id' }); return true; }

  const entry = getTerminalByShortId(id);
  if (!entry) { sendJson(404, { ok: false, error: `Terminal "${id}" not found` }); return true; }

  const cmd = getRunningCommand(entry.commandId);

  if (action === 'output') {
    if (cmd) {
      // 运行中：从内存缓冲区读取
      const output = cmd.outputLines.join('\n') + (cmd.outputPartial ? '\n' + cmd.outputPartial : '');
      sendJson(200, { ok: true, data: { output, command: entry.command, pid: cmd.pid, running: true } });
    } else {
      // 已结束：从磁盘读取（JSONL 历史 + outputFile）
      if (!entry.projectCwd) { sendJson(404, { ok: false, error: 'Command projectCwd unknown' }); return true; }
      const historyOutput = await readFinishedOutput(entry.projectCwd, entry.tabId, entry.commandId);
      if (historyOutput !== undefined) {
        sendJson(200, { ok: true, data: { output: historyOutput.output, command: entry.command, exitCode: historyOutput.exitCode, running: false } });
      } else {
        sendJson(404, { ok: false, error: 'Command output not available' });
      }
    }
    return true;
  }

  if (action === 'stdin') {
    if (!cmd) { sendJson(404, { ok: false, error: 'Command no longer running' }); return true; }
    const { data } = body;
    if (data === undefined) { sendJson(400, { ok: false, error: 'Missing data' }); return true; }

    if (cmd.usePty && cmd.ptyProcess) {
      try { cmd.ptyProcess.write(data); } catch { /* exited */ }
    } else if (cmd.process.stdin?.writable) {
      cmd.process.stdin.write(data);
    } else {
      sendJson(500, { ok: false, error: 'stdin not writable' }); return true;
    }
    sendJson(200, { ok: true });
    return true;
  }

  sendJson(400, { ok: false, error: `Unknown action: ${action}` });
  return true;
}

// ========== Terminal Follow WS ==========

/**
 * /ws/terminal-follow?id=<shortId> — 实时输出流
 *
 * 1. 先发 buffered output
 * 2. 实时推新输出 { type: 'output', data }
 * 3. 进程退出时发 { type: 'exit', code } 后关闭
 */
function handleTerminalFollow(ws: WebSocket, shortId: string): void {
  if (!shortId) { ws.close(4400, 'Missing id parameter'); return; }

  const entry = getTerminalByShortId(shortId);
  if (!entry) { ws.close(4404, 'Terminal not found'); return; }

  const cmd = getRunningCommand(entry.commandId);

  // 发送已缓冲的输出
  if (cmd) {
    const buffered = cmd.outputLines.join('\n') + (cmd.outputPartial ? '\n' + cmd.outputPartial : '');
    if (buffered) {
      ws.send(JSON.stringify({ type: 'output', data: buffered }));
    }
  }

  // 挂载实时监听
  const unsubOutput = addOutputListener(entry.commandId, (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  const unsubExit = addExitListener(entry.commandId, (code: number) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }));
      ws.close();
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  ws.on('close', () => {
    unsubOutput();
    unsubExit();
    clearInterval(heartbeat);
  });
}

// ========== Browser Automation HTTP API ==========

/**
 * 处理 /api/browser/<action> 请求
 *
 * 必须在 server.mjs 中拦截，不走 Next.js API route，
 * 因为 Next.js dev 模式会把 route 打包成独立模块实例，
 * 与 wsServer 的 BrowserBridge registry 不共享内存。
 */
export async function handleBrowserApi(req: IncomingMessage, res: import('http').ServerResponse): Promise<boolean> {
  const { pathname } = parse(req.url || '', true);
  const match = pathname?.match(/^\/api\/browser\/([a-z][a-z_]*)$/);
  if (!match || req.method !== 'POST') return false;

  const action = match[1];

  // 读取请求体
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: { id?: string; params?: Record<string, unknown>; timeout?: number };
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; }

  const { id, params: cmdParams = {}, timeout = 10000 } = body;

  const sendJson = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // list
  if (action === 'list') {
    sendJson(200, { ok: true, data: listBrowsers() });
    return true;
  }

  // unregister：断开 WS 并删除注册条目
  if (action === 'unregister') {
    if (!id) { sendJson(400, { ok: false, error: 'Missing browser id' }); return true; }
    const browser = getBrowserByShortId(id);
    if (browser) {
      if (browser.ws && browser.ws.readyState === WebSocket.OPEN) {
        browser.ws.close();
      }
      unregisterBrowser(browser.fullId);
    }
    sendJson(200, { ok: true });
    return true;
  }

  if (!id) { sendJson(400, { ok: false, error: 'Missing browser id' }); return true; }

  const browser = getBrowserByShortId(id);
  if (!browser) { sendJson(404, { ok: false, error: `Browser "${id}" not found` }); return true; }
  if (!browser.ws || browser.ws.readyState !== WebSocket.OPEN) {
    sendJson(503, { ok: false, error: `Browser "${id}" is disconnected` }); return true;
  }

  const reqId = `r-${randomUUID().slice(0, 8)}`;
  const sent = sendCommandToBrowser(id, reqId, action, cmdParams);
  if (!sent) { sendJson(503, { ok: false, error: 'Failed to send command' }); return true; }

  try {
    const data = await createPendingRequest(reqId, timeout);
    sendJson(200, { ok: true, data });
  } catch (err) {
    sendJson(504, { ok: false, error: (err as Error).message });
  }
  return true;
}

// ========== Browser Automation Bridge ==========

/**
 * /ws/browser?fullId=... — 浏览器气泡自动化桥
 *
 * BrowserBubble 组件连接此 WS，注册 shortId，
 * 接收来自 API 的自动化命令，转发给 iframe content script，
 * 并将结果返回。
 *
 * 服务端 → 客户端：
 *   { type: 'registered', shortId: 'abcd' }
 *   { type: 'browser:cmd', reqId, action, params }
 *
 * 客户端 → 服务端：
 *   { type: 'browser:cmd-result', reqId, ok, data?, error? }
 */
function handleBrowser(ws: WebSocket, fullId: string): void {
  if (!fullId) {
    ws.close(4400, 'Missing fullId parameter');
    return;
  }

  const shortId = registerBrowser(fullId, ws);
  ws.send(JSON.stringify({ type: 'registered', shortId }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'browser:cmd-result') {
      const { reqId, ok, data, error } = msg as {
        reqId: string; ok: boolean; data?: unknown; error?: string;
      };
      resolvePendingRequest(reqId, ok, data, error);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    unregisterBrowser(fullId);
  });
}
