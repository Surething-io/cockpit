'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { executeCommand as execCmd, interruptCommand as interruptCmd, attachCommand, queryRunningCommands, sendStdin, resizePty, dispose as disposeTerminalWs } from '@/lib/terminal/TerminalWsManager';
import { matchInput, getPlugin, generatePluginItemId, type PluginItemBase } from '@/lib/bubbles';

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

const PTY_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'nu', 'python', 'python3', 'node', 'irb', 'lua', 'vim', 'nvim', 'vi', 'nano', 'emacs', 'top', 'htop', 'less', 'man']);
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
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [bubbleOrder, setBubbleOrder] = useState<string[] | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const commandOutputRef = useRef<Map<string, string>>(new Map());
  const commandPtyRef = useRef<Set<string>>(new Set());
  const commandHistoryRef = useRef<string[]>([]);
  const ptySizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const executeCommandRef = useRef<((command: string) => void) | null>(null);
  const addPluginItemRef = useRef<((type: string, input: string, afterId?: string) => void) | null>(null);
  const consoleItemsRef = useRef<ConsoleItem[]>([]);

  // Scroll refs (passed in from ConsoleView)
  const scrollRef = useRef<HTMLDivElement>(null);

  // Notify parent component of the current directory on initialization
  useEffect(() => {
    onCwdChange?.(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const MAX_PTY_BYTES = 5 * 1024 * 1024;
  const MAX_PIPE_BYTES = 2 * 1024 * 1024;
  const appendOutput = useCallback((commandId: string, data: string) => {
    const currentOutput = commandOutputRef.current.get(commandId) || '';
    const newOutput = currentOutput + data;
    const isPty = commandPtyRef.current.has(commandId);
    const maxBytes = isPty ? MAX_PTY_BYTES : MAX_PIPE_BYTES;

    if (newOutput.length > maxBytes) {
      const truncated = safeTruncate(newOutput, maxBytes);
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

  const cleanupOutputRefs = useCallback((commandId: string) => {
    commandOutputRef.current.delete(commandId);
    commandPtyRef.current.delete(commandId);
    pendingOutputRef.current.delete(commandId);
  }, []);

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
      const response = await fetch(
        `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&page=${page}&pageSize=100`
      );
      if (response.ok) {
        const data = await response.json();

        const historyCommands: Command[] = [];
        const historyPluginItems: PluginItemBase[] = [];
        const restoredSleeping = new Set<string>();

        for (const entry of data.entries) {
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
            historyCommands.push({
              id: entry.id.includes('-') && entry.id.split('-').length === 3
                ? entry.id
                : generateUniqueCommandId(),
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
    try {
      await fetch('/api/terminal/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          tabId,
          entry: {
            id: command.id,
            command: command.command,
            output: command.output,
            exitCode: command.exitCode,
            timestamp: command.timestamp,
            cwd: currentCwd,
          },
        }),
      });
    } catch (error) {
      console.error('Failed to save cd history:', error);
    }
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
              // Already has pid, ignore
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

    const newCommand: Command = {
      id: commandId,
      command,
      output: actualCommand !== command ? `→ ${actualCommand}\n` : '',
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
      if (targetDir.startsWith('/')) {
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
        onData: (type, data) => {
          if (type === 'pid') {
            setCommands((prev) =>
              prev.map((cmd) => (cmd.id === commandId ? { ...cmd, pid: data.pid as number } : cmd))
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
    let actualCommand = cmd.command;
    if (aliases[firstWord]) {
      actualCommand = aliases[firstWord] + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
    }

    cleanupOutputRefs(commandId);
    const initialOutput = actualCommand !== cmd.command ? `→ ${actualCommand}\n` : '';
    commandOutputRef.current.set(commandId, initialOutput);

    setCommands((prev) =>
      prev.map((c) =>
        c.id === commandId
          ? { ...c, output: initialOutput, exitCode: undefined, isRunning: true, pid: undefined }
          : c
      )
    );

    const cmdUsePty = cmd.usePty || false;
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
        ...(cmdUsePty && ptySize ? { cols: ptySize.cols, rows: ptySize.rows } : {}),
        onData: (type, data) => {
          if (type === 'pid') {
            setCommands((prev) =>
              prev.map((c) => (c.id === commandId ? { ...c, pid: data.pid as number } : c))
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
      try {
        await fetch(
          `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&commandId=${encodeURIComponent(commandId)}`,
          { method: 'DELETE' },
        );
      } catch (error) {
        console.error('Failed to delete command:', error);
      }
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
        fetch('/api/terminal/bubble-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, tabId, order: currentOrder }),
        }).catch(() => {});
      }
    }

    // Persist
    if (tabId) {
      const historyFields = plugin.toHistory(item);
      fetch('/api/terminal/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          tabId,
          entry: { type, id: item.id, timestamp: item.timestamp, ...historyFields },
        }),
      }).catch(e => console.error(`Failed to save ${type} item:`, e));
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
      fetch(
        `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&commandId=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ).catch(e => console.error('Failed to delete plugin item:', e));
    }
  }, [pluginItems, cwd, tabId]);

  addPluginItemRef.current = addPluginItem;
  executeCommandRef.current = executeCommand;

  const persistSleeping = useCallback((id: string, sleeping: boolean) => {
    if (!tabId) return;
    fetch('/api/terminal/history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, tabId, id, fields: { sleeping } }),
    }).catch(() => {});
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
    try {
      await fetch('/api/terminal/bubble-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, tabId, order: newOrder }),
      });
    } catch { /* ignore */ }
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
    try {
      const params = new URLSearchParams({ cwd });
      if (tabId) params.set('tabId', tabId);
      const response = await fetch(`/api/terminal/env?${params}`);
      if (response.ok) {
        const data = await response.json();
        setCustomEnv(data.env || {});
      }
    } catch (error) {
      console.error('Failed to load env:', error);
    }
  };

  const loadAliases = async () => {
    try {
      const response = await fetch('/api/terminal/aliases');
      if (response.ok) {
        const data = await response.json();
        setAliases(data.aliases || {});
      }
    } catch (error) {
      console.error('Failed to load aliases:', error);
    }
  };

  const loadBubbleOrder = async () => {
    if (!tabId) return;
    try {
      const res = await fetch(`/api/terminal/bubble-order?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.order && data.order.length > 0) {
          setBubbleOrder(data.order);
        }
      }
    } catch { /* ignore */ }
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
  };
}
