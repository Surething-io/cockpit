// ============================================
// LSP Server Registry
// 管理所有 Language Server 进程，每种语言最多 1 个实例
// 使用 globalThis 确保 Turbopack 模块隔离下共享同一实例
// ============================================

import type { LanguageServerAdapter, LSPServerInstance, SupportedLanguage } from './types';
import { TSServerAdapter } from './tsserverAdapter';
import { PyrightAdapter } from './pyrightAdapter';

const GLOBAL_KEY = Symbol.for('lsp_server_registry');

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: Map<string, LSPServerInstance> | undefined;
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

/**
 * 获取或创建 Language Server 实例
 * 每种语言全局只有一个实例
 */
export async function getOrCreateServer(language: SupportedLanguage): Promise<LSPServerInstance | null> {
  const registry = getRegistry();
  const existing = registry.get(language);

  if (existing) {
    // 等待初始化完成
    await existing.readyPromise;
    return existing;
  }

  const adapter = createAdapter(language);
  if (!adapter) return null;

  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const childProcess = adapter.spawn();

  const instance: LSPServerInstance = {
    language,
    adapter,
    process: childProcess,
    openedFiles: new Set(),
    ready: false,
    readyPromise,
  };

  registry.set(language, instance);
  console.log(`[lsp-registry] started ${language} server, pid=${childProcess.pid}`);

  // 监听进程退出，自动清理
  childProcess.on('exit', () => {
    console.log(`[lsp-registry] ${language} server exited`);
    registry.delete(language);
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
export function getServer(language: SupportedLanguage): LSPServerInstance | undefined {
  return getRegistry().get(language);
}

/**
 * 确保文件在对应 LS 中已打开
 */
export async function ensureFileOpen(
  server: LSPServerInstance,
  filePath: string,
  content: string
): Promise<void> {
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
 * 关闭指定语言的 Language Server
 */
export function shutdown(language: SupportedLanguage): void {
  const registry = getRegistry();
  const instance = registry.get(language);
  if (!instance) return;

  console.log(`[lsp-registry] shutting down ${language} server`);
  instance.adapter.shutdown();
  registry.delete(language);
}

/**
 * 关闭所有 Language Server
 */
export function shutdownAll(): void {
  const registry = getRegistry();
  for (const [language, instance] of registry) {
    console.log(`[lsp-registry] shutting down ${language} server`);
    try {
      instance.adapter.shutdown();
    } catch {
      // ignore cleanup errors
    }
  }
  registry.clear();
}

/**
 * 获取所有运行中的 Language Server 状态
 */
export function getStatus(): Array<{
  language: string;
  pid: number | undefined;
  ready: boolean;
  openedFiles: number;
}> {
  const results: ReturnType<typeof getStatus> = [];
  for (const [, instance] of getRegistry()) {
    results.push({
      language: instance.language,
      pid: instance.process.pid,
      ready: instance.ready,
      openedFiles: instance.openedFiles.size,
    });
  }
  return results;
}
