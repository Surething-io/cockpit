import { useEffect, useRef } from 'react';

interface UseWebSocketOptions {
  /** WebSocket URL path, e.g. '/ws/watch?cwd=...' */
  url: string;
  /** 收到业务消息时的回调（不含 ping） */
  onMessage: (data: unknown) => void;
  /** 是否启用，默认 true */
  enabled?: boolean;
}

/**
 * WebSocket hook，封装连接、自动重连（指数退避）、心跳处理
 */
export function useWebSocket({ url, onMessage, enabled = true }: UseWebSocketOptions): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(() => {
    if (!enabled) return;

    let unmounted = false;
    let ws: WebSocket | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (unmounted) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}${urlRef.current}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        retryCount = 0;
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ping') return;
          onMessageRef.current(msg);
        } catch {
          // 忽略解析错误
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        const delay = Math.min(1000 * Math.pow(1.5, retryCount), 10000);
        retryCount++;
        retryTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose 会紧跟触发
      };
    }

    connect();

    return () => {
      unmounted = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) ws.close();
    };
  }, [url, enabled]);
}
