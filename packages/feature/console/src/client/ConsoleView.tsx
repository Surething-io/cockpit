'use client';

import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ConsoleBubbleRow } from './ConsoleBubbleRow';
import { EnvManager } from './EnvManager';
import { AliasManager } from './AliasManager';
import { ConsoleInputBar } from './ConsoleInputBar';
import { ConsoleScrollButtons } from './ConsoleScrollButtons';
import { useConsoleState, type ConsoleItem } from './useConsoleState';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { Effect } from 'effect';
import {
  loadProjectSettings,
  saveProjectSettings,
} from './effect/consoleClient';

interface ConsoleViewProps {
  cwd: string;
  initialShellCwd?: string;
  tabId?: string;
  onCwdChange?: (newCwd: string) => void;
  onOpenNote?: () => void;
}

const TOOLBAR_HEIGHT = 41;

// Empty-state guide: supported bubble types and how to trigger each.
// `label` is an i18n key; `triggers` are literal examples shown as code chips.
const BUBBLE_GUIDE: { key: string; label: string; triggers: string[]; notes?: string[] }[] = [
  { key: 'command', label: 'console.bubbleCommand', triggers: ['ls', 'git status', 'npm run dev'] },
  { key: 'pty', label: 'console.bubbleInteractive', triggers: ['zsh', 'vim', 'python', 'top'] },
  { key: 'browser', label: 'console.bubbleBrowser', triggers: ['https://…', '*.html', '*.md', '*.png', '*.pdf', '*.json'], notes: ['console.bubbleBrowserNoteIframe', 'console.bubbleBrowserNoteCookie'] },
  { key: 'database', label: 'console.bubbleDatabase', triggers: ['postgresql://', 'mysql://', 'redis://', 'neo4j://'] },
  { key: 'notebook', label: 'console.bubbleNotebook', triggers: ['*.ipynb'] },
];

function ConsoleViewImpl({ cwd, initialShellCwd, tabId, onCwdChange, onOpenNote }: ConsoleViewProps) {
  const { t } = useTranslation();
  const state = useConsoleState({ cwd, initialShellCwd, tabId, onCwdChange });
  const {
    consoleItems, scrollRef: stateScrollRef, selectedCommandId, setSelectedCommandId,
    interruptCommand, sendStdin, deleteCommand, rerunCommand, ptySizeRef, resizePty,
    executeCommand: stateExecuteCommand, addPluginItem, closePluginItem,
    sleepingBubbles, handleBubbleSleep, handleBubbleWake,
    scrollToBottom, currentCwd, commandHistoryRef, setCustomEnv, setAliases,
    saveBubbleOrder, hasMoreHistory, loadHistory, currentPage, isLoadingHistory,
    subscribePtyOutput,
    subscribePtyReset,
    subscribePtyRefresh,
  } = state;

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
  useEffect(() => { consoleItemsRef.current = consoleItems; }, [consoleItems]);

  // ========== Scroll detection ==========

  const checkIfAtBottom = useCallback(() => {
    const container = stateScrollRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  }, [stateScrollRef]);

  const checkIfAtTop = useCallback(() => {
    const container = stateScrollRef.current;
    if (!container) return true;
    return container.scrollTop < 50;
  }, [stateScrollRef]);

  const handleScroll = useCallback(() => {
    setShowTopButton(!checkIfAtTop());
    setShowBottomButton(!checkIfAtBottom());
  }, [checkIfAtBottom, checkIfAtTop]);

  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // ========== Settings ==========

  const loadSettings = async () => {
    const exit = await BrowserRuntime.runPromiseExit(loadProjectSettings(cwd));
    if (exit._tag === 'Success') {
      const settings = exit.value.settings as { gridLayout?: unknown } | undefined;
      if (settings?.gridLayout !== undefined) {
        setGridLayout(settings.gridLayout as typeof gridLayout);
      }
    } else {
      console.error('Failed to load project settings:', exit.cause);
    }
  };

  const saveSettings = (settings: Record<string, unknown>) => {
    BrowserRuntime.runFork(
      saveProjectSettings({ cwd, settings }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => console.error('Failed to save project settings:', err))
        ),
        Effect.orElse(() => Effect.void)
      )
    );
  };

  useEffect(() => { queueMicrotask(() => loadSettings()); }, []);

  // ========== Drag-to-reorder ==========

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
    saveBubbleOrder(newIds);
  }, [saveBubbleOrder]);

  // ========== Maximize/minimize ==========

  const toggleMaximize = useCallback((id: string) => {
    setMaximizedId(prev => prev === id ? null : id);
  }, []);

  // Stable wrapper so ConsoleBubbleRow's `extra` doesn't churn each render.
  const addBrowserItem = useCallback(
    (url: string, afterId: string) => addPluginItem('browser', url, afterId),
    [addPluginItem],
  );

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

  // Track visible area height
  useEffect(() => {
    const el = stateScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setScrollAreaHeight(entry.contentRect.height);
    });
    ro.observe(el);
    setScrollAreaHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [stateScrollRef]);

  // Maximize step 1: measure visible height
  const scrollRef = stateScrollRef;
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
  }, [maximizedId, scrollRef]);

  // Maximize step 2: scroll to target + lock
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !maximizedId || !consoleHeight) return;
    const rafId = requestAnimationFrame(() => {
      const bubbleEl = el.querySelector(`[data-bubble-id="${maximizedId}"]`) as HTMLElement | null;
      if (bubbleEl) {
        bubbleEl.scrollIntoView({ block: 'start' });
      }
      el.style.overflow = 'hidden';
    });
    return () => cancelAnimationFrame(rafId);
  }, [maximizedId, consoleHeight, scrollRef]);

  // Listen for terminal command execution events from ChatInput
  const executeCommand = stateExecuteCommand;
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

  // Open a browser bubble from another panel (e.g. chat's HTML preview modal's
  // "open in Console" button). TabManager handles the swipe to this panel; we
  // just create the bubble. Local file paths and http(s) URLs both go as `url`.
  useEffect(() => {
    const handler = (e: Event) => {
      const url = (e as CustomEvent).detail?.url;
      if (url) addPluginItem('browser', url);
    };
    window.addEventListener('console-open-browser', handler);
    return () => window.removeEventListener('console-open-browser', handler);
  }, [addPluginItem]);

  // Bubble 50% layout
  const bubbleContentHeight = scrollAreaHeight > 0
    ? Math.floor((scrollAreaHeight - 32 - 12) / 2 - TOOLBAR_HEIGHT)
    : undefined;

  return (
    <div ref={terminalRootRef} className="h-full flex flex-col bg-background relative">
      {/* Command history area */}
      <div ref={stateScrollRef} onScroll={handleScroll} className={`console-scroll-root flex-1 overflow-y-auto ${maximizedId ? '' : 'py-4 px-4'}`}>
        {consoleItems.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-md flex flex-col gap-4 text-sm">
              <p className="text-muted-foreground">{t('console.emptyIntro')}</p>
              <ul className="flex flex-col gap-2">
                {BUBBLE_GUIDE.map((b) => (
                  <li key={b.key} className="flex items-start gap-3">
                    <span className="w-16 flex-shrink-0 text-foreground font-medium">{t(b.label)}</span>
                    <span className="flex-1 flex flex-col gap-1">
                      <span className="flex flex-wrap gap-1">
                        {b.triggers.map((tr) => (
                          <code key={tr} className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono text-muted-foreground">{tr}</code>
                        ))}
                      </span>
                      {b.notes?.map((n) => (
                        <span key={n} className="text-xs leading-snug text-muted-foreground/70">{t(n)}</span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => stateExecuteCommand('zsh')}
                title={t('console.launchZsh')}
                className="self-start flex items-center gap-2 px-4 py-2 rounded-lg border border-input bg-background text-sm text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 transition-all"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                New PTY
              </button>
            </div>
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
                  {isLoadingHistory ? t('console.loadingMore') : t('console.loadMoreHistory')}
                </button>
              </div>
            )}
            <div className={maximizedId ? 'flex flex-col gap-3' : gridLayout ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
            {consoleItems.map((item) => (
              <ConsoleBubbleRow
                key={item.data.id}
                item={item}
                selected={selectedCommandId === item.data.id}
                maximized={maximizedId === item.data.id}
                initialSleeping={sleepingBubbles.has(item.data.id)}
                tabId={tabId}
                projectCwd={cwd}
                expandedHeight={consoleHeight}
                bubbleContentHeight={bubbleContentHeight}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onSelectId={setSelectedCommandId}
                onInterruptId={interruptCommand}
                onStdin={sendStdin}
                onDeleteCommand={deleteCommand}
                onRerun={rerunCommand}
                subscribePtyOutput={subscribePtyOutput}
                subscribePtyReset={subscribePtyReset}
                subscribePtyRefresh={subscribePtyRefresh}
                ptySizeRef={ptySizeRef}
                resizePty={resizePty}
                onToggleMaximizeId={toggleMaximize}
                onTitleMouseDown={handleTitleMouseDown}
                onClosePlugin={closePluginItem}
                addBrowserItem={addBrowserItem}
                onSleep={handleBubbleSleep}
                onWake={handleBubbleWake}
              />
            ))}
            </div>
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Jump buttons */}
      {!maximizedId && consoleItems.length > 0 && (
        <ConsoleScrollButtons
          showTop={showTopButton}
          showBottom={showBottomButton}
          onScrollTop={scrollToTop}
          onScrollBottom={scrollToBottom}
        />
      )}

      {/* Bottom input area */}
      <ConsoleInputBar
        cwd={cwd}
        currentCwd={currentCwd}
        commandHistoryRef={commandHistoryRef}
        gridLayout={gridLayout}
        onGridLayoutChange={(grid) => { setGridLayout(grid); saveSettings({ gridLayout: grid }); }}
        onExecute={stateExecuteCommand}
        onAddPluginItem={addPluginItem}
        onShowEnvManager={() => setShowEnvManager(true)}
        onOpenZsh={() => stateExecuteCommand('zsh')}
        onOpenNote={onOpenNote}
      />

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
    </div>
  );
}

// Memoized: always mounted next to Chat/Explorer, so a chat switch re-renders
// TabManager. Props (cwd, tabId, stable onOpenNote) don't change on a switch,
// so memo keeps the terminal/browser-bubble subtree from re-rendering.
export const ConsoleView = memo(ConsoleViewImpl);
