/**
 * In-process broadcast to all /ws/global-state clients.
 *
 * Extracted from wsServer.ts (which has top-level side effects + pulls in the whole WS
 * server) so that API routes can push a global-state event WITHOUT importing the server.
 * The client Set is pinned to globalThis: the WS server realm (server.mjs) populates it on
 * connect, and route realms (Next bundle) read the SAME set — same rationale as the run
 * registry in sessionRunHub.ts.
 */
import { WebSocket } from 'ws';

const g = globalThis as unknown as { __cockpitGlobalStateClients?: Set<WebSocket> };

export const globalStateClients: Set<WebSocket> =
  g.__cockpitGlobalStateClients ?? (g.__cockpitGlobalStateClients = new Set<WebSocket>());

/** Broadcast a message to all /ws/global-state clients. */
export function broadcastToGlobalState(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const ws of globalStateClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
