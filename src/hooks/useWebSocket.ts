import { useEffect, useRef } from 'react';

interface UseWebSocketOptions {
  /** WebSocket URL path, e.g. '/ws/watch?cwd=...' */
  url: string;
  /** Callback for incoming business messages (excludes ping) */
  onMessage: (data: unknown) => void;
  /** Whether enabled, defaults to true */
  enabled?: boolean;
}

/* ---------- per-URL connection sharing ---------- */

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
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        if (conn.listeners.size === 0) return; // No subscribers left, skip reconnect
        const delay = Math.min(1000 * Math.pow(1.5, conn.retryCount), 10000);
        conn.retryCount++;
        conn.retryTimer = setTimeout(() => conn.connect(), delay);
      };

      ws.onerror = () => {
        // onclose will fire immediately after
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
 * WebSocket hook wrapping connection, auto-reconnect (exponential backoff), and heartbeat handling.
 * Multiple calls with the same URL share a single WebSocket connection.
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
