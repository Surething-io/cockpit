/**
 * Terminal WebSocket Manager
 * 单个 WS 连接管理所有终端命令的执行、stdin、attach、interrupt
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

// 一次性回调（如 running 查询）
let runningCallback: ((commands: Array<Record<string, unknown>>) => void) | null = null;

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
    runningCallback?.(msg.commands as Array<Record<string, unknown>>);
    runningCallback = null;
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

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    retryCount = 0;
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    ws = null;
    if (closed) return;
    // 防止 dispose() 之后 onclose 回调延迟触发再注册新 timer
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(1000 * Math.pow(1.5, retryCount), 10000);
    retryCount++;
    retryTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => {
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
  onData: MessageHandler;
  onError: (error: string) => void;
}): Promise<void> {
  const { cwd, command, commandId, tabId, projectCwd, env, onData, onError } = options;

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
  sendMessage({ type: 'exec', commandId, command, cwd, tabId, env });
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
 * 中断命令（发送 SIGTERM）
 */
export function interruptCommand(pid: number): void {
  sendMessage({ type: 'interrupt', pid });
}

/**
 * 查询正在运行的命令列表
 */
export async function queryRunningCommands(projectCwd: string): Promise<Array<Record<string, unknown>>> {
  ensureConnection(projectCwd);
  try {
    await waitForOpen();
  } catch {
    return [];
  }

  return new Promise((resolve) => {
    runningCallback = resolve;
    sendMessage({ type: 'running' });
    // 超时保护
    setTimeout(() => {
      if (runningCallback === resolve) {
        runningCallback = null;
        resolve([]);
      }
    }, 3000);
  });
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
  if (ws) { ws.close(); ws = null; }
  commandCallbacks.clear();
  runningCallback = null;
  wsUrl = '';
  retryCount = 0;
}
