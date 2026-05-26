/**
 * BrowserBridge - server-side core
 *
 * Manages the shortId registry and pending requests for browser bubbles.
 * Middleware layer for the CLI → API → WS → BrowserBubble → content script flow.
 */

import { WebSocket } from 'ws';
import { toShortId } from '@cockpit/shared-utils';

// ============================================================================
// Registry
// ============================================================================

interface BrowserEntry {
  fullId: string;
  ws: WebSocket | null;
  lastSeen: number;
  /** Project cwd the browser bubble belongs to (forwarded via WS query at register). */
  projectCwd?: string;
  /** Tab id the bubble lives in (used to scope bubble-titles JSON lookups). */
  tabId?: string;
}

// Registries pinned to globalThis. wsServer is currently the only caller (so
// today there is just one module realm), but the moment any Next.js API route
// imports from this file via `@/lib/bubbles/browser/BrowserBridge`, the webpack
// bundler will instantiate a second copy and shortId routing would split
// across two Maps — registerBrowser writes to one, sendCommandToBrowser reads
// from the other, and commands silently miss. Defending pre-emptively.
const g_browser = globalThis as unknown as {
  __cockpitBrowserRegistry?: Map<string, BrowserEntry>;
  __cockpitBrowserFullIdToShort?: Map<string, string>;
  __cockpitBrowserPending?: Map<string, PendingRequest>;
};

/** shortId → BrowserEntry */
const registry = g_browser.__cockpitBrowserRegistry ?? (g_browser.__cockpitBrowserRegistry = new Map<string, BrowserEntry>());

/** fullId → shortId (reverse index) */
const fullIdToShort = g_browser.__cockpitBrowserFullIdToShort ?? (g_browser.__cockpitBrowserFullIdToShort = new Map<string, string>());

export function registerBrowser(fullId: string, ws: WebSocket, projectCwd?: string, tabId?: string): string {
  const shortId = toShortId(fullId);
  registry.set(shortId, { fullId, ws, lastSeen: Date.now(), projectCwd, tabId });
  fullIdToShort.set(fullId, shortId);
  return shortId;
}

export function unregisterBrowser(fullId: string): void {
  const shortId = fullIdToShort.get(fullId);
  if (shortId) {
    registry.delete(shortId);
    fullIdToShort.delete(fullId);
  }
}

export function getBrowserByShortId(shortId: string): BrowserEntry | undefined {
  return registry.get(shortId);
}

export function updateBrowserWs(fullId: string, ws: WebSocket | null): void {
  const shortId = fullIdToShort.get(fullId);
  if (shortId) {
    const entry = registry.get(shortId);
    if (entry) {
      entry.ws = ws;
      entry.lastSeen = Date.now();
    }
  }
}

export function listBrowsers(): Array<{
  shortId: string;
  fullId: string;
  connected: boolean;
  projectCwd?: string;
  tabId?: string;
}> {
  const result: ReturnType<typeof listBrowsers> = [];
  for (const [shortId, entry] of registry) {
    result.push({
      shortId,
      fullId: entry.fullId,
      connected: entry.ws !== null && entry.ws.readyState === WebSocket.OPEN,
      projectCwd: entry.projectCwd,
      tabId: entry.tabId,
    });
  }
  return result;
}

// ============================================================================
// Pending Requests (API long-poll waiting for browser response)
// ============================================================================

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Same globalThis pinning rationale as the registry above.
const pendingRequests = g_browser.__cockpitBrowserPending ?? (g_browser.__cockpitBrowserPending = new Map<string, PendingRequest>());

/**
 * Create a pending request and wait for the browser to respond.
 */
export function createPendingRequest(reqId: string, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error(`Timeout after ${timeout}ms`));
    }, timeout);

    pendingRequests.set(reqId, { resolve, reject, timer });
  });
}

/**
 * Browser response arrived; resolve the corresponding pending request.
 */
export function resolvePendingRequest(reqId: string, ok: boolean, data: unknown, error?: string): void {
  const pending = pendingRequests.get(reqId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRequests.delete(reqId);

  if (ok) {
    pending.resolve(data);
  } else {
    pending.reject(new Error(error || 'Browser command failed'));
  }
}

/**
 * Send a command to the specified browser.
 */
export function sendCommandToBrowser(
  shortId: string,
  reqId: string,
  action: string,
  params: Record<string, unknown>
): boolean {
  const entry = registry.get(shortId);
  if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  entry.ws.send(JSON.stringify({
    type: 'browser:cmd',
    reqId,
    action,
    params,
  }));

  return true;
}
