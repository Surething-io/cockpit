/**
 * Terminal WebSocket Manager
 * A single WS connection manages execution, stdin, attach, and interrupt for all terminal commands
 *
 * Key design decisions:
 * 1. onclose instance reference comparison — prevents old WS onclose from overwriting new connection under React Strict Mode
 * 2. Shared Promise pattern — multiple TerminalViews calling queryRunningCommands simultaneously share a single query
 * 3. dispose resolves before clearing — prevents Promises from hanging indefinitely
 */

type MessageHandler = (type: string, data: Record<string, unknown>) => void;

interface PendingCallbacks {
  onData: MessageHandler;
  onError: (error: string) => void;
}

let ws: WebSocket | null = null;
let wsUrl = '';
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closed = false;

// Callbacks keyed by commandId
const commandCallbacks = new Map<string, PendingCallbacks>();

// Running query: uses a shared Promise + resolve callback
let runningCallback: ((commands: Array<Record<string, unknown>>) => void) | null = null;
let pendingRunningPromise: Promise<Array<Record<string, unknown>>> | null = null;

function getWsUrl(projectCwd: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/terminal?projectCwd=${encodeURIComponent(projectCwd)}`;
}

function handleMessage(event: MessageEvent) {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(event.data); } catch { return; }

  const type = msg.type as string;
  if (type === 'ping') return;

  // Running query response
  if (type === 'running') {
    if (runningCallback) {
      runningCallback(msg.commands as Array<Record<string, unknown>>);
      runningCallback = null;
    }
    return;
  }

  // Dispatch by commandId
  const commandId = msg.commandId as string;
  if (!commandId) return;

  const cb = commandCallbacks.get(commandId);
  if (!cb) return;

  if (type === 'error') {
    cb.onError(msg.error as string);
  } else {
    // Strip commandId to preserve the original SSE-compatible data format
    const { commandId: _, type: __, ...data } = msg;
    cb.onData(type, data);
  }

  // Clean up callbacks after exit/error
  if (type === 'exit' || type === 'error') {
    commandCallbacks.delete(commandId);
  }
}

function connect() {
  if (closed || !wsUrl) return;

  const myWs = new WebSocket(wsUrl);
  ws = myWs;

  myWs.onopen = () => {
    retryCount = 0;
  };

  myWs.onmessage = handleMessage;

  myWs.onclose = () => {
    // Key: if ws already points to a newer connection, this callback is from the old connection — ignore it
    if (ws !== myWs) return;
    ws = null;
    if (closed) return;
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(1000 * Math.pow(1.5, retryCount), 10000);
    retryCount++;
    retryTimer = setTimeout(connect, delay);
  };

  myWs.onerror = () => {
    // onclose will fire immediately after
  };
}

function sendMessage(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Ensure the WS connection is established (idempotent)
 */
export function ensureConnection(projectCwd: string): void {
  const url = getWsUrl(projectCwd);
  if (wsUrl === url && ws) return;

  // Close the old connection
  dispose();
  closed = false;
  wsUrl = url;
  connect();
}

/**
 * Wait for the WS connection to be ready
 */
function waitForOpen(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const check = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
  });
}

/**
 * Execute a command
 */
export async function executeCommand(options: {
  cwd: string;
  command: string;
  commandId: string;
  tabId: string;
  projectCwd: string;
  env?: Record<string, string>;
  usePty?: boolean;
  cols?: number;
  rows?: number;
  onData: MessageHandler;
  onError: (error: string) => void;
}): Promise<void> {
  const { cwd, command, commandId, tabId, projectCwd, env, usePty, cols, rows, onData, onError } = options;

  ensureConnection(projectCwd);
  try {
    await waitForOpen();
  } catch {
    onError('WebSocket connection failed');
    return;
  }

  // Prevent duplicate registration for the same commandId (rerun scenario)
  commandCallbacks.delete(commandId);
  commandCallbacks.set(commandId, { onData, onError });
  sendMessage({ type: 'exec', commandId, command, cwd, tabId, env, ...(usePty ? { usePty: true } : {}), ...(cols ? { cols, rows } : {}) });
}

/**
 * Re-attach to a running command
 */
export async function attachCommand(options: {
  commandId: string;
  projectCwd: string;
  onData: MessageHandler;
  onError: (error: string) => void;
}): Promise<void> {
  const { commandId, projectCwd, onData, onError } = options;

  ensureConnection(projectCwd);
  try {
    await waitForOpen();
  } catch {
    onError('WebSocket connection failed');
    return;
  }

  commandCallbacks.set(commandId, { onData, onError });
  sendMessage({ type: 'attach', commandId });
}

/**
 * Send stdin data to the process
 */
export function sendStdin(commandId: string, data: string): void {
  sendMessage({ type: 'stdin', commandId, data });
}

/**
 * Resize the PTY terminal
 */
export function resizePty(commandId: string, cols: number, rows: number): void {
  sendMessage({ type: 'resize', commandId, cols, rows });
}

/**
 * Interrupt a command (send SIGTERM)
 */
export function interruptCommand(pid: number): void {
  sendMessage({ type: 'interrupt', pid });
}

/**
 * Query the list of running commands
 *
 * Uses a shared Promise: multiple TerminalViews calling simultaneously share a single query result.
 * Key: pendingRunningPromise must be set synchronously before the first await,
 * otherwise multiple callers all pass the if-check and send duplicate queries.
 */
export function queryRunningCommands(projectCwd: string): Promise<Array<Record<string, unknown>>> {
  // If a query is already in progress, share the same Promise
  if (pendingRunningPromise) return pendingRunningPromise;

  // Set pendingRunningPromise synchronously (before any await!)
  pendingRunningPromise = _doRunningQuery(projectCwd);
  return pendingRunningPromise;
}

async function _doRunningQuery(projectCwd: string): Promise<Array<Record<string, unknown>>> {
  try {
    ensureConnection(projectCwd);
    try {
      await waitForOpen();
    } catch {
      return [];
    }

    return await new Promise<Array<Record<string, unknown>>>((resolve) => {
      runningCallback = (commands) => {
        resolve(commands);
      };
      sendMessage({ type: 'running' });
      // Timeout guard
      setTimeout(() => {
        if (runningCallback) {
          runningCallback = null;
          resolve([]);
        }
      }, 3000);
    });
  } finally {
    pendingRunningPromise = null;
  }
}

/**
 * Detach callback listeners for a command (does not kill the process)
 */
export function detachCommand(commandId: string): void {
  commandCallbacks.delete(commandId);
}

/**
 * Close the WS connection
 */
export function dispose(): void {
  closed = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (ws) {
    const dyingWs = ws;
    ws = null;  // Set to null first so that dyingWs.onclose sees ws !== myWs
    dyingWs.close();
  }
  commandCallbacks.clear();
  // Resolve any pending running query (returning empty) before clearing the callback, to prevent the Promise from hanging indefinitely
  if (runningCallback) {
    runningCallback([]);
    runningCallback = null;
  }
  pendingRunningPromise = null;
  wsUrl = '';
  retryCount = 0;
}
