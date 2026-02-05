'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Chat } from './Chat';
import { SessionBrowser } from './SessionBrowser';
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { FileBrowserModal } from './FileBrowserModal';
import { BrowserView } from './BrowserView';
import { SettingsModal } from './SettingsModal';
import { GitWorktreeModal } from './GitWorktreeModal';
import { Tooltip } from './Tooltip';
import { ChatProvider } from './ChatContext';
import { GlobalSessionMonitor } from './GlobalSessionMonitor';
import { ServicePanel } from './ServicePanel';
import { SwipeableViewContainer, SwipeableContent, ViewSwitcherBar, type ViewType } from './SwipeableViewContainer';
import { toast } from './Toast';

interface TabInfo {
  id: string;
  cwd?: string;
  sessionId?: string;
  title: string;
  isLoading?: boolean;
}

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function TabManager({ initialCwd, initialSessionId }: TabManagerProps) {
  // 标记是否已从服务端加载过 sessions
  const hasLoadedRef = useRef(false);
  // 标记是否正在初始化（避免初始化过程中触发保存）
  const isInitializingRef = useRef(true);

  // 初始化标签页（先创建一个临时标签，后续会被服务端数据覆盖）
  const [tabs, setTabs] = useState<TabInfo[]>(() => [{
    id: `tab-${Date.now()}`,
    cwd: initialCwd,
    title: 'New Chat',
  }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);

  // 从服务端加载保存的 sessions，并与 URL 参数合并
  useEffect(() => {
    if (!initialCwd || hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const loadSessions = async () => {
      try {
        const response = await fetch(`/api/project-state?cwd=${encodeURIComponent(initialCwd)}`);
        if (response.ok) {
          const data = await response.json();
          const savedSessions: string[] = data.sessions || [];
          const savedActiveSessionId: string | undefined = data.activeSessionId;

          // 合并 URL sessionId 和 session.json 中的 sessions（去重）
          let allSessions = [...savedSessions];
          if (initialSessionId && !allSessions.includes(initialSessionId)) {
            // URL 的 sessionId 放到最前面
            allSessions = [initialSessionId, ...allSessions];
          }

          if (allSessions.length > 0) {
            // 恢复 tabs
            const restoredTabs: TabInfo[] = allSessions.map((sessionId: string, index: number) => ({
              id: `tab-${Date.now()}-${index}`,
              cwd: initialCwd,
              sessionId,
              title: `Session ${sessionId.slice(0, 6)}...`,
            }));

            // 激活优先级：URL sessionId > session.json activeSessionId > 第一个
            let activeSessionToUse = initialSessionId || savedActiveSessionId;
            let activeIndex = activeSessionToUse ? allSessions.indexOf(activeSessionToUse) : -1;
            if (activeIndex < 0) activeIndex = 0;

            // 同时更新 tabs 和 activeTabId
            const newActiveTabId = restoredTabs[activeIndex].id;
            setTabs(restoredTabs);
            setActiveTabId(newActiveTabId);

            // 延迟结束初始化状态，确保 React 有时间处理 state 更新
            // 这样 URL 更新 useEffect 才能拿到正确的 tabs 和 activeTabId
            setTimeout(() => {
              isInitializingRef.current = false;
            }, 0);
          } else {
            isInitializingRef.current = false;
          }
        }
      } catch (error) {
        console.error('Failed to load sessions:', error);
        isInitializingRef.current = false;
      }
    };

    loadSessions();
  }, [initialCwd, initialSessionId]);

  // 当 tabs 或 activeTabId 变化时保存到服务端
  useEffect(() => {
    // 初始化过程中不保存
    if (isInitializingRef.current || !initialCwd) return;

    // 收集所有有 sessionId 的 tab
    const sessionIds = tabs
      .map(tab => tab.sessionId)
      .filter((id): id is string => !!id);

    // 获取当前激活 Tab 的 sessionId
    const activeTab = tabs.find(t => t.id === activeTabId);
    const activeSessionId = activeTab?.sessionId;

    // 保存到服务端（包含 activeSessionId）
    fetch('/api/project-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: initialCwd, sessions: sessionIds, activeSessionId }),
    }).catch(error => {
      console.error('Failed to save sessions:', error);
    });
  }, [tabs, activeTabId, initialCwd]);

  // 切换 Tab 时更新 URL（使用 replaceState 避免产生浏览器历史记录）
  useEffect(() => {
    // 初始化过程中不更新 URL
    if (isInitializingRef.current || !initialCwd) return;

    const activeTab = tabs.find(t => t.id === activeTabId);
    // 确保 activeTab 存在且有 sessionId
    // 额外检查：activeTabId 必须存在于当前 tabs 中（避免竞态条件）
    if (!activeTab) return;

    if (activeTab.sessionId) {
      const url = new URL(window.location.href);
      url.searchParams.set('sessionId', activeTab.sessionId);
      window.history.replaceState({}, '', url.toString());
    }
  }, [activeTabId, tabs, initialCwd]);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isWorktreeOpen, setIsWorktreeOpen] = useState(false);
  const [isServicePanelOpen, setIsServicePanelOpen] = useState(false);
  const [runningServicesCount, setRunningServicesCount] = useState(0);
  const [browserOpenUrl, setBrowserOpenUrl] = useState<string | undefined>(undefined);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [fileBrowserInitialTab, setFileBrowserInitialTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');
  // 用于强制触发 tab 切换（解决重复点击同一 tab 时 useEffect 不触发的问题）
  const [tabSwitchTrigger, setTabSwitchTrigger] = useState(0);
  // 视图切换状态：agent (Chat), explorer (FileBrowser), browser (BrowserView)
  const [activeView, setActiveView] = useState<ViewType>('agent');

  // 添加新标签页（插入到当前标签的右边）
  const addTab = useCallback((cwd?: string, sessionId?: string, title?: string) => {
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd,
      sessionId,
      title: title || (sessionId ? `Session ${sessionId.slice(0, 6)}...` : 'New Chat'),
    };
    setTabs((prev) => {
      const currentIndex = prev.findIndex((t) => t.id === activeTabId);
      if (currentIndex === -1) {
        // 没有当前标签，添加到末尾
        return [...prev, newTab];
      }
      // 插入到当前标签的右边
      const newTabs = [...prev];
      newTabs.splice(currentIndex + 1, 0, newTab);
      return newTabs;
    });
    setActiveTabId(newTab.id);
  }, [activeTabId]);

  // 关闭标签页
  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      // 如果关闭的是当前激活的标签，切换到最后一个标签
      if (tabId === activeTabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
      // 至少保留一个标签
      if (newTabs.length === 0) {
        const newTab: TabInfo = {
          id: `tab-${Date.now()}`,
          cwd: initialCwd,
          title: 'New Chat',
        };
        setActiveTabId(newTab.id);
        return [newTab];
      }
      return newTabs;
    });
  }, [activeTabId, initialCwd]);

  // 处理侧边栏点击 session - 添加新标签
  const handleSelectSession = useCallback((sid: string, title?: string) => {
    // 检查是否已经有这个 session 的标签
    const existingTab = tabs.find((t) => t.sessionId === sid);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      addTab(initialCwd, sid, title);
    }
  }, [tabs, initialCwd, addTab]);

  // 新建空白标签
  const handleNewTab = useCallback(() => {
    addTab(initialCwd);
  }, [initialCwd, addTab]);

  // 打开新 session（用于 Fork，总是创建新标签）
  const handleOpenSession = useCallback((sid: string, title?: string) => {
    addTab(initialCwd, sid, title);
  }, [initialCwd, addTab]);

  // 更新标签页状态（loading、sessionId）
  const updateTabState = useCallback((tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
    );
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

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
            // 找到当前 cwd 对应的 worktree
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

  // 轮询运行中的服务数量（每3秒）
  useEffect(() => {
    if (!initialCwd) return;

    const loadServicesCount = async () => {
      try {
        const res = await fetch(`/api/services/status?cwd=${encodeURIComponent(initialCwd)}`);
        if (res.ok) {
          const data = await res.json();
          // 只统计当前项目的服务数量
          const count = data.filter((s: { cwd: string }) => s.cwd === initialCwd).length;
          setRunningServicesCount(count);
        }
      } catch (error) {
        console.error('Failed to load services count:', error);
      }
    };

    loadServicesCount();
    const timer = setInterval(loadServicesCount, 3000);

    return () => clearInterval(timer);
  }, [initialCwd]);

  // 键盘快捷键：Cmd+1/2/3 切换视图
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
          setActiveView('browser');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Top bar 组件（主标题栏，始终显示）
  const TopBar = (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center justify-between px-4 py-2 relative">
        {/* 左侧：Logo + 项目路径 + Git 分支 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img src="/icons/icon-72x72.png" alt="Cockpit" className="w-6 h-6" />
            {initialCwd ? (
              <span
                className="text-sm text-foreground max-w-md truncate cursor-help"
                title={`CWD: ${initialCwd}`}
              >
                {initialCwd}
              </span>
            ) : (
              <h1 className="text-lg font-semibold text-foreground">
                Cockpit
              </h1>
            )}
          </div>
          {/* Git Worktree 按钮 */}
          {isGitRepo && (
            <button
              onClick={() => setIsWorktreeOpen(true)}
              className="flex items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title="Git Worktrees"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0l-4-4m4 4l-4 4M3 7v6a4 4 0 004 4h5" />
              </svg>
              <span className="text-sm">{currentBranch || 'main'}</span>
            </button>
          )}
        </div>

        {/* 中间：视图切换按钮 - 绝对定位居中 */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ViewSwitcherBar />
        </div>

        {/* 右侧：会话相关 + 设置 */}
        <div className="flex items-center gap-2">
          {/* 全局会话监控（运行中的会话） */}
          <GlobalSessionMonitor currentCwd={activeTab?.cwd} onSwitchSession={handleSelectSession} />
          {/* 当前项目 Sessions 按钮 */}
          {initialCwd && (
            <button
              onClick={() => setIsProjectSessionsOpen(true)}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title="项目会话"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>
          )}
          {/* 全局 Session Browser 按钮 */}
          <button
            onClick={() => setIsSessionBrowserOpen(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="浏览所有会话"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </button>
          {/* Cursor 打开按钮 */}
          <button
            onClick={async () => {
              if (activeTab?.cwd) {
                try {
                  await fetch('/api/open-cursor', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cwd: activeTab.cwd }),
                  });
                } catch {
                  // 忽略错误
                }
              }
            }}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="在 Cursor 中打开"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.5 2L20.5 12L4.5 22V2Z" />
            </svg>
          </button>
          {/* 后台服务按钮 */}
          <button
            onClick={() => setIsServicePanelOpen(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors relative"
            title="后台服务"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            {runningServicesCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-9 text-white text-xs font-medium rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                {runningServicesCount}
              </span>
            )}
          </button>
          {/* 复制 claude -r 命令按钮 */}
          {activeTab?.sessionId && (
            <button
              onClick={() => {
                const command = `claude -r ${activeTab.sessionId}`;
                navigator.clipboard.writeText(command).then(() => {
                  toast('已复制: ' + command, 'success');
                });
              }}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title={`复制命令: claude -r ${activeTab.sessionId}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          )}
          {/* 设置按钮 */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="设置"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );

  // Tab bar 组件（标签页，仅在 AGENT 视图显示）
  const TabBar = (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center px-2 gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <Tooltip key={tab.id} content={tab.title} delay={200}>
            <div
              className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer rounded-t-lg transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-secondary'
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.isLoading && (
                <span className="inline-block w-3 h-3 border-2 border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
              )}
              <span className="max-w-32 truncate">{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="ml-1 p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="关闭标签"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </Tooltip>
        ))}
        {/* 新建标签按钮 */}
        <button
          onClick={handleNewTab}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          title="新建标签"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <ChatProvider>
    <SwipeableViewContainer activeView={activeView} onViewChange={setActiveView}>
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar - 始终显示 */}
        {TopBar}

        {/* 内容区域 - 根据 activeView 切换（滑动效果） */}
        {initialCwd ? (
          <SwipeableContent>
            {/* AGENT 视图：Tab bar + Chat */}
            <div className="w-1/3 h-full flex flex-col overflow-hidden">
              {TabBar}
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
                      onShowGitStatus={() => {
                        setFileBrowserInitialTab('status');
                        setTabSwitchTrigger(n => n + 1);
                        setActiveView('explorer');
                      }}
                      onOpenSession={handleOpenSession}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* EXPLORER 视图：FileBrowser */}
            <div className="w-1/3 h-full overflow-hidden">
              <FileBrowserModal
                onClose={() => setActiveView('agent')}
                cwd={initialCwd}
                initialTab={fileBrowserInitialTab}
                tabSwitchTrigger={tabSwitchTrigger}
              />
            </div>

            {/* BROWSER 视图：BrowserView */}
            <div className="w-1/3 h-full overflow-hidden">
              <BrowserView cwd={initialCwd} openUrl={browserOpenUrl} />
            </div>
          </SwipeableContent>
        ) : (
          /* 无 cwd 时，只显示 Tab bar + Chat（不需要滑动） */
          <div className="flex-1 flex flex-col overflow-hidden">
            {TabBar}
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

      {/* Session Browser Modal */}
      <SessionBrowser
        isOpen={isSessionBrowserOpen}
        onClose={() => setIsSessionBrowserOpen(false)}
      />

      {/* Project Sessions Modal */}
      {initialCwd && (
        <ProjectSessionsModal
          isOpen={isProjectSessionsOpen}
          onClose={() => setIsProjectSessionsOpen(false)}
          cwd={initialCwd}
          onSelectSession={handleSelectSession}
        />
      )}


      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* Git Worktree Modal */}
      {initialCwd && isGitRepo && (
        <GitWorktreeModal
          isOpen={isWorktreeOpen}
          onClose={() => setIsWorktreeOpen(false)}
          cwd={initialCwd}
        />
      )}

      {/* Service Panel */}
      <ServicePanel
        isOpen={isServicePanelOpen}
        onClose={() => setIsServicePanelOpen(false)}
        initialCwd={initialCwd}
        onOpenBrowser={(url) => {
          // 关闭服务面板
          setIsServicePanelOpen(false);
          // 切换到 BROWSER 视图
          setActiveView('browser');
          // 传递 URL 给 BrowserView
          setBrowserOpenUrl(url);
        }}
      />
    </div>
    </SwipeableViewContainer>
    </ChatProvider>
  );
}

// 简化的 Chat 面板，不包含 header 和 sidebar
interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  isActive?: boolean; // Tab 是否激活
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => void;
  onShowGitStatus?: () => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
}

function ChatPanel({ tabId, cwd, sessionId, isActive, onStateChange, onShowGitStatus, onOpenSession }: ChatPanelProps) {
  // 使用 useCallback 稳定回调函数引用，避免无限循环
  const handleLoadingChange = useCallback((isLoading: boolean) => {
    onStateChange(tabId, { isLoading });
  }, [tabId, onStateChange]);

  const handleSessionIdChange = useCallback((newSessionId: string) => {
    onStateChange(tabId, { sessionId: newSessionId });
  }, [tabId, onStateChange]);

  const handleTitleChange = useCallback((title: string) => {
    onStateChange(tabId, { title });
  }, [tabId, onStateChange]);

  return (
    <Chat
      tabId={tabId}
      initialCwd={cwd}
      initialSessionId={sessionId}
      hideHeader
      hideSidebar
      isActive={isActive}
      onLoadingChange={handleLoadingChange}
      onSessionIdChange={handleSessionIdChange}
      onTitleChange={handleTitleChange}
      onShowGitStatus={onShowGitStatus}
      onOpenSession={onOpenSession}
    />
  );
}
