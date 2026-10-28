// ============================================
// LSP Server Registry
// One Language Server instance per (language, project cwd).
// LRU eviction (max 5) + idle timeout auto-cleanup (5 minutes).
// Uses globalThis to share one instance across Turbopack module isolation.
// ============================================

import { resolve } from 'path';
import { createHash } from 'crypto';
import type { LanguageServerAdapter, LSPServerInstance, SupportedLanguage } from './types';
import { TSServerAdapter } from './tsserverAdapter';
import { PyrightAdapter } from './pyrightAdapter';

// The registry lives on globalThis, so it OUTLIVES a module reload — in dev
// a hot reload swaps this file's code while keeping instances built by the
// previous version. Any change to the `LSPServerInstance` shape must bump
// this key, or the new code will operate on old-shaped objects and throw
// (v1 → v2 turned `openedFiles` from a Set into a Map). Orphaned v1 servers
// stay owned by their own registry's idle timer + exit hook, so they are
// still reaped; they just stop receiving new requests.
const GLOBAL_KEY = Symbol.for('lsp_server_registry_v2');
const IDLE_TIMER_KEY = Symbol.for('lsp_idle_timer_v2');

const HEALTH_KEY = Symbol.for('lsp_server_health_v1');

const MAX_SERVERS = 5;
const IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 minutes
const IDLE_CHECK_INTERVAL = 60 * 1000; // check every 60 seconds

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]:
    | Map<string, LSPServerInstance>
    | Map<string, ServerHealth>
    | ReturnType<typeof setInterval>
    | undefined;
};

// ============================================
// Out-of-memory circuit breaker
//
// A server that dies of heap exhaustion while loading its project will die
// the same way on every respawn, and each attempt holds the request that
// triggered it for the whole load (37s per hover, measured). Health is kept
// per (language, cwd) as a small state machine; no entry means "running":
//
//   running    ──OOM exit──────────────────────▶ restarting (streak 1)
//   restarting ──OOM exit, streak < MAX────────▶ restarting (streak + 1)
//   restarting ──OOM exit, streak = MAX────────▶ tripped
//   restarting ──non-OOM exit (idle, LRU, …)───▶ running
//   tripped    ──cooldown elapsed──────────────▶ restarting (one more try)
//
// While tripped, getOrCreateServer returns null — the same "no LSP for this
// file" answer callers already handle — instead of spawning.
// ============================================

type ServerHealth =
  | { state: 'restarting'; oomStreak: number }
  | { state: 'tripped'; until: number };

/** Consecutive OOM exits before the breaker trips. */
const MAX_OOM_STREAK = 2;
/** How long a tripped server stays down before one more attempt. */
const TRIP_COOLDOWN = 30 * 60 * 1000;
/** An OOM after this much uptime is a fresh incident (e.g. a huge file
 *  opened hours in), not a continuation of a crash-on-load streak. */
const OOM_STREAK_WINDOW = 10 * 60 * 1000;

function getHealth(): Map<string, ServerHealth> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[HEALTH_KEY]) g[HEALTH_KEY] = new Map<string, ServerHealth>();
  return g[HEALTH_KEY] as Map<string, ServerHealth>;
}

/** True while the breaker for `key` is open. A tripped entry whose cooldown
 *  has elapsed moves to `restarting` one strike short of the limit, so a
 *  single further OOM re-trips it. */
function isTripped(key: string): boolean {
  const health = getHealth();
  const h = health.get(key);
  if (h?.state !== 'tripped') return false;
  if (Date.now() < h.until) return true;
  health.set(key, { state: 'restarting', oomStreak: MAX_OOM_STREAK - 1 });
  return false;
}

function recordExit(key: string, outOfMemory: boolean, uptimeMs: number): void {
  const health = getHealth();
  if (!outOfMemory) {
    health.delete(key);
    return;
  }
  const prev = health.get(key);
  const streak =
    prev?.state === 'restarting' && uptimeMs < OOM_STREAK_WINDOW ? prev.oomStreak + 1 : 1;
  if (streak >= MAX_OOM_STREAK) {
    health.set(key, { state: 'tripped', until: Date.now() + TRIP_COOLDOWN });
    console.log(
      `[lsp-registry] ${key} ran out of memory ${streak} times in a row; ` +
        `not restarting for ${TRIP_COOLDOWN / 60_000} min`,
    );
  } else {
    health.set(key, { state: 'restarting', oomStreak: streak });
  }
}

/** Test-only handle on the module-private breaker. NEVER call from
 *  production code. Driving it through getOrCreateServer would need a real
 *  language server that runs out of memory on demand. */
export const __lspHealthTesting = {
  recordExit,
  isTripped,
  clear(): void {
    getHealth().clear();
  },
};

function getRegistry(): Map<string, LSPServerInstance> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, LSPServerInstance>();
    console.log('[lsp-registry] initialized');

    // Clean up all Language Servers on process exit
    process.on('exit', () => {
      shutdownAll();
    });
  }
  return g[GLOBAL_KEY] as Map<string, LSPServerInstance>;
}

/** Build a registry key: language:absoluteCwd */
function makeKey(language: string, cwd: string): string {
  return `${language}:${resolve(cwd)}`;
}

/** Create the adapter for the specified language */
function createAdapter(language: SupportedLanguage): LanguageServerAdapter | null {
  switch (language) {
    case 'typescript':
      return new TSServerAdapter();
    case 'python':
      if (!PyrightAdapter.isAvailable()) {
        console.log('[lsp-registry] pyright-langserver not found, python LSP disabled');
        return null;
      }
      return new PyrightAdapter();
    default:
      return null;
  }
}

// ============================================
// Idle timeout cleanup
// ============================================

function startIdleTimer(): void {
  const g = globalThis as GlobalWithRegistry;
  if (g[IDLE_TIMER_KEY]) return; // already running

  g[IDLE_TIMER_KEY] = setInterval(() => {
    const registry = getRegistry();
    const now = Date.now();

    for (const [key, instance] of registry) {
      if (now - instance.lastUsedAt > IDLE_TIMEOUT) {
        console.log(`[lsp-registry] idle timeout: ${instance.language} @ ${instance.cwd}, closing`);
        try {
          instance.adapter.shutdown();
        } catch {
          // ignore cleanup errors
        }
        registry.delete(key);
      }
    }

    // Stop the timer when the registry is empty
    if (registry.size === 0) {
      stopIdleTimer();
    }
  }, IDLE_CHECK_INTERVAL);

  // Do not prevent process exit
  if (typeof (g[IDLE_TIMER_KEY] as ReturnType<typeof setInterval>).unref === 'function') {
    (g[IDLE_TIMER_KEY] as ReturnType<typeof setInterval>).unref();
  }
}

function stopIdleTimer(): void {
  const g = globalThis as GlobalWithRegistry;
  if (g[IDLE_TIMER_KEY]) {
    clearInterval(g[IDLE_TIMER_KEY] as ReturnType<typeof setInterval>);
    g[IDLE_TIMER_KEY] = undefined;
  }
}

// ============================================
// LRU eviction
// ============================================

/** Evict the least-recently-used instance until registry.size < MAX_SERVERS */
function evictIfNeeded(): void {
  const registry = getRegistry();
  while (registry.size >= MAX_SERVERS) {
    // Find the entry with the smallest lastUsedAt
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, instance] of registry) {
      if (instance.lastUsedAt < oldestTime) {
        oldestTime = instance.lastUsedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;

    const victim = registry.get(oldestKey)!;
    console.log(`[lsp-registry] LRU evict: ${victim.language} @ ${victim.cwd}, pid=${victim.process.pid}`);
    try {
      victim.adapter.shutdown();
    } catch {
      // ignore cleanup errors
    }
    registry.delete(oldestKey);
  }
}

// ============================================
// Public API
// ============================================

/**
 * Get or create a Language Server instance.
 * One instance per (language, cwd) pair.
 */
export async function getOrCreateServer(language: SupportedLanguage, cwd: string): Promise<LSPServerInstance | null> {
  const resolvedCwd = resolve(cwd);
  const key = makeKey(language, resolvedCwd);
  const registry = getRegistry();
  const existing = registry.get(key);

  if (existing) {
    existing.lastUsedAt = Date.now();
    await existing.readyPromise;
    return existing;
  }

  if (isTripped(key)) return null;

  // LRU eviction
  evictIfNeeded();

  const adapter = createAdapter(language);
  if (!adapter) return null;

  let resolveReady: () => void;
  const readyPromise = new Promise<void>((r) => {
    resolveReady = r;
  });

  const childProcess = adapter.spawn();
  const startedAt = Date.now();

  const instance: LSPServerInstance = {
    language,
    cwd: resolvedCwd,
    adapter,
    process: childProcess,
    openedFiles: new Map(),
    ready: false,
    readyPromise,
    lastUsedAt: Date.now(),
  };

  registry.set(key, instance);
  console.log(`[lsp-registry] started ${language} server for ${resolvedCwd}, pid=${childProcess.pid}`);

  // Start the idle timer
  startIdleTimer();

  // Auto-clean up when the process exits
  childProcess.on('exit', () => {
    console.log(`[lsp-registry] ${language} server exited (cwd=${resolvedCwd})`);
    // Only the current instance may clear the slot — an old process exiting
    // late must not evict its replacement.
    if (registry.get(key) === instance) registry.delete(key);
    recordExit(key, adapter.exitedOutOfMemory?.() ?? false, Date.now() - startedAt);
  });

  // Initialize if the adapter requires it (e.g. pyright's LSP initialize handshake)
  if (adapter.initialize) {
    try {
      await adapter.initialize();
    } catch (err) {
      console.error(`[lsp-registry] ${language} initialize error:`, err);
    }
  }

  instance.ready = true;
  resolveReady!();

  return instance;
}

/**
 * Get an already-running Language Server (does not start a new one).
 */
export function getServer(language: SupportedLanguage, cwd: string): LSPServerInstance | undefined {
  const key = makeKey(language, cwd);
  const instance = getRegistry().get(key);
  if (instance) {
    instance.lastUsedAt = Date.now();
  }
  return instance;
}

/** Fingerprint of the content last handed to the server, so a re-open is
 *  skipped only when the file genuinely hasn't moved. Callers already read
 *  the file to get `content`, so hashing it costs nothing next to the IO. */
function fingerprint(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Ensure a file is open in the corresponding Language Server, and in sync
 * with the content the caller just read off disk.
 *
 * Re-open when any of these hold:
 *   - the server has never seen this file;
 *   - its content changed since we last synced it — the common case when
 *     the user is actively editing the file they're hovering, which is
 *     exactly what a diff view is showing. Skipping this reload used to
 *     serve type info from a stale copy, with no visible sign;
 *   - the adapter's active file moved elsewhere (tsserver tracks a single
 *     current file and needs it re-asserted on switch back).
 */
export async function ensureFileOpen(
  server: LSPServerInstance,
  filePath: string,
  content: string
): Promise<void> {
  server.lastUsedAt = Date.now();

  const hash = fingerprint(content);
  const syncedHash = server.openedFiles.get(filePath);

  if (syncedHash !== hash || server.lastOpenedFile !== filePath) {
    server.openedFiles.set(filePath, hash);
    server.adapter.openFile(filePath, content);
    server.lastOpenedFile = filePath;
  }
}

/**
 * Shut down the Language Server for the specified language and cwd.
 */
export function shutdown(language: SupportedLanguage, cwd: string): void {
  const key = makeKey(language, cwd);
  const registry = getRegistry();
  const instance = registry.get(key);
  if (!instance) return;

  console.log(`[lsp-registry] shutting down ${language} server (cwd=${resolve(cwd)})`);
  instance.adapter.shutdown();
  registry.delete(key);
}

/**
 * Shut down all Language Servers.
 */
export function shutdownAll(): void {
  const registry = getRegistry();
  for (const [, instance] of registry) {
    console.log(`[lsp-registry] shutting down ${instance.language} server (cwd=${instance.cwd})`);
    try {
      instance.adapter.shutdown();
    } catch {
      // ignore cleanup errors
    }
  }
  registry.clear();
  stopIdleTimer();
}

/**
 * Get the status of all running Language Servers.
 */
export function getStatus(): Array<{
  language: string;
  cwd: string;
  pid: number | undefined;
  ready: boolean;
  openedFiles: number;
}> {
  const results: ReturnType<typeof getStatus> = [];
  for (const [, instance] of getRegistry()) {
    results.push({
      language: instance.language,
      cwd: instance.cwd,
      pid: instance.process.pid,
      ready: instance.ready,
      openedFiles: instance.openedFiles.size,
    });
  }
  return results;
}
