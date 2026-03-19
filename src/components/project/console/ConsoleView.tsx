'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { CommandBubble } from './CommandBubble';
import { EnvManager } from './EnvManager';
import { AliasManager } from '../AliasManager';
import { ConsoleInputBar } from './ConsoleInputBar';
import { ConsoleScrollButtons } from './ConsoleScrollButtons';
import { useConsoleState, type ConsoleItem } from '@/hooks/useConsoleState';
import { interruptCommand as interruptCmd } from '@/lib/terminal/TerminalWsManager';
import { getPlugin } from '@/lib/bubbles';

interface ConsoleViewProps {
  cwd: string;
  initialShellCwd?: string;
  tabId?: string;
  onCwdChange?: (newCwd: string) => void;
  onOpenNote?: () => void;
}

const TOOLBAR_HEIGHT = 41;

export function ConsoleView({ cwd, initialShellCwd, tabId, onCwdChange, onOpenNote }: ConsoleViewProps) {
  const state = useConsoleState({ cwd, initialShellCwd, tabId, onCwdChange });

  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [consoleHeight, setConsoleHeight] = useState(0);
  const [scrollAreaHeight, setScrollAreaHeight] = useState(0);
  const [gridLayout, setGridLayout] = useState(true);
  const [showEnvManager, setShowEnvManager] = useState(false);
  const [showAliasManager, setShowAliasManager] = useState(false);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);

  const terminalRootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const dragEnabledRef = useRef(false);
  const dragItemIdRef = useRef<string | null>(null);
  const dragOverItemIdRef = useRef<string | null>(null);
  const consoleItemsRef = useRef<ConsoleItem[]>([]);
  consoleItemsRef.current = state.consoleItems;

  // ========== 滚动检测 ==========

  const checkIfAtBottom = useCallback(() => {
    const container = state.scrollRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  }, [state.scrollRef]);

  const checkIfAtTop = useCallback(() => {
    const container = state.scrollRef.current;
    if (!container) return true;
    return container.scrollTop < 50;
  }, [state.scrollRef]);

  const handleScroll = useCallback(() => {
    setShowTopButton(!checkIfAtTop());
    setShowBottomButton(!checkIfAtBottom());
  }, [checkIfAtBottom, checkIfAtTop]);

  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // ========== 设置 ==========

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

  useEffect(() => { loadSettings(); }, []);

  // ========== 拖拽排序 ==========

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
    newIds[fromIndex] = toId;
    newIds[toIndex] = fromId;
    state.saveBubbleOrder(newIds);
  }, [state.saveBubbleOrder]);

  // ========== 放大/缩小 ==========

  const toggleMaximize = useCallback((id: string) => {
    setMaximizedId(prev => prev === id ? null : id);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'm' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (state.selectedCommandId) {
          toggleMaximize(state.selectedCommandId);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.selectedCommandId, toggleMaximize]);

  // 跟踪可视区域高度
  useEffect(() => {
    const el = state.scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setScrollAreaHeight(entry.contentRect.height);
    });
    ro.observe(el);
    setScrollAreaHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [state.scrollRef]);

  // 放大第1步：测量可视高度
  useEffect(() => {
    const el = state.scrollRef.current;
    if (!el) return;
    if (maximizedId) {
      setConsoleHeight(el.clientHeight);
    } else {
      el.style.overflow = '';
      setConsoleHeight(0);
    }
    return () => { if (el) el.style.overflow = ''; };
  }, [maximizedId, state.scrollRef]);

  // 放大第2步：滚动到目标 + 锁定
  useEffect(() => {
    const el = state.scrollRef.current;
    if (!el || !maximizedId || !consoleHeight) return;
    const rafId = requestAnimationFrame(() => {
      const bubbleEl = el.querySelector(`[data-bubble-id="${maximizedId}"]`) as HTMLElement | null;
      if (bubbleEl) {
        bubbleEl.scrollIntoView({ block: 'start' });
      }
      el.style.overflow = 'hidden';
    });
    return () => cancelAnimationFrame(rafId);
  }, [maximizedId, consoleHeight, state.scrollRef]);

  // 监听 ChatInput 的终端命令执行事件
  useEffect(() => {
    const handler = (e: Event) => {
      const command = (e as CustomEvent).detail?.command;
      if (command) {
        state.executeCommand(command);
      }
    };
    window.addEventListener('execute-terminal-command', handler);
    return () => window.removeEventListener('execute-terminal-command', handler);
  }, [state.executeCommand]);

  // 气泡 50% 布局
  const bubbleContentHeight = scrollAreaHeight > 0
    ? Math.floor((scrollAreaHeight - 32 - 12) / 2 - TOOLBAR_HEIGHT)
    : undefined;

  return (
    <div ref={terminalRootRef} className="h-full flex flex-col bg-background relative">
      {/* 命令历史区域 */}
      <div ref={state.scrollRef} onScroll={handleScroll} className={`flex-1 overflow-y-auto ${maximizedId ? '' : 'py-4 px-4'}`}>
        {state.consoleItems.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            输入命令或网址开始使用
          </div>
        ) : (
          <>
            <div ref={topRef} />
            {state.hasMoreHistory && (
              <div className="flex justify-center mb-4">
                <button
                  onClick={() => state.loadHistory(state.currentPage + 1)}
                  disabled={state.isLoadingHistory}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors disabled:opacity-50"
                >
                  {state.isLoadingHistory ? '加载中...' : '加载更多历史'}
                </button>
              </div>
            )}
            <div className={maximizedId ? 'flex flex-col gap-3' : gridLayout ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
            {state.consoleItems.map((item) => {
              const dragProps = {
                draggable: true,
                onDragStart: (e: React.DragEvent) => handleDragStart(e, item.data.id),
                onDragOver: (e: React.DragEvent) => handleDragOver(e, item.data.id),
                onDragEnter: handleDragEnter,
                onDragLeave: handleDragLeave,
                onDrop: handleDrop,
                onDragEnd: handleDragEnd,
              };

              if (item.type === 'command') {
                const cmd = item.data as import('@/hooks/useConsoleState').Command;
                return (
                  <div key={cmd.id} data-bubble-id={cmd.id} className="group/cmd rounded-lg transition-shadow" {...dragProps}>
                    <CommandBubble
                      commandId={cmd.id}
                      tabId={tabId}
                      projectCwd={cwd}
                      command={cmd.command}
                      output={cmd.output}
                      exitCode={cmd.exitCode}
                      isRunning={cmd.isRunning}
                      selected={state.selectedCommandId === cmd.id}
                      onSelect={() => { state.setSelectedCommandId(cmd.id); }}
                      onInterrupt={cmd.isRunning ? () => state.interruptCommand(cmd.id) : undefined}
                      onStdin={cmd.isRunning ? (data: string) => state.sendStdin(cmd.id, data) : undefined}
                      onDelete={() => {
                        if (cmd.isRunning && cmd.pid) interruptCmd(cmd.pid);
                        state.deleteCommand(cmd.id);
                      }}
                      onRerun={() => state.rerunCommand(cmd.id)}
                      timestamp={cmd.timestamp}
                      usePty={cmd.usePty}
                      onPtyResize={(cols, rows) => { state.ptySizeRef.current.set(cmd.id, { cols, rows }); state.resizePty(cmd.id, cols, rows); }}
                      onToggleMaximize={() => toggleMaximize(cmd.id)}
                      maximized={maximizedId === cmd.id}
                      expandedHeight={consoleHeight}
                      bubbleContentHeight={bubbleContentHeight}
                      onTitleMouseDown={handleTitleMouseDown}
                    />
                  </div>
                );
              }

              // 插件气泡：从注册表查找 Component
              const plugin = getPlugin(item.type);
              if (!plugin) return null;
              const Comp = plugin.Component;
              const pluginData = item.data as import('@/lib/bubblePlugins').PluginItemBase;
              return (
                <div key={pluginData.id} data-bubble-id={pluginData.id} className="rounded-lg transition-shadow" {...dragProps}>
                  <Comp
                    item={pluginData}
                    selected={state.selectedCommandId === pluginData.id}
                    maximized={maximizedId === pluginData.id}
                    expandedHeight={consoleHeight}
                    bubbleContentHeight={bubbleContentHeight}
                    timestamp={pluginData.timestamp}
                    onSelect={() => { state.setSelectedCommandId(pluginData.id); }}
                    onClose={() => state.closePluginItem(pluginData.id)}
                    onToggleMaximize={() => toggleMaximize(pluginData.id)}
                    onTitleMouseDown={handleTitleMouseDown}
                    extra={{
                      addBrowserItem: (url: string, afterId: string) => state.addPluginItem('browser', url, afterId),
                      initialSleeping: state.sleepingBubbles.has(pluginData.id),
                      onSleep: state.handleBubbleSleep,
                      onWake: state.handleBubbleWake,
                    }}
                  />
                </div>
              );
            })}
            </div>
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* 跳转按钮 */}
      {!maximizedId && state.consoleItems.length > 0 && (
        <ConsoleScrollButtons
          showTop={showTopButton}
          showBottom={showBottomButton}
          onScrollTop={scrollToTop}
          onScrollBottom={state.scrollToBottom}
        />
      )}

      {/* 底部输入区域 */}
      <ConsoleInputBar
        cwd={cwd}
        currentCwd={state.currentCwd}
        commandHistoryRef={state.commandHistoryRef}
        gridLayout={gridLayout}
        onGridLayoutChange={(grid) => { setGridLayout(grid); saveSettings({ gridLayout: grid }); }}
        onExecute={state.executeCommand}
        onAddPluginItem={state.addPluginItem}
        onShowEnvManager={() => setShowEnvManager(true)}
        onOpenZsh={() => state.executeCommand('zsh')}
        onOpenNote={onOpenNote}
      />

      {showEnvManager && (
        <EnvManager
          cwd={cwd}
          tabId={tabId}
          onClose={() => setShowEnvManager(false)}
          onSave={(newEnv) => state.setCustomEnv(newEnv)}
        />
      )}

      {showAliasManager && (
        <AliasManager
          onClose={() => setShowAliasManager(false)}
          onSave={(newAliases) => state.setAliases(newAliases)}
        />
      )}
    </div>
  );
}
