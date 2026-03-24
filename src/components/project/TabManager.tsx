'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { FileBrowserModal } from './FileBrowserModal';
import { GitWorktreeModal } from './GitWorktreeModal';
import { ConsoleView } from './console/ConsoleView';
import { AliasManager } from './AliasManager';
import { ChatProvider } from './ChatContext';
import { SwipeableViewContainer, SwipeableContent, type ViewType } from './SwipeableViewContainer';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { ChatPanel } from './ChatPanel';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePinnedSessions } from '@/hooks/usePinnedSessions';
import { useScheduledTasks } from '@/hooks/useScheduledTasks';

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function TabManager({ initialCwd, initialSessionId }: TabManagerProps) {
  // activeView must be declared before useTabState, as useTabState needs it to determine unread state
  const [activeView, setActiveView] = useState<ViewType>('agent');

  // Tab state management
  const {
    tabs,
    activeTabId,
    activeTab,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,
    closeTab,
    switchTab,
    handleSelectSession,
    handleNewTab,
    handleOpenSession,
    updateTabState,
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

  // Restore activeView from project-settings
  useEffect(() => {
    if (!initialCwd) return;
    fetch(`/api/project-settings?cwd=${encodeURIComponent(initialCwd)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.settings?.activeView) setActiveView(data.settings.activeView);
      })
      .catch(() => {});
  }, [initialCwd]);

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
    fetch('/api/project-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: initialCwd, settings: { activeView: view } }),
    }).catch(() => {});
    window.parent.postMessage({ type: 'VIEW_CHANGE', cwd: initialCwd, view }, '*');
  }, [initialCwd]);

  // Load Git repository info (branch)
  const loadGitInfo = useCallback(async () => {
    if (!initialCwd) return;
    try {
      const response = await fetch(`/api/git/worktree?cwd=${encodeURIComponent(initialCwd)}`);
      if (response.ok) {
        const data = await response.json();
        setIsGitRepo(data.isGitRepo);
        if (data.isGitRepo && data.worktrees.length > 0) {
          const currentWorktree = data.worktrees.find((w: { path: string }) => w.path === initialCwd);
          if (currentWorktree) {
            setCurrentBranch(currentWorktree.branch);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load git info:', error);
    }
  }, [initialCwd]);

  useEffect(() => { loadGitInfo(); }, [loadGitInfo]);

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

  // Keyboard shortcuts: Cmd+1/2/3 to switch views
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
          if (initialCwd && !targetTab?.isLoading) {
            fetch('/api/global-state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cwd: initialCwd, sessionId, status: 'normal' }),
            }).catch(() => {});
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

  // Open note
  const handleOpenNote = initialCwd ? useCallback(() => {
    window.parent.postMessage({ type: 'OPEN_NOTE', cwd: initialCwd }, '*');
  }, [initialCwd]) : undefined;

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
          onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
          onOpenAliasManager={() => setIsAliasManagerOpen(true)}
          onBranchSwitched={loadGitInfo}
        />

        {/* Screenshot in progress banner */}
        {screenshotActive && (
          <div className="flex items-center justify-center gap-2 py-1 bg-brand/15 text-brand text-xs font-medium border-b border-brand/20">
            <span className="animate-pulse">●</span>
            截图中...
          </div>
        )}

        {/* Content area - switches based on activeView (swipe effect) */}
        {initialCwd ? (
          <SwipeableContent>
            {/* AGENT view: Tab bar + Chat */}
            <div className="w-1/3 h-full flex flex-col overflow-hidden">
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
                onNewTab={handleNewTab}
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
                      isActive={tab.id === activeTabId && activeView === 'agent'}
                      onStateChange={updateTabState}
                      onShowGitStatus={handleShowGitStatus}
                      onContentSearch={handleContentSearch}
                      onOpenNote={handleOpenNote}
                      onCreateScheduledTask={createScheduledTask}
                      onOpenSession={handleOpenSession}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* EXPLORER view: FileBrowser */}
            <div className="w-1/3 h-full overflow-hidden">
              <FileBrowserModal
                onClose={() => handleViewChange('agent')}
                cwd={initialCwd}
                initialTab={fileBrowserInitialTab}
                tabSwitchTrigger={tabSwitchTrigger}
                initialSearchQuery={fileBrowserSearchQuery}
                searchQueryTrigger={searchQueryTrigger}
              />
            </div>

            {/* CONSOLE view: command execution + browser */}
            <div className="w-1/3 h-full overflow-hidden">
              <ConsoleView cwd={initialCwd} tabId="default" onOpenNote={handleOpenNote} />
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
              onNewTab={handleNewTab}
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
                    isActive={tab.id === activeTabId}
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

    </div>
    </SwipeableViewContainer>
    </ChatProvider>
  );
}
