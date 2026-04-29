'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { usePageVisible } from '@/hooks/usePageVisible';

// ============================================
// Types
// ============================================

export type ChatEngine = 'claude' | 'claude2' | 'codex' | 'kimi' | 'ollama' | 'deepseek';

export type DeepseekModel = 'deepseek-v4-flash' | 'deepseek-v4-pro';

export interface TabInfo {
  id: string;
  cwd?: string;
  sessionId?: string;
  title: string;
  isLoading?: boolean;
  engine?: ChatEngine;
  ollamaModel?: string;
  deepseekModel?: DeepseekModel;
}

// ============================================
// Hook
// ============================================

interface UseTabStateOptions {
  initialCwd?: string;
  initialSessionId?: string;
  /** Current view (agent/explorer/console), used to determine unread: active tab also marked unread when not on agent screen */
  activeView?: string;
}

export function useTabState({ initialCwd, initialSessionId, activeView }: UseTabStateOptions) {
  // Mark whether sessions have been loaded from server
  const hasLoadedRef = useRef(false);
  // Mark whether currently initializing (avoid triggering save during initialization)
  const isInitializingRef = useRef(true);
  const activeViewRef = useRef(activeView);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  const pageVisible = usePageVisible();
  const pageVisibleRef = useRef(pageVisible);
  useEffect(() => { pageVisibleRef.current = pageVisible; }, [pageVisible]);

  // Initialize tabs (first create a temporary tab, later overwritten by server data)
  const [tabs, setTabs] = useState<TabInfo[]>(() => [{
    id: `tab-${Date.now()}`,
    cwd: initialCwd,
    title: 'New Chat',
  }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id);

  // Unread tabs (session completed but not yet viewed)
  const [unreadTabs, setUnreadTabs] = useState<Set<string>>(new Set());

  // Ref for tabs (avoid stale closures in callbacks)
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  // Update session status in state.json (notify Workspace layer)
  const updateSessionStatus = useCallback((sessionId: string, status: string) => {
    if (!initialCwd || !sessionId) return;
    fetch('/api/global-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: initialCwd, sessionId, status }),
    }).catch(() => {});
  }, [initialCwd]);

  // Tab drag state
  const [dragTabIndex, setDragTabIndex] = useState<number | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

  // Load saved sessions from server and merge with URL params
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
          const savedEngines: Record<string, string> = data.engines || {};
          const savedOllamaModels: Record<string, string> = data.ollamaModels || {};
          const savedDeepseekModels: Record<string, string> = data.deepseekModels || {};

          // Merge URL sessionId with sessions in session.json (deduplicate)
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
              engine: (savedEngines[sessionId] as ChatEngine) || undefined,
              ollamaModel: savedOllamaModels[sessionId] || undefined,
              deepseekModel: (savedDeepseekModels[sessionId] as DeepseekModel) || undefined,
            }));

            // Activation priority: URL sessionId > session.json activeSessionId > first
            const activeSessionToUse = initialSessionId || savedActiveSessionId;
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

  // Save to server when tabs or activeTabId changes
  useEffect(() => {
    if (isInitializingRef.current || !initialCwd) return;

    const sessionIds = tabs
      .map(tab => tab.sessionId)
      .filter((id): id is string => !!id);

    const activeTab = tabs.find(t => t.id === activeTabId);
    const activeSessionId = activeTab?.sessionId;

    // Build engine map for tabs that have a non-default engine
    const engines: Record<string, string> = {};
    const ollamaModels: Record<string, string> = {};
    const deepseekModels: Record<string, string> = {};
    for (const tab of tabs) {
      if (tab.sessionId && tab.engine) {
        engines[tab.sessionId] = tab.engine;
      }
      if (tab.sessionId && tab.ollamaModel) {
        ollamaModels[tab.sessionId] = tab.ollamaModel;
      }
      if (tab.sessionId && tab.deepseekModel) {
        deepseekModels[tab.sessionId] = tab.deepseekModel;
      }
    }

    fetch('/api/project-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: initialCwd, sessions: sessionIds, activeSessionId, engines, ollamaModels, deepseekModels }),
    }).catch(error => {
      console.error('Failed to save sessions:', error);
    });
  }, [tabs, activeTabId, initialCwd]);

  // Notify parent Workspace when switching tab (parent handles URL update)
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

  // Add new tab (insert to the right of current tab)
  const addTab = useCallback((cwd?: string, sessionId?: string, title?: string, engine?: ChatEngine, ollamaModel?: string, deepseekModel?: DeepseekModel) => {
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd,
      sessionId,
      title: title || (sessionId ? `Session ${sessionId.slice(0, 6)}...` : 'New Chat'),
      engine,
      ollamaModel,
      deepseekModel,
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

  // Close tab
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

  // Handle sidebar session click - add new tab
  const handleSelectSession = useCallback((sid: string, title?: string) => {
    const existingTab = tabs.find((t) => t.sessionId === sid);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      addTab(initialCwd, sid, title);
    }
  }, [tabs, initialCwd, addTab]);

  // Create new blank tab
  const handleNewTab = useCallback(() => {
    addTab(initialCwd);
  }, [initialCwd, addTab]);

  // Create new Claude 2 tab
  const handleNewClaude2Tab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Claude 2 Chat', 'claude2');
  }, [initialCwd, addTab]);

  // Create new Codex tab
  const handleNewCodexTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Codex Chat', 'codex');
  }, [initialCwd, addTab]);

  // Create new Kimi tab
  const handleNewKimiTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Kimi Chat', 'kimi');
  }, [initialCwd, addTab]);

  // Create new Ollama tab
  const handleNewOllamaTab = useCallback((model?: string) => {
    addTab(initialCwd, undefined, model ? `New Ollama (${model})` : 'New Ollama Chat', 'ollama', model);
  }, [initialCwd, addTab]);

  // Update Ollama model for a tab
  const updateTabOllamaModel = useCallback((tabId: string, model: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, ollamaModel: model } : tab
      )
    );
  }, []);

  // Create new Deepseek tab (defaults to v4-flash; picker in chat header lets user switch later)
  const handleNewDeepseekTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Deepseek Chat', 'deepseek', undefined, 'deepseek-v4-flash');
  }, [initialCwd, addTab]);

  // Update Deepseek model for a tab
  const updateTabDeepseekModel = useCallback((tabId: string, model: DeepseekModel) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, deepseekModel: model } : tab
      )
    );
  }, []);

  // Open new session (for Fork, always creates a new tab)
  const handleOpenSession = useCallback((sid: string, title?: string) => {
    addTab(initialCwd, sid, title);
  }, [initialCwd, addTab]);

  // Update tab state (loading, sessionId)
  const updateTabState = useCallback((tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => {
    setTabs((prev) => {
      const oldTab = prev.find(t => t.id === tabId);
      if (oldTab?.isLoading && updates.isLoading === false) {
        // User "is watching" requires all 3 conditions:
        // 1. Is the current active tab
        // 2. On the agent screen (not explorer/console)
        // 3. iframe is visible to user (is the current active project)
        const isOnAgent = !activeViewRef.current || activeViewRef.current === 'agent';
        const isUserWatching = tabId === activeTabId && isOnAgent && pageVisibleRef.current;
        if (!isUserWatching) {
          setUnreadTabs(u => new Set(u).add(tabId));
          // state.json already set to 'unread' by /api/chat, no need to write
        } else {
          // User is watching → correct state.json to 'normal' (/api/chat defaults to 'unread')
          const sid = oldTab.sessionId || updates.sessionId;
          if (sid) updateSessionStatus(sid, 'normal');
        }
      }
      return prev.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      );
    });
  }, [activeTabId, updateSessionStatus]);

  // Clear unread for current active tab when switching back to agent screen / switching tab / iframe becomes visible
  // Must satisfy both: on agent screen + iframe visible
  useEffect(() => {
    const isOnAgent = !activeView || activeView === 'agent';
    if (isOnAgent && pageVisible) {
      setUnreadTabs(u => {
        if (!u.has(activeTabId)) return u;
        const next = new Set(u);
        next.delete(activeTabId);
        // Sync write state.json
        const tab = tabsRef.current.find(t => t.id === activeTabId);
        if (tab?.sessionId) {
          updateSessionStatus(tab.sessionId, 'normal');
          // Clear scheduled task unread for this session
          fetch('/api/scheduled-tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'markReadBySessionId', fields: { sessionId: tab.sessionId } }),
          }).catch(() => {});
        }
        return next;
      });
    }
  }, [activeView, activeTabId, pageVisible, updateSessionStatus]);

  // Switch tab and clear unread
  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setUnreadTabs(u => {
      if (!u.has(tabId)) return u;
      const next = new Set(u);
      next.delete(tabId);
      // Sync write to state.json
      const tab = tabsRef.current.find(t => t.id === tabId);
      if (tab?.sessionId) {
        updateSessionStatus(tab.sessionId, 'normal');
        // Clear scheduled task unread for this session
        fetch('/api/scheduled-tasks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'markReadBySessionId', fields: { sessionId: tab.sessionId } }),
        }).catch(() => {});
      }
      return next;
    });
  }, [updateSessionStatus]);

  // Tab drag-to-reorder
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
    handleNewClaude2Tab,
    handleNewCodexTab,
    handleNewKimiTab,
    handleNewOllamaTab,
    handleNewDeepseekTab,
    handleOpenSession,
    updateTabState,
    updateTabOllamaModel,
    updateTabDeepseekModel,

    // Drag operations
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  };
}
