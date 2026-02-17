'use client';

import { useState, useEffect, useCallback } from 'react';
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { FileBrowserModal } from './FileBrowserModal';
import { BrowserView } from './BrowserView';
import { GitWorktreeModal } from './GitWorktreeModal';
import { TerminalTabManager } from './terminal/TerminalTabManager';
import { ChatProvider } from './ChatContext';
import { SwipeableViewContainer, SwipeableContent, type ViewType } from './SwipeableViewContainer';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { ChatPanel } from './ChatPanel';

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function TabManager({ initialCwd, initialSessionId }: TabManagerProps) {
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
  } = useTabState({ initialCwd, initialSessionId });

  // UI 状态
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isWorktreeOpen, setIsWorktreeOpen] = useState(false);
  const [browserOpenUrl, setBrowserOpenUrl] = useState<string | undefined>(undefined);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [fileBrowserInitialTab, setFileBrowserInitialTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');
  const [tabSwitchTrigger, setTabSwitchTrigger] = useState(0);
  const [activeView, setActiveView] = useState<ViewType>('agent');

  // 加载 Git 仓库信息（分支）
  useEffect(() => {
    if (!initialCwd) return;

    const loadGitInfo = async () => {
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
    };

    loadGitInfo();
  }, [initialCwd]);

  // 键盘快捷键：Cmd+1/2/3/4 切换视图
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (e.key === '1') {
          e.preventDefault();
          setActiveView('agent');
        } else if (e.key === '2') {
          e.preventDefault();
          setActiveView('explorer');
        } else if (e.key === '3') {
          e.preventDefault();
          setActiveView('terminal');
        } else if (e.key === '4') {
          e.preventDefault();
          setActiveView('browser');
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
        const { sessionId } = event.data;
        if (sessionId) {
          handleSelectSession(sessionId);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleSelectSession]);

  // 打开 Git Status 视图
  const handleShowGitStatus = useCallback(() => {
    setFileBrowserInitialTab('status');
    setTabSwitchTrigger(n => n + 1);
    setActiveView('explorer');
  }, []);

  // 打开笔记
  const handleOpenNote = initialCwd ? useCallback(() => {
    window.parent.postMessage({ type: 'OPEN_NOTE', cwd: initialCwd }, '*');
  }, [initialCwd]) : undefined;

  return (
    <ChatProvider>
    <SwipeableViewContainer activeView={activeView} onViewChange={setActiveView}>
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
        />

        {/* 内容区域 - 根据 activeView 切换（滑动效果） */}
        {initialCwd ? (
          <SwipeableContent>
            {/* AGENT 视图：Tab bar + Chat */}
            <div className="w-1/4 h-full flex flex-col overflow-hidden">
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                unreadTabs={unreadTabs}
                dragTabIndex={dragTabIndex}
                dragOverTabIndex={dragOverTabIndex}
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
                      onOpenSession={handleOpenSession}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* EXPLORER 视图：FileBrowser */}
            <div className="w-1/4 h-full overflow-hidden">
              <FileBrowserModal
                onClose={() => setActiveView('agent')}
                cwd={initialCwd}
                initialTab={fileBrowserInitialTab}
                tabSwitchTrigger={tabSwitchTrigger}
              />
            </div>

            {/* TERMINAL 视图：TerminalTabManager */}
            <div className="w-1/4 h-full overflow-hidden">
              <TerminalTabManager initialCwd={initialCwd} />
            </div>

            {/* BROWSER 视图：BrowserView */}
            <div className="w-1/4 h-full overflow-hidden">
              <BrowserView cwd={initialCwd} openUrl={browserOpenUrl} />
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

    </div>
    </SwipeableViewContainer>
    </ChatProvider>
  );
}
