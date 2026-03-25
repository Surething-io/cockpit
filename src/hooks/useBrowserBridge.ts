'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

interface BrowserCmd {
  type: 'browser:cmd';
  reqId: string;
  action: string;
  params: Record<string, unknown>;
}

// Client-side shortId calculation (shares the same algorithm as the server)
import { toShortId } from '@/lib/shortId';

/**
 * WebSocket bridge hook used by BrowserBubble
 *
 * - shortId is always available (client-side CRC32 calculation)
 * - WS is established on demand: connect() returns a Promise that resolves on open
 * - Repeated connect() calls do not create duplicate connections (resolves immediately if already connected)
 * - disconnect() closes the WS
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

  // Use refs to track the latest values so that WS is not recreated on every change
  const iframeReadyRef = useRef(iframeReady);
  useEffect(() => { iframeReadyRef.current = iframeReady; });

  // Pending resolvers for connect()
  const connectResolversRef = useRef<Array<() => void>>([]);

  // Handle messages returned from the iframe content script
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      // cmd-result: command execution result → forward back to WS
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

      // prepare-screenshot: ensure the iframe is visible before taking a screenshot, return bounds
      if (e.data?.type === 'cockpit:prepare-screenshot') {
        const iframe = iframeRef.current;
        if (!iframe?.contentWindow) return;

        // 1) Notify TabManager to switch to console view + show screenshot hint
        //    Notify Workspace to save the current project and switch to this project
        const cwd = new URLSearchParams(window.location.search).get('cwd') || '';
        window.dispatchEvent(new CustomEvent('cockpit-screenshot-state', { detail: { active: true } }));
        window.parent.postMessage({ type: 'SCREENSHOT_PREPARE', cwd }, '*');

        // 2) Wait for rendering to complete (3 frames + 150ms)
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => {
            const rect = iframe.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            // rect is relative to the project iframe viewport,
            // but captureVisibleTab captures the entire browser tab,
            // so accumulate offsets from all ancestor iframes to get absolute coordinates
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
              // Stop traversal on cross-origin; use the already-accumulated offset
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

      // screenshot-done: screenshot complete, restore UI
      if (e.data?.type === 'cockpit:screenshot-done') {
        window.dispatchEvent(new CustomEvent('cockpit-screenshot-state', { detail: { active: false } }));
        window.parent.postMessage({ type: 'SCREENSHOT_DONE' }, '*');
        return;
      }

    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Send a command to the iframe via postMessage
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

  // WS connection: depends only on connected and fullId, not rebuilt when iframeReady changes
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
        // Resolve all pending connect() promises
        for (const resolve of connectResolversRef.current) resolve();
        connectResolversRef.current = [];

        // Flush pending commands
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

  // Flush pending commands after iframe is ready
  useEffect(() => {
    if (iframeReady && pendingCmdsRef.current.length > 0) {
      for (const cmd of pendingCmdsRef.current) sendToIframe(cmd);
      pendingCmdsRef.current = [];
    }
  }, [iframeReady, sendToIframe]);

  /** Establish connection. Resolves immediately if already connected, otherwise waits for WS open */
  const connect = useCallback((): Promise<void> => {
    if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      connectResolversRef.current.push(resolve);
      if (!connected) setConnected(true);
    });
  }, [connected]);

  /** Disconnect */
  const disconnect = useCallback(() => {
    setConnected(false);
  }, []);

  return { shortId, connected, connect, disconnect };
}
