'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { AtSign, Variable, Zap, Plus, X, Play, Loader, Square, LayoutGrid, List } from 'lucide-react';
import { CommandBubble } from './TerminalBubble';
import { OutputViewerModal } from './OutputViewerModal';
import { EnvManager } from './EnvManager';
import { AliasManager } from './AliasManager';
import { Tooltip } from '@/components/shared/Tooltip';
import { executeCommand as execCmd, interruptCommand as interruptCmd, attachCommand, queryRunningCommands, sendStdin, resizePty, dispose as disposeTerminalWs } from '@/lib/terminal/TerminalWsManager';

// 生成唯一ID的辅助函数
function generateUniqueCommandId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

interface Command {
  id: string;
  command: string;
  output: string;
  exitCode?: number;
  isRunning: boolean;
  pid?: number;
  timestamp: string;
  cwd?: string;  // 命令执行时的工作目录（用于 rerun）
  usePty?: boolean;
}

interface TerminalViewProps {
  cwd: string;
  initialShellCwd?: string;
  tabId?: string;
  onCwdChange?: (newCwd: string) => void;
}

export function TerminalView({ cwd, initialShellCwd, tabId, onCwdChange }: TerminalViewProps) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [currentCwd, setCurrentCwd] = useState(initialShellCwd || cwd);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState('');
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<string[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [showEnvManager, setShowEnvManager] = useState(false);
  const [showAliasManager, setShowAliasManager] = useState(false);
  const [gridLayout, setGridLayout] = useState(true);
  const [maximizedCommandId, setMaximizedCommandId] = useState<string | null>(null);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [showRunningCommands, setShowRunningCommands] = useState(false);
  const [quickCustomCommands, setQuickCustomCommands] = useState<string[]>([]);
  const [quickScripts, setQuickScripts] = useState<Record<string, string>>({});
  const [quickCommandInput, setQuickCommandInput] = useState('');
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [showViewer, setShowViewer] = useState(false);
  const [isAddingCommand, setIsAddingCommand] = useState(false);
  const [customEnv, setCustomEnv] = useState<Record<string, string>>({});
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const terminalRootRef = useRef<HTMLDivElement>(null);
  // 已无需 per-command AbortController（WS 统一管理）
  const rafIdRef = useRef<number | null>(null);
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const commandOutputRef = useRef<Map<string, string>>(new Map());
  const commandLineCountRef = useRef<Map<string, number>>(new Map());
  const commandHistoryRef = useRef<string[]>([]);
  const ptySizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const quickCommandsRef = useRef<HTMLDivElement>(null);
  const runningCommandsRef = useRef<HTMLDivElement>(null);

  // 初始化时通知父组件当前目录
  useEffect(() => {
    onCwdChange?.(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // RAF 节流的状态更新
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

  // 累积输出并调度 RAF 更新（在数据源头做 5000 行限制）
  const MAX_DISPLAY_LINES = 5000;
  const appendOutput = useCallback((commandId: string, data: string) => {
    const currentOutput = commandOutputRef.current.get(commandId) || '';
    const newOutput = currentOutput + data;

    // 增量计算新增的换行符数量
    let addedNewlines = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === '\n') addedNewlines++;
    }
    const lineCount = (commandLineCountRef.current.get(commandId) || 0) + addedNewlines;

    if (lineCount > MAX_DISPLAY_LINES) {
      const lines = newOutput.split('\n');
      const truncated = lines.slice(-MAX_DISPLAY_LINES).join('\n');
      commandOutputRef.current.set(commandId, truncated);
      pendingOutputRef.current.set(commandId, truncated);
      commandLineCountRef.current.set(commandId, MAX_DISPLAY_LINES);
    } else {
      commandOutputRef.current.set(commandId, newOutput);
      pendingOutputRef.current.set(commandId, newOutput);
      commandLineCountRef.current.set(commandId, lineCount);
    }

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushPendingOutput);
    }
  }, [flushPendingOutput]);

  // 清理某个命令的 output refs
  const cleanupOutputRefs = useCallback((commandId: string) => {
    commandOutputRef.current.delete(commandId);
    commandLineCountRef.current.delete(commandId);
    pendingOutputRef.current.delete(commandId);
  }, []);

  // 强制刷新 + 获取最终输出
  const flushAndGetOutput = useCallback((commandId: string) => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    flushPendingOutput();
    return commandOutputRef.current.get(commandId) || '';
  }, [flushPendingOutput]);

  const checkIfAtBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  }, []);

  const checkIfAtTop = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return true;
    return container.scrollTop < 50;
  }, []);

  const handleScroll = useCallback(() => {
    setShowTopButton(!checkIfAtTop());
    setShowBottomButton(!checkIfAtBottom());
  }, [checkIfAtBottom, checkIfAtTop]);

  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // 加载历史记录
  const loadHistory = useCallback(async (page: number = 0) => {
    if (!tabId) return;

    setIsLoadingHistory(true);
    try {
      const response = await fetch(
        `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&page=${page}&pageSize=20`
      );
      if (response.ok) {
        const data = await response.json();
        const historyCommands: Command[] = data.entries.map((entry: any) => ({
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
        }));

        if (page === 0) {
          setCommands(historyCommands);
        } else {
          setCommands((prev) => {
            const existingIds = new Set(prev.map((cmd) => cmd.id));
            const newCommands = historyCommands.filter((cmd) => !existingIds.has(cmd.id));
            return [...prev, ...newCommands];
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

  // 保存 cd 命令到历史
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

  // 恢复运行中的命令
  const reattachRunning = useCallback(async (cancelled: { current: boolean }) => {
    try {
      const runningCmds = await queryRunningCommands(cwd);
      if (cancelled.current) return;

      for (const cmd of runningCmds) {
        if (tabId && cmd.tabId !== tabId) continue;
        if (cancelled.current) break;

        const commandId = cmd.commandId as string;

        // 添加或更新为运行态（loadHistory 可能先加载了已完成的旧记录）
        setCommands(prev => {
          const existing = prev.find(c => c.id === commandId);
          if (existing) {
            // 服务器说还在运行 → 覆盖为运行态
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

        // 重新接入 WS 流
        await attachCommand({
          commandId,
          projectCwd: cwd,
          onData: (type, data) => {
            if (type === 'pid') {
              // 已有 pid，忽略
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
      // 网络错误，忽略
    }
  }, [cwd, tabId, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

  // 初始化：先加载历史，再恢复运行中的命令（顺序执行避免竞态）
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
    loadSettings();
    return () => { cancelled.current = true; };
  }, [loadHistory, reattachRunning]);

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
      const response = await fetch(`/api/terminal/aliases?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data = await response.json();
        setAliases(data.aliases || {});
      }
    } catch (error) {
      console.error('Failed to load aliases:', error);
    }
  };

  const loadSettings = async () => {
    try {
      const response = await fetch(`/api/terminal/settings?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.settings?.gridLayout !== undefined) {
          setGridLayout(data.settings.gridLayout);
        }
      }
    } catch (error) {
      console.error('Failed to load terminal settings:', error);
    }
  };

  const saveSettings = async (settings: Record<string, unknown>) => {
    try {
      await fetch('/api/terminal/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, settings }),
      });
    } catch (error) {
      console.error('Failed to save terminal settings:', error);
    }
  };

  // 加载快捷命令
  const loadQuickCommands = useCallback(async () => {
    try {
      const [configRes, scriptsRes] = await Promise.all([
        fetch(`/api/services/config?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/services/scripts?cwd=${encodeURIComponent(cwd)}`),
      ]);
      if (configRes.ok) {
        const data = await configRes.json();
        setQuickCustomCommands(data.customCommands || []);
      }
      if (scriptsRes.ok) {
        const data = await scriptsRes.json();
        setQuickScripts(data.scripts || {});
      }
    } catch (error) {
      console.error('Failed to load quick commands:', error);
    }
  }, [cwd]);

  const saveCustomCommands = useCallback(async (commands: string[]) => {
    setQuickCustomCommands(commands);
    try {
      await fetch('/api/services/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, customCommands: commands }),
      });
    } catch (error) {
      console.error('Failed to save custom commands:', error);
    }
  }, [cwd]);

  // 构建命令历史数组（用于上下箭头导航）
  useEffect(() => {
    const historyCommands = commands
      .filter((cmd) => !cmd.isRunning && cmd.command.trim())
      .map((cmd) => cmd.command);
    commandHistoryRef.current = historyCommands;
  }, [commands]);

  // 执行命令
  const executeCommand = useCallback(async (command: string) => {
    const parts = command.trim().split(/\s+/);
    const firstWord = parts[0];
    let actualCommand = command;

    if (aliases[firstWord]) {
      actualCommand = aliases[firstWord] + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
    }

    const commandId = generateUniqueCommandId();
    const timestamp = new Date().toISOString();

    const newCommand: Command = {
      id: commandId,
      command,
      output: actualCommand !== command ? `→ ${actualCommand}\n` : '',
      isRunning: true,
      timestamp,
      cwd: currentCwd,
    };

    setCommands((prev) => {
      if (prev.some((cmd) => cmd.id === commandId)) return prev;
      return [...prev, newCommand];
    });
    setSelectedCommandId(commandId);
    commandOutputRef.current.set(commandId, newCommand.output);
    commandLineCountRef.current.set(commandId, 0);
    setTimeout(scrollToBottom, 100);

    // cd 命令特殊处理
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

    // Per-command WS 执行
    try {
      await execCmd({
        cwd: currentCwd,
        command: actualCommand,
        commandId,
        tabId: tabId || '',
        projectCwd: cwd,
        env: customEnv,
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
  }, [currentCwd, scrollToBottom, saveCdToHistory, aliases, customEnv, tabId, cwd, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

  // 一键启动 PTY 交互式终端（zsh）
  const launchPtyShell = useCallback(async () => {
    const shell = process.env.SHELL || '/bin/zsh';
    const shellName = shell.split('/').pop() || 'zsh';
    const commandId = generateUniqueCommandId();
    const timestamp = new Date().toISOString();

    const newCommand: Command = {
      id: commandId,
      command: shellName,
      output: '',
      isRunning: true,
      timestamp,
      cwd: currentCwd,
      usePty: true,
    };

    setCommands((prev) => [...prev, newCommand]);
    setSelectedCommandId(commandId);
    commandOutputRef.current.set(commandId, '');
    commandLineCountRef.current.set(commandId, 0);
    setTimeout(scrollToBottom, 100);

    try {
      await execCmd({
        cwd: currentCwd,
        command: shellName,
        commandId,
        tabId: tabId || '',
        projectCwd: cwd,
        env: customEnv,
        usePty: true,
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
  }, [currentCwd, scrollToBottom, customEnv, tabId, cwd, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

  // 快捷命令执行
  const handleQuickCommand = useCallback((command: string) => {
    setShowQuickCommands(false);
    executeCommand(command);
  }, [executeCommand]);

  // 中断命令
  const interruptCommand = useCallback((commandId: string) => {
    const command = commands.find((cmd) => cmd.id === commandId);
    if (!command?.pid) return;
    interruptCmd(command.pid);
  }, [commands]);

  // 重新运行命令：原地重跑，不新增气泡
  const rerunCommand = useCallback(async (commandId: string) => {
    const cmd = commands.find((c) => c.id === commandId);
    if (!cmd) return;

    // 如果运行中，先中断
    if (cmd.isRunning && cmd.pid) {
      interruptCmd(cmd.pid);
      // 等一下让进程结束
      await new Promise((r) => setTimeout(r, 200));
    }

    // 处理别名
    const parts = cmd.command.trim().split(/\s+/);
    const firstWord = parts[0];
    let actualCommand = cmd.command;
    if (aliases[firstWord]) {
      actualCommand = aliases[firstWord] + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
    }

    // 重置当前气泡状态
    cleanupOutputRefs(commandId);
    const initialOutput = actualCommand !== cmd.command ? `→ ${actualCommand}\n` : '';
    commandOutputRef.current.set(commandId, initialOutput);
    commandLineCountRef.current.set(commandId, 0);

    setCommands((prev) =>
      prev.map((c) =>
        c.id === commandId
          ? { ...c, output: initialOutput, exitCode: undefined, isRunning: true, pid: undefined, timestamp: new Date().toISOString() }
          : c
      )
    );

    // 重新执行（使用命令记录时的 pty 模式）
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

  // 删除单条历史记录（state + JSONL + outputFile）
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

  // 处理输入提交
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    executeCommand(inputValue);
    setInputValue('');
    setHistoryIndex(-1);
    setTemporaryInput('');
  }, [inputValue, executeCommand]);

  // Tab 键自动补全
  const handleAutocomplete = useCallback(async () => {
    if (!inputRef.current) return;
    const cursorPosition = inputRef.current.selectionStart || 0;

    try {
      const response = await fetch('/api/terminal/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: currentCwd, input: inputValue, cursorPosition }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.suggestions && data.suggestions.length > 0) {
          setAutocompleteSuggestions(data.suggestions);
          setAutocompleteIndex(0);
          setShowAutocomplete(true);

          if (data.suggestions.length === 1) {
            const before = inputValue.substring(0, data.replaceStart);
            const after = inputValue.substring(data.replaceEnd);
            const newValue = before + data.suggestions[0] + after;
            setInputValue(newValue);
            setShowAutocomplete(false);

            setTimeout(() => {
              if (inputRef.current) {
                const newPos = data.replaceStart + data.suggestions[0].length;
                inputRef.current.setSelectionRange(newPos, newPos);
              }
            }, 0);
          }
        }
      }
    } catch (error) {
      console.error('Autocomplete error:', error);
    }
  }, [currentCwd, inputValue]);

  const applyAutocompleteSuggestion = useCallback((suggestion: string) => {
    if (!inputRef.current) return;
    const cursorPosition = inputRef.current.selectionStart || 0;
    const beforeCursor = inputValue.substring(0, cursorPosition);
    const afterCursor = inputValue.substring(cursorPosition);
    const words = beforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1] || '';
    const replaceStart = cursorPosition - lastWord.length;
    const before = inputValue.substring(0, replaceStart);
    const newValue = before + suggestion + afterCursor;
    setInputValue(newValue);
    setShowAutocomplete(false);

    setTimeout(() => {
      if (inputRef.current) {
        const newPos = replaceStart + suggestion.length;
        inputRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }, [inputValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (showAutocomplete && autocompleteSuggestions.length > 0) {
        const newIndex = (autocompleteIndex + 1) % autocompleteSuggestions.length;
        setAutocompleteIndex(newIndex);
        applyAutocompleteSuggestion(autocompleteSuggestions[newIndex]);
      } else {
        handleAutocomplete();
      }
      return;
    }

    if (e.key === 'Escape' && showAutocomplete) {
      e.preventDefault();
      setShowAutocomplete(false);
      return;
    }

    const history = commandHistoryRef.current;
    if (history.length === 0) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex === -1) setTemporaryInput(inputValue);
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInputValue(history[newIndex]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setInputValue(temporaryInput);
      } else {
        setHistoryIndex(newIndex);
        setInputValue(history[newIndex]);
      }
    }
  }, [historyIndex, inputValue, temporaryInput, showAutocomplete, autocompleteSuggestions, autocompleteIndex, handleAutocomplete, applyAutocompleteSuggestion]);

  // 聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 组件卸载时关闭 terminal WS 连接
  useEffect(() => {
    return () => {
      disposeTerminalWs();
    };
  }, []);

  // 点击外部关闭快捷命令弹窗
  useEffect(() => {
    if (!showQuickCommands) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (quickCommandsRef.current && !quickCommandsRef.current.contains(e.target as Node)) {
        setShowQuickCommands(false);
        setIsAddingCommand(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showQuickCommands]);

  // 没有运行中命令时自动关闭弹窗
  const runningCount = commands.filter((cmd) => cmd.isRunning).length;
  useEffect(() => {
    if (runningCount === 0 && showRunningCommands) {
      setShowRunningCommands(false);
    }
  }, [runningCount, showRunningCommands]);

  // 点击外部关闭运行中命令弹窗
  useEffect(() => {
    if (!showRunningCommands) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (runningCommandsRef.current && !runningCommandsRef.current.contains(e.target as Node)) {
        setShowRunningCommands(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showRunningCommands]);

  // Cmd+M: 放大/缩小选中气泡（PTY 和 PIPE 都用全屏 overlay）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'm' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (selectedCommandId) {
          const cmd = commands.find(c => c.id === selectedCommandId);
          if (cmd?.usePty) {
            setMaximizedCommandId(prev => prev === selectedCommandId ? null : selectedCommandId);
          } else {
            setShowViewer(prev => !prev);
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCommandId, commands]);

  // 清理 RAF
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return (
    <div ref={terminalRootRef} className="h-full flex flex-col bg-background relative">
      {/* 命令历史区域 */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto py-4 px-4">
        {commands.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            输入命令开始使用终端
          </div>
        ) : (
          <>
            <div ref={topRef} />
            {hasMoreHistory && (
              <div className="flex justify-center mb-4">
                <button
                  onClick={() => loadHistory(currentPage + 1)}
                  disabled={isLoadingHistory}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors disabled:opacity-50"
                >
                  {isLoadingHistory ? '加载中...' : '加载更多历史'}
                </button>
              </div>
            )}
            <div className={gridLayout ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
            {commands.map((cmd) => (
              <div key={cmd.id} className="group/cmd">
                <CommandBubble
                  command={cmd.command}
                  output={cmd.output}
                  exitCode={cmd.exitCode}
                  isRunning={cmd.isRunning}
                  selected={selectedCommandId === cmd.id}
                  onSelect={() => { setSelectedCommandId(cmd.id); setShowViewer(false); }}
                  onInterrupt={cmd.isRunning ? () => interruptCommand(cmd.id) : undefined}
                  onStdin={cmd.isRunning ? (data: string) => sendStdin(cmd.id, data) : undefined}
                  onDelete={() => {
                    if (cmd.isRunning && cmd.pid) interruptCmd(cmd.pid);
                    deleteCommand(cmd.id);
                  }}
                  onRerun={() => rerunCommand(cmd.id)}
                  timestamp={cmd.timestamp}
                  usePty={cmd.usePty}
                  onPtyResize={(cols, rows) => { ptySizeRef.current.set(cmd.id, { cols, rows }); resizePty(cmd.id, cols, rows); }}
                  onToggleMaximize={() => setMaximizedCommandId(prev => prev === cmd.id ? null : cmd.id)}
                  maximized={maximizedCommandId === cmd.id}
                  portalContainer={terminalRootRef.current}
                />
              </div>
            ))}
            </div>
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* 跳转按钮 */}
      {showTopButton && commands.length > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-14 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95 z-10"
          title="跳转到开始"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
      {showBottomButton && commands.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95 z-10"
          title="跳转到最新"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}

      {/* 底部输入区域 */}
      <div className="border-t border-border p-4">
        <form onSubmit={handleSubmit} className="relative flex gap-2 items-center">
          <button
            type="button"
            onClick={async () => {
              setCommands([]);
              commandOutputRef.current.clear();
              pendingOutputRef.current.clear();
              if (tabId) {
                try {
                  await fetch(`/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}`, { method: 'DELETE' });
                } catch (e) {
                  console.error('Failed to delete history:', e);
                }
              }
            }}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="清空历史"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          {/* 快捷命令按钮 */}
          <div className="relative" ref={quickCommandsRef}>
            <button
              type="button"
              onClick={() => {
                if (!showQuickCommands) loadQuickCommands();
                setShowQuickCommands(!showQuickCommands);
                setIsAddingCommand(false);
                setQuickCommandInput('');
              }}
              className={`p-2 rounded-lg transition-all ${
                showQuickCommands
                  ? 'text-brand bg-brand/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'
              }`}
              title="快捷命令"
            >
              <Zap className="w-4 h-4" />
            </button>

            {/* 快捷命令弹窗 */}
            {showQuickCommands && (
              <div className="absolute bottom-full left-0 mb-2 w-72 bg-popover border border-border rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
                {/* 自定义命令 */}
                <div className="p-2 border-b border-border">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground px-1">自定义命令</span>
                    <button
                      type="button"
                      onClick={() => { setIsAddingCommand(true); setQuickCommandInput(''); }}
                      className="p-0.5 text-muted-foreground hover:text-foreground rounded"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {isAddingCommand && (
                    <input
                      type="text"
                      value={quickCommandInput}
                      onChange={(e) => setQuickCommandInput(e.target.value)}
                      placeholder="输入命令, Enter 确认..."
                      className="w-full px-2 py-1 mb-1 text-xs font-mono rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.stopPropagation();
                          if (quickCommandInput.trim()) {
                            saveCustomCommands([...quickCustomCommands, quickCommandInput.trim()]);
                            setQuickCommandInput('');
                            setIsAddingCommand(false);
                          }
                        } else if (e.key === 'Escape') {
                          setIsAddingCommand(false);
                          setQuickCommandInput('');
                        }
                      }}
                    />
                  )}
                  {quickCustomCommands.length === 0 && !isAddingCommand && (
                    <div className="text-xs text-muted-foreground px-1 py-1">暂无自定义命令</div>
                  )}
                  {quickCustomCommands.map((cmd, i) => (
                    <Tooltip key={i} content={cmd}>
                      <div className="flex items-center group min-w-0">
                        <button
                          type="button"
                          onClick={() => handleQuickCommand(cmd)}
                          className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm font-mono rounded hover:bg-accent transition-colors"
                        >
                          <Play className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate">{cmd}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => saveCustomCommands(quickCustomCommands.filter((_, j) => j !== i))}
                          className="p-1 text-muted-foreground hover:text-destructive rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </Tooltip>
                  ))}
                </div>

                {/* package.json scripts */}
                {Object.keys(quickScripts).length > 0 && (
                  <div className="p-2">
                    <span className="text-xs font-medium text-muted-foreground px-1 mb-1 block">package.json scripts</span>
                    {Object.entries(quickScripts).map(([name, script]) => (
                      <Tooltip key={name} content={`npm run ${name} → ${script}`}>
                        <button
                          type="button"
                          onClick={() => handleQuickCommand(`npm run ${name}`)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-accent transition-colors"
                        >
                          <Play className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                          <span className="font-mono">{name}</span>
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 运行中命令按钮 */}
          {(() => {
            const runningCmds = commands.filter((cmd) => cmd.isRunning);
            if (runningCmds.length === 0) return null;
            return (
              <div className="relative" ref={runningCommandsRef}>
                <button
                  type="button"
                  onClick={() => setShowRunningCommands(!showRunningCommands)}
                  className={`relative p-2 rounded-lg transition-all ${
                    showRunningCommands
                      ? 'text-brand bg-brand/10'
                      : 'text-orange-500 hover:text-orange-600 hover:bg-orange-500/10 active:scale-95'
                  }`}
                  title={`${runningCmds.length} 个命令运行中`}
                >
                  <Loader className="w-4 h-4 animate-spin" />
                  <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center text-[10px] font-bold bg-orange-500 text-white rounded-full px-1">
                    {runningCmds.length}
                  </span>
                </button>

                {/* 运行中命令弹窗 */}
                {showRunningCommands && (
                  <div className="absolute bottom-full left-0 mb-2 w-80 bg-popover border border-border rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
                    <div className="p-2">
                      <div className="flex items-center justify-between mb-2 px-1">
                        <span className="text-xs font-medium text-muted-foreground">运行中的命令</span>
                        {runningCmds.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              runningCmds.forEach((cmd) => interruptCommand(cmd.id));
                            }}
                            className="text-[11px] text-destructive hover:text-destructive/80 font-medium px-2 py-0.5 rounded hover:bg-destructive/10 transition-colors"
                          >
                            全部停止
                          </button>
                        )}
                      </div>
                      {runningCmds.map((cmd) => (
                        <div
                          key={cmd.id}
                          className="flex items-center gap-2 px-2 py-2 rounded hover:bg-accent transition-colors group"
                        >
                          <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
                          <span className="flex-1 text-sm font-mono truncate">{cmd.command}</span>
                          <button
                            type="button"
                            onClick={() => interruptCommand(cmd.id)}
                            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 rounded transition-colors flex-shrink-0"
                            title="Ctrl+C 停止"
                          >
                            <Square className="w-3 h-3" />
                            <span>停止</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          <button
            type="button"
            onClick={() => setGridLayout(prev => { const next = !prev; saveSettings({ gridLayout: next }); return next; })}
            className={`p-2 rounded-lg transition-all ${gridLayout ? 'text-brand bg-brand/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'}`}
            title={gridLayout ? '单列布局' : '双列布局'}
          >
            {gridLayout ? <List className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => setShowAliasManager(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="命令别名"
          >
            <AtSign className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setShowEnvManager(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="环境变量"
          >
            <Variable className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={launchPtyShell}
            className="px-1.5 py-1 rounded text-[11px] font-mono font-medium transition-colors flex-shrink-0 hover:bg-accent text-muted-foreground"
            title="新建交互式终端 (zsh)"
          >
            PTY
          </button>

          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (historyIndex !== -1) {
                setHistoryIndex(-1);
                setTemporaryInput('');
              }
              setShowAutocomplete(false);
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入命令并按 Enter 执行... (↑↓ 历史, Tab 补全)"
            className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />

          {showAutocomplete && autocompleteSuggestions.length > 1 && (
            <div className="absolute bottom-full left-0 mb-1 bg-popover border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
              <div className="py-1">
                {autocompleteSuggestions.map((suggestion, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => applyAutocompleteSuggestion(suggestion)}
                    className={`w-full px-3 py-1.5 text-left text-sm font-mono hover:bg-accent transition-colors ${
                      index === autocompleteIndex ? 'bg-accent' : ''
                    }`}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
                Tab 切换 · Esc 关闭
              </div>
            </div>
          )}
        </form>
      </div>

      {showEnvManager && (
        <EnvManager
          cwd={cwd}
          tabId={tabId}
          onClose={() => setShowEnvManager(false)}
          onSave={(newEnv) => setCustomEnv(newEnv)}
        />
      )}

      {showAliasManager && (
        <AliasManager
          cwd={cwd}
          onClose={() => setShowAliasManager(false)}
          onSave={(newAliases) => setAliases(newAliases)}
        />
      )}

      {/* Cmd+M 放大查看选中气泡输出（PIPE 模式） */}
      {showViewer && selectedCommandId && (() => {
        const cmd = commands.find(c => c.id === selectedCommandId);
        if (!cmd) return null;
        return (
          <OutputViewerModal
            output={cmd.output}
            isRunning={cmd.isRunning}
            onClose={() => setShowViewer(false)}
          />
        );
      })()}

      {/* PTY 全屏由 CommandBubble 通过 portal 渲染到此容器 */}
    </div>
  );
}
