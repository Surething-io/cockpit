// ============================================
// LSP Server Registry
// 每个 (语言, 项目cwd) 独立一个 Language Server 实例
// LRU 淘汰（上限 5 个）+ idle 超时自动清理（5 分钟）
// 使用 globalThis 确保 Turbopack 模块隔离下共享同一实例
// ============================================

import { resolve } from 'path';
import type { LanguageServerAdapter, LSPServerInstance, SupportedLanguage } from './types';
import { TSServerAdapter } from './tsserverAdapter';
import { PyrightAdapter } from './pyrightAdapter';

const GLOBAL_KEY = Symbol.for('lsp_server_registry');
const IDLE_TIMER_KEY = Symbol.for('lsp_idle_timer');

const MAX_SERVERS = 5;
const IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 分钟
const IDLE_CHECK_INTERVAL = 60 * 1000; // 每 60 秒检查一次

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: Map<string, LSPServerInstance> | ReturnType<typeof setInterval> | undefined;
};

function getRegistry(): Map<string, LSPServerInstance> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, LSPServerInstance>();
    console.log('[lsp-registry] initialized');

    // 进程退出时清理所有 Language Server
    process.on('exit', () => {
      shutdownAll();
    });
  }
  return g[GLOBAL_KEY] as Map<string, LSPServerInstance>;
}

/** 构造 registry key：language:absoluteCwd */
function makeKey(language: string, cwd: string): string {
  return `${language}:${resolve(cwd)}`;
}

/** 创建对应语言的 adapter */
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
// Idle 超时清理
// ============================================

function startIdleTimer(): void {
  const g = globalThis as GlobalWithRegistry;
  if (g[IDLE_TIMER_KEY]) return; // 已在运行

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

    // registry 空了就停止定时器
    if (registry.size === 0) {
      stopIdleTimer();
    }
  }, IDLE_CHECK_INTERVAL);

  // 不阻止进程退出
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
// LRU 淘汰
// ============================================

/** 淘汰最久没用的实例，直到 registry.size < MAX_SERVERS */
function evictIfNeeded(): void {
  const registry = getRegistry();
  while (registry.size >= MAX_SERVERS) {
    // 找 lastUsedAt 最小的
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
// 公开 API
// ============================================

/**
 * 获取或创建 Language Server 实例
 * 每个 (语言, cwd) 独立一个实例
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

  // LRU 淘汰
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

  // 启动 idle 定时器
  startIdleTimer();

  // 监听进程退出，自动清理
  childProcess.on('exit', () => {
    console.log(`[lsp-registry] ${language} server exited (cwd=${resolvedCwd})`);
    registry.delete(key);
  });

  // 初始化（如果 adapter 需要，如 pyright 的 LSP initialize 握手）
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
 * 获取已运行的 Language Server（不启动新的）
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
 * 确保文件在对应 LS 中已打开
 */
export async function ensureFileOpen(
  server: LSPServerInstance,
  filePath: string,
  content: string
): Promise<void> {
  server.lastUsedAt = Date.now();

  if (!server.openedFiles.has(filePath)) {
    // 首次打开
    server.openedFiles.add(filePath);
    server.adapter.openFile(filePath, content);
    server.lastOpenedFile = filePath;
    return;
  }
  // 已打开过：仅在切换文件时 reload 一次，同一文件连续请求不重复 reload
  if (server.lastOpenedFile !== filePath) {
    server.adapter.openFile(filePath, content);
    server.lastOpenedFile = filePath;
  }
}

/**
 * 关闭指定语言 + cwd 的 Language Server
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
 * 关闭所有 Language Server
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
 * 获取所有运行中的 Language Server 状态
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
