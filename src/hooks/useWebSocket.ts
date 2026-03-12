import { useEffect, useRef } from 'react';

interface UseWebSocketOptions {
  /** WebSocket URL path, e.g. '/ws/watch?cwd=...' */
  url: string;
  /** 收到业务消息时的回调（不含 ping） */
  onMessage: (data: unknown) => void;
  /** 是否启用，默认 true */
  enabled?: boolean;
}

/* ---------- per-URL 连接复用 ---------- */

type Listener = (data: unknown) => void;

interface SharedConnection {
  ws: WebSocket | null;
  listeners: Set<Listener>;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  connect: () => void;
  destroy: () => void;
}

const connections = new Map<string, SharedConnection>();

function getOrCreateConnection(url: string): SharedConnection {
  const existing = connections.get(url);
  if (existing) return existing;

  const conn: SharedConnection = {
    ws: null,
    listeners: new Set(),
    retryCount: 0,
    retryTimer: null,

    connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}${url}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        conn.retryCount = 0;
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ping') return;
          conn.listeners.forEach(listener => listener(msg));
        } catch {
          // 忽略解析错误
        }
      };

      ws.onclose = () => {
        if (conn.listeners.size === 0) return; // 已无订阅者，不重连
        const delay = Math.min(1000 * Math.pow(1.5, conn.retryCount), 10000);
        conn.retryCount++;
        conn.retryTimer = setTimeout(() => conn.connect(), delay);
      };

      ws.onerror = () => {
        // onclose 会紧跟触发
      };

      conn.ws = ws;
    },

    destroy() {
      if (conn.retryTimer) clearTimeout(conn.retryTimer);
      if (conn.ws) conn.ws.close();
      conn.ws = null;
      connections.delete(url);
    },
  };

  connections.set(url, conn);
  conn.connect();
  return conn;
}

/* ---------- hook ---------- */

/**
 * WebSocket hook，封装连接、自动重连（指数退避）、心跳处理
 * 相同 URL 的多个调用共享同一条 WebSocket 连接
 */
export function useWebSocket({ url, onMessage, enabled = true }: UseWebSocketOptions): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled) return;

    const listener: Listener = (data) => onMessageRef.current(data);
    const conn = getOrCreateConnection(url);
    conn.listeners.add(listener);

    return () => {
      conn.listeners.delete(listener);
      if (conn.listeners.size === 0) {
        conn.destroy();
      }
    };
  }, [url, enabled]);
}
