'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { executeCommand as execCmd, interruptCommand as interruptCmd, attachCommand, queryRunningCommands, sendStdin, resizePty, dispose as disposeTerminalWs } from './TerminalWsManager';
import { matchInput, getPlugin, generatePluginItemId, type PluginItemBase } from './pluginRegistry';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { useWebSocket } from '@cockpit/shared-ui';
import { expandHomePath, isHomeRelativePath } from '@cockpit/shared-utils/homePath';
import {
  loadTerminalEnv,
  loadAliases as loadAliasesEff,
  loadBubbleOrder as loadBubbleOrderEff,
  saveBubbleOrder as saveBubbleOrderEff,
  loadHistoryPage,
  saveHistoryEntry,
  deleteHistoryEntry,
  patchHistoryEntry,
} from './effect/consoleClient';

// ============================================
// Types
// ============================================

export interface Command {
  id: string;
  command: string;
  output: string;
  exitCode?: number;
  isRunning: boolean;
  pid?: number;
  timestamp: string;
  cwd?: string;
  usePty?: boolean;
}

export type ConsoleItem =
  | { type: 'command'; data: Command }
  | { type: string; data: PluginItemBase };

// ============================================
// Helpers
// ============================================

function generateUniqueCommandId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export const OPEN_PREFERRED_SHELL_COMMAND = '__cockpit_open_preferred_shell__';
const OPEN_PREFERRED_SHELL_LABEL = 'shell';

const PTY_COMMANDS = new Set([OPEN_PREFERRED_SHELL_COMMAND, 'zsh', 'bash', 'sh', 'fish', 'nu', 'python', 'python3', 'node', 'irb', 'lua', 'vim', 'nvim', 'vi', 'nano', 'emacs', 'top', 'htop', 'less', 'man']);
function isPtyCommand(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  return PTY_COMMANDS.has(firstWord);
}

/**
 * Safe truncation: keep the last maxLen characters from the tail, then skip any ANSI sequences or surrogate pairs truncated at the cut point
 */
function safeTruncate(str: string, maxLen: number): string {
  const s = str.slice(-maxLen);
  let skip = 0;

  if (s.length > 0) {
    const code = s.charCodeAt(0);
    if (code >= 0xDC00 && code <= 0xDFFF) {
      skip = 1;
    }
  }

  const scanLen = Math.min(s.length, 64);
  for (let i = skip; i < scanLen; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x1b) {
      skip = i;
      break;
    }
    if ((ch >= 0x30 && ch <= 0x3F) || ch === 0x3B || ch === 0x3F || ch === 0x20) {
      continue;
    }
    if (ch >= 0x40 && ch <= 0x7E) {
      skip = i + 1;
      break;
    }
    break;
  }

  return skip > 0 ? s.slice(skip) : s;
}

export { isPtyCommand, matchInput };

// ============================================
// Hook
// ============================================

interface UseConsoleStateOptions {
  cwd: string;
  initialShellCwd?: string;
  tabId?: string;
  onCwdChange?: (newCwd: string) => void;
}

export function useConsoleState({ cwd, initialShellCwd, tabId, onCwdChange }: UseConsoleStateOptions) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [pluginItems, setPluginItems] = useState<PluginItemBase[]>([]);
  const [sleepingBubbles, setSleepingBubbles] = useState<Set<string>>(new Set());
  const [currentCwd, setCurrentCwd] = useState(initialShellCwd || cwd);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [customEnv, setCustomEnv] = useState<Record<string, string>>({});
  /** Server home dir for `~` expansion; loaded with the terminal env. */
  const homeDirRef = useRef('');
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [bubbleOrder, setBubbleOrder] = useState<string[] | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const commandOutputRef = useRef<Map<string, string>>(new Map());
  const commandPtyRef = useRef<Set<string>>(new Set());
  const commandHistoryRef = useRef<string[]>([]);
  const ptySizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  // PTY direct-write subscribers: commandId → Set of callbacks (write directly to xterm, bypass React state)
  const ptyWritersRef = useRef<Map<string, Set<(data: string) => void>>>(new Map());
  // Early buffer for PTY data arriving before xterm mounts
  const ptyEarlyBufferRef = useRef<Map<string, string[]>>(new Map());
  const executeCommandRef = useRef<((command: string) => void) | null>(null);
  const addPluginItemRef = useRef<((type: string, input: string, afterId?: string) => void) | null>(null);
  const consoleItemsRef = useRef<ConsoleItem[]>([]);

  // Stable per-browser-tab id, attached to every mutation so the cross-tab sync
  // broadcast can be ignored when it echoes back to the tab that caused it.
  const sourceIdRef = useRef<string>('');
  if (!sourceIdRef.current) {
    sourceIdRef.current =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  // Scroll refs (passed in from ConsoleView)
  const scrollRef = useRef<HTMLDivElement>(null);

  // Notify parent component of the current directory on initialization
  useEffect(() => {
    onCwdChange?.(cwd);
     
  }, []);

  // ========== RAF-throttled output ==========

  const flushPendingOutput = useCallback(() => {
    if (pendingOutputRef.current.size > 0) {
      const updates = new Map(pendingOutputRef.current);
      pendingOutputRef.current.clear();

      setCommands((prev) =>
        prev.map((cmd) => {
          const newOutput = updates.get(cmd.id);
          if (newOutput !== undefined) {
            return { ...cmd, output: newOutput };
          }
          return cmd;
        })
      );
    }
    rafIdRef.current = null;
  }, []);

  const MAX_PIPE_BYTES = 2 * 1024 * 1024;
  const appendOutput = useCallback((commandId: string, data: string) => {
    const isPty = commandPtyRef.current.has(commandId);

    // PTY mode: write directly to xterm subscribers, skip React state accumulation.
    // xterm.js scrollback buffer manages memory (no safeTruncate needed).
    if (isPty) {
      const writers = ptyWritersRef.current.get(commandId);
      if (writers && writers.size > 0) {
        for (const w of writers) w(data);
      } else {
        // xterm not mounted yet — buffer for later flush
        if (!ptyEarlyBufferRef.current.has(commandId)) {
          ptyEarlyBufferRef.current.set(commandId, []);
        }
        ptyEarlyBufferRef.current.get(commandId)!.push(data);
      }
      return;
    }

    // Pipe mode: accumulate string as before
    const currentOutput = commandOutputRef.current.get(commandId) || '';
    const newOutput = currentOutput + data;

    if (newOutput.length > MAX_PIPE_BYTES) {
      const truncated = safeTruncate(newOutput, MAX_PIPE_BYTES);
      commandOutputRef.current.set(commandId, truncated);
      pendingOutputRef.current.set(commandId, truncated);
    } else {
      commandOutputRef.current.set(commandId, newOutput);
      pendingOutputRef.current.set(commandId, newOutput);
    }

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushPendingOutput);
    }
  }, [flushPendingOutput]);

  const cleanupOutputRefs = useCallback((commandId: string, keepPtySubscribers = false) => {
    commandOutputRef.current.delete(commandId);
    commandPtyRef.current.delete(commandId);
    pendingOutputRef.current.delete(commandId);
    ptyEarlyBufferRef.current.delete(commandId);
    if (!keepPtySubscribers) {
      ptyWritersRef.current.delete(commandId);
      ptyResettersRef.current.delete(commandId);
    }
  }, []);

  /**
   * Subscribe to PTY output for direct xterm writes.
   * Returns unsubscribe function. On subscribe, flushes any early-buffered data.
   */
  const subscribePtyOutput = useCallback((commandId: string, writer: (data: string) => void) => {
    if (!ptyWritersRef.current.has(commandId)) {
      ptyWritersRef.current.set(commandId, new Set());
    }
    ptyWritersRef.current.get(commandId)!.add(writer);

    // Flush early buffer (data arrived before xterm mounted)
    const earlyBuf = ptyEarlyBufferRef.current.get(commandId);
    if (earlyBuf && earlyBuf.length > 0) {
      for (const chunk of earlyBuf) writer(chunk);
      ptyEarlyBufferRef.current.delete(commandId);
    }

    return () => {
      ptyWritersRef.current.get(commandId)?.delete(writer);
    };
  }, []);

  /**
   * Reset PTY xterm for a command (used on rerun).
   * Calls reset on all subscribed writers' parent xterm instances aren't directly accessible,
   * so we use a separate reset callback registry.
   */
  const ptyResettersRef = useRef<Map<string, Set<() => void>>>(new Map());

  const subscribePtyReset = useCallback((commandId: string, resetter: () => void) => {
    if (!ptyResettersRef.current.has(commandId)) {
      ptyResettersRef.current.set(commandId, new Set());
    }
    ptyResettersRef.current.get(commandId)!.add(resetter);
    return () => {
      ptyResettersRef.current.get(commandId)?.delete(resetter);
    };
  }, []);

  // PTY repaint registry. A reorder swaps bubble positions; React relocates the
  // DOM node of the bubble that moves to a LATER index (insertBefore), which drops
  // xterm's rendered rows without a resize to trigger a repaint. We re-fit + repaint
  // from the buffer after every bubbleOrder change.
  const ptyRefreshersRef = useRef<Map<string, Set<() => void>>>(new Map());

  const subscribePtyRefresh = useCallback((commandId: string, refresher: () => void) => {
    if (!ptyRefreshersRef.current.has(commandId)) {
      ptyRefreshersRef.current.set(commandId, new Set());
    }
    ptyRefreshersRef.current.get(commandId)!.add(refresher);
    return () => {
      ptyRefreshersRef.current.get(commandId)?.delete(refresher);
    };
  }, []);

  useEffect(() => {
    if (!bubbleOrder) return;
    // Run after the DOM move has committed and painted.
    const raf = requestAnimationFrame(() => {
      for (const set of ptyRefreshersRef.current.values()) {
        for (const fn of set) fn();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [bubbleOrder]);

  const flushAndGetOutput = useCallback((commandId: string) => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    flushPendingOutput();
    return commandOutputRef.current.get(commandId) || '';
  }, [flushPendingOutput]);

  // ========== Scroll ==========

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // ========== History ==========

  const loadHistory = useCallback(async (page: number = 0) => {
    if (!tabId) return;

    setIsLoadingHistory(true);
    try {
      const data = await BrowserRuntime.runPromise(
        loadHistoryPage(cwd, tabId, page, 100)
      ).catch((err) => {
        console.error('Failed to load history:', err);
        return null;
      });
      if (data) {
        const historyCommands: Command[] = [];
        const historyPluginItems: PluginItemBase[] = [];
        const restoredSleeping = new Set<string>();

        for (const rawEntry of data.entries) {
          // The v1 backend history-item schema is loose with dynamic runtime fields; preserve v1 any-style behavior here
          const entry = rawEntry as unknown as {
            type: string;
            id: string;
            timestamp: string;
            sleeping?: boolean;
            running?: boolean;
            command: string;
            output: string;
            exitCode?: number;
            cwd?: string;
            usePty?: boolean;
          };
          const plugin = getPlugin(entry.type);
          if (plugin) {
            // Plugin type: restore via plugin's fromHistory method
            const fields = plugin.fromHistory(entry);
            historyPluginItems.push({
              id: entry.id,
              _type: entry.type,
              timestamp: entry.timestamp,
              ...fields,
            });
            if (entry.sleeping) restoredSleeping.add(entry.id);
          } else {
            // Command type
            if (entry.running) continue;
            const cmdId = entry.id.includes('-') && entry.id.split('-').length === 3
              ? entry.id
              : generateUniqueCommandId();
            historyCommands.push({
              id: cmdId,
              command: entry.command,
              output: entry.output,
              exitCode: entry.exitCode,
              isRunning: false,
              timestamp: entry.timestamp,
              cwd: entry.cwd,
              usePty: entry.usePty,
            });
          }
        }

        if (page === 0) {
          setCommands(historyCommands);
          setPluginItems(historyPluginItems);
          if (restoredSleeping.size > 0) setSleepingBubbles(restoredSleeping);
        } else {
          setCommands((prev) => {
            const existingIds = new Set(prev.map((cmd) => cmd.id));
            const newCommands = historyCommands.filter((cmd) => !existingIds.has(cmd.id));
            return [...prev, ...newCommands];
          });
          setPluginItems((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const newItems = historyPluginItems.filter((p) => !existingIds.has(p.id));
            return [...prev, ...newItems];
          });
        }
        setHasMoreHistory(data.hasMore);
        setCurrentPage(page);
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [cwd, tabId]);

  const saveCdToHistory = useCallback(async (command: Command) => {
    if (!tabId) return;
    await BrowserRuntime.runPromise(
      saveHistoryEntry(cwd, tabId, {
        id: command.id,
        command: command.command,
        output: command.output,
        exitCode: command.exitCode,
        timestamp: command.timestamp,
        cwd: currentCwd,
      }, sourceIdRef.current).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => console.error('Failed to save cd history:', err))
        ),
        Effect.orElse(() => Effect.void)
      )
    );
  }, [cwd, tabId, currentCwd]);

  // ========== Reattach running commands ==========

  const reattachRunning = useCallback(async (cancelled: { current: boolean }) => {
    try {
      const runningCmds = await queryRunningCommands(cwd);
      if (cancelled.current) return;

      for (const cmd of runningCmds) {
        if (tabId && cmd.tabId !== tabId) continue;
        if (cancelled.current) break;

        const commandId = cmd.commandId as string;

        setCommands(prev => {
          const existing = prev.find(c => c.id === commandId);
          if (existing) {
            return prev.map(c => c.id === commandId
              ? { ...c, isRunning: true, exitCode: undefined, pid: cmd.pid as number, ...(cmd.usePty ? { usePty: true } : {}) }
              : c
            );
          }
          return [...prev, {
            id: commandId,
            command: cmd.command as string,
            output: '',
            isRunning: true,
            pid: cmd.pid as number,
            timestamp: cmd.timestamp as string,
            cwd: cmd.cwd as string,
            ...(cmd.usePty ? { usePty: true } : {}),
          }];
        });
        commandOutputRef.current.set(commandId, '');
        if (cmd.usePty) commandPtyRef.current.add(commandId);

        await attachCommand({
          commandId,
          projectCwd: cwd,
          onData: (type, data) => {
            if (type === 'pid') {
              if (typeof data.command === 'string') {
                setCommands(prev => prev.map(c => c.id === commandId ? { ...c, command: data.command as string } : c));
              }
            } else if (type === 'stdout' || type === 'stderr') {
              appendOutput(commandId, data.data as string);
            } else if (type === 'exit') {
              const finalOutput = flushAndGetOutput(commandId);
              cleanupOutputRefs(commandId);
              setCommands(prev =>
                prev.map(c => c.id === commandId
                  ? { ...c, output: finalOutput, exitCode: data.code as number, isRunning: false, pid: undefined }
                  : c
                )
              );
            }
          },
          onError: () => {
            setCommands(prev =>
              prev.map(c => c.id === commandId && c.isRunning
                ? { ...c, isRunning: false }
                : c
              )
            );
          },
        });
      }
    } catch {
      // Network error, ignore
    }
  }, [cwd, tabId, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

  // ========== Cross-tab sync (bubble list + PTY stream) ==========

  // Attach this tab to a running command that was created in ANOTHER browser tab
  // (learned via a `console-delta` add). Mirrors reattachRunning's per-command
  // subscription so output/exit flow in; the server replays the ring buffer once.
  const attachRunningCommand = useCallback((commandId: string, usePty: boolean) => {
    commandOutputRef.current.set(commandId, '');
    if (usePty) commandPtyRef.current.add(commandId);
    attachCommand({
      commandId,
      projectCwd: cwd,
      onData: (type, data) => {
        if (type === 'pid') {
          setCommands(prev => prev.map(c => c.id === commandId ? {
            ...c,
            pid: data.pid as number,
            ...(typeof data.command === 'string' ? { command: data.command } : {}),
          } : c));
        } else if (type === 'stdout' || type === 'stderr') {
          appendOutput(commandId, data.data as string);
        } else if (type === 'exit') {
          const finalOutput = flushAndGetOutput(commandId);
          cleanupOutputRefs(commandId);
          setCommands(prev => prev.map(c => c.id === commandId
            ? { ...c, output: finalOutput, exitCode: data.code as number, isRunning: false, pid: undefined }
            : c));
        }
      },
      onError: () => {
        setCommands(prev => prev.map(c => c.id === commandId && c.isRunning ? { ...c, isRunning: false } : c));
      },
    }).catch(() => { /* attach failed — bubble stays as-is */ });
  }, [cwd, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

  // Upsert a bubble learned from another tab (add / rerun-of-unknown). Ignores
  // ids we already have so we never double-add or re-attach (a second attach
  // would replay the ring buffer again). Auto-attaches running commands.
  const addConsoleEntry = useCallback((entry: Record<string, unknown>) => {
    const id = entry?.id as string | undefined;
    if (!entry || !id) return;
    if (consoleItemsRef.current.some(i => i.data.id === id)) return;

    const type = entry.type as string | undefined;
    const plugin = type ? getPlugin(type) : undefined;
    if (plugin) {
      setPluginItems(prev => prev.some(p => p.id === id) ? prev : [...prev, {
        id,
        _type: type as string,
        timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
        ...plugin.fromHistory(entry),
      }]);
      if (entry.sleeping) setSleepingBubbles(prev => new Set(prev).add(id));
    } else {
      const running = !!entry.running;
      setCommands(prev => prev.some(c => c.id === id) ? prev : [...prev, {
        id,
        command: (entry.command as string) ?? '',
        output: (entry.output as string) ?? '',
        exitCode: entry.exitCode as number | undefined,
        isRunning: running,
        timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
        cwd: entry.cwd as string | undefined,
        usePty: entry.usePty as boolean | undefined,
      }]);
      if (running) attachRunningCommand(id, !!entry.usePty);
    }
    setBubbleOrder(prev => (prev && !prev.includes(id)) ? [...prev, id] : prev);
  }, [attachRunningCommand]);

  // Apply one delta from another tab. Last-writer-wins: add=upsert,
  // rerun=reset+re-attach, update=patch-only-if-present (never resurrects a
  // deleted bubble), delete/clear=remove, reorder=replace. Output never travels
  // here — it rides the per-command terminal stream.
  const applyConsoleDelta = useCallback((msg: {
    op?: string;
    entry?: Record<string, unknown>;
    id?: string;
    fields?: Record<string, unknown>;
    order?: string[];
  }) => {
    if (msg.op === 'add') {
      if (msg.entry) addConsoleEntry(msg.entry);
    } else if (msg.op === 'rerun') {
      const entry = msg.entry;
      const id = entry?.id as string | undefined;
      if (!entry || !id) return;
      // Don't have this bubble yet → just add it fresh.
      if (!consoleItemsRef.current.some(i => i.data.id === id)) {
        addConsoleEntry(entry);
        return;
      }
      // Reset the existing bubble and re-attach to the new run. Keep PTY
      // subscribers (the mounted xterm) so the fresh ring-buffer replay lands.
      const usePty = !!entry.usePty;
      if (usePty) {
        const resetters = ptyResettersRef.current.get(id);
        if (resetters) for (const r of resetters) r();
      }
      cleanupOutputRefs(id, usePty);
      setCommands(prev => prev.map(c => c.id === id
        ? { ...c, output: '', exitCode: undefined, isRunning: true, pid: undefined }
        : c));
      attachRunningCommand(id, usePty);
    } else if (msg.op === 'update') {
      const id = msg.id;
      const fields = msg.fields;
      if (!id || !fields) return;
      if (fields.sleeping !== undefined) {
        setSleepingBubbles(prev => {
          const next = new Set(prev);
          if (fields.sleeping) next.add(id); else next.delete(id);
          return next;
        });
      }
      if (fields.exitCode !== undefined || fields.running !== undefined) {
        setCommands(prev => prev.map(c => c.id === id ? {
          ...c,
          ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode as number } : {}),
          ...(fields.running !== undefined ? { isRunning: fields.running as boolean } : {}),
        } : c));
      }
    } else if (msg.op === 'delete') {
      const id = msg.id;
      if (!id) return;
      setCommands(prev => prev.filter(c => c.id !== id));
      setPluginItems(prev => prev.filter(p => p.id !== id));
      setBubbleOrder(prev => prev ? prev.filter(x => x !== id) : prev);
      setSleepingBubbles(prev => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
      cleanupOutputRefs(id);
    } else if (msg.op === 'clear') {
      setCommands([]);
      setPluginItems([]);
      setBubbleOrder([]);
      setSleepingBubbles(new Set());
    } else if (msg.op === 'reorder') {
      if (Array.isArray(msg.order)) setBubbleOrder(msg.order);
    }
  }, [addConsoleEntry, attachRunningCommand, cleanupOutputRefs]);

  useWebSocket({
    url: '/ws/global-state',
    enabled: !!cwd && !!tabId,
    onMessage: (raw) => {
      const p = raw as {
        type?: string; cwd?: string; tabId?: string; sourceId?: string;
        op?: string; entry?: Record<string, unknown>; id?: string;
        fields?: Record<string, unknown>; order?: string[];
      };
      if (p.type !== 'console-delta') return;
      if (p.cwd !== cwd || p.tabId !== tabId) return;
      if (p.sourceId && p.sourceId === sourceIdRef.current) return; // ignore own echo
      applyConsoleDelta(p);
    },
  });

  // ========== Command execution ==========

  const executeCommand = useCallback(async (command: string) => {
    const parts = command.trim().split(/\s+/);
    const firstWord = parts[0];
    let actualCommand = command;

    if (aliases[firstWord]) {
      actualCommand = aliases[firstWord] + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
    }

    const matchedPlugin = matchInput(actualCommand);
    if (matchedPlugin) {
      addPluginItemRef.current?.(matchedPlugin.type, actualCommand.trim());
      return;
    }

    const commandId = generateUniqueCommandId();
    const timestamp = new Date().toISOString();
    const usePty = isPtyCommand(actualCommand);

    const displayCommand =
      actualCommand === OPEN_PREFERRED_SHELL_COMMAND
        ? OPEN_PREFERRED_SHELL_LABEL
        : command;

    const newCommand: Command = {
      id: commandId,
      command: displayCommand,
      output: actualCommand !== command && actualCommand !== OPEN_PREFERRED_SHELL_COMMAND ? `→ ${actualCommand}\n` : '',
      isRunning: true,
      timestamp,
      cwd: currentCwd,
      ...(usePty ? { usePty: true } : {}),
    };

    setCommands((prev) => {
      if (prev.some((cmd) => cmd.id === commandId)) return prev;
      return [...prev, newCommand];
    });
    setSelectedCommandId(commandId);
    commandOutputRef.current.set(commandId, newCommand.output);

    if (usePty) commandPtyRef.current.add(commandId);
    setTimeout(scrollToBottom, 100);

    // Special handling for cd command
    if (actualCommand.trim().startsWith('cd ')) {
      const targetDir = actualCommand.trim().substring(3).trim();
      let newCwd = currentCwd;
      if (isHomeRelativePath(targetDir)) {
        // `~` is rooted, not relative. Without a home dir (env fetch failed)
        // stay put rather than inventing `<cwd>/~`, which is what used to
        // happen and silently poisoned every later relative path.
        newCwd = homeDirRef.current
          ? expandHomePath(targetDir, homeDirRef.current)
          : currentCwd;
      } else if (targetDir.startsWith('/')) {
        newCwd = targetDir;
      } else if (targetDir === '..') {
        newCwd = currentCwd.split('/').slice(0, -1).join('/') || '/';
      } else if (targetDir !== '.') {
        newCwd = `${currentCwd}/${targetDir}`.replace(/\/+/g, '/');
      }

      setCurrentCwd(newCwd);
      onCwdChange?.(newCwd);
      setCommands((prev) =>
        prev.map((cmd) => {
          if (cmd.id === commandId) {
            const finishedCmd = { ...cmd, output: `Changed directory to: ${newCwd}`, exitCode: 0, isRunning: false };
            saveCdToHistory(finishedCmd);
            return finishedCmd;
          }
          return cmd;
        })
      );
      return;
    }

    try {
      await execCmd({
        cwd: currentCwd,
        command: actualCommand,
        commandId,
        tabId: tabId || '',
        projectCwd: cwd,
        env: customEnv,
        usePty,
        sourceId: sourceIdRef.current,
        onData: (type, data) => {
          if (type === 'pid') {
            setCommands((prev) =>
              prev.map((cmd) => (cmd.id === commandId ? {
                ...cmd,
                pid: data.pid as number,
                ...(typeof data.command === 'string' ? { command: data.command } : {}),
              } : cmd))
            );
          } else if (type === 'stdout' || type === 'stderr') {
            appendOutput(commandId, data.data as string);
          } else if (type === 'exit') {
            const finalOutput = flushAndGetOutput(commandId);
            cleanupOutputRefs(commandId);
            setCommands((prev) =>
              prev.map((cmd) => {
                if (cmd.id === commandId) {
                  return { ...cmd, output: finalOutput, exitCode: data.code as number, isRunning: false, pid: undefined };
                }
                return cmd;
              })
            );
          }
        },
        onError: (error) => {
          const finalOutput = flushAndGetOutput(commandId);
          cleanupOutputRefs(commandId);
          setCommands((prev) =>
            prev.map((cmd) => {
              if (cmd.id === commandId) {
                return { ...cmd, output: finalOutput + `\nError: ${error}`, exitCode: 1, isRunning: false, pid: undefined };
              }
              return cmd;
            })
          );
        },
      });
    } catch (error) {
      const finalOutput = flushAndGetOutput(commandId);
      cleanupOutputRefs(commandId);
      setCommands((prev) =>
        prev.map((cmd) => {
          if (cmd.id === commandId) {
            return { ...cmd, output: finalOutput + `\nError: ${(error as Error).message}`, exitCode: 1, isRunning: false, pid: undefined };
          }
          return cmd;
        })
      );
    }
  }, [aliases, currentCwd, customEnv, tabId, cwd, appendOutput, flushAndGetOutput, cleanupOutputRefs, scrollToBottom, onCwdChange, saveCdToHistory]);

  // ========== Interrupt command ==========

  const interruptCommand = useCallback((commandId: string) => {
    const cmd = commands.find((c) => c.id === commandId);
    if (cmd?.isRunning && cmd.pid) {
      interruptCmd(cmd.pid);
    }
  }, [commands]);

  // ========== Re-run command ==========

  const rerunCommand = useCallback(async (commandId: string) => {
    const cmd = commands.find((c) => c.id === commandId);
    if (!cmd) return;

    if (cmd.isRunning && cmd.pid) {
      interruptCmd(cmd.pid);
      await new Promise((r) => setTimeout(r, 200));
    }

    const parts = cmd.command.trim().split(/\s+/);
    const firstWord = parts[0];
    const isPreferredShellRerun =
      cmd.usePty && cmd.command === OPEN_PREFERRED_SHELL_LABEL;
    let actualCommand = isPreferredShellRerun
      ? OPEN_PREFERRED_SHELL_COMMAND
      : cmd.command;
    if (!isPreferredShellRerun && aliases[firstWord]) {
      actualCommand = aliases[firstWord] + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
    }

    const cmdUsePty = cmd.usePty || false;

    // For PTY: reset xterm and keep subscribers alive (component stays mounted)
    if (cmdUsePty) {
      const resetters = ptyResettersRef.current.get(commandId);
      if (resetters) for (const r of resetters) r();
    }

    cleanupOutputRefs(commandId, cmdUsePty);
    const initialOutput = actualCommand !== cmd.command ? `→ ${actualCommand}\n` : '';
    if (!cmdUsePty) {
      commandOutputRef.current.set(commandId, initialOutput);
    }
    // Restore PTY tracking (cleanupOutputRefs cleared it)
    if (cmdUsePty) commandPtyRef.current.add(commandId);

    setCommands((prev) =>
      prev.map((c) =>
        c.id === commandId
          ? { ...c, output: cmdUsePty ? '' : initialOutput, exitCode: undefined, isRunning: true, pid: undefined }
          : c
      )
    );

    const ptySize = ptySizeRef.current.get(commandId);
    try {
      await execCmd({
        cwd: cmd.cwd || currentCwd,
        command: actualCommand,
        commandId,
        tabId: tabId || '',
        projectCwd: cwd,
        env: customEnv,
        usePty: cmdUsePty,
        sourceId: sourceIdRef.current,
        ...(cmdUsePty && ptySize ? { cols: ptySize.cols, rows: ptySize.rows } : {}),
        onData: (type, data) => {
          if (type === 'pid') {
            setCommands((prev) =>
              prev.map((c) => (c.id === commandId ? {
                ...c,
                pid: data.pid as number,
                ...(typeof data.command === 'string' ? { command: data.command } : {}),
              } : c))
            );
          } else if (type === 'stdout' || type === 'stderr') {
            appendOutput(commandId, data.data as string);
          } else if (type === 'exit') {
            const finalOutput = flushAndGetOutput(commandId);
            cleanupOutputRefs(commandId);
            setCommands((prev) =>
              prev.map((c) => {
                if (c.id === commandId) {
                  return { ...c, output: finalOutput, exitCode: data.code as number, isRunning: false, pid: undefined };
                }
                return c;
              })
            );
          }
        },
        onError: (error) => {
          const finalOutput = flushAndGetOutput(commandId);
          cleanupOutputRefs(commandId);
          setCommands((prev) =>
            prev.map((c) => {
              if (c.id === commandId) {
                return { ...c, output: finalOutput + `\nError: ${error}`, exitCode: 1, isRunning: false, pid: undefined };
              }
              return c;
            })
          );
        },
      });
    } catch (error) {
      const finalOutput = flushAndGetOutput(commandId);
      cleanupOutputRefs(commandId);
      setCommands((prev) =>
        prev.map((c) => {
          if (c.id === commandId) {
            return { ...c, output: finalOutput + `\nError: ${(error as Error).message}`, exitCode: 1, isRunning: false, pid: undefined };
          }
          return c;
        })
      );
    }
  }, [commands, aliases, currentCwd, customEnv, tabId, cwd, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

  // ========== Delete command ==========

  const deleteCommand = useCallback(async (commandId: string) => {
    setCommands((prev) => prev.filter((cmd) => cmd.id !== commandId));
    cleanupOutputRefs(commandId);
    if (tabId) {
      await BrowserRuntime.runPromise(
        deleteHistoryEntry(cwd, tabId, commandId, sourceIdRef.current).pipe(
          Effect.tapError((err) =>
            Effect.sync(() => console.error('Failed to delete command:', err))
          ),
          Effect.orElse(() => Effect.void)
        )
      );
    }
  }, [cwd, tabId, cleanupOutputRefs]);

  // ========== Plugin bubbles (generic) ==========

  const addPluginItem = useCallback((type: string, input: string, afterId?: string) => {
    const plugin = getPlugin(type);
    if (!plugin) return;

    const fields = plugin.parse(input);
    // Inject cwd for plugins that need it (e.g. jupyter notebook)
    if ('cwd' in fields && !fields.cwd) {
      fields.cwd = currentCwd;
    }
    const item: PluginItemBase = {
      id: generatePluginItemId(plugin.idPrefix),
      _type: type,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    setPluginItems(prev => [...prev, item]);
    setSelectedCommandId(item.id);
    setTimeout(scrollToBottom, 100);

    // Insert after afterId (position controlled via bubbleOrder)
    if (afterId) {
      const currentOrder = bubbleOrder && bubbleOrder.length > 0
        ? [...bubbleOrder]
        : consoleItemsRef.current.map(i => i.data.id);
      const idx = currentOrder.indexOf(afterId);
      if (idx !== -1) {
        currentOrder.splice(idx + 1, 0, item.id);
      } else {
        currentOrder.push(item.id);
      }
      setBubbleOrder(currentOrder);
      if (tabId) {
        BrowserRuntime.runFork(
          saveBubbleOrderEff(cwd, tabId, currentOrder, sourceIdRef.current).pipe(
            Effect.orElse(() => Effect.void)
          )
        );
      }
    }

    // Persist
    if (tabId) {
      const historyFields = plugin.toHistory(item);
      BrowserRuntime.runFork(
        saveHistoryEntry(cwd, tabId, {
          type,
          id: item.id,
          timestamp: item.timestamp,
          ...historyFields,
        }, sourceIdRef.current).pipe(
          Effect.tapError((e) =>
            Effect.sync(() => console.error(`Failed to save ${type} item:`, e))
          ),
          Effect.orElse(() => Effect.void)
        )
      );
    }
  }, [scrollToBottom, cwd, tabId, bubbleOrder]);

  const closePluginItem = useCallback(async (id: string) => {
    const item = pluginItems.find(p => p.id === id);
    setPluginItems(prev => prev.filter(p => p.id !== id));
    setSelectedCommandId(prev => prev === id ? null : prev);
    setSleepingBubbles(prev => { const next = new Set(prev); next.delete(id); return next; });

    // Invoke plugin cleanup logic
    if (item) {
      const plugin = getPlugin(item._type);
      plugin?.onClose?.(item);
    }

    // Delete persisted entry
    if (tabId) {
      BrowserRuntime.runFork(
        deleteHistoryEntry(cwd, tabId, id, sourceIdRef.current).pipe(
          Effect.tapError((e) =>
            Effect.sync(() => console.error('Failed to delete plugin item:', e))
          ),
          Effect.orElse(() => Effect.void)
        )
      );
    }
  }, [pluginItems, cwd, tabId]);

  addPluginItemRef.current = addPluginItem;
  executeCommandRef.current = executeCommand;

  const persistSleeping = useCallback((id: string, sleeping: boolean) => {
    if (!tabId) return;
    BrowserRuntime.runFork(
      patchHistoryEntry(cwd, tabId, id, { sleeping }, sourceIdRef.current).pipe(
        Effect.orElse(() => Effect.void)
      )
    );
  }, [cwd, tabId]);

  const handleBubbleSleep = useCallback((id: string) => {
    setSleepingBubbles(prev => new Set(prev).add(id));
    persistSleeping(id, true);
  }, [persistSleeping]);

  const handleBubbleWake = useCallback((id: string) => {
    setSleepingBubbles(prev => { const next = new Set(prev); next.delete(id); return next; });
    persistSleeping(id, false);
  }, [persistSleeping]);

  // ========== Bubble ordering ==========

  const saveBubbleOrder = useCallback(async (newOrder: string[]) => {
    setBubbleOrder(newOrder);
    if (!tabId) return;
    await BrowserRuntime.runPromise(
      saveBubbleOrderEff(cwd, tabId, newOrder, sourceIdRef.current).pipe(
        Effect.orElse(() => Effect.void)
      )
    );
  }, [cwd, tabId]);

  // ========== Merged list ==========

  const consoleItems = useMemo<ConsoleItem[]>(() => {
    const all: ConsoleItem[] = [
      ...commands.map(cmd => ({ type: 'command' as const, data: cmd })),
      ...pluginItems.map(item => ({ type: item._type, data: item })),
    ];
    if (!bubbleOrder || bubbleOrder.length === 0) {
      return all.sort((a, b) => new Date(a.data.timestamp).getTime() - new Date(b.data.timestamp).getTime());
    }
    const orderIndex = new Map(bubbleOrder.map((id, i) => [id, i]));
    const ordered: ConsoleItem[] = [];
    const unordered: ConsoleItem[] = [];
    for (const item of all) {
      if (orderIndex.has(item.data.id)) {
        ordered.push(item);
      } else {
        unordered.push(item);
      }
    }
    ordered.sort((a, b) => orderIndex.get(a.data.id)! - orderIndex.get(b.data.id)!);
    unordered.sort((a, b) => new Date(a.data.timestamp).getTime() - new Date(b.data.timestamp).getTime());
    return [...ordered, ...unordered];
  }, [commands, pluginItems, bubbleOrder]);
  consoleItemsRef.current = consoleItems;

  // ========== Command history array (used for up/down arrow navigation) ==========

  useEffect(() => {
    const historyCommands = commands
      .filter((cmd) => !cmd.isRunning && cmd.command.trim())
      .map((cmd) => cmd.command);
    commandHistoryRef.current = historyCommands;
  }, [commands]);

  // ========== Initialization ==========

  const loadEnv = async () => {
    const result = await BrowserRuntime.runPromise(
      loadTerminalEnv(cwd, tabId).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => console.error('Failed to load env:', e))
        ),
        Effect.orElseSucceed(() => ({ env: {}, home: '' }))
      )
    );
    setCustomEnv(result.env);
    // Kept in a ref, not state: `cd ~` reads it inside executeCommand and the
    // value never changes for the life of the server, so re-rendering on it
    // would only churn every bubble below.
    homeDirRef.current = result.home;
  };

  const loadAliases = async () => {
    const aliases = await BrowserRuntime.runPromise(
      loadAliasesEff().pipe(
        Effect.tapError((e) =>
          Effect.sync(() => console.error('Failed to load aliases:', e))
        ),
        Effect.orElseSucceed(() => ({}) as Record<string, string>)
      )
    );
    setAliases(aliases);
  };

  const loadBubbleOrder = async () => {
    if (!tabId) return;
    const order = await BrowserRuntime.runPromise(
      loadBubbleOrderEff(cwd, tabId).pipe(
        Effect.orElseSucceed(() => [] as string[])
      )
    );
    if (order.length > 0) {
      setBubbleOrder(order);
    }
  };

  useEffect(() => {
    const cancelled = { current: false };

    const init = async () => {
      await loadHistory(0);
      if (!cancelled.current) {
        await reattachRunning(cancelled);
      }
    };

    init();
    loadEnv();
    loadAliases();
    loadBubbleOrder();
    return () => { cancelled.current = true; };
  }, [loadHistory, reattachRunning]);

  // Clean up RAF
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Close the terminal WS when the component unmounts
  useEffect(() => {
    return () => {
      disposeTerminalWs();
    };
  }, []);

  return {
    // State
    commands,
    pluginItems,
    sleepingBubbles,
    consoleItems,
    currentCwd,
    selectedCommandId,
    setSelectedCommandId,
    customEnv,
    setCustomEnv,
    aliases,
    setAliases,
    isLoadingHistory,
    hasMoreHistory,
    currentPage,

    // Refs
    scrollRef,
    commandHistoryRef,
    ptySizeRef,
    executeCommandRef,

    // Actions
    executeCommand,
    interruptCommand,
    rerunCommand,
    deleteCommand,
    addPluginItem,
    closePluginItem,
    handleBubbleSleep,
    handleBubbleWake,
    loadHistory,
    scrollToBottom,
    saveBubbleOrder,

    // For stdin/resize passthrough
    sendStdin,
    resizePty,

    // PTY direct-write subscription (bypass React state, write to xterm directly)
    subscribePtyOutput,
    subscribePtyReset,
    subscribePtyRefresh,
  };
}
