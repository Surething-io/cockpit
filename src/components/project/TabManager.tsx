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
  // activeView 需要在 useTabState 之前声明，因为 useTabState 需要它来判断未读
  const [activeView, setActiveView] = useState<ViewType>('agent');

  // Tab 状态管理
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

  // Pin 状态管理
  const { isPinned, pinSession, unpinSession } = usePinnedSessions();

  // 定时任务
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

  // UI 状态
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isWorktreeOpen, setIsWorktreeOpen] = useState(false);
  const [isAliasManagerOpen, setIsAliasManagerOpen] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [fileBrowserInitialTab, setFileBrowserInitialTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');
  const [tabSwitchTrigger, setTabSwitchTrigger] = useState(0);

  // 从 project-settings 恢复 activeView
  useEffect(() => {
    if (!initialCwd) return;
    fetch(`/api/project-settings?cwd=${encodeURIComponent(initialCwd)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.settings?.activeView) setActiveView(data.settings.activeView);
      })
      .catch(() => {});
  }, [initialCwd]);

  // 截图状态：自动切换 console view + 顶部提示条 + 截图完成后恢复
  const [screenshotActive, setScreenshotActive] = useState(false);
  const preScreenshotViewRef = useRef<ViewType | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { active } = (e as CustomEvent).detail;
      if (active) {
        // 截图开始：保存当前视图，切到 console
        preScreenshotViewRef.current = activeView;
        setActiveView('console');
        setScreenshotActive(true);
      } else {
        // 截图完成：恢复之前的视图
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

  // 切屏时持久化 activeView 并通知父级 Workspace
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

  // 加载 Git 仓库信息（分支）
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

  // 监听 git 变更事件，实时更新分支名
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

  // 键盘快捷键：Cmd+1/2/3/4 切换视图
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

  // 监听父窗口消息（用于 Workspace 切换 session）
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SWITCH_SESSION') {
        const { sessionId, switchToAgent } = event.data;
        if (sessionId) {
          handleSelectSession(sessionId);
          // 从侧边栏（最近会话/常用会话/定时任务）跳转时，自动切到 Agent 视图
          if (switchToAgent) {
            handleViewChange('agent');
          }
          // 红点清除由 useTabState 内部统一处理（switchTab / activeView useEffect）
          // 不在这里直接写 state.json，避免 loading 中的红点被误清
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleSelectSession, handleViewChange, initialCwd]);

  // 打开 Git Status 视图
  const handleShowGitStatus = useCallback(() => {
    setFileBrowserInitialTab('status');
    setTabSwitchTrigger(n => n + 1);
    handleViewChange('explorer');
  }, [handleViewChange]);

  // 打开笔记
  const handleOpenNote = initialCwd ? useCallback(() => {
    window.parent.postMessage({ type: 'OPEN_NOTE', cwd: initialCwd }, '*');
  }, [initialCwd]) : undefined;

  return (
    <ChatProvider>
    <SwipeableViewContainer activeView={activeView} onViewChange={handleViewChange}>
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar - 始终显示 */}
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

        {/* 截图进行中提示条 */}
        {screenshotActive && (
          <div className="flex items-center justify-center gap-2 py-1 bg-brand/15 text-brand text-xs font-medium border-b border-brand/20">
            <span className="animate-pulse">●</span>
            截图中...
          </div>
        )}

        {/* 内容区域 - 根据 activeView 切换（滑动效果） */}
        {initialCwd ? (
          <SwipeableContent>
            {/* AGENT 视图：Tab bar + Chat */}
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
                      onOpenNote={handleOpenNote}
                      onCreateScheduledTask={createScheduledTask}
                      onOpenSession={handleOpenSession}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* EXPLORER 视图：FileBrowser */}
            <div className="w-1/3 h-full overflow-hidden">
              <FileBrowserModal
                onClose={() => handleViewChange('agent')}
                cwd={initialCwd}
                initialTab={fileBrowserInitialTab}
                tabSwitchTrigger={tabSwitchTrigger}
              />
            </div>

            {/* CONSOLE 视图：命令执行 + 浏览器 */}
            <div className="w-1/3 h-full overflow-hidden">
              <ConsoleView cwd={initialCwd} tabId="default" onOpenNote={handleOpenNote} />
            </div>
          </SwipeableContent>
        ) : (
          /* 无 cwd 时，只显示 Tab bar + Chat */
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
