import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import { watch, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn, execSync } from 'child_process';
import * as nodePty from 'node-pty';
import { fileWatcher, reviewWatcher, type FileEvent } from './fileWatcher';
import { GLOBAL_STATE_FILE, readJsonFile, getTerminalHistoryPath } from './paths';
import { readFile } from 'fs/promises';
import { getLastUserMessage } from './global-state';
import { registerCommand, finalizeCommand, getRunningCommands, getRunningCommand, getRegistrySize, getAllProjectCwds } from './terminal/RunningCommandRegistry';
import { registerBrowser, unregisterBrowser, resolvePendingRequest, getBrowserByShortId, createPendingRequest, sendCommandToBrowser, listBrowsers } from './bubbles/browser/BrowserBridge';
import { getTerminalByShortId, listTerminals, addOutputListener, addExitListener, registerTerminal, unregisterTerminal } from './terminal/TerminalBridge';
import { randomUUID } from 'crypto';
import { isWindows, getDefaultShell, getDefaultPath } from './platform';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: string;  // 'normal' | 'loading' | 'unread'
  title?: string;
  lastUserMessage?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

const HEARTBEAT_INTERVAL = 30000;

// Track all global-state WS clients for broadcasting scheduled task notifications
const globalStateClients = new Set<WebSocket>();

/**
 * Broadcast a message to all global-state clients
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
  } else if (pathname === '/ws/jupyter') {
    handleJupyter(ws, query.bubbleId as string, query.cwd as string);
  }
});

/**
 * Handle HTTP upgrade requests, only accept /ws/ paths
 * Returns true if handled, false if not a ws path
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const { pathname } = parse(req.url || '', true);

  if (pathname === '/ws/watch' || pathname === '/ws/global-state' || pathname === '/ws/terminal' || pathname === '/ws/browser' || pathname === '/ws/terminal-follow' || pathname === '/ws/jupyter') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  return false;
}

/**
 * /ws/watch?cwd=... — file change listener
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

  // Also subscribe to review directory change events
  const unsubReview = reviewWatcher.subscribe(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'watch', data: [{ type: 'review' }] }));
    }
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  ws.on('close', () => {
    unsubscribe();
    unsubReview();
    clearInterval(heartbeat);
  });
}

/**
 * /ws/global-state — global state listener
 */
function handleGlobalState(ws: WebSocket): void {
  globalStateClients.add(ws);
  let closed = false;

  const sendState = async () => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
      // Backward compatibility: isLoading → status
      for (const s of state.sessions) {
        if (!s.status) {
          const legacy = s as GlobalSession & { isLoading?: boolean };
          s.status = legacy.isLoading ? 'loading' : 'normal';
        }
      }
      state.sessions.sort((a, b) => b.lastActive - a.lastActive);
      const recentSessions = state.sessions.slice(0, 15);

      const sessionsWithLastMessage = await Promise.all(
        recentSessions.map(async (session) => {
          // When loading, state.json already has the latest lastUserMessage (written by chat route), no need to read transcript
          if (session.status === 'loading' && session.lastUserMessage) {
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

  // Serialize sendState: merge new changes that arrive during execution into one send, ensuring order
  let sending = false;
  let pendingSend = false;
  const scheduleSend = () => {
    if (sending) {
      pendingSend = true;  // Mark pending change; send once more after current completes
      return;
    }
    sending = true;
    sendState().finally(() => {
      sending = false;
      if (pendingSend) {
        pendingSend = false;
        scheduleSend();   // Push once more with the latest state.json
      }
    });
  };

  // Push immediately once
  scheduleSend();

  // Watch state.json
  const dir = dirname(GLOBAL_STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(GLOBAL_STATE_FILE, () => {
      scheduleSend();
    });
    watcher.on('error', (error) => {
      console.error('Global state file watcher error:', error);
    });
  } catch {
    try {
      watcher = watch(dir, (_, filename) => {
        if (filename === 'state.json') {
          scheduleSend();
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
    clearInterval(heartbeat);
  });
}

// ========== Terminal ==========

/**
 * Get all descendant PIDs of a process (depth-first, leaf processes first)
 */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  function collect(parentPid: number) {
    try {
      let result: string;
      if (isWindows) {
        result = execSync(`wmic process where (ParentProcessId=${parentPid}) get ProcessId /format:list`, { encoding: 'utf-8', timeout: 3000 }).trim();
        // wmic output: "ProcessId=1234"
        const childPids = result.split('\n').map(l => l.replace(/\r/, '').match(/ProcessId=(\d+)/)?.[1]).filter(Boolean).map(Number);
        for (const childPid of childPids) { collect(childPid); descendants.push(childPid); }
      } else {
        result = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf-8', timeout: 3000 }).trim();
        const childPids = result.split('\n').filter(Boolean).map(Number);
        for (const childPid of childPids) { collect(childPid); descendants.push(childPid); }
      }
    } catch { /* no children */ }
  }
  collect(pid);
  return descendants;
}

/**
 * /ws/terminal?projectCwd=... — Terminal command execution and stdin interaction
 *
 * Client → Server messages:
 *   { type: 'exec', commandId, command, cwd, tabId, env? }
 *   { type: 'stdin', commandId, data }
 *   { type: 'attach', commandId }
 *   { type: 'interrupt', pid }
 *   { type: 'running' }       — query the list of running commands
 *
 * Server → Client messages:
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

  // Cleanup functions for each command's output listeners
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
   * Attach output + exit listeners to a child process (pipe mode)
   * Clean up listeners on WS disconnect (process continues running)
   */
  function attachPipeListeners(commandId: string, child: import('child_process').ChildProcess) {
    // Clean up old listeners first
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
   * Attach output + exit listeners to a PTY process
   * In PTY mode, stdout/stderr are merged into a single data stream
   */
  function attachPtyListeners(commandId: string, pty: import('node-pty').IPty) {
    // Clean up old listeners first
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

      // Build a minimal environment (avoid inheriting Next.js dev server pollution)
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
        const userShell = getDefaultShell();

        if (usePty) {
          // PTY mode: use node-pty to create a pseudo-terminal
          // For interactive commands that require a TTY (claude, vim, htop, etc.)
          // node-pty env must be all strings (no undefined), and requires PATH
          const ptyEnv: Record<string, string> = {
            PATH: getDefaultPath(),
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

          // node-pty needs a dummy ChildProcess to be compatible with attach logic
          // Create a placeholder ChildProcess that does nothing
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
          // Pipe mode: traditional spawn (default)
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
        // PTY mode: write directly to PTY, control characters handled by PTY itself
        try { cmd.ptyProcess.write(data); } catch { /* already exited */ }
      } else {
        // Pipe mode: control characters must be converted to real signals/operations
        if (data === '\x03' && cmd.pid) {
          // Ctrl+C → SIGINT (send to process group)
          try { process.kill(-cmd.pid, 'SIGINT'); } catch {
            try { process.kill(cmd.pid, 'SIGINT'); } catch { /* already exited */ }
          }
        } else if (data === '\x1a' && cmd.pid) {
          // Ctrl+Z → SIGTSTP
          try { process.kill(cmd.pid, 'SIGTSTP'); } catch { /* already exited */ }
        } else if (data === '\x04') {
          // Ctrl+D → close stdin (send EOF)
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

      // Send pid
      send({ type: 'pid', commandId, pid: cmd.pid });

      // Send all buffered output
      const buffered = cmd.outputLines.join('\n') + (cmd.outputPartial ? '\n' + cmd.outputPartial : '');
      if (buffered) {
        send({ type: 'stdout', commandId, data: buffered });
      }

      // Attach WS forwarding listeners (old ones were cleaned up when the previous WS disconnected)
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
      // SIGKILL after 1s
      setTimeout(() => {
        for (const p of allPids) {
          try { process.kill(p, 0); process.kill(p, 'SIGKILL'); } catch { /* already exited */ }
        }
      }, 1000);

    } else if (type === 'resize') {
      // Resize terminal in PTY mode
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
    // Clean up all output listeners (without killing processes, allowing re-attach)
    for (const cleanup of cleanupMap.values()) {
      cleanup();
    }
    cleanupMap.clear();
  });
}

// ========== Terminal CLI HTTP API ==========

/**
 * Read finished command output from disk (JSONL history + separate outputFile)
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
 * Handle /api/terminal/<action> requests
 * Same pattern as handleBrowserApi; intercepted in server.mjs.
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

  // register: on-demand registration when the user clicks a shortId badge
  if (action === 'register') {
    const { tabId, commandId, command, projectCwd } = body as { tabId?: string; commandId?: string; command?: string; projectCwd?: string };
    if (!tabId || !commandId || !command) { sendJson(400, { ok: false, error: 'Missing tabId/commandId/command' }); return true; }
    const shortId = registerTerminal(tabId, commandId, command, projectCwd);
    sendJson(200, { ok: true, data: { shortId } });
    return true;
  }

  // unregister: deregister a terminal
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
      // Still running: read from in-memory buffer
      const output = cmd.outputLines.join('\n') + (cmd.outputPartial ? '\n' + cmd.outputPartial : '');
      sendJson(200, { ok: true, data: { output, command: entry.command, pid: cmd.pid, running: true } });
    } else {
      // Finished: read from disk (JSONL history + outputFile)
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
 * /ws/terminal-follow?id=<shortId> — live output stream
 *
 * 1. Send buffered output first
 * 2. Push new output in real time: { type: 'output', data }
 * 3. Send { type: 'exit', code } and close when the process exits
 */
function handleTerminalFollow(ws: WebSocket, shortId: string): void {
  if (!shortId) { ws.close(4400, 'Missing id parameter'); return; }

  const entry = getTerminalByShortId(shortId);
  if (!entry) { ws.close(4404, 'Terminal not found'); return; }

  const cmd = getRunningCommand(entry.commandId);

  // Send buffered output
  if (cmd) {
    const buffered = cmd.outputLines.join('\n') + (cmd.outputPartial ? '\n' + cmd.outputPartial : '');
    if (buffered) {
      ws.send(JSON.stringify({ type: 'output', data: buffered }));
    }
  }

  // Attach real-time listeners
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
 * Handle /api/browser/<action> requests
 *
 * Must be intercepted in server.mjs rather than a Next.js API route,
 * because Next.js dev mode bundles each route as a separate module instance
 * that does not share memory with the BrowserBridge registry in wsServer.
 */
export async function handleBrowserApi(req: IncomingMessage, res: import('http').ServerResponse): Promise<boolean> {
  const { pathname } = parse(req.url || '', true);
  const match = pathname?.match(/^\/api\/browser\/([a-z][a-z_]*)$/);
  if (!match || req.method !== 'POST') return false;

  const action = match[1];

  // Read request body
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

  // unregister: close WS and remove registration entry
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
 * /ws/browser?fullId=... — browser bubble automation bridge
 *
 * BrowserBubble connects to this WS, registers a shortId,
 * receives automation commands from the API, forwards them to the iframe content script,
 * and returns the results.
 *
 * Server → Client:
 *   { type: 'registered', shortId: 'abcd' }
 *   { type: 'browser:cmd', reqId, action, params }
 *
 * Client → Server:
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

// ========== Jupyter Kernel WebSocket ==========

/**
 * /ws/jupyter?bubbleId=...&cwd=... — Jupyter kernel communication
 *
 * Client → Server messages:
 *   { type: 'execute', msg_id, code }
 *   { type: 'interrupt' }
 *
 * Server → Client messages:
 *   { type: 'output', msg_id, msg_type, content }
 *   { type: 'status', execution_state }
 *   { type: 'kernel_error', message }
 *   { type: 'kernel_died', exit_code }
 *   { type: 'ready' }
 */
async function handleJupyter(ws: WebSocket, bubbleId: string, cwd: string): Promise<void> {
  if (!bubbleId || !cwd) {
    ws.close(4400, 'Missing bubbleId or cwd parameter');
    return;
  }

  let closed = false;
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

  // Lazy import to avoid loading kernel manager on every WS connection
  const { kernelManager } = await import('./bubbles/jupyter/JupyterKernelManager');

  // Start or connect to existing kernel
  try {
    const instance = await kernelManager.getOrCreate(bubbleId, cwd);
    if (instance.errorMessage) {
      send({ type: 'kernel_error', message: instance.errorMessage });
    } else {
      send({ type: 'ready' });
    }
  } catch (err) {
    send({ type: 'kernel_error', message: (err as Error).message });
  }

  // Subscribe to kernel outputs
  const unsubscribe = kernelManager.addOutputListener(bubbleId, (msg) => {
    if (msg.msg_type === 'kernel_error') {
      send({ type: 'kernel_error', message: msg.content.message as string });
    } else if (msg.msg_type === 'kernel_died') {
      send({ type: 'kernel_died', exit_code: msg.content.exit_code });
    } else if (msg.msg_type === 'status') {
      send({ type: 'status', execution_state: (msg.content as Record<string, unknown>).execution_state });
    } else {
      send({ type: 'output', msg_id: msg.msg_id, msg_type: msg.msg_type, content: msg.content });
    }
  });

  ws.on('message', async (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const type = msg.type as string;

    if (type === 'execute') {
      const { msg_id, code } = msg as { msg_id: string; code: string };
      try {
        await kernelManager.execute(bubbleId, code, msg_id, cwd);
      } catch (err) {
        send({ type: 'kernel_error', message: (err as Error).message });
      }
    } else if (type === 'interrupt') {
      await kernelManager.interrupt(bubbleId);
    }
  });

  ws.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    // Note: kernel keeps running — reconnection possible
  });
}
