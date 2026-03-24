// ============================================
// LSP Server Registry
// One Language Server instance per (language, project cwd).
// LRU eviction (max 5) + idle timeout auto-cleanup (5 minutes).
// Uses globalThis to share one instance across Turbopack module isolation.
// ============================================

import { resolve } from 'path';
import type { LanguageServerAdapter, LSPServerInstance, SupportedLanguage } from './types';
import { TSServerAdapter } from './tsserverAdapter';
import { PyrightAdapter } from './pyrightAdapter';

const GLOBAL_KEY = Symbol.for('lsp_server_registry');
const IDLE_TIMER_KEY = Symbol.for('lsp_idle_timer');

const MAX_SERVERS = 5;
const IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 minutes
const IDLE_CHECK_INTERVAL = 60 * 1000; // check every 60 seconds

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: Map<string, LSPServerInstance> | ReturnType<typeof setInterval> | undefined;
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

  // LRU eviction
  evictIfNeeded();

  const adapter = createAdapter(language);
  if (!adapter) return null;

  let resolveReady: () => void;
  const readyPromise = new Promise<void>((r) => {
    resolveReady = r;
  });

  const childProcess = adapter.spawn();

  const instance: LSPServerInstance = {
    language,
    cwd: resolvedCwd,
    adapter,
    process: childProcess,
    openedFiles: new Set(),
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
    registry.delete(key);
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

/**
 * Ensure a file is open in the corresponding Language Server.
 */
export async function ensureFileOpen(
  server: LSPServerInstance,
  filePath: string,
  content: string
): Promise<void> {
  server.lastUsedAt = Date.now();

  if (!server.openedFiles.has(filePath)) {
    // First open
    server.openedFiles.add(filePath);
    server.adapter.openFile(filePath, content);
    server.lastOpenedFile = filePath;
    return;
  }
  // Already opened: reload only when switching files; consecutive requests for the same file skip reload
  if (server.lastOpenedFile !== filePath) {
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
