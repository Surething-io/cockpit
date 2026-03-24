/**
 * TerminalBridge - Registry for CLI access to terminal bubbles
 *
 * Manages shortId mappings and output listeners (for follow live streaming).
 * Parallel to BrowserBridge, but requires no WS reference or pending-request
 * (terminal operations are direct server-side operations).
 */

import { toShortId } from '../shortId';

interface TerminalEntry {
  shortId: string;
  commandId: string;
  tabId: string;
  command: string;
  projectCwd?: string;
  registeredAt: number;
  /** Cache final output after process exits (used by CLI output command) */
  finalOutput?: string;
  exitCode?: number;
}

// Use globalThis + Symbol.for to share the same instance across HMR / Turbopack module reloads
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
 * Called when process exits: retain entry, clean up listeners (output is read from disk)
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
 * Completely remove an entry (called when the bubble is deleted)
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
// Output listeners (for follow live streaming)
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

/** Called by RunningCommandRegistry.appendCommandOutput */
export function notifyOutputListeners(commandId: string, data: string): void {
  const cbs = getOutputListeners().get(commandId);
  if (cbs) {
    for (const cb of cbs) cb(data);
  }
}

// ============================================================================
// Exit listeners (notify process completion during follow)
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

/** Called by RunningCommandRegistry.finalizeCommand (before delete) */
export function notifyExitListeners(commandId: string, exitCode: number): void {
  const cbs = getExitListeners().get(commandId);
  if (cbs) {
    for (const cb of cbs) cb(exitCode);
  }
}
