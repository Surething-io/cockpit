/**
 * BrowserBridge - server-side core
 *
 * shortId registry + command routing for everything `cockpit browser <id>`
 * can drive. Two kinds of target share one registry:
 *
 *   bubble — a Console browser bubble. Registered by the bubble UI over
 *            `/ws/browser`; that socket is only used to coordinate with the UI
 *            (wait until the iframe is awake, frame a screenshot). The command
 *            itself is executed by the OpenCockpit Bridge extension, which
 *            locates the bubble's frame on its own.
 *   tab    — a real Chrome tab the extension reports (opened by
 *            `cockpit browser open --tab`, or shared by the user). Owned by
 *            one extension connection.
 *
 * Flow: CLI → /api/browser/<action> → dispatchBrowserCommand → extension
 * (via the native host on /ws/browser-ext) → chrome.scripting / chrome.debugger.
 */

import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { toShortId } from '@cockpit/shared-utils';
import {
  getExtension,
  listExtensions,
  sendToExtension,
  NO_EXTENSION_HINT,
} from './ExtensionBridge';

// ============================================================================
// Registry
// ============================================================================

export type BrowserKind = 'bubble' | 'tab';

interface BrowserEntry {
  kind: BrowserKind;
  fullId: string;
  /** bubble: the bubble UI's coordination socket. Unused for tabs. */
  ws: WebSocket | null;
  /** tab: the extension connection that owns the tab. */
  extId?: string;
  /** bubble: the extension connection that last found this bubble's frame. */
  lastExtId?: string;
  lastSeen: number;
  /** Last time we successfully resolved a pending command (ms epoch). */
  lastSuccessTs?: number;
  /** Last action name that resolved successfully — useful for diagnostics. */
  lastSuccessAction?: string;
  /** Project cwd the bubble / opened tab belongs to. */
  projectCwd?: string;
  /** Tab id the bubble lives in (used to scope bubble-titles JSON lookups). */
  tabId?: string;
  /** tab: last reported URL / title / how it came under control. */
  url?: string;
  title?: string;
  /** tab: Cockpit opened it (`open --tab`). */
  origin?: 'opened';
  /** tab: its site is allowed, so commands run without asking the user. */
  allowed?: boolean;
  /** tab: the selected tab of its window. */
  active?: boolean;
  /** tab: the extension's debugger is attached to it right now. */
  debugging?: boolean;
}

// Registries pinned to globalThis. wsServer is currently the only caller (so
// today there is just one module realm), but the moment any Next.js API route
// imports from this file via `@/lib/bubbles/browser/BrowserBridge`, the webpack
// bundler will instantiate a second copy and shortId routing would split
// across two Maps — registerBrowser writes to one, dispatchBrowserCommand
// reads from the other, and commands silently miss. Defending pre-emptively.
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
  const prev = registry.get(shortId);
  // A tab already holds this short id. A bubble's id is persisted and cannot
  // move, so the tab yields: its extension regenerates the tab's id.
  if (prev?.kind === 'tab' && prev.fullId !== fullId) {
    fullIdToShort.delete(prev.fullId);
    if (prev.extId) sendToExtension(prev.extId, { type: 'tab-ids', ids: {}, reroll: [prev.fullId] });
  }
  registry.set(shortId, {
    kind: 'bubble', fullId, ws, lastSeen: Date.now(), projectCwd, tabId,
    lastExtId: prev?.fullId === fullId ? prev.lastExtId : undefined,
  });
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

/**
 * Release a bubble registration, but only if it still belongs to `ws`. A
 * bubble that reconnects registers its new socket before the old one's
 * cleanup runs; an unconditional unregister would drop the live entry.
 */
export function unregisterBubbleSocket(fullId: string, ws: WebSocket): void {
  const shortId = fullIdToShort.get(fullId);
  if (!shortId) return;
  const entry = registry.get(shortId);
  if (entry?.kind === 'bubble' && entry.ws === ws) unregisterBrowser(fullId);
}

export function getBrowserByShortId(shortId: string): BrowserEntry | undefined {
  return registry.get(shortId);
}

export interface ReportedTab {
  fullId: string;
  chromeTabId?: number;
  url?: string;
  title?: string;
  projectCwd?: string;
  origin?: 'opened';
  allowed?: boolean;
  active?: boolean;
  debugging?: boolean;
}

function upsertTab(extId: string, t: ReportedTab): string {
  const shortId = toShortId(t.fullId);
  const prev = registry.get(shortId);
  const same = prev?.kind === 'tab' && prev.fullId === t.fullId;
  registry.set(shortId, {
    kind: 'tab',
    fullId: t.fullId,
    ws: null,
    extId,
    lastSeen: Date.now(),
    lastSuccessTs: same ? prev.lastSuccessTs : undefined,
    lastSuccessAction: same ? prev.lastSuccessAction : undefined,
    projectCwd: t.projectCwd ?? (same ? prev.projectCwd : undefined),
    url: t.url ?? (same ? prev.url : undefined),
    title: t.title ?? (same ? prev.title : undefined),
    origin: t.origin,
    allowed: !!t.allowed,
    active: !!t.active,
    debugging: !!t.debugging,
  });
  fullIdToShort.set(t.fullId, shortId);
  return shortId;
}

/** CLI name users type for this server — `cockpit-dev` for the dev instance. */
export function cockpitCliName(): string {
  return process.env.COCKPIT_ENV === 'dev' ? 'cockpit-dev' : 'cockpit';
}

/**
 * Replace the set of tabs an extension reports with its latest snapshot.
 *
 * Returns the short id of every accepted tab (shown on the extension's
 * toolbar badge) and the tabs whose short id is already taken by a different
 * target: those are not registered, and the extension regenerates their ids
 * and reports again. A short id therefore always names exactly one target.
 */
export function syncExtensionTabs(
  extId: string,
  tabs: ReportedTab[],
): { ids: Record<string, string>; reroll: string[] } {
  const ids: Record<string, string> = {};
  const reroll: string[] = [];
  const reported = new Set(tabs.filter((t) => t && typeof t.fullId === 'string' && t.fullId).map((t) => t.fullId));
  // Drop this extension's tabs that are gone first, so they cannot block a new one.
  for (const [shortId, entry] of registry) {
    if (entry.kind === 'tab' && entry.extId === extId && !reported.has(entry.fullId)) {
      registry.delete(shortId);
      fullIdToShort.delete(entry.fullId);
    }
  }
  for (const t of tabs) {
    if (!t || typeof t.fullId !== 'string' || !t.fullId) continue;
    const taken = registry.get(toShortId(t.fullId));
    if (taken && taken.fullId !== t.fullId) {
      reroll.push(t.fullId);
      continue;
    }
    ids[t.fullId] = upsertTab(extId, t);
  }
  return { ids, reroll };
}

/** The extension connection went away — its tabs are no longer drivable. */
export function dropExtensionTabs(extId: string): void {
  syncExtensionTabs(extId, []);
}

function entryConnected(entry: BrowserEntry): boolean {
  if (entry.kind === 'tab') return !!getExtension(entry.extId);
  return entry.ws !== null && entry.ws.readyState === WebSocket.OPEN;
}

export function listBrowsers(): Array<{
  shortId: string;
  fullId: string;
  kind: BrowserKind;
  connected: boolean;
  projectCwd?: string;
  tabId?: string;
  url?: string;
  title?: string;
  origin?: 'opened';
  allowed?: boolean;
  active?: boolean;
  debugging?: boolean;
}> {
  const result: ReturnType<typeof listBrowsers> = [];
  for (const [shortId, entry] of registry) {
    result.push({
      shortId,
      fullId: entry.fullId,
      kind: entry.kind,
      connected: entryConnected(entry),
      projectCwd: entry.projectCwd,
      tabId: entry.tabId,
      url: entry.url,
      title: entry.title,
      origin: entry.origin,
      allowed: entry.allowed,
      active: entry.active,
      debugging: entry.debugging,
    });
  }
  return result;
}

// ============================================================================
// Pending Requests (API long-poll waiting for a UI / extension response)
// ============================================================================

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Error carrying the extension's machine-readable code (e.g. TARGET_NOT_FOUND). */
export class BrowserCommandError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

// Same globalThis pinning rationale as the registry above.
const pendingRequests = g_browser.__cockpitBrowserPending ?? (g_browser.__cockpitBrowserPending = new Map<string, PendingRequest>());

/**
 * Create a pending request and wait for the response.
 */
export function createPendingRequest(reqId: string, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      // Crucial: decrement inflight on timeout, otherwise the count leaks and
      // health/wait --extension-ready report stale pending counts forever
      // (dogfood discovery — see Phase 3 verification).
      recordCommandResolved(reqId, false);
      reject(new Error(`Timeout after ${timeout}ms`));
    }, timeout);

    pendingRequests.set(reqId, { resolve, reject, timer });
  });
}

/**
 * Response arrived; resolve the corresponding pending request.
 */
export function resolvePendingRequest(reqId: string, ok: boolean, data: unknown, error?: string, code?: string): void {
  const pending = pendingRequests.get(reqId);
  if (!pending) {
    // Still update inflight bookkeeping even if the pending was already removed
    // (e.g. timeout fired just before the response arrived).
    recordCommandResolved(reqId, ok);
    return;
  }

  clearTimeout(pending.timer);
  pendingRequests.delete(reqId);
  recordCommandResolved(reqId, ok);

  if (ok) {
    pending.resolve(data);
  } else {
    pending.reject(new BrowserCommandError(error || 'Browser command failed', code));
  }
}

/** reqId → { shortId, action } for resolving health/lastSuccess + scoping pending count. */
interface ReqMeta { shortId: string; action: string }
const reqIdMeta: Map<string, ReqMeta> =
  ((globalThis as unknown as { __cockpitBrowserReqMeta?: typeof reqIdMeta }).__cockpitBrowserReqMeta)
    ?? ((globalThis as unknown as { __cockpitBrowserReqMeta: Map<string, ReqMeta> })
      .__cockpitBrowserReqMeta = new Map());

/**
 * Hook called by the WS message routers AND createPendingRequest's timeout, to
 * clean reqId tracking and update success bookkeeping. Always idempotent.
 */
export function recordCommandResolved(reqId: string, ok: boolean): void {
  const meta = reqIdMeta.get(reqId);
  if (!meta) return;
  reqIdMeta.delete(reqId);
  if (ok) {
    const entry = registry.get(meta.shortId);
    if (entry) {
      entry.lastSuccessTs = Date.now();
      entry.lastSuccessAction = meta.action;
      entry.lastSeen = Date.now();
    }
  }
}

function newReqId(): string {
  return `r-${randomUUID().slice(0, 8)}`;
}

/** Send one request over a socket-ish sender and await its result. */
function request(
  send: (msg: Record<string, unknown>) => boolean,
  msg: Record<string, unknown>,
  timeout: number,
  track?: ReqMeta,
): Promise<unknown> {
  const reqId = newReqId();
  const pending = createPendingRequest(reqId, timeout);
  if (track) reqIdMeta.set(reqId, track);
  if (!send({ ...msg, reqId })) {
    resolvePendingRequest(reqId, false, undefined, 'connection closed before the request could be sent');
  }
  return pending;
}

/** Ask the bubble UI to do something (wake / frame a screenshot). */
function uiRequest(entry: BrowserEntry, op: string, timeout: number): Promise<unknown> {
  return request(
    (m) => {
      if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) return false;
      entry.ws.send(JSON.stringify(m));
      return true;
    },
    { type: 'browser:ui', op },
    timeout,
  );
}

function uiNotify(entry: BrowserEntry, op: string): void {
  if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify({ type: 'browser:ui', op }));
  }
}

export function extensionRequest(
  extId: string,
  msg: Record<string, unknown>,
  timeout: number,
  track?: ReqMeta,
): Promise<unknown> {
  return request((m) => sendToExtension(extId, m), msg, timeout, track);
}

/**
 * Execute one `cockpit browser <id> <action>` against a registered target.
 * Throws BrowserCommandError / Error (incl. "Timeout after …") on failure.
 */
export async function dispatchBrowserCommand(
  shortId: string,
  action: string,
  params: Record<string, unknown>,
  timeout: number,
): Promise<unknown> {
  const entry = registry.get(shortId);
  if (!entry) throw new BrowserCommandError(`Browser "${shortId}" not found`, 'NOT_REGISTERED');
  const track = { shortId, action };

  if (entry.kind === 'tab') {
    if (!getExtension(entry.extId)) {
      throw new BrowserCommandError(`The browser that owns tab "${shortId}" is no longer connected.`, 'NO_EXTENSION');
    }
    // `timeout` lets the extension bound how long it waits for the user to
    // approve a not-yet-allowed site.
    return extensionRequest(entry.extId!, {
      type: 'cmd', target: { kind: 'tab', fullId: entry.fullId }, action, params, timeout,
    }, timeout, track);
  }

  // Bubble: make sure the iframe is awake and loaded before the extension looks for it.
  await uiRequest(entry, 'ensure-ready', Math.min(timeout, 15000));

  const run = async (p: Record<string, unknown>) => {
    const exts = listExtensions();
    if (!exts.length) throw new BrowserCommandError(NO_EXTENSION_HINT, 'NO_EXTENSION');
    // Prefer the browser that found this bubble last time.
    exts.sort((a, b) => Number(b.id === entry.lastExtId) - Number(a.id === entry.lastExtId));
    let lastErr: unknown = null;
    for (const ext of exts) {
      try {
        const data = await extensionRequest(ext.id, {
          type: 'cmd', target: { kind: 'bubble', bubbleId: entry.fullId }, action, params: p,
        }, timeout, track);
        entry.lastExtId = ext.id;
        return data;
      } catch (err) {
        if ((err as BrowserCommandError).code !== 'TARGET_NOT_FOUND') throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  };

  if (action !== 'screenshot') return run(params);

  const bounds = await uiRequest(entry, 'prepare-screenshot', 10000);
  try {
    return await run({ ...params, bounds });
  } finally {
    uiNotify(entry, 'screenshot-done');
  }
}

/** Open a real tab through the most recently connected extension. */
export async function openBrowserTab(opts: {
  url: string;
  projectCwd?: string;
  show?: boolean;
  timeout?: number;
}): Promise<{ shortId: string; fullId: string; chromeTabId?: number; browser?: string }> {
  const [ext] = listExtensions();
  if (!ext) throw new BrowserCommandError(NO_EXTENSION_HINT, 'NO_EXTENSION');
  const fullId = `tab-${randomUUID()}`;
  const data = await extensionRequest(ext.id, {
    type: 'open-tab', fullId, url: opts.url, projectCwd: opts.projectCwd, show: !!opts.show,
  }, opts.timeout ?? 10000) as { chromeTabId?: number } | undefined;
  const shortId = upsertTab(ext.id, {
    fullId, chromeTabId: data?.chromeTabId, url: opts.url, projectCwd: opts.projectCwd, origin: 'opened',
  });
  return { shortId, fullId, chromeTabId: data?.chromeTabId, browser: ext.browser };
}

/** Close a tab Cockpit opened. The extension refuses to close the user's own tabs. */
export async function closeBrowserTab(shortId: string): Promise<{ closed: boolean }> {
  const entry = registry.get(shortId);
  if (!entry || entry.kind !== 'tab') throw new BrowserCommandError(`Tab "${shortId}" not found`, 'NOT_REGISTERED');
  if (!getExtension(entry.extId)) {
    throw new BrowserCommandError(`The browser that owns tab "${shortId}" is no longer connected.`, 'NO_EXTENSION');
  }
  const data = await extensionRequest(entry.extId!, { type: 'close-tab', fullId: entry.fullId }, 10000) as
    { closed: boolean };
  registry.delete(shortId);
  fullIdToShort.delete(entry.fullId);
  return data;
}

/**
 * Server-side health snapshot for a browser target. NEVER hits the page —
 * answers from in-process state only, so it works even when the page is
 * blocked on a long-running evaluate.
 */
export function getBrowserHealth(shortId: string): {
  found: boolean;
  kind: BrowserKind | null;
  ws: 'open' | 'closed' | 'unknown';
  extension: 'connected' | 'none';
  lastSeenMs: number | null;
  lastSuccessMs: number | null;
  lastSuccessAction: string | null;
  pendingCommands: number;
} {
  const entry = registry.get(shortId);
  const extension = listExtensions().length ? 'connected' as const : 'none' as const;
  if (!entry) {
    return {
      found: false,
      kind: null,
      ws: 'unknown',
      extension,
      lastSeenMs: null,
      lastSuccessMs: null,
      lastSuccessAction: null,
      pendingCommands: 0,
    };
  }
  const now = Date.now();
  // Pending = entries in pendingRequests whose reqId still maps to this
  // shortId. Both maps get cleaned up on timeout (via createPendingRequest's
  // setTimeout calling recordCommandResolved), so this can't leak.
  let pending = 0;
  for (const reqId of pendingRequests.keys()) {
    if (reqIdMeta.get(reqId)?.shortId === shortId) pending += 1;
  }
  return {
    found: true,
    kind: entry.kind,
    ws: entryConnected(entry) ? 'open' : 'closed',
    extension: entry.kind === 'tab' ? (getExtension(entry.extId) ? 'connected' : 'none') : extension,
    lastSeenMs: entry.lastSeen ? now - entry.lastSeen : null,
    lastSuccessMs: entry.lastSuccessTs ? now - entry.lastSuccessTs : null,
    lastSuccessAction: entry.lastSuccessAction ?? null,
    pendingCommands: pending,
  };
}
