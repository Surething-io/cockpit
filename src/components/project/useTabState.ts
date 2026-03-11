'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

// ============================================
// Types
// ============================================

export interface TabInfo {
  id: string;
  cwd?: string;
  sessionId?: string;
  title: string;
  isLoading?: boolean;
}

// ============================================
// Hook
// ============================================

interface UseTabStateOptions {
  initialCwd?: string;
  initialSessionId?: string;
  /** 当前视图（agent/explorer/console），用于判断未读：不在 agent 屏时活跃 tab 也标记未读 */
  activeView?: string;
}

export function useTabState({ initialCwd, initialSessionId, activeView }: UseTabStateOptions) {
  // 标记是否已从服务端加载过 sessions
  const hasLoadedRef = useRef(false);
  // 标记是否正在初始化（避免初始化过程中触发保存）
  const isInitializingRef = useRef(true);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  // 初始化标签页（先创建一个临时标签，后续会被服务端数据覆盖）
  const [tabs, setTabs] = useState<TabInfo[]>(() => [{
    id: `tab-${Date.now()}`,
    cwd: initialCwd,
    title: 'New Chat',
  }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);

  // 未读 Tab（会话完成但未切换查看）
  const [unreadTabs, setUnreadTabs] = useState<Set<string>>(new Set());

  // Tab 拖拽状态
  const [dragTabIndex, setDragTabIndex] = useState<number | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

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
            allSessions = [initialSessionId, ...allSessions];
          }

          if (allSessions.length > 0) {
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

            const newActiveTabId = restoredTabs[activeIndex].id;
            setTabs(restoredTabs);
            setActiveTabId(newActiveTabId);

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
    if (isInitializingRef.current || !initialCwd) return;

    const sessionIds = tabs
      .map(tab => tab.sessionId)
      .filter((id): id is string => !!id);

    const activeTab = tabs.find(t => t.id === activeTabId);
    const activeSessionId = activeTab?.sessionId;

    fetch('/api/project-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: initialCwd, sessions: sessionIds, activeSessionId }),
    }).catch(error => {
      console.error('Failed to save sessions:', error);
    });
  }, [tabs, activeTabId, initialCwd]);

  // 切换 Tab 时通知父级 Workspace（由父级统一更新 URL）
  useEffect(() => {
    if (isInitializingRef.current || !initialCwd) return;

    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab?.sessionId) return;

    window.parent.postMessage({
      type: 'SESSION_CHANGE',
      cwd: initialCwd,
      sessionId: activeTab.sessionId,
    }, '*');
  }, [activeTabId, tabs, initialCwd]);

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
        return [...prev, newTab];
      }
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
      if (tabId === activeTabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
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
    setTabs((prev) => {
      const oldTab = prev.find(t => t.id === tabId);
      if (oldTab?.isLoading && updates.isLoading === false) {
        // 非活跃 tab → 标记未读
        // 活跃 tab 但明确不在 agent 屏（在 explorer/console）→ 也标记未读
        // 注意：undefined 视为 agent（默认视图）
        const isOnAgent = !activeViewRef.current || activeViewRef.current === 'agent';
        if (tabId !== activeTabId || !isOnAgent) {
          setUnreadTabs(u => new Set(u).add(tabId));
        }
      }
      return prev.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      );
    });
  }, [activeTabId]);

  // 切回 agent 屏时，清除当前活跃 tab 的未读
  // undefined 视为 agent（默认视图）
  useEffect(() => {
    if (!activeView || activeView === 'agent') {
      setUnreadTabs(u => {
        if (!u.has(activeTabId)) return u;
        const next = new Set(u);
        next.delete(activeTabId);
        return next;
      });
    }
  }, [activeView, activeTabId]);

  // 切换 Tab 并清除未读
  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setUnreadTabs(u => {
      const next = new Set(u);
      next.delete(tabId);
      return next;
    });
  }, []);

  // Tab 拖拽排序
  const handleTabDragStart = useCallback((index: number) => {
    setDragTabIndex(index);
  }, []);

  const handleTabDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragTabIndex !== null && dragTabIndex !== index) {
      setDragOverTabIndex(index);
    }
  }, [dragTabIndex]);

  const handleTabDrop = useCallback((targetIndex: number) => {
    if (dragTabIndex !== null && dragTabIndex !== targetIndex) {
      setTabs((prev) => {
        const newTabs = [...prev];
        const [removed] = newTabs.splice(dragTabIndex, 1);
        newTabs.splice(targetIndex, 0, removed);
        return newTabs;
      });
    }
    setDragTabIndex(null);
    setDragOverTabIndex(null);
  }, [dragTabIndex]);

  const handleTabDragEnd = useCallback(() => {
    setDragTabIndex(null);
    setDragOverTabIndex(null);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return {
    // State
    tabs,
    activeTabId,
    activeTab,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,

    // Tab operations
    addTab,
    closeTab,
    switchTab,
    handleSelectSession,
    handleNewTab,
    handleOpenSession,
    updateTabState,

    // Drag operations
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  };
}
