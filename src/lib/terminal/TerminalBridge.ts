/**
 * TerminalBridge - CLI 访问终端气泡的注册表
 *
 * 管理 shortId 映射和输出监听（用于 follow 实时流）。
 * 与 BrowserBridge 平行，但不需要 WS 引用或 pending-request
 * （终端操作是直接的服务端操作）。
 */

import { toShortId } from '../shortId';

interface TerminalEntry {
  shortId: string;
  commandId: string;
  tabId: string;
  command: string;
  projectCwd?: string;
  registeredAt: number;
  /** 进程结束后缓存最终输出（用于 CLI output 命令） */
  finalOutput?: string;
  exitCode?: number;
}

// 使用 globalThis + Symbol.for 确保 HMR / Turbopack 模块重载下共享同一实例
const REGISTRY_KEY = Symbol.for('terminal_bridge_registry');
const REVERSE_KEY = Symbol.for('terminal_bridge_reverse');
const OUTPUT_LISTENERS_KEY = Symbol.for('terminal_bridge_output_listeners');
const EXIT_LISTENERS_KEY = Symbol.for('terminal_bridge_exit_listeners');

type GlobalWithBridge = typeof globalThis & {
  [key: symbol]: Map<string, unknown> | undefined;
};

function getRegistry(): Map<string, TerminalEntry> {
  const g = globalThis as GlobalWithBridge;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, TerminalEntry>;
}

function getReverseIndex(): Map<string, string> {
  const g = globalThis as GlobalWithBridge;
  if (!g[REVERSE_KEY]) g[REVERSE_KEY] = new Map();
  return g[REVERSE_KEY] as Map<string, string>;
}

function getOutputListeners(): Map<string, Set<(data: string) => void>> {
  const g = globalThis as GlobalWithBridge;
  if (!g[OUTPUT_LISTENERS_KEY]) g[OUTPUT_LISTENERS_KEY] = new Map();
  return g[OUTPUT_LISTENERS_KEY] as Map<string, Set<(data: string) => void>>;
}

function getExitListeners(): Map<string, Set<(code: number) => void>> {
  const g = globalThis as GlobalWithBridge;
  if (!g[EXIT_LISTENERS_KEY]) g[EXIT_LISTENERS_KEY] = new Map();
  return g[EXIT_LISTENERS_KEY] as Map<string, Set<(code: number) => void>>;
}

export function registerTerminal(tabId: string, commandId: string, command: string, projectCwd?: string): string {
  const fullId = tabId + commandId;
  const shortId = toShortId(fullId);
  getRegistry().set(shortId, { shortId, commandId, tabId, command, projectCwd, registeredAt: Date.now() });
  getReverseIndex().set(commandId, shortId);
  return shortId;
}

/**
 * 进程结束时调用：保留条目，清理监听器（输出从磁盘读取）
 */
export function finalizeTerminal(commandId: string, exitCode: number): void {
  const shortId = getReverseIndex().get(commandId);
  if (shortId) {
    const entry = getRegistry().get(shortId);
    if (entry) {
      entry.exitCode = exitCode;
    }
    getOutputListeners().delete(commandId);
    getExitListeners().delete(commandId);
  }
}

/**
 * 完全移除条目（气泡被删除时调用）
 */
export function unregisterTerminal(commandId: string): void {
  const shortId = getReverseIndex().get(commandId);
  if (shortId) {
    getRegistry().delete(shortId);
    getReverseIndex().delete(commandId);
    getOutputListeners().delete(commandId);
    getExitListeners().delete(commandId);
  }
}

export function getTerminalByShortId(shortId: string): TerminalEntry | undefined {
  return getRegistry().get(shortId);
}

export function getTerminalShortId(commandId: string): string | undefined {
  return getReverseIndex().get(commandId);
}

export function listTerminals(getRunning?: (commandId: string) => { pid: number } | undefined): Array<{
  shortId: string;
  commandId: string;
  tabId: string;
  command: string;
  pid: number;
  running: boolean;
}> {
  const result: ReturnType<typeof listTerminals> = [];
  for (const [, entry] of getRegistry()) {
    const cmd = getRunning?.(entry.commandId);
    result.push({
      shortId: entry.shortId,
      commandId: entry.commandId,
      tabId: entry.tabId,
      command: entry.command,
      pid: cmd?.pid ?? 0,
      running: !!cmd,
    });
  }
  return result;
}

// ============================================================================
// 输出监听（用于 follow 实时流）
// ============================================================================

export function addOutputListener(commandId: string, cb: (data: string) => void): () => void {
  const listeners = getOutputListeners();
  if (!listeners.has(commandId)) listeners.set(commandId, new Set());
  listeners.get(commandId)!.add(cb);
  return () => {
    listeners.get(commandId)?.delete(cb);
    if (listeners.get(commandId)?.size === 0) listeners.delete(commandId);
  };
}

/** 被 RunningCommandRegistry.appendCommandOutput 调用 */
export function notifyOutputListeners(commandId: string, data: string): void {
  const cbs = getOutputListeners().get(commandId);
  if (cbs) {
    for (const cb of cbs) cb(data);
  }
}

// ============================================================================
// 退出监听（用于 follow 时通知进程结束）
// ============================================================================

export function addExitListener(commandId: string, cb: (code: number) => void): () => void {
  const listeners = getExitListeners();
  if (!listeners.has(commandId)) listeners.set(commandId, new Set());
  listeners.get(commandId)!.add(cb);
  return () => {
    listeners.get(commandId)?.delete(cb);
    if (listeners.get(commandId)?.size === 0) listeners.delete(commandId);
  };
}

/** 被 RunningCommandRegistry.finalizeCommand 调用（在 delete 之前） */
export function notifyExitListeners(commandId: string, exitCode: number): void {
  const cbs = getExitListeners().get(commandId);
  if (cbs) {
    for (const cb of cbs) cb(exitCode);
  }
}
