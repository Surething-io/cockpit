'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { AtSign, Variable, Zap, Plus, X, Play, LayoutGrid, List } from 'lucide-react';
import { CommandBubble } from './CommandBubble';
import { BrowserBubble } from './BrowserBubble';
import { EnvManager } from './EnvManager';
import { AliasManager } from '../AliasManager';
import { Tooltip } from '@/components/shared/Tooltip';
import { executeCommand as execCmd, interruptCommand as interruptCmd, attachCommand, queryRunningCommands, sendStdin, resizePty, dispose as disposeTerminalWs } from '@/lib/terminal/TerminalWsManager';
import type { CustomCommand } from '@/app/api/services/config/route';


// 生成唯一ID的辅助函数
function generateUniqueCommandId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** 判断输入是否为 URL（http:// 或 https:// 开头） */
function isUrlInput(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

/** 判断命令是否应该用 PTY 模式（交互式 shell） */
const PTY_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'nu', 'python', 'python3', 'node', 'irb', 'lua', 'vim', 'nvim', 'vi', 'nano', 'emacs', 'top', 'htop', 'less', 'man']);
function isPtyCommand(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  return PTY_COMMANDS.has(firstWord);
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

/** 浏览器气泡 */
interface BrowserItem {
  id: string;
  url: string;
  timestamp: string;
}

/** Console 统一列表项 */
type ConsoleItem =
  | { type: 'command'; data: Command }
  | { type: 'browser'; data: BrowserItem };

interface ConsoleViewProps {
  cwd: string;
  initialShellCwd?: string;
  tabId?: string;
  onCwdChange?: (newCwd: string) => void;
}

export function ConsoleView({ cwd, initialShellCwd, tabId, onCwdChange }: ConsoleViewProps) {
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
  /** 统一放大 ID：任意类型气泡（PTY/Pipe/Browser）共用 */
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  /** scrollRef 可视区高度，传给放大的气泡 */
  const [consoleHeight, setConsoleHeight] = useState(0);
  const [showQuickCommands, setShowQuickCommands] = useState(false);

  const [quickCustomCommands, setQuickCustomCommands] = useState<CustomCommand[]>([]);
  const [quickScripts, setQuickScripts] = useState<Record<string, string>>({});
  const [newCmdName, setNewCmdName] = useState('');
  const [newCmdCommand, setNewCmdCommand] = useState('');
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [isAddingCommand, setIsAddingCommand] = useState(false);
  const [customEnv, setCustomEnv] = useState<Record<string, string>>({});
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [filteredSlashCommands, setFilteredSlashCommands] = useState<CustomCommand[]>([]);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const slashListRef = useRef<HTMLDivElement>(null);
  const [browserItems, setBrowserItems] = useState<BrowserItem[]>([]);
  const [sleepingBubbles, setSleepingBubbles] = useState<Set<string>>(new Set());
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);
  const [bubbleOrder, setBubbleOrder] = useState<string[] | null>(null);
  const executeCommandRef = useRef<((command: string) => void) | null>(null);
  const dragEnabledRef = useRef(false);
  const dragItemIdRef = useRef<string | null>(null);
  const dragOverItemIdRef = useRef<string | null>(null);
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

        // 按 type 分流（缺少 type 的旧数据默认为 command）
        const historyCommands: Command[] = [];
        const historyBrowsers: BrowserItem[] = [];

        const restoredSleeping = new Set<string>();
        for (const entry of data.entries) {
          if (entry.type === 'browser') {
            historyBrowsers.push({
              id: entry.id,
              url: entry.url,
              timestamp: entry.timestamp,
            });
            if (entry.sleeping) restoredSleeping.add(entry.id);
          } else {
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
          setBrowserItems(historyBrowsers);
          if (restoredSleeping.size > 0) setSleepingBubbles(restoredSleeping);
        } else {
          setCommands((prev) => {
            const existingIds = new Set(prev.map((cmd) => cmd.id));
            const newCommands = historyCommands.filter((cmd) => !existingIds.has(cmd.id));
            return [...prev, ...newCommands];
          });
          setBrowserItems((prev) => {
            const existingIds = new Set(prev.map((b) => b.id));
            const newItems = historyBrowsers.filter((b) => !existingIds.has(b.id));
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
    loadBubbleOrder();
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
      const response = await fetch('/api/terminal/aliases');
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
      const response = await fetch(`/api/project-settings?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.settings?.gridLayout !== undefined) {
          setGridLayout(data.settings.gridLayout);
        }
      }
    } catch (error) {
      console.error('Failed to load project settings:', error);
    }
  };

  const saveSettings = async (settings: Record<string, unknown>) => {
    try {
      await fetch('/api/project-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, settings }),
      });
    } catch (error) {
      console.error('Failed to save project settings:', error);
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

  // 拖拽排序处理
  const handleTitleMouseDown = useCallback(() => {
    dragEnabledRef.current = true;
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, itemId: string) => {
    if (!dragEnabledRef.current) { e.preventDefault(); return; }
    dragEnabledRef.current = false;
    dragItemIdRef.current = itemId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', itemId);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
    // 创建自定义拖拽预览（PTY 气泡含 canvas 无法自动生成 ghost）
    const titleBar = (e.currentTarget as HTMLElement).querySelector('[data-drag-handle]') as HTMLElement | null;
    if (titleBar) {
      const ghost = titleBar.cloneNode(true) as HTMLElement;
      ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:' + titleBar.offsetWidth + 'px;background:var(--card);border-radius:8px;padding:4px 12px;opacity:0.9;';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 16);
      requestAnimationFrame(() => document.body.removeChild(ghost));
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, itemId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dragOverItemIdRef.current = itemId;
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.add('ring-2', 'ring-brand');
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('ring-2', 'ring-brand');
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('ring-2', 'ring-brand');
  }, []);

  const consoleItemsRef = useRef<ConsoleItem[]>([]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    const fromId = dragItemIdRef.current;
    const toId = dragOverItemIdRef.current;
    dragItemIdRef.current = null;
    dragOverItemIdRef.current = null;
    if (!fromId || !toId || fromId === toId) return;
    const currentIds = consoleItemsRef.current.map(item => item.data.id);
    const fromIndex = currentIds.indexOf(fromId);
    const toIndex = currentIds.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) return;
    const newIds = [...currentIds];
    // 互换位置
    newIds[fromIndex] = toId;
    newIds[toIndex] = fromId;
    saveBubbleOrder(newIds);
  }, [saveBubbleOrder]);

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

  // 组件挂载时加载自定义命令
  useEffect(() => {
    loadQuickCommands();
  }, [loadQuickCommands]);

  // 输入变化时过滤 / 自定义命令
  useEffect(() => {
    if (inputValue.startsWith('/')) {
      const keyword = inputValue.slice(1).toLowerCase();
      const filtered = quickCustomCommands.filter(c => c.name.toLowerCase().startsWith(keyword));
      setFilteredSlashCommands(filtered);
      setShowSlashCommands(filtered.length > 0);
      setSlashSelectedIndex(0);
    } else {
      setShowSlashCommands(false);
    }
  }, [inputValue, quickCustomCommands]);

  // 滚动选中项到可视区域
  useEffect(() => {
    if (showSlashCommands && slashListRef.current) {
      const item = slashListRef.current.children[slashSelectedIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [slashSelectedIndex, showSlashCommands]);

  const handleSlashSelect = useCallback((cmd: CustomCommand) => {
    setShowSlashCommands(false);
    const finalCmd = cmd.command;
    if (isUrlInput(finalCmd)) {
      addBrowserItemRef.current?.(finalCmd.trim());
    } else {
      executeCommandRef.current?.(finalCmd);
    }
    setInputValue('');
  }, []);

  const saveCustomCommands = useCallback(async (commands: CustomCommand[]) => {
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

    // 解析后的命令可能是 URL（如自定义命令指向 http://...）→ 打开浏览器
    if (isUrlInput(actualCommand)) {
      addBrowserItemRef.current?.(actualCommand.trim());
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
  }, [currentCwd, scrollToBottom, saveCdToHistory, aliases, customEnv, tabId, cwd, appendOutput, flushAndGetOutput, cleanupOutputRefs]);

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
          ? { ...c, output: initialOutput, exitCode: undefined, isRunning: true, pid: undefined }
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

  // 添加浏览器气泡（同时持久化到 history）
  const addBrowserItem = useCallback((url: string) => {
    const item: BrowserItem = {
      id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      timestamp: new Date().toISOString(),
    };
    setBrowserItems(prev => [...prev, item]);
    setSelectedCommandId(item.id);
    setTimeout(scrollToBottom, 100);

    // 持久化
    if (tabId) {
      fetch('/api/terminal/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          tabId,
          entry: { type: 'browser', id: item.id, url: item.url, timestamp: item.timestamp },
        }),
      }).catch(e => console.error('Failed to save browser item:', e));
    }
  }, [scrollToBottom, cwd, tabId]);

  // ref 供回调内部调用（避免循环依赖）
  const addBrowserItemRef = useRef(addBrowserItem);
  addBrowserItemRef.current = addBrowserItem;
  executeCommandRef.current = executeCommand;

  // 关闭浏览器气泡（同时从 history 中删除）
  const closeBrowserItem = useCallback((id: string) => {
    setBrowserItems(prev => prev.filter(item => item.id !== id));
    if (maximizedId === id) setMaximizedId(null);
    if (selectedCommandId === id) setSelectedCommandId(null);
    setSleepingBubbles(prev => { const next = new Set(prev); next.delete(id); return next; });

    // 从持久化中删除
    if (tabId) {
      fetch(
        `/api/terminal/history?cwd=${encodeURIComponent(cwd)}&tabId=${encodeURIComponent(tabId)}&commandId=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ).catch(e => console.error('Failed to delete browser item:', e));
    }
  }, [maximizedId, selectedCommandId, cwd, tabId]);

  // 持久化休眠状态到 history
  const persistSleeping = useCallback((id: string, sleeping: boolean) => {
    if (!tabId) return;
    fetch('/api/terminal/history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, tabId, id, fields: { sleeping } }),
    }).catch(() => {});
  }, [cwd, tabId]);

  // 气泡休眠回调
  const handleBubbleSleep = useCallback((id: string) => {
    setSleepingBubbles(prev => new Set(prev).add(id));
    persistSleeping(id, true);
  }, [persistSleeping]);

  // 气泡唤醒回调
  const handleBubbleWake = useCallback((id: string) => {
    setSleepingBubbles(prev => { const next = new Set(prev); next.delete(id); return next; });
    persistSleeping(id, false);
  }, [persistSleeping]);

  // 快捷命令执行（自动识别 browser / pty / pipe）
  const handleQuickCommand = useCallback((command: string) => {
    setShowQuickCommands(false);
    if (isUrlInput(command)) {
      addBrowserItem(command.trim());
    } else {
      executeCommand(command);
    }
  }, [executeCommand, addBrowserItem]);

  // 监听 ChatInput 的终端命令执行事件
  useEffect(() => {
    const handler = (e: Event) => {
      const command = (e as CustomEvent).detail?.command;
      if (command) {
        executeCommand(command);
      }
    };
    window.addEventListener('execute-terminal-command', handler);
    return () => window.removeEventListener('execute-terminal-command', handler);
  }, [executeCommand]);

  // 合并命令和浏览器项，按自定义排序或时间排序
  const consoleItems = useMemo<ConsoleItem[]>(() => {
    const all: ConsoleItem[] = [
      ...commands.map(cmd => ({ type: 'command' as const, data: cmd })),
      ...browserItems.map(item => ({ type: 'browser' as const, data: item })),
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
  }, [commands, browserItems, bubbleOrder]);
  consoleItemsRef.current = consoleItems;

  // 展开自定义命令：/name args → actualCommand args
  const expandCustomCommand = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const firstWord = parts[0];
    if (!firstWord.startsWith('/') || firstWord.length <= 1) return null;
    const cmdName = firstWord.slice(1);
    const matched = quickCustomCommands.find(c => c.name === cmdName);
    if (!matched) return null;
    return matched.command + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
  }, [quickCustomCommands]);

  // 追踪输入法组合状态
  const isComposingRef = useRef(false);

  // 处理输入提交
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (isComposingRef.current) return;
    if (!inputValue.trim()) return;

    // 优先展开自定义命令
    const expanded = expandCustomCommand(inputValue);
    const finalInput = expanded ?? inputValue;

    if (isUrlInput(finalInput)) {
      addBrowserItem(finalInput.trim());
    } else {
      executeCommand(finalInput);
    }

    setInputValue('');
    setHistoryIndex(-1);
    setTemporaryInput('');
  }, [inputValue, executeCommand, addBrowserItem, expandCustomCommand]);

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
    // 输入法组合输入中（如中文拼音），不处理键盘事件
    if (e.nativeEvent.isComposing) return;

    // / 命令候选列表键盘导航
    if (showSlashCommands && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(prev => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex(prev => (prev + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        handleSlashSelect(filteredSlashCommands[slashSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashCommands(false);
        return;
      }
    }

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
  }, [historyIndex, inputValue, temporaryInput, showAutocomplete, autocompleteSuggestions, autocompleteIndex, handleAutocomplete, applyAutocompleteSuggestion, showSlashCommands, filteredSlashCommands, slashSelectedIndex, handleSlashSelect]);

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


  // Cmd+M: 放大/缩小选中气泡（统一处理 PTY / PIPE / Browser）
  const toggleMaximize = useCallback((id: string) => {
    setMaximizedId(prev => prev === id ? null : id);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'm' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (selectedCommandId) {
          toggleMaximize(selectedCommandId);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCommandId, toggleMaximize]);

  // 放大第1步：测量可视高度（或重置）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (maximizedId) {
      setConsoleHeight(el.clientHeight);
    } else {
      el.style.overflow = '';
      setConsoleHeight(0);
    }
    return () => { if (el) el.style.overflow = ''; };
  }, [maximizedId]);

  // 放大第2步：consoleHeight 生效后（气泡已撑开），滚动到目标 + 锁定
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !maximizedId || !consoleHeight) return;
    // 此时子组件已拿到 expandedHeight 并完成 re-render，等一帧确保 DOM 提交
    const rafId = requestAnimationFrame(() => {
      const bubbleEl = el.querySelector(`[data-bubble-id="${maximizedId}"]`) as HTMLElement | null;
      if (bubbleEl) {
        bubbleEl.scrollIntoView({ block: 'start' });
      }
      el.style.overflow = 'hidden';
    });
    return () => cancelAnimationFrame(rafId);
  }, [maximizedId, consoleHeight]);

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
      <div ref={scrollRef} onScroll={handleScroll} className={`flex-1 overflow-y-auto ${maximizedId ? '' : 'py-4 px-4'}`}>
        {consoleItems.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            输入命令或网址开始使用
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
            <div className={maximizedId ? 'flex flex-col gap-3' : gridLayout ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
            {consoleItems.map((item) => (
              item.type === 'command' ? (
                <div
                  key={item.data.id}
                  data-bubble-id={item.data.id}
                  className="group/cmd rounded-lg transition-shadow"
                  draggable
                  onDragStart={(e) => handleDragStart(e, item.data.id)}
                  onDragOver={(e) => handleDragOver(e, item.data.id)}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                >
                  <CommandBubble
                    command={item.data.command}
                    output={item.data.output}
                    exitCode={item.data.exitCode}
                    isRunning={item.data.isRunning}
                    selected={selectedCommandId === item.data.id}
                    onSelect={() => { setSelectedCommandId(item.data.id); }}
                    onInterrupt={item.data.isRunning ? () => interruptCommand(item.data.id) : undefined}
                    onStdin={item.data.isRunning ? (data: string) => sendStdin(item.data.id, data) : undefined}
                    onDelete={() => {
                      if (item.data.isRunning && item.data.pid) interruptCmd(item.data.pid);
                      deleteCommand(item.data.id);
                    }}
                    onRerun={() => rerunCommand(item.data.id)}
                    timestamp={item.data.timestamp}
                    usePty={item.data.usePty}
                    onPtyResize={(cols, rows) => { ptySizeRef.current.set(item.data.id, { cols, rows }); resizePty(item.data.id, cols, rows); }}
                    onToggleMaximize={() => toggleMaximize(item.data.id)}
                    maximized={maximizedId === item.data.id}
                    expandedHeight={consoleHeight}
                    onTitleMouseDown={handleTitleMouseDown}
                  />
                </div>
              ) : (
                <div
                  key={item.data.id}
                  data-bubble-id={item.data.id}
                  className="rounded-lg transition-shadow"
                  draggable
                  onDragStart={(e) => handleDragStart(e, item.data.id)}
                  onDragOver={(e) => handleDragOver(e, item.data.id)}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                >
                  <BrowserBubble
                    id={item.data.id}
                    url={item.data.url}
                    selected={selectedCommandId === item.data.id}
                    maximized={maximizedId === item.data.id}
                    onSelect={() => { setSelectedCommandId(item.data.id); }}
                    onClose={() => closeBrowserItem(item.data.id)}
                    onToggleMaximize={() => toggleMaximize(item.data.id)}
                    onNewTab={addBrowserItem}
                    expandedHeight={consoleHeight}
                    timestamp={item.data.timestamp}
                    onTitleMouseDown={handleTitleMouseDown}
                    initialSleeping={sleepingBubbles.has(item.data.id)}
                    onSleep={handleBubbleSleep}
                    onWake={handleBubbleWake}
                  />
                </div>
              )
            ))}
            </div>
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* 跳转按钮 */}
      {!maximizedId && showTopButton && consoleItems.length > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95 z-10"
          title="跳转到开始"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}
      {!maximizedId && showBottomButton && consoleItems.length > 0 && (
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
          {/* 快捷命令按钮 */}
          <div className="relative" ref={quickCommandsRef}>
            <button
              type="button"
              onClick={() => {
                if (!showQuickCommands) loadQuickCommands();
                setShowQuickCommands(!showQuickCommands);
                setIsAddingCommand(false);
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
                <div className="p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground px-1">自定义命令</span>
                    <button
                      type="button"
                      onClick={() => { setIsAddingCommand(true); setNewCmdName(''); setNewCmdCommand(''); }}
                      className="p-0.5 text-muted-foreground hover:text-foreground rounded"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {isAddingCommand && (
                    <div className="flex gap-1 mb-1">
                      <input
                        type="text"
                        value={newCmdName}
                        onChange={(e) => setNewCmdName(e.target.value)}
                        placeholder="名称"
                        className="w-24 flex-shrink-0 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setIsAddingCommand(false); }
                        }}
                      />
                      <input
                        type="text"
                        value={newCmdCommand}
                        onChange={(e) => setNewCmdCommand(e.target.value)}
                        placeholder="命令"
                        className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (newCmdName.trim() && newCmdCommand.trim()) {
                              saveCustomCommands([...quickCustomCommands, { name: newCmdName.trim(), command: newCmdCommand.trim() }]);
                              setNewCmdName('');
                              setNewCmdCommand('');
                              setIsAddingCommand(false);
                            }
                          } else if (e.key === 'Escape') {
                            setIsAddingCommand(false);
                          }
                        }}
                      />
                    </div>
                  )}
                  {quickCustomCommands.length === 0 && !isAddingCommand && (
                    <div className="text-xs text-muted-foreground px-1 py-1">暂无自定义命令</div>
                  )}
                  {quickCustomCommands.map((cmd, i) => (
                    <Tooltip key={i} content={cmd.command}>
                      <div className="flex items-center group min-w-0">
                        <button
                          type="button"
                          onClick={() => handleQuickCommand(cmd.command)}
                          className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-accent transition-colors"
                        >
                          <Play className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate">{cmd.name}</span>
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
              </div>
            )}
          </div>

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
            onClick={() => setShowEnvManager(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="环境变量"
          >
            <Variable className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => { executeCommand('zsh'); }}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="启动 zsh 交互终端"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
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
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            placeholder="输入命令或网址并按 Enter... (↑↓ 历史, Tab 补全)"
            className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />

          {/* / 自定义命令候选列表 */}
          {showSlashCommands && filteredSlashCommands.length > 0 && (
            <div
              ref={slashListRef}
              className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto bg-popover border border-border rounded-lg shadow-lg z-50"
            >
              {filteredSlashCommands.map((cmd, index) => (
                <div
                  key={cmd.name}
                  onClick={() => handleSlashSelect(cmd)}
                  className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer text-sm ${
                    index === slashSelectedIndex ? 'bg-brand/10' : 'hover:bg-accent'
                  }`}
                >
                  <span className="font-mono font-medium text-foreground">/{cmd.name}</span>
                  <span className="flex-1 text-muted-foreground truncate">{cmd.command}</span>
                </div>
              ))}
            </div>
          )}

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
          onClose={() => setShowAliasManager(false)}
          onSave={(newAliases) => setAliases(newAliases)}
        />
      )}

      {/* 放大由各气泡组件内部通过 expandedHeight 实现，无需 portal */}
    </div>
  );
}
