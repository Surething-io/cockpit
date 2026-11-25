/**
 * ExtensionBridge — registry of OpenCockpit Bridge extension connections.
 *
 * One connection per browser profile that has the extension installed. Each
 * arrives through the native messaging host (bin/bridge-host.mjs) on
 * `/ws/browser-ext`, already authenticated by the per-boot token (see
 * src/lib/wsServer.ts). Commands for bubbles and tabs are sent here; results
 * come back as `{ type: 'result', reqId, ok, data?, error?, code? }` and are
 * resolved through the shared pending-request map in BrowserBridge.
 */
import { WebSocket } from 'ws';

export interface ExtensionConnection {
  id: string;
  ws: WebSocket;
  /** Registration order — breaks same-millisecond ties in connectedAt. */
  seq: number;
  connectedAt: number;
  browser?: string;
  version?: string;
  protocol?: number;
}

// Pinned to globalThis for the same reason as BrowserBridge's registry: a
// second module realm would split the map and silently drop commands.
const g_ext = globalThis as unknown as {
  __cockpitExtensionConns?: Map<string, ExtensionConnection>;
  __cockpitExtensionSeq?: number;
};
const conns = g_ext.__cockpitExtensionConns ?? (g_ext.__cockpitExtensionConns = new Map());

export function registerExtension(ws: WebSocket): string {
  const seq = (g_ext.__cockpitExtensionSeq ?? 0) + 1;
  g_ext.__cockpitExtensionSeq = seq;
  const id = `ext-${seq}`;
  conns.set(id, { id, ws, seq, connectedAt: Date.now() });
  return id;
}

export function unregisterExtension(id: string): void {
  conns.delete(id);
}

export function setExtensionHello(
  id: string,
  hello: { browser?: unknown; version?: unknown; protocol?: unknown },
): void {
  const c = conns.get(id);
  if (!c) return;
  if (typeof hello.browser === 'string') c.browser = hello.browser;
  if (typeof hello.version === 'string') c.version = hello.version;
  if (typeof hello.protocol === 'number') c.protocol = hello.protocol;
}

function isOpen(c: ExtensionConnection | undefined): c is ExtensionConnection {
  return !!c && c.ws.readyState === WebSocket.OPEN;
}

/** Open connections, most recently connected first. */
export function listExtensions(): ExtensionConnection[] {
  return [...conns.values()].filter(isOpen).sort((a, b) => b.seq - a.seq);
}

export function getExtension(id: string | undefined): ExtensionConnection | undefined {
  const c = id ? conns.get(id) : undefined;
  return isOpen(c) ? c : undefined;
}

export function sendToExtension(id: string, msg: Record<string, unknown>): boolean {
  const c = getExtension(id);
  if (!c) return false;
  c.ws.send(JSON.stringify(msg));
  return true;
}

/** Human-readable recovery hint for "no extension connected". */
export const NO_EXTENSION_HINT =
  `No browser has the OpenCockpit Bridge extension connected.\n` +
  `  Fix:\n` +
  `    1. Install the extension: Settings → Browser extension (load the folder shown there in chrome://extensions).\n` +
  `    2. Restart the browser once after installing, so it picks up the native host Cockpit registered at boot.\n` +
  `    3. Check the extension's toolbar tooltip — it says whether the native host is connected.`;
