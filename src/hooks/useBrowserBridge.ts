'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

interface BrowserCmd {
  type: 'browser:cmd';
  reqId: string;
  action: string;
  params: Record<string, unknown>;
}

// Client-side shortId 计算（与服务端共享同一算法）
import { toShortId } from '@/lib/shortId';

/**
 * BrowserBubble 用的 WS bridge hook
 *
 * - shortId 始终可用（客户端 CRC32 计算）
 * - WS 按需建立：connect() 返回 Promise，连接成功后 resolve
 * - 重复 connect() 不重复建连（已连接时立即 resolve）
 * - disconnect() 断开 WS
 */
export function useBrowserBridge(
  fullId: string,
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  iframeReady: boolean,
) {
  const shortId = useMemo(() => toShortId(fullId), [fullId]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingCmdsRef = useRef<BrowserCmd[]>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldConnectRef = useRef(false);

  // 用 ref 追踪最新值，避免 effect 因这些变化而重建 WS
  const iframeReadyRef = useRef(iframeReady);
  iframeReadyRef.current = iframeReady;

  // connect() 的 pending resolvers
  const connectResolversRef = useRef<Array<() => void>>([]);

  // 处理从 iframe content script 返回的消息
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      // cmd-result: 命令执行结果 → 转发回 WS
      if (e.data?.type === 'cockpit:cmd-result') {
        const { reqId, ok, data, error } = e.data;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'browser:cmd-result',
            reqId, ok, data, error,
          }));
        }
        return;
      }

      // prepare-screenshot: 截图前确保 iframe 可见，返回 bounds
      if (e.data?.type === 'cockpit:prepare-screenshot') {
        const iframe = iframeRef.current;
        if (!iframe?.contentWindow) return;

        // 1) 通知 TabManager 切到 console view + 显示截图提示
        //    通知 Workspace 保存当前项目 + 切到本项目
        const cwd = new URLSearchParams(window.location.search).get('cwd') || '';
        window.dispatchEvent(new CustomEvent('cockpit-screenshot-state', { detail: { active: true } }));
        window.parent.postMessage({ type: 'SCREENSHOT_PREPARE', cwd }, '*');

        // 2) 等待渲染完成（3 帧 + 150ms）
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => {
            const rect = iframe.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            // rect 是相对于 project iframe viewport 的坐标，
            // 但 captureVisibleTab 截取的是整个浏览器 tab，
            // 需要累加所有父级 iframe 的偏移量得到绝对坐标
            let absX = rect.x;
            let absY = rect.y;
            try {
              let cur: Window = window;
              while (cur !== cur.top) {
                const frameEl = cur.frameElement as HTMLElement | null;
                if (frameEl) {
                  const frameRect = frameEl.getBoundingClientRect();
                  absX += frameRect.x;
                  absY += frameRect.y;
                }
                cur = cur.parent;
              }
            } catch {
              // cross-origin 时停止遍历，使用已累加的偏移
            }

            iframe.contentWindow?.postMessage({
              type: 'cockpit:screenshot-bounds',
              reqId: e.data.reqId,
              bounds: {
                x: Math.round(absX * dpr),
                y: Math.round(absY * dpr),
                width: Math.round(rect.width * dpr),
                height: Math.round(rect.height * dpr),
                dpr,
              },
            }, '*');
          }, 150);
        })));
        return;
      }

      // screenshot-done: 截图完成，恢复界面
      if (e.data?.type === 'cockpit:screenshot-done') {
        window.dispatchEvent(new CustomEvent('cockpit-screenshot-state', { detail: { active: false } }));
        window.parent.postMessage({ type: 'SCREENSHOT_DONE' }, '*');
        return;
      }

    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // 将命令通过 postMessage 发送给 iframe
  const sendToIframe = useCallback((cmd: BrowserCmd) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser:cmd-result',
          reqId: cmd.reqId, ok: false,
          error: 'iframe not available (page may be sleeping)',
        }));
      }
      return;
    }
    iframe.contentWindow.postMessage({
      type: 'cockpit:cmd',
      reqId: cmd.reqId,
      action: cmd.action,
      params: cmd.params,
    }, '*');
  }, [iframeRef]);

  // WS 连接：仅依赖 connected 和 fullId，不因 iframeReady 变化而重建
  useEffect(() => {
    if (!connected) return;

    let disposed = false;
    shouldConnectRef.current = true;

    function doConnect() {
      if (disposed || !shouldConnectRef.current) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/browser?fullId=${encodeURIComponent(fullId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // resolve 所有等待的 connect() promise
        for (const resolve of connectResolversRef.current) resolve();
        connectResolversRef.current = [];

        // flush pending commands
        if (pendingCmdsRef.current.length > 0) {
          for (const cmd of pendingCmdsRef.current) sendToIframe(cmd);
          pendingCmdsRef.current = [];
        }
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(event.data as string); } catch { return; }

        if (msg.type === 'browser:cmd') {
          const cmd = msg as unknown as BrowserCmd;
          if (iframeRef.current?.contentWindow && iframeReadyRef.current) {
            sendToIframe(cmd);
          } else {
            pendingCmdsRef.current.push(cmd);
          }
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed && shouldConnectRef.current) {
          reconnectTimerRef.current = setTimeout(doConnect, 3000);
        }
      };

      ws.onerror = () => ws.close();
    }

    doConnect();

    return () => {
      disposed = true;
      shouldConnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      connectResolversRef.current = [];
    };
  }, [connected, fullId, iframeRef, sendToIframe]);

  // iframe ready 后 flush pending commands
  useEffect(() => {
    if (iframeReady && pendingCmdsRef.current.length > 0) {
      for (const cmd of pendingCmdsRef.current) sendToIframe(cmd);
      pendingCmdsRef.current = [];
    }
  }, [iframeReady, sendToIframe]);

  /** 建立连接。已连接时立即 resolve，否则等 WS open */
  const connect = useCallback((): Promise<void> => {
    if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      connectResolversRef.current.push(resolve);
      if (!connected) setConnected(true);
    });
  }, [connected]);

  /** 断开连接 */
  const disconnect = useCallback(() => {
    setConnected(false);
  }, []);

  return { shortId, connected, connect, disconnect };
}
