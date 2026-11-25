'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';

/** Server → UI coordination request (see src/lib/effect/browserHandler.ts). */
interface UiRequest {
  type: 'browser:ui';
  reqId?: string;
  op: 'ensure-ready' | 'prepare-screenshot' | 'screenshot-done';
}

// Client-side shortId calculation (shares the same algorithm as the server)
import { toShortId } from '@cockpit/shared-utils';

/**
 * WebSocket bridge hook used by BrowserBubble
 *
 * Registers the bubble with the server so `cockpit browser <shortId>` can
 * address it. Commands are executed by the OpenCockpit Bridge extension, which
 * finds the bubble's iframe by its `name`; this socket only answers the
 * server's coordination requests: wait until the iframe is awake, and frame /
 * restore the UI around a screenshot.
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
  /** Forwarded to the server registry so `/api/connection/list?cwd=...` can filter this bubble. */
  projectCwd?: string,
  /** Forwarded so bubble-titles lookup can use the right per-tab JSON. */
  tabId?: string,
) {
  const shortId = useMemo(() => toShortId(fullId), [fullId]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  /** ensure-ready requests waiting for the iframe to finish loading */
  const pendingReadyRef = useRef<string[]>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldConnectRef = useRef(false);

  // Use refs to track the latest values so that WS is not recreated on every change
  const iframeReadyRef = useRef(iframeReady);
  useEffect(() => { iframeReadyRef.current = iframeReady; });

  // Pending resolvers for connect()
  const connectResolversRef = useRef<Array<() => void>>([]);

  const reply = useCallback((reqId: string | undefined, ok: boolean, data?: unknown, error?: string) => {
    const ws = wsRef.current;
    if (!reqId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'browser:cmd-result', reqId, ok, data, error }));
  }, []);

  // Frame the bubble for a screenshot: bring the console + this project to the
  // front, then report the iframe's rect in device pixels relative to the top
  // window (captureVisibleTab captures the whole browser tab).
  const prepareScreenshot = useCallback((reqId: string | undefined) => {
    const iframe = iframeRef.current;
    if (!iframe) { reply(reqId, false, undefined, 'bubble iframe not mounted (sleeping?)'); return; }

    const cwd = new URLSearchParams(window.location.search).get('cwd') || '';
    window.dispatchEvent(new CustomEvent('cockpit-screenshot-state', { detail: { active: true } }));
    publishTopic(Topics.ScreenshotPrepare, { cwd });

    // Wait for rendering to complete (3 frames + 150ms)
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(() => {
        const rect = iframe.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // rect is relative to this (project) frame's viewport; accumulate
        // ancestor iframe offsets to get top-window coordinates.
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
        reply(reqId, true, {
          x: Math.round(absX * dpr),
          y: Math.round(absY * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
          dpr,
        });
      }, 150);
    })));
  }, [iframeRef, reply]);

  const handleUi = useCallback((msg: UiRequest) => {
    if (msg.op === 'ensure-ready') {
      if (iframeReadyRef.current) reply(msg.reqId, true, { ready: true });
      else if (msg.reqId) pendingReadyRef.current.push(msg.reqId);
      return;
    }
    if (msg.op === 'prepare-screenshot') {
      prepareScreenshot(msg.reqId);
      return;
    }
    if (msg.op === 'screenshot-done') {
      window.dispatchEvent(new CustomEvent('cockpit-screenshot-state', { detail: { active: false } }));
      publishTopic(Topics.ScreenshotDone, {});
    }
  }, [prepareScreenshot, reply]);

  // WS connection: depends only on connected and fullId, not rebuilt when iframeReady changes
  useEffect(() => {
    if (!connected) return;

    let disposed = false;
    shouldConnectRef.current = true;

    function doConnect() {
      if (disposed || !shouldConnectRef.current) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ fullId });
      if (projectCwd) params.set('projectCwd', projectCwd);
      if (tabId) params.set('tabId', tabId);
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/browser?${params.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Resolve all pending connect() promises
        for (const resolve of connectResolversRef.current) resolve();
        connectResolversRef.current = [];

      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(event.data as string); } catch { return; }

        if (msg.type === 'browser:ui') handleUi(msg as unknown as UiRequest);
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
  }, [connected, fullId, handleUi, projectCwd, tabId]);

  // Answer ensure-ready requests once the iframe has loaded
  useEffect(() => {
    if (iframeReady && pendingReadyRef.current.length > 0) {
      for (const reqId of pendingReadyRef.current) reply(reqId, true, { ready: true });
      pendingReadyRef.current = [];
    }
  }, [iframeReady, reply]);

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
