'use client';

import { useState, useCallback } from 'react';
import { Chat } from './Chat';
import { SessionBrowser } from './SessionBrowser';
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { FileBrowserModal } from './FileBrowserModal';
import { SettingsModal } from './SettingsModal';
import { Tooltip } from './Tooltip';

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
  // 初始化标签页
  const [tabs, setTabs] = useState<TabInfo[]>(() => {
    const initialTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd: initialCwd,
      sessionId: initialSessionId,
      title: initialSessionId ? `Session ${initialSessionId.slice(0, 6)}...` : 'New Chat',
    };
    return [initialTab];
  });
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [fileBrowserInitialTab, setFileBrowserInitialTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');

  // 添加新标签页
  const addTab = useCallback((cwd?: string, sessionId?: string, title?: string) => {
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd,
      sessionId,
      title: title || (sessionId ? `Session ${sessionId.slice(0, 6)}...` : 'New Chat'),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

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

  // 更新标签页状态（loading、sessionId）
  const updateTabState = useCallback((tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
    );
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with Tabs */}
        <div className="border-b border-border bg-card">
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-2">
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
            <div className="flex items-center gap-3">
              {/* 文件浏览器按钮 */}
              {initialCwd && (
                <button
                  onClick={() => {
                    setFileBrowserInitialTab('tree');
                    setIsFileBrowserOpen(true);
                  }}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                  title="文件浏览"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </button>
              )}
              {/* Git 变更 按钮 */}
              {initialCwd && (
                <button
                  onClick={() => {
                    setFileBrowserInitialTab('status');
                    setIsFileBrowserOpen(true);
                  }}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                  title="Git 变更"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </button>
              )}
              {/* Git History 按钮 */}
              {initialCwd && (
                <button
                  onClick={() => {
                    setFileBrowserInitialTab('history');
                    setIsFileBrowserOpen(true);
                  }}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                  title="Git 历史"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              )}
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

          {/* Tab bar */}
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

        {/* Chat Content - 每个标签独立渲染 */}
        <div className="flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`h-full ${tab.id === activeTabId ? 'block' : 'hidden'}`}
            >
              <ChatPanel
                tabId={tab.id}
                cwd={tab.cwd}
                sessionId={tab.sessionId}
                onStateChange={updateTabState}
              />
            </div>
          ))}
        </div>
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

      {/* File Browser Modal (includes Git Status and Git History) */}
      {initialCwd && (
        <FileBrowserModal
          isOpen={isFileBrowserOpen}
          onClose={() => setIsFileBrowserOpen(false)}
          cwd={initialCwd}
          initialTab={fileBrowserInitialTab}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}

// 简化的 Chat 面板，不包含 header 和 sidebar
interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => void;
}

function ChatPanel({ tabId, cwd, sessionId, onStateChange }: ChatPanelProps) {
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
      initialCwd={cwd}
      initialSessionId={sessionId}
      hideHeader
      hideSidebar
      onLoadingChange={handleLoadingChange}
      onSessionIdChange={handleSessionIdChange}
      onTitleChange={handleTitleChange}
    />
  );
}
