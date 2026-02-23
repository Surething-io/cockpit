import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import { watch, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn, execSync } from 'child_process';
import { fileWatcher, type FileEvent } from './fileWatcher';
import { GLOBAL_STATE_FILE, readJsonFile } from './paths';
import { getLastUserMessage } from './global-state';
import { registerCommand, appendCommandOutput, finalizeCommand, getRunningCommands, getRunningCommand } from './terminal/RunningCommandRegistry';

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

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const { pathname, query } = parse(req.url || '', true);

  if (pathname === '/ws/watch') {
    handleFileWatch(ws, query.cwd as string);
  } else if (pathname === '/ws/global-state') {
    handleGlobalState(ws);
  } else if (pathname === '/ws/terminal') {
    handleTerminal(ws, query.projectCwd as string);
  }
});

/**
 * 处理 HTTP upgrade 请求，仅接受 /ws/ 路径
 * 返回 true 表示已处理，false 表示不属于 ws 路径
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const { pathname } = parse(req.url || '', true);

  if (pathname === '/ws/watch' || pathname === '/ws/global-state' || pathname === '/ws/terminal') {
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
   * 为某个子进程挂载 stdout/stderr + close/error 监听
   * WS 断开时只清理 stdout/stderr（进程继续运行）
   * close/error 也挂在 cleanupMap 中，但 WS close 时只调 outputCleanup
   */
  function attachAllListeners(commandId: string, child: import('child_process').ChildProcess, isNew: boolean) {
    // 先清理旧监听
    const oldCleanup = cleanupMap.get(commandId);
    if (oldCleanup) oldCleanup();

    const onStdout = (data: Buffer) => {
      const text = data.toString();
      if (isNew) appendCommandOutput(commandId, text);
      send({ type: 'stdout', commandId, data: text });
    };
    const onStderr = (data: Buffer) => {
      const text = data.toString();
      if (isNew) appendCommandOutput(commandId, text);
      send({ type: 'stderr', commandId, data: text });
    };
    const onClose = async (code: number | null) => {
      const exitCode = code ?? 0;
      send({ type: 'exit', commandId, code: exitCode });
      try { await finalizeCommand(commandId, exitCode); } catch (e) { console.error('[ws/terminal] finalize error:', e); }
      cleanupMap.delete(commandId);
    };
    const onError = async (error: Error) => {
      send({ type: 'error', commandId, error: error.message });
      try { await finalizeCommand(commandId, 1); } catch (e) { console.error('[ws/terminal] finalize error:', e); }
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

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const type = msg.type as string;

    if (type === 'exec') {
      const { commandId, command, cwd, tabId, env } = msg as {
        commandId: string; command: string; cwd: string; tabId: string;
        env?: Record<string, string>;
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
        const userShell = process.env.SHELL || '/bin/bash';
        const child = spawn(userShell, ['--login', '-c', command], {
          cwd,
          env: childEnv as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,  // 独立进程组，方便 kill(-pid) 发信号给整组
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
          attachAllListeners(commandId, child, true);
        } else {
          send({ type: 'error', commandId, error: 'Failed to spawn process' });
        }
      } catch (e) {
        send({ type: 'error', commandId, error: (e as Error).message });
      }

    } else if (type === 'stdin') {
      const { commandId, data } = msg as { commandId: string; data: string };
      const cmd = getRunningCommand(commandId);
      if (!cmd) return;

      // pipe 模式下控制字符需要转为真实信号/操作
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

      // 挂载所有监听（旧的已被前一个 WS 断开时清理）
      attachAllListeners(commandId, cmd.process, false);

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

    } else if (type === 'running') {
      const commands = getRunningCommands(projectCwd);
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
