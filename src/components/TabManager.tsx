'use client';

import { useState, useCallback } from 'react';
import { Chat } from './Chat';
import { SessionSidebar } from './SessionSidebar';
import { SessionBrowser } from './SessionBrowser';
import { ProjectSessionsModal } from './ProjectSessionsModal';
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
    <div className="flex h-screen bg-white dark:bg-gray-900">
      {/* Sidebar - 只在有 cwd 时显示 */}
      {initialCwd && (
        <SessionSidebar
          cwd={initialCwd}
          currentSessionId={activeTab?.sessionId || null}
          onSelectSession={handleSelectSession}
          loadingSessionIds={tabs.filter(t => t.isLoading && t.sessionId).map(t => t.sessionId!)}
        />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-2">
              <img src="/icons/icon-72x72.png" alt="Cockpit" className="w-6 h-6" />
              <div className="flex items-baseline gap-2">
                <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Cockpit
                </h1>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  One seat. One AI. Everything under control.
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* 显示项目路径 */}
              {initialCwd && (
                <span
                  className="text-sm text-gray-700 dark:text-gray-300 max-w-md truncate cursor-help"
                  title={`CWD: ${initialCwd}`}
                >
                  {initialCwd}
                </span>
              )}
              {/* 当前项目 Sessions 按钮 */}
              {initialCwd && (
                <button
                  onClick={() => setIsProjectSessionsOpen(true)}
                  className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                  title="Project Sessions"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </button>
              )}
              {/* 全局 Session Browser 按钮 */}
              <button
                onClick={() => setIsSessionBrowserOpen(true)}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                title="Browse All Sessions"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
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
                      ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                      : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
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
                      className="ml-1 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Close tab"
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
              className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
              title="New Tab"
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
