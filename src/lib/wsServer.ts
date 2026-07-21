/**
 * WebSocket Server — dispatch only.
 *
 * The 6 WS handlers live in src/lib/effect/; this file only owns WS upgrade,
 * route dispatch, and the broadcast helper.
 *
 * Handler implementations: src/lib/effect/{globalStateHandler,fileWatchHandler,
 * terminalFollowHandler,browserHandler,jupyterHandler,terminalHandler}.ts
 */
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import { runGlobalStateHandler } from './effect/globalStateHandler';
import { runFileWatchHandler } from './effect/fileWatchHandler';
import { runTerminalFollowHandler } from './effect/terminalFollowHandler';
import { runBrowserHandler } from './effect/browserHandler';
import { runJupyterHandler } from './effect/jupyterHandler';
import { runTerminalHandler } from './effect/terminalHandler';
import { runBashHandler } from './effect/bashStreamHandler';
import { runSessionStreamHandler } from './effect/sessionStreamHandler';
import { wireCodeIndexToFileWatcher } from './codeIndexSync';
// globalStateClients + broadcastToGlobalState live in a side-effect-free module so API
// routes can broadcast without importing this server.
import { globalStateClients, broadcastToGlobalState } from './globalStateBroadcast';

// Re-exported for existing callers that import it from here.
export { broadcastToGlobalState };

// Wire fileWatcher → codeIndex lazy sync. wsServer is on the guaranteed
// server-boot path, so calling this at module top-level runs it exactly once
// per process. `wireCodeIndexToFileWatcher` is itself idempotent.
wireCodeIndexToFileWatcher();

// ─────────────────────────────────────────────────────────
// WSS + client set are pinned to globalThis so a second module realm (Next.js
// custom-server topology, dev-mode HMR, dist/wsServer.mjs vs the bundled copy
// inside .next/server) cannot create a parallel WebSocketServer or a parallel
// client Set. Two WSS instances would each register their own 'connection'
// handler on the same upgrade, causing every WS message to be dispatched
// twice; two client Sets would mean broadcastToGlobalState reaches only half
// the connected UIs.
// ─────────────────────────────────────────────────────────

/**
 * Same-origin check for the /ws/bash upgrade: the WS `Origin` header must match
 * the request `Host`. A cross-site page (drive-by to localhost) sends a
 * different host and is rejected; so is a missing/unparseable Origin.
 *
 * This is the ONLY gate on the RCE channel. No preview surface renders in an
 * opaque origin today — HTML previews and console browser bubbles are all
 * same-origin with no sandbox attribute — so `Origin: null` is not a case this
 * codebase currently produces. It is still rejected, but do not read that as a
 * second tier of protection: it isn't one.
 */
function isSameOriginWs(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const g_ws = globalThis as unknown as {
  __cockpitWss?: WebSocketServer;
};

const wss: WebSocketServer = g_ws.__cockpitWss ?? (() => {
  const server = new WebSocketServer({ noServer: true });
  g_ws.__cockpitWss = server;

  // Listener registered exactly once — re-registering on a second module load
  // would dispatch each connection twice (same WSS instance, two listeners).
  server.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const { pathname, query } = parse(req.url || '', true);

    if (pathname === '/ws/watch') {
      runFileWatchHandler(ws, query.cwd as string);
    } else if (pathname === '/ws/global-state') {
      // Keep globalStateClients populated so broadcastToGlobalState can reach this socket
      globalStateClients.add(ws);
      ws.on('close', () => globalStateClients.delete(ws));
      runGlobalStateHandler(ws);
    } else if (pathname === '/ws/terminal') {
      runTerminalHandler(ws, query.projectCwd as string);
    } else if (pathname === '/ws/bash') {
      // RCE channel — only same-origin embedders may connect. HTML previews and
      // console bubbles carry Origin === host and pass; an external website
      // (drive-by to localhost) mismatches and is rejected. There is no
      // "untrusted preview" tier: every local .html rendered by this app is
      // same-origin, so it passes here whether or not we injected the SDK into
      // it — a page can hand-roll its own WebSocket. This check is the whole
      // boundary, which is why the decision of WHAT to preview is the security
      // decision.
      if (!isSameOriginWs(req)) {
        try { ws.close(4403, 'forbidden origin'); } catch { /* ignore */ }
      } else {
        runBashHandler(ws, query.cwd as string | undefined);
      }
    } else if (pathname === '/ws/browser') {
      runBrowserHandler(
        ws,
        query.fullId as string,
        query.projectCwd as string | undefined,
        query.tabId as string | undefined,
      );
    } else if (pathname === '/ws/terminal-follow') {
      runTerminalFollowHandler(ws, query.id as string);
    } else if (pathname === '/ws/jupyter') {
      runJupyterHandler(ws, query.bubbleId as string, query.cwd as string);
    } else if (pathname === '/ws/session-stream') {
      runSessionStreamHandler(ws, query.sessionId as string);
    }
  });

  return server;
})();

/**
 * Handle HTTP upgrade requests, only accept /ws/ paths
 * Returns true if handled, false if not a ws path
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const { pathname } = parse(req.url || '', true);

  if (
    pathname === '/ws/watch' ||
    pathname === '/ws/global-state' ||
    pathname === '/ws/terminal' ||
    pathname === '/ws/bash' ||
    pathname === '/ws/browser' ||
    pathname === '/ws/terminal-follow' ||
    pathname === '/ws/jupyter' ||
    pathname === '/ws/session-stream'
  ) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  return false;
}
