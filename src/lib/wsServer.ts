import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import { watch, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileWatcher, type FileEvent } from './fileWatcher';
import { GLOBAL_STATE_FILE, readJsonFile } from './paths';
import { getLastUserMessage } from './global-state';

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
  }
});

/**
 * 处理 HTTP upgrade 请求，仅接受 /ws/ 路径
 * 返回 true 表示已处理，false 表示不属于 ws 路径
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const { pathname } = parse(req.url || '', true);

  if (pathname === '/ws/watch' || pathname === '/ws/global-state') {
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
