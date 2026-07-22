'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { usePageVisible, useWebSocket } from '@cockpit/shared-ui';
import type { ChatEngine, DeepseekModel, ChatMode } from '@cockpit/feature-agent';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadProjectState,
  saveProjectState,
  updateSessionStatus as updateSessionStatusEff,
  markScheduledTasksReadBySession,
} from './effect/stateClient';

// ============================================
// Types
// ============================================

export interface TabInfo {
  id: string;
  cwd?: string;
  sessionId?: string;
  title: string;
  isLoading?: boolean;
  engine?: ChatEngine;
  ollamaModel?: string;
  deepseekModel?: DeepseekModel;
  chatMode?: ChatMode;
  planMode?: boolean;
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

  // Initialize tabs (first create a temporary tab, later overwritten by server data).
  // Seed it with initialSessionId (from the URL) so that a project with no state.json yet
  // still opens the requested session: loadSessions' null-data branch keeps this default tab
  // as-is, and its data branch merges/activates initialSessionId anyway. This removes the
  // dependency on a post-onLoad SWITCH_SESSION message and its race with the restore.
  const [tabs, setTabs] = useState<TabInfo[]>(() => [{
    id: `tab-${Date.now()}`,
    cwd: initialCwd,
    sessionId: initialSessionId,
    title: initialSessionId ? `Session ${initialSessionId.slice(0, 6)}...` : 'New Chat',
  }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id ?? '');

  // Unread tabs (session completed but not yet viewed)
  const [unreadTabs, setUnreadTabs] = useState<Set<string>>(new Set());

  // Ref for tabs (avoid stale closures in callbacks)
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  // Sessions explicitly closed in THIS tab since the last save. The next save sends them as
  // closedSessionIds so the server removes them from the shared union (the only removal path).
  const pendingClosedRef = useRef<Set<string>>(new Set());

  // Update session status in state.json (notify Workspace layer)
  const updateSessionStatus = useCallback((sessionId: string, status: string) => {
    if (!initialCwd || !sessionId) return;
    BrowserRuntime.runFork(
      updateSessionStatusEff(initialCwd, sessionId, status).pipe(
        Effect.catchAll(() => Effect.void)
      )
    );
  }, [initialCwd]);

  // Tab drag state
  const [dragTabIndex, setDragTabIndex] = useState<number | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

  // Load saved sessions from server and merge with URL params
  useEffect(() => {
    if (!initialCwd || hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    // loadProjectState wraps Effect.catchAll -> Effect.succeed(null) internally so
    // runPromise never rejects; the outer try/catch would never fire. On failure
    // data === null and we fall through to the else branch.
    const loadSessions = async () => {
      const data = await BrowserRuntime.runPromise(
        loadProjectState(initialCwd).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (data) {
        const savedSessions: string[] = data.sessions || [];
        const savedActiveSessionId: string | undefined = data.activeSessionId;
        const savedEngines: Record<string, string> = data.engines || {};
        const savedOllamaModels: Record<string, string> = data.ollamaModels || {};
        const savedDeepseekModels: Record<string, string> = data.deepseekModels || {};
        const savedChatModes: Record<string, string> = data.chatModes || {};
        const savedPlanModes: Record<string, boolean> = data.planModes || {};

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
            chatMode: (savedChatModes[sessionId] as ChatMode) || undefined,
            planMode: savedPlanModes[sessionId] || undefined,
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
      } else {
        // loadProjectState failed: don't block init, keep the default tab list
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
    const chatModes: Record<string, string> = {};
    const planModes: Record<string, boolean> = {};
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
      // Persist the explicit value for sessions THIS tab has open, so switching
      // back to the default actually overrides a previously-saved non-default.
      // The server merge is a union — an absent key keeps the old value, which
      // made "off"/"sdk" un-persistable (toggle off → key omitted → stale value
      // survives → re-applied on reload). Sessions open only in OTHER tabs aren't
      // in this payload, so the union still preserves their settings.
      if (tab.sessionId) {
        chatModes[tab.sessionId] = tab.chatMode === 'pty' ? 'pty' : 'sdk';
        planModes[tab.sessionId] = !!tab.planMode;
      }
    }

    // Sessions closed in this tab since the last save → the server subtracts them from the
    // shared union (saves otherwise only ADD, never shrink). Snapshot but do NOT drain yet:
    // removal is the ONLY shrink path and the union has no memory, so a `closedSessionIds`
    // lost to a failed POST = a ghost session that re-materializes forever. Clear each id
    // only AFTER the save succeeds (and only those ids — closes that arrive mid-flight stay
    // pending for the next save).
    const closedSessionIds = [...pendingClosedRef.current];

    BrowserRuntime.runFork(
      saveProjectState({
        cwd: initialCwd,
        sessions: sessionIds,
        activeSessionId,
        engines,
        ollamaModels,
        deepseekModels,
        chatModes,
        planModes,
        ...(closedSessionIds.length ? { closedSessionIds } : {}),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const id of closedSessionIds) pendingClosedRef.current.delete(id);
          })
        ),
        Effect.tapError((e) =>
          Effect.sync(() => console.error('Failed to save sessions:', e))
        ),
        Effect.catchAll(() => Effect.void)
      )
    );
  }, [tabs, activeTabId, initialCwd]);

  // Notify parent Workspace when switching tab (parent handles URL update)
  useEffect(() => {
    if (isInitializingRef.current || !initialCwd) return;

    const activeTab = tabs.find(t => t.id === activeTabId);
    if (!activeTab?.sessionId) return;

    publishTopic(Topics.SessionChange, {
      cwd: initialCwd,
      sessionId: activeTab.sessionId,
    });
  }, [activeTabId, tabs, initialCwd]);

  // #10: keep in-app tabs in sync across browser tabs of the same project. The
  // /api/project-state route broadcasts `project-state-changed` after every tab open/close.
  // We do NOT mirror by set-diff (a tab that simply hasn't opened a session must not be read
  // as "closed it" — that collapsed every tab to the smallest set). Instead:
  //   • ADD: any session in the shared state.json (a union) we don't have a tab for.
  //   • REMOVE: only the sessions in the event's `closedSessionIds` (an explicit close).
  // State is written before the broadcast, so engine/model are already correct (no race).
  const reconcileTabs = useCallback((closedIds: string[]) => {
    if (!initialCwd) return;
    BrowserRuntime.runPromise(
      loadProjectState(initialCwd).pipe(Effect.catchAll(() => Effect.succeed(null)))
    ).then((data) => {
      if (!data) return;
      const saved: string[] = data.sessions || [];
      const engines = (data.engines || {}) as Record<string, string>;
      const ollamaModels = (data.ollamaModels || {}) as Record<string, string>;
      const deepseekModels = (data.deepseekModels || {}) as Record<string, string>;
      const chatModes = (data.chatModes || {}) as Record<string, string>;
      const planModes = (data.planModes || {}) as Record<string, boolean>;

      const prev = tabsRef.current;
      const closedSet = new Set(closedIds);
      // remove only explicitly-closed sessions; keep placeholders + everything else
      const kept = prev.filter((t) => !t.sessionId || !closedSet.has(t.sessionId));
      const keptIds = new Set(kept.map((t) => t.sessionId).filter(Boolean));
      // add union sessions we don't have
      const toAdd = saved.filter((sid) => !keptIds.has(sid));

      // No removal + no add → bail (referential stability avoids a save→broadcast loop).
      if (kept.length === prev.length && toAdd.length === 0) return;

      const added: TabInfo[] = toAdd.map((sid, i) => ({
        id: `tab-${Date.now()}-sync-${i}`,
        cwd: initialCwd,
        sessionId: sid,
        title: `Session ${sid.slice(0, 6)}...`,
        engine: (engines[sid] as ChatEngine) || undefined,
        ollamaModel: ollamaModels[sid] || undefined,
        deepseekModel: (deepseekModels[sid] as DeepseekModel) || undefined,
        chatMode: (chatModes[sid] as ChatMode) || undefined,
        planMode: planModes[sid] || undefined,
      }));
      let next = [...kept, ...added];
      // never leave the tab bar empty (tabs[0].id is read every render)
      if (next.length === 0) {
        next = [{ id: `tab-${Date.now()}`, cwd: initialCwd, title: 'New Chat' }];
      }
      setTabs(next);
      // active tab closed elsewhere → fall back to the last remaining tab
      if (!next.some((t) => t.id === activeTabIdRef.current)) {
        setActiveTabId(next[next.length - 1].id);
      }
    });
  }, [initialCwd]);

  useWebSocket({
    url: '/ws/global-state',
    enabled: !!initialCwd,
    onMessage: (raw) => {
      if (isInitializingRef.current || !initialCwd) return;
      const p = raw as { type?: string; cwd?: string; closedSessionIds?: string[] };
      if (p.type === 'project-state-changed' && p.cwd === initialCwd) {
        reconcileTabs(p.closedSessionIds ?? []);
      }
    },
  });

  // Add new tab
  // - appendToEnd=true (new chats from "+" menu, opening existing sessions from sidebar):
  //   append to the end of all tabs
  // - appendToEnd=false (forked chats): insert to the right of current tab
  const addTab = useCallback((cwd?: string, sessionId?: string, title?: string, engine?: ChatEngine, ollamaModel?: string, deepseekModel?: DeepseekModel, appendToEnd: boolean = false) => {
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
      if (appendToEnd) {
        return [...prev, newTab];
      }
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
    // Record an explicit close so the next save removes it from the shared union (and the
    // broadcast tells other browser tabs to remove exactly this session).
    const closing = tabsRef.current.find((t) => t.id === tabId);
    if (closing?.sessionId) pendingClosedRef.current.add(closing.sessionId);
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

  // Close every tab at once, then reset to a single blank tab. Mirrors closeTab's
  // shared-union bookkeeping: record all sessionIds so the next save removes them
  // from the shared set and broadcasts the removals to other browser tabs.
  const closeAllTabs = useCallback(() => {
    tabsRef.current.forEach((t) => {
      if (t.sessionId) pendingClosedRef.current.add(t.sessionId);
    });
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd: initialCwd,
      title: 'New Chat',
    };
    setActiveTabId(newTab.id);
    setTabs([newTab]);
  }, [initialCwd]);

  // Handle sidebar session click - add new tab (appended to end)
  const handleSelectSession = useCallback((sid: string, title?: string) => {
    const existingTab = tabs.find((t) => t.sessionId === sid);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      addTab(initialCwd, sid, title, undefined, undefined, undefined, true);
    }
  }, [tabs, initialCwd, addTab]);

  // Create new blank tab (Claude Code, appended to end)
  const handleNewTab = useCallback(() => {
    addTab(initialCwd, undefined, undefined, undefined, undefined, undefined, true);
  }, [initialCwd, addTab]);

  // Create new Claude 2 tab (appended to end)
  const handleNewClaude2Tab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Claude 2 Chat', 'claude2', undefined, undefined, true);
  }, [initialCwd, addTab]);

  // Create new Codex tab (appended to end)
  const handleNewCodexTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Codex Chat', 'codex', undefined, undefined, true);
  }, [initialCwd, addTab]);

  // Create new Kimi tab (appended to end)
  const handleNewKimiTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Kimi Chat', 'kimi', undefined, undefined, true);
  }, [initialCwd, addTab]);

  // Create new Ollama tab (appended to end)
  const handleNewOllamaTab = useCallback((model?: string) => {
    addTab(initialCwd, undefined, model ? `New Ollama (${model})` : 'New Ollama Chat', 'ollama', model, undefined, true);
  }, [initialCwd, addTab]);

  // Update Ollama model for a tab
  const updateTabOllamaModel = useCallback((tabId: string, model: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, ollamaModel: model } : tab
      )
    );
  }, []);

  // Create new DeepSeek tab (defaults to v4-flash; picker in chat header lets user switch later) (appended to end)
  const handleNewDeepseekTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New DeepSeek Chat', 'deepseek', undefined, 'deepseek-v4-flash', true);
  }, [initialCwd, addTab]);

  // Update DeepSeek model for a tab
  const updateTabDeepseekModel = useCallback((tabId: string, model: DeepseekModel) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, deepseekModel: model } : tab
      )
    );
  }, []);

  // Update execution mode (sdk/pty) for a tab
  const updateTabChatMode = useCallback((tabId: string, chatMode: ChatMode) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, chatMode } : tab
      )
    );
  }, []);

  // Update plan mode (read-only planning) for a tab
  const updateTabPlanMode = useCallback((tabId: string, planMode: boolean) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, planMode } : tab
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
          BrowserRuntime.runFork(
            markScheduledTasksReadBySession(tab.sessionId).pipe(
              Effect.catchAll(() => Effect.void)
            )
          );
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
        BrowserRuntime.runFork(
          markScheduledTasksReadBySession(tab.sessionId).pipe(
            Effect.catchAll(() => Effect.void)
          )
        );
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

    // Drag operations
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  };
}
