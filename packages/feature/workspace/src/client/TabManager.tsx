'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectSessionsModal } from '@cockpit/feature-agent';
import { FileBrowserModal } from '@cockpit/feature-explorer';
import { GitWorktreeModal } from '@cockpit/feature-explorer';
import { HtmlAppsModal } from '@cockpit/feature-explorer';
import { ConsoleView, AliasManager } from '@cockpit/feature-console';
import { ChatProvider, FileDiffViewer } from '@cockpit/feature-agent';
import type { ToolCallInfo } from '@cockpit/feature-agent';
import { SwipeableViewContainer, SwipeableContent, type ViewType } from '@cockpit/shared-ui';
import { PanelPortalProvider } from '@cockpit/shared-ui';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { ChatPanel } from '@cockpit/feature-agent';
import { useWebSocket } from '@cockpit/shared-ui';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { Effect } from 'effect';
import { IframeBus, Topics } from '@cockpit/effect-services';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadProjectSettings,
  saveProjectSettings,
  loadGitWorktrees,
} from './effect/workspaceClient';
import { updateSessionStatus, markScheduledTasksReadBySession } from './effect/stateClient';

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
  /** View to force on mount (from the URL). When set, it overrides the saved project view. */
  initialView?: ViewType;
}

export function TabManager({ initialCwd, initialSessionId, initialView }: TabManagerProps) {
  const { t } = useTranslation();
  // activeView must be declared before useTabState, as useTabState needs it to determine unread state
  const [activeView, setActiveView] = useState<ViewType>(initialView ?? 'agent');

  // Tab state management
  const {
    tabs,
    activeTabId,
    activeTab,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,
    closeTab,
    closeAllTabs,
    switchTab,
    handleSelectSession,
    handleNewTab,
    handleNewClaude2Tab,
    handleNewCodexTab,
    handleNewKimiTab,
    handleNewOllamaTab,
    handleNewDeepseekTab,
    handleOpenSession,
    updateTabState,
    updateTabOllamaModel,
    updateTabDeepseekModel,
    updateTabChatMode,
    updateTabPlanMode,
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  } = useTabState({ initialCwd, initialSessionId, activeView });

  // Pin state management
  const { isPinned, pinSession, unpinSession } = usePinnedSessions();

  // Scheduled tasks
  const { createTask: createScheduledTask } = useScheduledTasks();

  const isTabPinned = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    return tab?.sessionId ? isPinned(tab.sessionId) : false;
  }, [tabs, isPinned]);

  const handleTogglePin = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab?.sessionId) return;
    if (isPinned(tab.sessionId)) {
      unpinSession(tab.sessionId);
    } else {
      pinSession(tab.sessionId, tab.cwd || initialCwd || '', tab.title);
    }
  }, [tabs, isPinned, pinSession, unpinSession, initialCwd]);

  // UI state
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isWorktreeOpen, setIsWorktreeOpen] = useState(false);
  const [isAliasManagerOpen, setIsAliasManagerOpen] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [fileBrowserInitialTab, setFileBrowserInitialTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');
  const [tabSwitchTrigger, setTabSwitchTrigger] = useState(0);
  const [fileBrowserSearchQuery, setFileBrowserSearchQuery] = useState<string | null>(null);
  const [searchQueryTrigger, setSearchQueryTrigger] = useState(0);
  // Message-level "view all file changes": hosted in the Explorer panel (panel 2)
  // as an overlay above the FileBrowser, instead of a full-screen modal. Null =
  // not showing. Setting it also swipes to Explorer (see handleShowFileDiff).
  const [fileDiffRequest, setFileDiffRequest] = useState<{ toolCalls: ToolCallInfo[]; cwd?: string } | null>(null);
  // Forced chat refresh signal: bumped when a SWITCH_SESSION jump targets a session whose
  // tab already exists. Activating an already-active tab produces no isActive rising edge
  // in Chat, so without this a jump from the scheduled-tasks / recent / pinned panels would
  // never re-fetch messages appended externally (e.g. a scheduled-task run).
  const [sessionRefresh, setSessionRefresh] = useState<{ sessionId: string; nonce: number } | null>(null);

  // Restore activeView from project-settings. Skip when the URL forced a view
  // (initialView): a "jump into a session" open must land on the requested view
  // rather than whatever view this project was last left on.
  useEffect(() => {
    if (!initialCwd || initialView) return;
    BrowserRuntime.runPromiseExit(loadProjectSettings(initialCwd)).then((exit) => {
      if (exit._tag === 'Success') {
        const settings = exit.value.settings as { activeView?: ViewType } | undefined;
        if (settings?.activeView) setActiveView(settings.activeView);
      }
    });
  }, [initialCwd, initialView]);

  // Screenshot state: auto-switch to console view + top banner + restore after screenshot completes
  const [screenshotActive, setScreenshotActive] = useState(false);
  const preScreenshotViewRef = useRef<ViewType | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { active } = (e as CustomEvent).detail;
      if (active) {
        // Screenshot started: save current view and switch to console
        preScreenshotViewRef.current = activeView;
        setActiveView('console');
        setScreenshotActive(true);
      } else {
        // Screenshot finished: restore previous view
        setScreenshotActive(false);
        if (preScreenshotViewRef.current && preScreenshotViewRef.current !== 'console') {
          setActiveView(preScreenshotViewRef.current);
        }
        preScreenshotViewRef.current = null;
      }
    };
    window.addEventListener('cockpit-screenshot-state', handler);
    return () => window.removeEventListener('cockpit-screenshot-state', handler);
  }, [activeView]);

  // Persist activeView on panel switch and notify parent Workspace
  const handleViewChange = useCallback((view: ViewType) => {
    setActiveView(view);
    if (!initialCwd) return;
    BrowserRuntime.runFork(
      saveProjectSettings({ cwd: initialCwd, settings: { activeView: view } }).pipe(
        Effect.orElse(() => Effect.void)
      )
    );
    // v2: publish via IframeBus; automatically emits both v1-compat and v2 formats.
    BrowserRuntime.runFork(
      Effect.flatMap(IframeBus, (bus) =>
        bus.publish(Topics.ViewChange, { cwd: initialCwd, view })
      )
    );
  }, [initialCwd]);

  // Swipe to the console panel when another panel asks to open a browser bubble
  // there (chat HTML preview's "open in Console" button). ConsoleView is always
  // mounted and creates the bubble off the same window event; here we just make
  // the console panel visible.
  useEffect(() => {
    const handler = () => handleViewChange('console');
    window.addEventListener('console-open-browser', handler);
    return () => window.removeEventListener('console-open-browser', handler);
  }, [handleViewChange]);

  // HTML-apps launcher. Rendered here (inside the project iframe, same frame as
  // ConsoleView + the console input bar's "HTML" button) — window events don't
  // cross the iframe/parent boundary, so it can't live in the parent Workspace.
  const [isHtmlAppsOpen, setIsHtmlAppsOpen] = useState(false);
  useEffect(() => {
    const handler = () => setIsHtmlAppsOpen(true);
    window.addEventListener('cockpit-open-html-apps', handler);
    return () => window.removeEventListener('cockpit-open-html-apps', handler);
  }, []);

  // Load Git repository info (branch)
  const loadGitInfo = useCallback(async () => {
    if (!initialCwd) return;
    const exit = await BrowserRuntime.runPromiseExit(loadGitWorktrees(initialCwd));
    if (exit._tag === 'Success') {
      const data = exit.value as {
        isGitRepo?: boolean;
        worktrees?: Array<{ path: string; branch: string }>;
      };
      setIsGitRepo(!!data.isGitRepo);
      if (data.isGitRepo && data.worktrees && data.worktrees.length > 0) {
        const currentWorktree = data.worktrees.find((w) => w.path === initialCwd);
        if (currentWorktree) {
          setCurrentBranch(currentWorktree.branch);
        }
      }
    } else {
      console.error('Failed to load git info:', exit.cause);
    }
  }, [initialCwd]);

  useEffect(() => { queueMicrotask(() => loadGitInfo()); }, [loadGitInfo]);

  // Listen for git change events and update branch name in real time
  const handleWatchMessage = useCallback((msg: unknown) => {
    const { data } = msg as { type: string; data: Array<{ type: string }> };
    if (data?.some(e => e.type === 'git')) {
      loadGitInfo();
    }
  }, [loadGitInfo]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(initialCwd || '')}`,
    onMessage: handleWatchMessage,
    enabled: !!initialCwd,
  });

  // Keyboard shortcuts: Cmd+1/2/3 to switch views;
  // also globally swallow Cmd+S so the browser's "Save Page As..." never leaks
  // through on panels without an active editor. When a CodeViewer/FileEditorModal
  // is mounted, it registers its own document-level listener and still receives
  // the event to actually save.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (e.key === '1') {
          e.preventDefault();
          handleViewChange('agent');
        } else if (e.key === '2') {
          e.preventDefault();
          handleViewChange('explorer');
        } else if (e.key === '3') {
          e.preventDefault();
          handleViewChange('console');
        } else if (e.key === 's') {
          // no-op: prevent browser "Save Page As..." default.
          // Editors (CodeViewer/FileEditorModal) handle Cmd+S themselves when open.
          e.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for messages from the parent window (used by Workspace to switch sessions)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SWITCH_SESSION') {
        const { sessionId, switchToAgent } = event.data;
        if (sessionId) {
          handleSelectSession(sessionId);
          // When navigating from sidebar (recent/pinned sessions/scheduled tasks), auto-switch to Agent view
          if (switchToAgent) {
            handleViewChange('agent');
          }
          // User viewed this session → write state.json as normal (skip sessions still loading to avoid clearing the unread indicator prematurely)
          const targetTab = tabs.find(t => t.sessionId === sessionId);
          // Existing tab (possibly already active → no rising edge): force Chat to
          // re-fetch the latest messages from disk. New tabs load history in full anyway.
          if (targetTab) {
            setSessionRefresh(prev => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
          }
          if (initialCwd && !targetTab?.isLoading) {
            BrowserRuntime.runFork(
              updateSessionStatus(initialCwd, sessionId, 'normal').pipe(
                Effect.orElse(() => Effect.void)
              )
            );
            // Also clear scheduled-task unread for this session: jumping in via
            // SWITCH_SESSION (recent/pinned sessions) otherwise never decrements
            // the scheduled-task unread badge — only the scheduled-tasks panel did.
            BrowserRuntime.runFork(
              markScheduledTasksReadBySession(sessionId).pipe(
                Effect.orElse(() => Effect.void)
              )
            );
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleSelectSession, handleViewChange, initialCwd, tabs]);

  // Open the Git Status view
  const handleShowGitStatus = useCallback(() => {
    setFileBrowserInitialTab('status');
    setTabSwitchTrigger(n => n + 1);
    handleViewChange('explorer');
  }, [handleViewChange]);

  // Project-wide content search (triggered from Chat)
  const handleContentSearch = useCallback((query: string) => {
    setFileBrowserSearchQuery(query);
    setSearchQueryTrigger(n => n + 1);
    handleViewChange('explorer');
  }, [handleViewChange]);

  // Same as above but for a search fired from the file-diff overlay: the
  // overlay sits above the FileBrowser (z-20), so it must be dismissed first
  // or the search results stay hidden behind it.
  const handleDiffContentSearch = useCallback((query: string) => {
    setFileDiffRequest(null);
    handleContentSearch(query);
  }, [handleContentSearch]);

  // Message "view all file changes": show the diff in the Explorer panel and
  // swipe there. Re-firing with a new message replaces the content and (re)asserts
  // the Explorer panel — no extra bookkeeping needed for the "already on panel 2,
  // click a new entry" case.
  // Stable onClose for the (memoized) Explorer panel so a chat-tab/session switch
  // — which re-renders TabManager — doesn't re-render the whole FileBrowser subtree.
  const handleExplorerClose = useCallback(() => handleViewChange('agent'), [handleViewChange]);

  const handleShowFileDiff = useCallback((toolCalls: ToolCallInfo[], cwd?: string) => {
    setFileDiffRequest({ toolCalls, cwd });
    handleViewChange('explorer');
  }, [handleViewChange]);

  // Any command that drives the FileBrowser (git status, content search, and any
  // future file-oriented entry) dismisses the diff overlay in one place — so we
  // never have to clear it per entry point. Contract: file-oriented entries bump
  // a trigger counter; handleShowFileDiff deliberately does not, so it survives.
  useEffect(() => {
    setFileDiffRequest(null);
  }, [tabSwitchTrigger, searchQueryTrigger]);

  // Open note
  const handleOpenNote = useCallback(() => {
    if (!initialCwd) return;
    BrowserRuntime.runFork(
      Effect.flatMap(IframeBus, (bus) =>
        bus.publish(Topics.OpenNote, { cwd: initialCwd })
      )
    );
  }, [initialCwd]);

  return (
    <ChatProvider>
    <SwipeableViewContainer activeView={activeView} onViewChange={handleViewChange}>
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar - always visible */}
        <TabManagerTopBar
          initialCwd={initialCwd}
          activeTab={activeTab}
          isGitRepo={isGitRepo}
          currentBranch={currentBranch}
          onOpenWorktree={() => setIsWorktreeOpen(true)}
          onOpenAliasManager={() => setIsAliasManagerOpen(true)}
          onBranchSwitched={loadGitInfo}
        />

        {/* Screenshot in progress banner */}
        {screenshotActive && (
          <div className="flex items-center justify-center gap-2 py-1 bg-brand/15 text-brand text-xs font-medium border-b border-brand/20">
            <span className="animate-pulse">●</span>
            {t('console.screenshotting')}
          </div>
        )}

        {/* Content area - switches based on activeView (swipe effect) */}
        {initialCwd ? (
          <SwipeableContent>
            {/* AGENT view: Tab bar + Chat */}
            <div className="w-1/3 h-full flex flex-col overflow-hidden">
              <PanelPortalProvider>
                <div className="w-full h-full flex flex-col">
                  <TabBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    unreadTabs={unreadTabs}
                    dragTabIndex={dragTabIndex}
                    dragOverTabIndex={dragOverTabIndex}
                    isPinned={isTabPinned}
                    onTogglePin={handleTogglePin}
                    onSwitchTab={switchTab}
                    onCloseTab={closeTab}
                    onCloseAllTabs={closeAllTabs}
                    onNewTab={handleNewTab}
                    onNewClaude2Tab={handleNewClaude2Tab}
                    onNewCodexTab={handleNewCodexTab}
                    onNewKimiTab={handleNewKimiTab}
                    onNewOllamaTab={handleNewOllamaTab}
                    onNewDeepseekTab={handleNewDeepseekTab}
                    onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
                    onDragStart={handleTabDragStart}
                    onDragOver={handleTabDragOver}
                    onDrop={handleTabDrop}
                    onDragEnd={handleTabDragEnd}
                  />
                  <div className="flex-1 overflow-hidden relative">
                    {tabs.map((tab) => (
                      <div
                        key={tab.id}
                        className={`h-full ${tab.id === activeTabId ? 'block' : 'hidden'}`}
                      >
                        <ChatPanel
                          tabId={tab.id}
                          cwd={tab.cwd}
                          sessionId={tab.sessionId}
                          engine={tab.engine}
                          ollamaModel={tab.ollamaModel}
                          onOllamaModelChange={updateTabOllamaModel}
                          deepseekModel={tab.deepseekModel}
                          onDeepseekModelChange={updateTabDeepseekModel}
                          chatMode={tab.chatMode}
                          onChatModeChange={updateTabChatMode}
                          planMode={tab.planMode}
                          onPlanModeChange={updateTabPlanMode}
                          isActive={tab.id === activeTabId && activeView === 'agent'}
                          refreshSignal={sessionRefresh}
                          onStateChange={updateTabState}
                          onShowGitStatus={handleShowGitStatus}
                          onContentSearch={handleContentSearch}
                          onShowFileDiff={handleShowFileDiff}
                          onOpenNote={handleOpenNote}
                          onCreateScheduledTask={createScheduledTask}
                          onOpenSession={handleOpenSession}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </PanelPortalProvider>
            </div>

            {/* EXPLORER view: FileBrowser (+ optional message file-diff overlay) */}
            <div className="w-1/3 h-full overflow-hidden relative">
              <PanelPortalProvider>
                <FileBrowserModal
                  onClose={handleExplorerClose}
                  cwd={initialCwd}
                  initialTab={fileBrowserInitialTab}
                  tabSwitchTrigger={tabSwitchTrigger}
                  initialSearchQuery={fileBrowserSearchQuery}
                  searchQueryTrigger={searchQueryTrigger}
                />
                {/* Message "view all file changes": overlays the FileBrowser (kept
                    mounted underneath). Close stays on this panel — no swipe back. */}
                {fileDiffRequest && (
                  <div
                    className="absolute inset-0 z-20 flex bg-black/50 p-[4vmin]"
                    onClick={() => setFileDiffRequest(null)}
                  >
                    <FileDiffViewer
                      // Switching to a different message must reset the viewer
                      // (first commit / first file, or empty state) — key on the
                      // tool-call identity forces a fresh mount per message while
                      // leaving same-message refetches (stable key) untouched.
                      key={fileDiffRequest.toolCalls.map((tc) => tc.id).filter(Boolean).join(',')}
                      toolCalls={fileDiffRequest.toolCalls}
                      cwd={fileDiffRequest.cwd}
                      onClose={() => setFileDiffRequest(null)}
                      onContentSearch={handleDiffContentSearch}
                    />
                  </div>
                )}
              </PanelPortalProvider>
            </div>

            {/* CONSOLE view: command execution + browser */}
            <div className="w-1/3 h-full overflow-hidden">
              <PanelPortalProvider>
                <ConsoleView cwd={initialCwd} tabId="default" onOpenNote={handleOpenNote} />
              </PanelPortalProvider>
            </div>
          </SwipeableContent>
        ) : (
          /* When no cwd is set, only show Tab bar + Chat */
          <div className="flex-1 flex flex-col overflow-hidden">
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              unreadTabs={unreadTabs}
              dragTabIndex={dragTabIndex}
              dragOverTabIndex={dragOverTabIndex}
              isPinned={isTabPinned}
              onTogglePin={handleTogglePin}
              onSwitchTab={switchTab}
              onCloseTab={closeTab}
              onCloseAllTabs={closeAllTabs}
              onNewTab={handleNewTab}
              onNewClaude2Tab={handleNewClaude2Tab}
              onNewCodexTab={handleNewCodexTab}
              onNewKimiTab={handleNewKimiTab}
              onNewDeepseekTab={handleNewDeepseekTab}
              onDragStart={handleTabDragStart}
              onDragOver={handleTabDragOver}
              onDrop={handleTabDrop}
              onDragEnd={handleTabDragEnd}
            />
            <div className="flex-1 overflow-hidden relative">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`h-full ${tab.id === activeTabId ? 'block' : 'hidden'}`}
                >
                  <ChatPanel
                    tabId={tab.id}
                    cwd={tab.cwd}
                    sessionId={tab.sessionId}
                    engine={tab.engine}
                    ollamaModel={tab.ollamaModel}
                    onOllamaModelChange={updateTabOllamaModel}
                    deepseekModel={tab.deepseekModel}
                    onDeepseekModelChange={updateTabDeepseekModel}
                    chatMode={tab.chatMode}
                    onChatModeChange={updateTabChatMode}
                    planMode={tab.planMode}
                    onPlanModeChange={updateTabPlanMode}
                    isActive={tab.id === activeTabId}
                    refreshSignal={sessionRefresh}
                    onStateChange={updateTabState}
                    onCreateScheduledTask={createScheduledTask}
                    onOpenSession={handleOpenSession}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Project Sessions Modal */}
      {initialCwd && (
        <ProjectSessionsModal
          isOpen={isProjectSessionsOpen}
          onClose={() => setIsProjectSessionsOpen(false)}
          cwd={initialCwd}
          onSelectSession={handleSelectSession}
        />
      )}

      {/* Git Worktree Modal */}
      {initialCwd && isGitRepo && (
        <GitWorktreeModal
          isOpen={isWorktreeOpen}
          onClose={() => setIsWorktreeOpen(false)}
          cwd={initialCwd}
        />
      )}

      {/* Alias Manager Modal */}
      {isAliasManagerOpen && (
        <AliasManager
          onClose={() => setIsAliasManagerOpen(false)}
          onSave={() => setIsAliasManagerOpen(false)}
        />
      )}

      {/* HTML apps launcher (opened from the console input bar's leading AppWindow button) */}
      <HtmlAppsModal
        isOpen={isHtmlAppsOpen}
        onClose={() => setIsHtmlAppsOpen(false)}
      />

    </div>
    </SwipeableViewContainer>
    </ChatProvider>
  );
}
