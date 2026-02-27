/**
 * Terminal WebSocket Manager
 * 单个 WS 连接管理所有终端命令的执行、stdin、attach、interrupt
 *
 * 关键设计：
 * 1. onclose 实例引用对比 —— React Strict Mode 下旧 WS 的 onclose 异步触发时不覆盖新连接
 * 2. 共享 Promise 模式 —— 多个 TerminalView 同时 queryRunningCommands 时共享同一次查询
 * 3. dispose 先 resolve 再清空 —— 防止 Promise 永久挂起
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

// 每个 commandId 对应的回调
const commandCallbacks = new Map<string, PendingCallbacks>();

// running 查询：使用共享 Promise + resolve 回调
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

  // running 查询响应
  if (type === 'running') {
    if (runningCallback) {
      runningCallback(msg.commands as Array<Record<string, unknown>>);
      runningCallback = null;
    }
    return;
  }

  // 按 commandId 分发
  const commandId = msg.commandId as string;
  if (!commandId) return;

  const cb = commandCallbacks.get(commandId);
  if (!cb) return;

  if (type === 'error') {
    cb.onError(msg.error as string);
  } else {
    // 去掉 commandId，保持与原 SSE 兼容的数据格式
    const { commandId: _, type: __, ...data } = msg;
    cb.onData(type, data);
  }

  // exit/error 后清理回调
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
    // 关键：如果 ws 已经指向更新的连接，说明此回调来自旧连接，忽略
    if (ws !== myWs) return;
    ws = null;
    if (closed) return;
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(1000 * Math.pow(1.5, retryCount), 10000);
    retryCount++;
    retryTimer = setTimeout(connect, delay);
  };

  myWs.onerror = () => {
    // onclose 会紧跟触发
  };
}

function sendMessage(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * 确保 WS 连接已建立（幂等）
 */
export function ensureConnection(projectCwd: string): void {
  const url = getWsUrl(projectCwd);
  if (wsUrl === url && ws) return;

  // 关闭旧连接
  dispose();
  closed = false;
  wsUrl = url;
  connect();
}

/**
 * 等待 WS 连接就绪
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
 * 执行命令
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

  // 防止同一 commandId 重复注册（rerun 场景）
  commandCallbacks.delete(commandId);
  commandCallbacks.set(commandId, { onData, onError });
  sendMessage({ type: 'exec', commandId, command, cwd, tabId, env, ...(usePty ? { usePty: true } : {}), ...(cols ? { cols, rows } : {}) });
}

/**
 * 重新接入正在运行的命令
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
 * 发送 stdin 数据到进程
 */
export function sendStdin(commandId: string, data: string): void {
  sendMessage({ type: 'stdin', commandId, data });
}

/**
 * 调整 PTY 终端尺寸
 */
export function resizePty(commandId: string, cols: number, rows: number): void {
  sendMessage({ type: 'resize', commandId, cols, rows });
}

/**
 * 中断命令（发送 SIGTERM）
 */
export function interruptCommand(pid: number): void {
  sendMessage({ type: 'interrupt', pid });
}

/**
 * 查询正在运行的命令列表
 *
 * 使用共享 Promise：多个 TerminalView 同时调用时，共享同一次查询结果。
 * 关键：pendingRunningPromise 必须在第一个 await 之前同步设置，
 * 否则多个调用方都会跳过 if 检查导致发送多次查询。
 */
export function queryRunningCommands(projectCwd: string): Promise<Array<Record<string, unknown>>> {
  // 如果已有进行中的查询，直接共享同一个 Promise
  if (pendingRunningPromise) return pendingRunningPromise;

  // 同步设置 pendingRunningPromise（在任何 await 之前！）
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
      // 超时保护
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
 * 取消某个命令的回调监听（不杀进程）
 */
export function detachCommand(commandId: string): void {
  commandCallbacks.delete(commandId);
}

/**
 * 关闭 WS 连接
 */
export function dispose(): void {
  closed = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (ws) {
    const dyingWs = ws;
    ws = null;  // 先置 null，确保 dyingWs 的 onclose 中 ws !== myWs 成立
    dyingWs.close();
  }
  commandCallbacks.clear();
  // 先 resolve 挂起的 running 查询（返回空），再清空回调，防止 Promise 永久挂起
  if (runningCallback) {
    runningCallback([]);
    runningCallback = null;
  }
  pendingRunningPromise = null;
  wsUrl = '';
  retryCount = 0;
}
