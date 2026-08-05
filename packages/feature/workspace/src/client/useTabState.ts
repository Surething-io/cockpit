'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { usePageVisible, useWebSocket } from '@cockpit/shared-ui';
import type { ChatEngine, DeepseekModel, EngineModelId, ChatMode } from '@cockpit/feature-agent';
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
  kimiModel?: EngineModelId;
  chatMode?: ChatMode;
  planMode?: boolean;
  /** ollama only: send every user message with no prior history (independent task) */
  noHistory?: boolean;
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
  // Mark whether currently initializing (avoid triggering save during initialization).
  // Mirrored into state because the save effect must RE-RUN when initialization ends: work
  // that resolves inside the init window (e.g. Chat backfilling a session's engine from its
  // transcript store) changes `tabs` while saving is suppressed, and without a re-run that
  // repair is computed and then silently dropped — nothing else touches `tabs` afterwards.
  const isInitializingRef = useRef(true);
  const [initDone, setInitDone] = useState(false);
  const finishInitializing = useCallback(() => {
    isInitializingRef.current = false;
    setInitDone(true);
  }, []);
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
        const savedKimiModels: Record<string, string> = data.kimiModels || {};
        const savedChatModes: Record<string, string> = data.chatModes || {};
        const savedPlanModes: Record<string, boolean> = data.planModes || {};
        const savedNoHistories: Record<string, boolean> = data.noHistories || {};

        // Merge URL sessionId with sessions in session.json (deduplicate)
        let allSessions = [...savedSessions];
        if (initialSessionId && !allSessions.includes(initialSessionId)) {
          allSessions = [initialSessionId, ...allSessions];
        }

        if (allSessions.length > 0) {
          // This load is async, so a tab may already have resolved its own engine/mode from
          // the transcript store while it was in flight (Chat's backfill). session.json is
          // the weaker source — it holds nothing for a session that was never open as a tab —
          // so it must not ERASE what is already known; fall back to the live tab instead.
          const live = tabsRef.current;
          const restoredTabs: TabInfo[] = allSessions.map((sessionId: string, index: number) => {
            const prev = live.find((t) => t.sessionId === sessionId);
            return {
              id: `tab-${Date.now()}-${index}`,
              cwd: initialCwd,
              sessionId,
              title: `Session ${sessionId.slice(0, 6)}...`,
              engine: (savedEngines[sessionId] as ChatEngine) || prev?.engine || undefined,
              ollamaModel: savedOllamaModels[sessionId] || prev?.ollamaModel || undefined,
              deepseekModel: (savedDeepseekModels[sessionId] as DeepseekModel) || prev?.deepseekModel || undefined,
              kimiModel: (savedKimiModels[sessionId] as EngineModelId) || prev?.kimiModel || undefined,
              chatMode: (savedChatModes[sessionId] as ChatMode) || prev?.chatMode || undefined,
              planMode: savedPlanModes[sessionId] ?? prev?.planMode,
              noHistory: savedNoHistories[sessionId] ?? prev?.noHistory,
            };
          });

          // Activation priority: URL sessionId > session.json activeSessionId > first
          const activeSessionToUse = initialSessionId || savedActiveSessionId;
          let activeIndex = activeSessionToUse ? allSessions.indexOf(activeSessionToUse) : -1;
          if (activeIndex < 0) activeIndex = 0;

          const newActiveTabId = restoredTabs[activeIndex].id;
          setTabs(restoredTabs);
          setActiveTabId(newActiveTabId);

          setTimeout(finishInitializing, 0);
        } else {
          finishInitializing();
        }
      } else {
        // loadProjectState failed: don't block init, keep the default tab list
        finishInitializing();
      }
    };

    loadSessions();
  }, [initialCwd, initialSessionId, finishInitializing]);

  // Save to server when tabs or activeTabId changes — and once more the moment
  // initialization ends, to flush anything resolved while saving was suppressed.
  useEffect(() => {
    if (!initDone || !initialCwd) return;

    const sessionIds = tabs
      .map(tab => tab.sessionId)
      .filter((id): id is string => !!id);

    const activeTab = tabs.find(t => t.id === activeTabId);
    const activeSessionId = activeTab?.sessionId;

    // Build engine map for tabs that have a non-default engine
    const engines: Record<string, string> = {};
    const ollamaModels: Record<string, string> = {};
    const deepseekModels: Record<string, string> = {};
    const kimiModels: Record<string, string> = {};
    const chatModes: Record<string, string> = {};
    const planModes: Record<string, boolean> = {};
    const noHistories: Record<string, boolean> = {};
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
      if (tab.sessionId && tab.kimiModel) {
        kimiModels[tab.sessionId] = tab.kimiModel;
      }
      // Persist the DECIDED value for sessions THIS tab has open, so switching back to the
      // default actually overrides a previously-saved non-default. The server merge is a
      // union — an absent key keeps the old value, which made "off"/"sdk" un-persistable
      // (toggle off → key omitted → stale value survives → re-applied on reload). Sessions
      // open only in OTHER tabs aren't in this payload, so the union still preserves theirs.
      //
      // "Decided" is the load-bearing word: `undefined` means this tab has not established
      // the value yet (a session reopened from a list starts that way and Chat's local
      // fallback — 'sdk', off — is NOT the tab's answer). Writing the fallback anyway is how
      // a Built-in Agent session got downgraded to 'sdk' on disk just by being reopened,
      // which is unrecoverable: the transcript store still says builtin, but nothing reads
      // it back. So only explicit values are written; Chat backfills the rest from the
      // store, at which point they become explicit and round-trip normally.
      if (tab.sessionId) {
        if (tab.chatMode !== undefined) chatModes[tab.sessionId] = tab.chatMode;
        if (tab.planMode !== undefined) planModes[tab.sessionId] = tab.planMode;
        if (tab.noHistory !== undefined) noHistories[tab.sessionId] = tab.noHistory;
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
        kimiModels,
        chatModes,
        planModes,
        noHistories,
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
  }, [tabs, activeTabId, initialCwd, initDone]);

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
      const kimiModels = (data.kimiModels || {}) as Record<string, string>;
      const chatModes = (data.chatModes || {}) as Record<string, string>;
      const planModes = (data.planModes || {}) as Record<string, boolean>;
      const noHistories = (data.noHistories || {}) as Record<string, boolean>;

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
        kimiModel: (kimiModels[sid] as EngineModelId) || undefined,
        chatMode: (chatModes[sid] as ChatMode) || undefined,
        planMode: planModes[sid] || undefined,
        noHistory: noHistories[sid] || undefined,
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
  // `opts` carries the tab's identity (engine/model/mode). For an EXISTING session it must be
  // filled from the session list — an omitted engine is not "claude", it is "unknown", and
  // every downstream check reads the two the same way.
  const addTab = useCallback((
    cwd?: string,
    sessionId?: string,
    title?: string,
    opts?: {
      engine?: ChatEngine;
      ollamaModel?: string;
      deepseekModel?: DeepseekModel;
      kimiModel?: EngineModelId;
      chatMode?: ChatMode;
      planMode?: boolean;
      noHistory?: boolean;
      appendToEnd?: boolean;
    }
  ) => {
    const { engine, ollamaModel, deepseekModel, kimiModel, chatMode, planMode, noHistory, appendToEnd = false } = opts ?? {};
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd,
      sessionId,
      title: title || (sessionId ? `Session ${sessionId.slice(0, 6)}...` : 'New Chat'),
      engine,
      ollamaModel,
      deepseekModel,
      kimiModel,
      chatMode,
      planMode,
      noHistory,
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

  // Handle sidebar session click - add new tab (appended to end).
  //
  // A reopened session comes back as itself from session.json — ONE source, for every entry
  // point (session list, recent, pinned, scheduled tasks, cross-project postMessage), rather
  // than threaded through each dialog. Two facts make this sufficient:
  //   • The UI preferences (plan mode, independent task, models) exist nowhere else at all —
  //     no transcript records them, so a tab created without them silently resets the user's
  //     choice to the default.
  //   • Engine and execution mode ARE re-derivable (from which store holds the transcript),
  //     and Chat resolves them from there on load and writes the answer back here. So this
  //     read is right for every session that has been opened once; for one that never has,
  //     the tab starts engine-less for a single round-trip and Chat's backfill settles it.
  //     Handing the same fact over a second, synchronous channel would only buy that one
  //     window, at the cost of a second derivation to keep in sync.
  // Fetched per open instead of reusing the snapshot loaded at mount: it is a <10ms local
  // request, and the snapshot goes stale as soon as another browser tab edits the project.
  const handleSelectSession = useCallback((sid: string, title?: string) => {
    const existingTab = tabs.find((t) => t.sessionId === sid);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }
    if (!initialCwd) {
      addTab(initialCwd, sid, title, { appendToEnd: true });
      return;
    }
    BrowserRuntime.runPromise(
      loadProjectState(initialCwd).pipe(Effect.catchAll(() => Effect.succeed(null)))
    ).then((data) => {
      // Re-check against the live tabs: the await above is long enough for a second click
      // (or a SWITCH_SESSION for the same id) to have opened this session already.
      const already = tabsRef.current.find((t) => t.sessionId === sid);
      if (already) {
        setActiveTabId(already.id);
        return;
      }
      addTab(initialCwd, sid, title, {
        engine: data?.engines?.[sid] as ChatEngine | undefined,
        chatMode: data?.chatModes?.[sid] as ChatMode | undefined,
        ollamaModel: data?.ollamaModels?.[sid],
        deepseekModel: data?.deepseekModels?.[sid] as DeepseekModel | undefined,
        kimiModel: data?.kimiModels?.[sid] as EngineModelId | undefined,
        planMode: data?.planModes?.[sid],
        noHistory: data?.noHistories?.[sid],
        appendToEnd: true,
      });
    });
  }, [tabs, initialCwd, addTab]);

  // Create new blank tab (Claude Code, appended to end)
  const handleNewTab = useCallback(() => {
    addTab(initialCwd, undefined, undefined, { appendToEnd: true });
  }, [initialCwd, addTab]);

  // Create new Claude 2 tab (appended to end)
  const handleNewClaude2Tab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Claude 2 Chat', { engine: 'claude2', appendToEnd: true });
  }, [initialCwd, addTab]);

  // Create new Codex tab (appended to end)
  const handleNewCodexTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Codex Chat', { engine: 'codex', appendToEnd: true });
  }, [initialCwd, addTab]);

  // Create new Kimi tab (appended to end). Defaults to kimi-for-coding: the entry tier,
  // callable on every membership level, so a fresh tab never opens on a model this account
  // is not entitled to. The picker in the chat header switches it.
  const handleNewKimiTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Kimi Chat', { engine: 'kimi', kimiModel: 'kimi-for-coding', appendToEnd: true });
  }, [initialCwd, addTab]);

  // Create new Ollama tab (appended to end)
  const handleNewOllamaTab = useCallback((model?: string) => {
    addTab(initialCwd, undefined, model ? `New Ollama (${model})` : 'New Ollama Chat', { engine: 'ollama', ollamaModel: model, appendToEnd: true });
  }, [initialCwd, addTab]);

  // Record a tab's engine. Fired by Chat's backfill when the tab was opened without one and
  // history resolved the authoritative value — this is what stops `engines` in session.json
  // from being a write-only-on-new-tab map that can never recover a lost entry.
  const updateTabEngine = useCallback((tabId: string, engine: ChatEngine) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.engine !== engine ? { ...tab, engine } : tab
      )
    );
  }, []);

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
    addTab(initialCwd, undefined, 'New DeepSeek Chat', { engine: 'deepseek', deepseekModel: 'deepseek-v4-flash', appendToEnd: true });
  }, [initialCwd, addTab]);

  // Update DeepSeek model for a tab
  const updateTabDeepseekModel = useCallback((tabId: string, model: DeepseekModel) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, deepseekModel: model } : tab
      )
    );
  }, []);

  // Update Kimi model for a tab
  const updateTabKimiModel = useCallback((tabId: string, model: EngineModelId) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, kimiModel: model } : tab
      )
    );
  }, []);

  // Update execution mode (sdk/pty) for a tab
  const updateTabChatMode = useCallback((tabId: string, chatMode: ChatMode) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId && tab.chatMode !== chatMode ? { ...tab, chatMode } : tab
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

  // Update independent-task mode (ollama: send no history) for a tab
  const updateTabNoHistory = useCallback((tabId: string, noHistory: boolean) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, noHistory } : tab
      )
    );
  }, []);

  // Open new session (for Fork, always creates a new tab). A fork lands in the SAME store as
  // its source, so the new tab inherits the source tab's engine/model/mode rather than
  // starting as "unknown" (which every downstream check would read as claude).
  const handleOpenSession = useCallback((sid: string, title?: string) => {
    const source = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    addTab(initialCwd, sid, title, {
      engine: source?.engine,
      ollamaModel: source?.ollamaModel,
      deepseekModel: source?.deepseekModel,
      kimiModel: source?.kimiModel,
      chatMode: source?.chatMode,
    });
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
    updateTabEngine,
    updateTabOllamaModel,
    updateTabDeepseekModel,
    updateTabKimiModel,
    updateTabChatMode,
    updateTabPlanMode,
    updateTabNoHistory,

    // Drag operations
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  };
}
