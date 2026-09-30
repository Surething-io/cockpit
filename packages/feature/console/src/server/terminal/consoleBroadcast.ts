/**
 * Cross-browser-tab console sync — server emit side.
 *
 * Pushes a small "console-delta" event to every /ws/global-state client so other
 * browser tabs viewing the same (cwd, tabId) can apply it with last-writer-wins
 * semantics. Deltas carry ONLY bubble-list membership + scalar metadata; PTY/pipe
 * output bytes stay on the per-command terminal WS stream and never travel here.
 *
 * The client Set is pinned to globalThis by src/lib/globalStateBroadcast.ts (the WS
 * server realm populates it on connect). We read that SAME set here instead of
 * importing src/lib — packages/feature/* must not depend on src/. Structural typing
 * avoids pulling in the `ws` package too.
 */

type WSLike = { readyState: number; send: (data: string) => void };
const WS_OPEN = 1; // WebSocket.OPEN

const g = globalThis as unknown as { __cockpitGlobalStateClients?: Set<WSLike> };

export type ConsoleDelta =
  | { op: "add"; entry: Record<string, unknown> }
  | { op: "rerun"; entry: Record<string, unknown> }
  | { op: "update"; id: string; fields: Record<string, unknown> }
  | { op: "delete"; id: string }
  | { op: "clear" }
  | { op: "reorder"; order: string[] }
  | { op: "rename"; titles: Record<string, string> };

/**
 * Broadcast a console bubble-list change to all global-state clients.
 * `sourceId` (when present) lets the originating tab drop its own echo.
 */
export function broadcastConsoleDelta(
  cwd: string,
  tabId: string,
  delta: ConsoleDelta,
  sourceId?: string,
): void {
  const set = g.__cockpitGlobalStateClients;
  if (!set || set.size === 0) return;
  const data = JSON.stringify({
    type: "console-delta",
    cwd,
    tabId,
    sourceId,
    ...delta,
  });
  for (const ws of set) {
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(data);
      } catch {
        /* drop a single dead client; never throw into the write path */
      }
    }
  }
}

/**
 * Tell every global-state client that the set of live terminals changed
 * (spawned, adopted, exited, killed). Carries no payload on purpose: clients
 * refetch `/api/terminal/running`, which also joins the bubble titles, so this
 * hot path never touches the disk.
 */
export function broadcastRunningChanged(): void {
  const set = g.__cockpitGlobalStateClients;
  if (!set || set.size === 0) return;
  const data = JSON.stringify({ type: "running-terminals-changed" });
  for (const ws of set) {
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(data);
      } catch {
        /* drop a single dead client */
      }
    }
  }
}
