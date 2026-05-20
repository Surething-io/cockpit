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

// ─────────────────────────────────────────────────────────
// WSS + client set are pinned to globalThis so a second module realm (Next.js
// custom-server topology, dev-mode HMR, dist/wsServer.mjs vs the bundled copy
// inside .next/server) cannot create a parallel WebSocketServer or a parallel
// client Set. Two WSS instances would each register their own 'connection'
// handler on the same upgrade, causing every WS message to be dispatched
// twice; two client Sets would mean broadcastToGlobalState reaches only half
// the connected UIs.
// ─────────────────────────────────────────────────────────

const g_ws = globalThis as unknown as {
  __cockpitWss?: WebSocketServer;
  __cockpitGlobalStateClients?: Set<WebSocket>;
};

const globalStateClients: Set<WebSocket> = g_ws.__cockpitGlobalStateClients
  ?? (g_ws.__cockpitGlobalStateClients = new Set<WebSocket>());

/** Broadcast a message to all /ws/global-state clients */
export function broadcastToGlobalState(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const ws of globalStateClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

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
    } else if (pathname === '/ws/browser') {
      runBrowserHandler(ws, query.fullId as string);
    } else if (pathname === '/ws/terminal-follow') {
      runTerminalFollowHandler(ws, query.id as string);
    } else if (pathname === '/ws/jupyter') {
      runJupyterHandler(ws, query.bubbleId as string, query.cwd as string);
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
    pathname === '/ws/browser' ||
    pathname === '/ws/terminal-follow' ||
    pathname === '/ws/jupyter'
  ) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  return false;
}
