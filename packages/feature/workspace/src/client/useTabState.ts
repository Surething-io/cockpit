'use client';

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { usePageVisible, useWebSocket } from '@cockpit/shared-ui';
import type { ChatEngine, DeepseekModel, EngineModelId, ClaudeModelId, ClaudeEffort, ClaudeContextWindow, CodexModelId, CodexReasoningEffort } from '@cockpit/feature-agent';
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
import { loadActiveTabTarget, saveActiveTabTarget, type ActiveTabTarget } from './effect/activeTabStorage';
import { createLatestTaskRunner, type LatestTaskRunner } from './latestTaskRunner';

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
  glmModel?: EngineModelId;
  claudeModel?: ClaudeModelId;
  claudeEffort?: ClaudeEffort;
  claudeContextWindow?: ClaudeContextWindow;
  claudeFastMode?: boolean;
  claudeThinking?: boolean;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
  planMode?: boolean;
  /** ollama only: send every user message with no prior history (independent task) */
  noHistory?: boolean;
}

interface GlobalSessionStatusSnapshot {
  cwd: string;
  sessionId: string;
  status?: string;
  engine?: string;
}

const CODEX_THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;

function normalizeCodexSessionId(sessionId: string): string {
  const match = sessionId.match(CODEX_THREAD_ID_RE);
  return match?.[1] ?? sessionId;
}

// ============================================
// Hook
// ============================================

interface UseTabStateOptions {
  initialCwd?: string;
  initialSessionId?: string;
  /** The URL explicitly points at a blank New Chat rather than a saved session. */
  initialBlank?: boolean;
  /** Current view (agent/explorer/console), used to determine unread: active tab also marked unread when not on agent screen */
  activeView?: string;
}


/**
 * The pane invariant, in one place: **every visible pane holds a tab that
 * exists, and no two panes hold the same one.**
 *
 * Both halves are load-bearing. A pane with no tab has no Chat, so no composer,
 * so no split toggle — a pane you cannot close. Two panes on one tab is one
 * Chat driven by two mounts, which renders as a single pane and corrupts the
 * session state behind it.
 *
 * Three call sites need it and used to have three answers: closing a tab,
 * restoring a saved layout, and reconciling after another browser tab closed
 * something. The third had none at all, which left a pane pointing at a removed
 * tab id and made it silently vanish.
 *
 * A vacated pane prefers an existing tab no other pane is using, and falls back
 * to a blank chat only when there is none — the same rule single-pane already
 * follows when you close the active tab. Returned `created` tabs MUST be
 * appended to the tab list by the caller: pane bookkeeping alone cannot satisfy
 * the invariant, a vacancy needs a real tab to point at.
 */
export function repairPanes(
  panes: string[],
  tabs: TabInfo[],
  cwd: string | undefined,
): { panes: string[]; created: TabInfo[] } {
  const alive = new Set(tabs.map((t) => t.id));
  const stillValid = new Set(panes.filter((id) => alive.has(id)));
  const created: TabInfo[] = [];
  const out: string[] = [];

  for (const id of panes) {
    if (alive.has(id) && !out.includes(id)) {
      out.push(id);
      continue;
    }
    const claimed = new Set([...out, ...stillValid]);
    const successor = [...tabs].reverse().find((t) => !claimed.has(t.id));
    if (successor) {
      out.push(successor.id);
      stillValid.add(successor.id);
      continue;
    }
    const blank: TabInfo = {
      id: `tab-${Date.now()}-pane${created.length}`,
      cwd,
      title: 'New Chat',
    };
    created.push(blank);
    out.push(blank.id);
  }
  return { panes: out, created };
}

export function useTabState({ initialCwd, initialSessionId, initialBlank, activeView }: UseTabStateOptions) {
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

  // Panes. There are one or two slots that can show a chat, and one index
  // saying which of them is active.
  //
  // `activeTabId` is DERIVED from those two rather than being state of its own,
  // and that is the whole design. Held separately it means both "the left
  // pane's tab" and "the tab the app is on", so every consumer downstream has
  // to ask which one is meant — that ambiguity is what grew a parallel routing
  // helper, a separate id for the tab bar to highlight, and a bespoke pane
  // check. Derived, the active pane simply IS the old single-pane mode, and
  // every existing setActiveTabId call site keeps working unchanged.
  const [paneTabIds, setPaneTabIds] = useState<string[]>(() => [tabs[0]?.id ?? '']);
  const [activePane, setActivePane] = useState(0);
  const activePaneRef = useRef(activePane);
  useEffect(() => { activePaneRef.current = activePane; }, [activePane]);
  const paneTabIdsRef = useRef(paneTabIds);
  useEffect(() => { paneTabIdsRef.current = paneTabIds; }, [paneTabIds]);

  const activeTabId = paneTabIds[activePane] ?? paneTabIds[0] ?? '';

  // "Show this tab" for every caller there has ever been: restore, new tab,
  // history pick, externally opened session, tab click. It lands in the ACTIVE
  // pane — except when the tab is already showing in the other one, where the
  // only thing actually wrong is which pane has focus, so focus moves instead
  // and nothing on screen is rearranged.
  const setActiveTabId = useCallback((tabId: string) => {
    setPaneTabIds((prev) => {
      const at = prev.indexOf(tabId);
      if (at !== -1) {
        if (at !== activePaneRef.current) setActivePane(at);
        return prev;
      }
      const next = [...prev];
      next[activePaneRef.current] = tabId;
      return next;
    });
  }, []);


  // Unread tabs (session completed but not yet viewed)
  const [unreadTabs, setUnreadTabs] = useState<Set<string>>(new Set());

  // Ref for tabs (avoid stale closures in callbacks)
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  // The global-state socket commonly delivers its first snapshot while project
  // tabs are still being restored. Keep it until initialization finishes so
  // persisted unread state is not lost merely because tab ids do not exist yet.
  const globalSessionsRef = useRef<GlobalSessionStatusSnapshot[]>([]);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  // Only one project-state write runs at once. While it runs, newer snapshots
  // replace the pending one instead of forming a backlog of stale tab states.
  const saveRunnerRef = useRef<LatestTaskRunner<Parameters<typeof saveProjectState>[0]> | null>(null);
  // switchTab reads all three to decide which pane a click lands in; via refs so
  // its identity stays stable for the memoised TabBar.


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

  const syncUnreadTabsFromGlobalState = useCallback((sessions: GlobalSessionStatusSnapshot[]) => {
    if (!initialCwd) return;

    const statusBySession = new Map<string, string>();
    for (const session of sessions) {
      if (session.cwd !== initialCwd) continue;
      const sessionId = session.engine === 'codex'
        ? normalizeCodexSessionId(session.sessionId)
        : session.sessionId;
      statusBySession.set(sessionId, session.status ?? 'normal');
    }

    setUnreadTabs((current) => {
      const next = new Set(current);
      let changed = false;
      for (const tab of tabsRef.current) {
        if (!tab.sessionId) continue;
        const status = statusBySession.get(tab.sessionId);
        // The WS snapshot is capped, so an absent session is unknown rather
        // than normal. Only reconcile entries the server actually sent.
        if (status === undefined) continue;
        if (status === 'unread') {
          if (!next.has(tab.id)) {
            next.add(tab.id);
            changed = true;
          }
        } else if (next.delete(tab.id)) {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [initialCwd]);

  useEffect(() => {
    if (!initDone) return;
    syncUnreadTabsFromGlobalState(globalSessionsRef.current);
  }, [initDone, syncUnreadTabsFromGlobalState]);

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
      const storedTarget = BrowserRuntime.runSync(
        loadActiveTabTarget(initialCwd).pipe(Effect.catchAll(() => Effect.succeed(null)))
      );
      const data = await BrowserRuntime.runPromise(
        loadProjectState(initialCwd).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (data) {
        const rawEngines: Record<string, string> = data.engines || {};
        const savedEngines: Record<string, string> = {};
        for (const [sid, engine] of Object.entries(rawEngines)) {
          savedEngines[engine === 'codex' ? normalizeCodexSessionId(sid) : sid] = engine;
        }
        const savedSessions: string[] = [];
        for (const sid of data.sessions || []) {
          const normalized = rawEngines[sid] === 'codex' ? normalizeCodexSessionId(sid) : sid;
          if (!savedSessions.includes(normalized)) savedSessions.push(normalized);
        }
        const savedActiveSessionId: string | null | undefined = data.activeSessionId && rawEngines[data.activeSessionId] === 'codex'
          ? normalizeCodexSessionId(data.activeSessionId)
          : data.activeSessionId;
        const savedOllamaModels: Record<string, string> = data.ollamaModels || {};
        const savedDeepseekModels: Record<string, string> = data.deepseekModels || {};
        const savedKimiModels: Record<string, string> = data.kimiModels || {};
        const savedGlmModels: Record<string, string> = data.glmModels || {};
        const savedClaudeModels: Record<string, string> = data.claudeModels || {};
        const savedClaudeEfforts: Record<string, string> = data.claudeEfforts || {};
        const savedClaudeContextWindows: Record<string, string> = data.claudeContextWindows || {};
        const savedClaudeFastModes: Record<string, boolean> = data.claudeFastModes || {};
        const savedClaudeThinkings: Record<string, boolean> = data.claudeThinkings || {};
        const savedCodexModels: Record<string, string> = data.codexModels || {};
        const savedCodexReasoningEfforts: Record<string, string> = data.codexReasoningEfforts || {};
        const savedPlanModes: Record<string, boolean> = data.planModes || {};
        const savedNoHistories: Record<string, boolean> = data.noHistories || {};

        // The same-window target is written synchronously when selection changes,
        // so it survives refresh even if URL or project-state IO is still pending.
        const storedSessionId = storedTarget?.kind === 'session' ? storedTarget.sessionId : undefined;

        // Merge explicit and window-local session targets with session.json.
        let allSessions = [...savedSessions];
        if (initialSessionId && !allSessions.includes(initialSessionId)) {
          allSessions = [initialSessionId, ...allSessions];
        }
        if (storedSessionId && !allSessions.includes(storedSessionId)) {
          allSessions = [storedSessionId, ...allSessions];
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
              glmModel: (savedGlmModels[sessionId] as EngineModelId) || prev?.glmModel || undefined,
              claudeModel: (savedClaudeModels[sessionId] as ClaudeModelId) || prev?.claudeModel || undefined,
              claudeEffort: (savedClaudeEfforts[sessionId] as ClaudeEffort) || prev?.claudeEffort || undefined,
              claudeContextWindow: (savedClaudeContextWindows[sessionId] as ClaudeContextWindow) || prev?.claudeContextWindow || undefined,
              claudeFastMode: savedClaudeFastModes[sessionId] ?? prev?.claudeFastMode,
              claudeThinking: savedClaudeThinkings[sessionId] ?? prev?.claudeThinking,
              codexModel: (savedCodexModels[sessionId] as CodexModelId) || prev?.codexModel || undefined,
              codexReasoningEffort: (savedCodexReasoningEfforts[sessionId] as CodexReasoningEffort) || prev?.codexReasoningEffort || undefined,
              planMode: savedPlanModes[sessionId] ?? prev?.planMode,
              noHistory: savedNoHistories[sessionId] ?? prev?.noHistory,
            };
          });

          // Activation priority: same-window target > URL sessionId >
          // session.json activeSessionId > first.
          // A persisted null is meaningful: the user was on a blank New Chat,
          // so restore one instead of silently falling back to the first session.
          const activeSessionToUse = storedSessionId || initialSessionId || savedActiveSessionId;
          let activeIndex = activeSessionToUse ? allSessions.indexOf(activeSessionToUse) : -1;
          if (activeIndex < 0) activeIndex = 0;

          const restoreBlankActive = storedTarget?.kind === 'blank'
            || (!storedTarget && !initialSessionId && (initialBlank || savedActiveSessionId === null));
          const blankActiveTab: TabInfo | undefined = restoreBlankActive
            ? { id: `tab-${Date.now()}-blank`, cwd: initialCwd, title: 'New Chat' }
            : undefined;
          const tabsToRestore = blankActiveTab ? [...restoredTabs, blankActiveTab] : restoredTabs;
          const newActiveTabId = blankActiveTab?.id ?? restoredTabs[activeIndex].id;

          /**
           * Restore the pane layout, if there was one.
           *
           * A `null` entry, or an id whose session is gone, becomes a fresh
           * blank chat rather than an empty pane — the invariant is that every
           * visible pane holds a real tab (see closeTab), and it has to hold on
           * the restore path too, not just at runtime.
           *
           * The active session still wins over the saved layout: deep-linking to
           * a session that is not in either pane has to show it, so it takes the
           * active pane. If that makes both panes the same tab, the layout
           * collapses to one — two panes on one tab is the other thing the
           * invariant forbids.
           */
          const savedPanes = data.paneSessionIds;
          if (Array.isArray(savedPanes) && savedPanes.length > 1) {
            // Sessions -> tab ids; an entry that resolves to nothing (never had
            // a session, or it has been closed since) is left as '' for
            // repairPanes to fill by the same rule every other site uses.
            const wanted = savedPanes.slice(0, 2).map((sid) => {
              const normalized = sid && rawEngines[sid] === 'codex' ? normalizeCodexSessionId(sid) : sid;
              return (normalized && restoredTabs.find((t) => t.sessionId === normalized)?.id) || '';
            });
            const { panes: paneIds, created } = repairPanes(wanted, tabsToRestore, initialCwd);

            // The active session outranks the saved layout: deep-linking to a
            // session in neither pane still has to show it, so it takes the
            // active pane. If that collapses both panes onto one tab, drop to a
            // single pane — the other half of the invariant.
            let pane = paneIds.indexOf(newActiveTabId);
            if (pane === -1) { paneIds[0] = newActiveTabId; pane = 0; }
            const collapsed = paneIds[0] === paneIds[1];

            setTabs([...tabsToRestore, ...created]);
            setPaneTabIds(collapsed ? [paneIds[0]] : paneIds);
            setActivePane(collapsed ? 0 : pane);
          } else {
            setTabs(tabsToRestore);
            setActiveTabId(newActiveTabId);
          }

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
  }, [initialCwd, initialSessionId, initialBlank, finishInitializing]);

  // Save to server when tabs or activeTabId changes — and once more the moment
  // initialization ends, to flush anything resolved while saving was suppressed.
  useEffect(() => {
    if (!initDone || !initialCwd) return;

    const sessionIds = tabs
      .map(tab => tab.sessionId)
      .filter((id): id is string => !!id);

    const activeTab = tabs.find(t => t.id === activeTabId);
    const activeSessionId = activeTab?.sessionId ?? null;

    // Build engine map for tabs that have a non-default engine
    const engines: Record<string, string> = {};
    const ollamaModels: Record<string, string> = {};
    const deepseekModels: Record<string, string> = {};
    const kimiModels: Record<string, string> = {};
    const glmModels: Record<string, string> = {};
    const claudeModels: Record<string, string> = {};
    const claudeEfforts: Record<string, string> = {};
    const claudeContextWindows: Record<string, string> = {};
    const claudeFastModes: Record<string, boolean> = {};
    const claudeThinkings: Record<string, boolean> = {};
    const codexModels: Record<string, string> = {};
    const codexReasoningEfforts: Record<string, string> = {};
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
      if (tab.sessionId && tab.glmModel) {
        glmModels[tab.sessionId] = tab.glmModel;
      }
      if (tab.sessionId && tab.claudeModel) {
        claudeModels[tab.sessionId] = tab.claudeModel;
      }
      if (tab.sessionId && tab.claudeEffort) {
        claudeEfforts[tab.sessionId] = tab.claudeEffort;
      }
      if (tab.sessionId && tab.claudeContextWindow) {
        claudeContextWindows[tab.sessionId] = tab.claudeContextWindow;
      }
      if (tab.sessionId && tab.codexModel) {
        codexModels[tab.sessionId] = tab.codexModel;
      }
      if (tab.sessionId && tab.codexReasoningEffort) {
        codexReasoningEfforts[tab.sessionId] = tab.codexReasoningEffort;
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
        if (tab.planMode !== undefined) planModes[tab.sessionId] = tab.planMode;
        if (tab.noHistory !== undefined) noHistories[tab.sessionId] = tab.noHistory;
        if (tab.claudeFastMode !== undefined) claudeFastModes[tab.sessionId] = tab.claudeFastMode;
        if (tab.claudeThinking !== undefined) claudeThinkings[tab.sessionId] = tab.claudeThinking;
      }
    }

    // Sessions closed in this tab since the last save → the server subtracts them from the
    // shared union (saves otherwise only ADD, never shrink). Snapshot but do NOT drain yet:
    // removal is the ONLY shrink path and the union has no memory, so a `closedSessionIds`
    // lost to a failed POST = a ghost session that re-materializes forever. Clear each id
    // only AFTER the save succeeds (and only those ids — closes that arrive mid-flight stay
    // pending for the next save).
    const closedSessionIds = [...pendingClosedRef.current];

    // Pane layout, by session, in on-screen order. Sent even when single-pane
    // (length 1): the server stores it only at length > 1, so a length-1 array
    // is how "split turned off" is persisted. Omitting the key instead would
    // leave the old layout on disk, since the server keeps what it has.
    const paneSessionIds = paneTabIds.map(
      (id) => tabs.find((t) => t.id === id)?.sessionId ?? null
    );

    const stateToSave = {
      cwd: initialCwd,
      sessions: sessionIds,
      activeSessionId,
      paneSessionIds,
      engines,
      ollamaModels,
      deepseekModels,
      kimiModels,
      glmModels,
      claudeModels,
      claudeEfforts,
      claudeContextWindows,
      claudeFastModes,
      claudeThinkings,
      codexModels,
      codexReasoningEfforts,
      planModes,
      noHistories,
      ...(closedSessionIds.length ? { closedSessionIds } : {}),
    };

    if (!saveRunnerRef.current) {
      saveRunnerRef.current = createLatestTaskRunner(async (snapshot) => {
        const exit = await BrowserRuntime.runPromiseExit(saveProjectState(snapshot));
        if (exit._tag === 'Success') {
          for (const id of snapshot.closedSessionIds ?? []) pendingClosedRef.current.delete(id);
        } else {
          console.error('Failed to save sessions:', exit.cause);
        }
      });
    }
    saveRunnerRef.current.enqueue(stateToSave);
  }, [tabs, activeTabId, paneTabIds, initialCwd, initDone]);

  // Notify parent Workspace when switching tab (parent handles URL update)
  useLayoutEffect(() => {
    if (isInitializingRef.current || !initialCwd) return;

    const sessionId = tabs.find(t => t.id === activeTabId)?.sessionId;
    const target: ActiveTabTarget = sessionId
      ? { kind: 'session', sessionId }
      : { kind: 'blank' };
    BrowserRuntime.runSync(
      saveActiveTabTarget(initialCwd, target).pipe(Effect.catchAll(() => Effect.void))
    );
    publishTopic(Topics.SessionChange, {
      cwd: initialCwd,
      sessionId: sessionId ?? null,
    });
  }, [activeTabId, tabs, initialCwd, initDone]);

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
      const rawEngines = (data.engines || {}) as Record<string, string>;
      const engines: Record<string, string> = {};
      for (const [sid, engine] of Object.entries(rawEngines)) {
        engines[engine === 'codex' ? normalizeCodexSessionId(sid) : sid] = engine;
      }
      const saved: string[] = [];
      for (const sid of data.sessions || []) {
        const normalized = rawEngines[sid] === 'codex' ? normalizeCodexSessionId(sid) : sid;
        if (!saved.includes(normalized)) saved.push(normalized);
      }
      const ollamaModels = (data.ollamaModels || {}) as Record<string, string>;
      const deepseekModels = (data.deepseekModels || {}) as Record<string, string>;
      const kimiModels = (data.kimiModels || {}) as Record<string, string>;
      const glmModels = (data.glmModels || {}) as Record<string, string>;
      const claudeModels = (data.claudeModels || {}) as Record<string, string>;
      const claudeEfforts = (data.claudeEfforts || {}) as Record<string, string>;
      const claudeContextWindows = (data.claudeContextWindows || {}) as Record<string, string>;
      const claudeFastModes = (data.claudeFastModes || {}) as Record<string, boolean>;
      const claudeThinkings = (data.claudeThinkings || {}) as Record<string, boolean>;
      const codexModels = (data.codexModels || {}) as Record<string, string>;
      const codexReasoningEfforts = (data.codexReasoningEfforts || {}) as Record<string, string>;
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
        glmModel: (glmModels[sid] as EngineModelId) || undefined,
        claudeModel: (claudeModels[sid] as ClaudeModelId) || undefined,
        claudeEffort: (claudeEfforts[sid] as ClaudeEffort) || undefined,
        claudeContextWindow: (claudeContextWindows[sid] as ClaudeContextWindow) || undefined,
        claudeFastMode: claudeFastModes[sid] ?? undefined,
        claudeThinking: claudeThinkings[sid] ?? undefined,
        codexModel: (codexModels[sid] as CodexModelId) || undefined,
        codexReasoningEffort: (codexReasoningEfforts[sid] as CodexReasoningEffort) || undefined,
        planMode: planModes[sid] || undefined,
        noHistory: noHistories[sid] || undefined,
      }));
      let next = [...kept, ...added];
      // never leave the tab bar empty (tabs[0].id is read every render)
      if (next.length === 0) {
        next = [{ id: `tab-${Date.now()}`, cwd: initialCwd, title: 'New Chat' }];
      }
      // A session closed in ANOTHER browser tab vacates a pane here exactly as
      // closeTab does locally, so the same invariant has to be re-established.
      // This site had no enforcement at all: a pane kept pointing at a removed
      // tab id, and silently stopped rendering.
      const { panes, created } = repairPanes(paneTabIdsRef.current, next, initialCwd);
      if (created.length) next = [...next, ...created];
      setTabs(next);
      setPaneTabIds(panes);
    });
  }, [initialCwd]);

  const handleGlobalStateMessage = useCallback((raw: unknown) => {
    if (!initialCwd) return;
    const message = raw as {
      type?: string;
      cwd?: string;
      closedSessionIds?: string[];
      data?: { sessions?: GlobalSessionStatusSnapshot[] };
    };

    if (message.type === 'global-state' && Array.isArray(message.data?.sessions)) {
      globalSessionsRef.current = message.data.sessions;
      if (!isInitializingRef.current) {
        syncUnreadTabsFromGlobalState(message.data.sessions);
      }
      return;
    }

    if (
      !isInitializingRef.current
      && message.type === 'project-state-changed'
      && message.cwd === initialCwd
    ) {
      reconcileTabs(message.closedSessionIds ?? []);
    }
  }, [initialCwd, reconcileTabs, syncUnreadTabsFromGlobalState]);

  useWebSocket({
    url: '/ws/global-state',
    enabled: !!initialCwd,
    onMessage: handleGlobalStateMessage,
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
      glmModel?: EngineModelId;
      claudeModel?: ClaudeModelId;
      claudeEffort?: ClaudeEffort;
      claudeContextWindow?: ClaudeContextWindow;
      claudeFastMode?: boolean;
      claudeThinking?: boolean;
      codexModel?: CodexModelId;
      codexReasoningEffort?: CodexReasoningEffort;
      planMode?: boolean;
      noHistory?: boolean;
      appendToEnd?: boolean;
    }
  ) => {
    const { engine, ollamaModel, deepseekModel, kimiModel, glmModel, claudeModel, claudeEffort, claudeContextWindow, claudeFastMode, claudeThinking, codexModel, codexReasoningEffort, planMode, noHistory, appendToEnd = false } = opts ?? {};
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd,
      sessionId,
      title: title || (sessionId ? `Session ${sessionId.slice(0, 6)}...` : 'New Chat'),
      engine,
      ollamaModel,
      deepseekModel,
      kimiModel,
      glmModel,
      claudeModel,
      claudeEffort,
      claudeContextWindow,
      claudeFastMode,
      claudeThinking,
      codexModel,
      codexReasoningEffort,
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

    // Pane repair is shared with the restore and cross-tab-reconcile paths —
    // see repairPanes for the invariant and why it lives in one place.
    const remaining = tabsRef.current.filter((t) => t.id !== tabId);
    const { panes, created } = repairPanes(paneTabIdsRef.current, remaining, initialCwd);

    setTabs([...remaining, ...created]);
    setPaneTabIds(panes);
  }, [initialCwd]);

  // Close every tab at once, then reset to a single blank tab. Mirrors closeTab's
  // shared-union bookkeeping: record all sessionIds so the next save removes them
  // from the shared set and broadcasts the removals to other browser tabs.
  const closeAllTabs = useCallback(() => {
    // Collapse to one pane as well: a single surviving blank tab cannot fill
    // two, and the invariant forbids leaving one of them empty.
    setActivePane(0);
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
        ollamaModel: data?.ollamaModels?.[sid],
        deepseekModel: data?.deepseekModels?.[sid] as DeepseekModel | undefined,
        kimiModel: data?.kimiModels?.[sid] as EngineModelId | undefined,
        glmModel: data?.glmModels?.[sid] as EngineModelId | undefined,
        claudeModel: data?.claudeModels?.[sid] as ClaudeModelId | undefined,
        claudeEffort: data?.claudeEfforts?.[sid] as ClaudeEffort | undefined,
        claudeContextWindow: data?.claudeContextWindows?.[sid] as ClaudeContextWindow | undefined,
        claudeFastMode: data?.claudeFastModes?.[sid],
        claudeThinking: data?.claudeThinkings?.[sid],
        codexModel: data?.codexModels?.[sid] as CodexModelId | undefined,
        codexReasoningEffort: data?.codexReasoningEfforts?.[sid] as CodexReasoningEffort | undefined,
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

  // Create new Codex tab (appended to end)
  const handleNewCodexTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Codex Chat', { engine: 'codex', appendToEnd: true });
  }, [initialCwd, addTab]);

  // Create new Kimi tab (appended to end). Seed the tab with the preferred model so the
  // picker and the first request agree before any session state has been persisted.
  const handleNewKimiTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New Kimi Chat', { engine: 'kimi', kimiModel: 'k3', appendToEnd: true });
  }, [initialCwd, addTab]);

  // Create new GLM tab (appended to end). Seeded with an explicit model for the same reason
  // kimi is: the tab's model must be DECIDED at creation, otherwise nothing is persisted for
  // the session and the picker has no value to show until the first round trip.
  const handleNewGlmTab = useCallback(() => {
    addTab(initialCwd, undefined, 'New GLM Chat', { engine: 'glm', glmModel: 'glm-5.3', appendToEnd: true });
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

  // Update GLM model for a tab
  const updateTabGlmModel = useCallback((tabId: string, model: EngineModelId) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, glmModel: model } : tab
      )
    );
  }, []);

  const updateTabClaudeModel = useCallback((tabId: string, model: ClaudeModelId) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, claudeModel: model } : tab
      )
    );
  }, []);

  const updateTabClaudeEffort = useCallback((tabId: string, effort: ClaudeEffort) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, claudeEffort: effort } : tab
      )
    );
  }, []);

  const updateTabClaudeContextWindow = useCallback((tabId: string, claudeContextWindow: ClaudeContextWindow) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, claudeContextWindow } : tab
      )
    );
  }, []);

  const updateTabClaudeFastMode = useCallback((tabId: string, claudeFastMode: boolean) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, claudeFastMode } : tab
      )
    );
  }, []);

  const updateTabClaudeThinking = useCallback((tabId: string, claudeThinking: boolean) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, claudeThinking } : tab
      )
    );
  }, []);

  const updateTabCodexModel = useCallback((tabId: string, model: CodexModelId) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, codexModel: model } : tab
      )
    );
  }, []);

  const updateTabCodexReasoningEffort = useCallback((tabId: string, codexReasoningEffort: CodexReasoningEffort) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, codexReasoningEffort } : tab
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
  // its source, so the new tab inherits the source tab's engine/model rather than
  // starting as "unknown" (which every downstream check would read as claude).
  const handleOpenSession = useCallback((sid: string, title?: string) => {
    const source = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    addTab(initialCwd, sid, title, {
      engine: source?.engine,
      ollamaModel: source?.ollamaModel,
      deepseekModel: source?.deepseekModel,
      kimiModel: source?.kimiModel,
      glmModel: source?.glmModel,
      claudeModel: source?.claudeModel,
      claudeEffort: source?.claudeEffort,
      claudeContextWindow: source?.claudeContextWindow,
      claudeFastMode: source?.claudeFastMode,
      claudeThinking: source?.claudeThinking,
      codexModel: source?.codexModel,
      codexReasoningEffort: source?.codexReasoningEffort,
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
  // One toggle for the whole panel.
  //
  // Opening pairs the active tab with the one to its RIGHT, or the one before
  // it at the end of the bar, or a brand new chat when there is nothing to pair
  // with. Closing keeps the pane you were looking at, so it is never lossy.
  const toggleSideBySide = useCallback(() => {
    const panes = paneTabIdsRef.current;
    if (panes.length > 1) {
      setPaneTabIds([panes[activePaneRef.current]]);
      setActivePane(0);
      return;
    }
    const list = tabsRef.current;
    const idx = list.findIndex((t) => t.id === panes[0]);
    const neighbour = list[idx + 1] ?? list[idx - 1];
    if (neighbour) {
      setPaneTabIds([panes[0], neighbour.id]);
      setActivePane(0);
      return;
    }
    const blank: TabInfo = { id: `tab-${Date.now()}`, cwd: initialCwd, title: 'New Chat' };
    setTabs((prev) => [...prev, blank]);
    setPaneTabIds([panes[0], blank.id]);
    setActivePane(1);
  }, [initialCwd]);

  // Close ONE column of the split: that pane is dropped and the survivor gets
  // the whole panel back. The tab itself stays open in the bar — this closes a
  // view, not a session; closing the session is the tab bar's own ✕ (closeTab).
  // Keeping both is why the pane invariant is untouched here: no pane is left
  // empty and no tab is left in two panes, because a pane is only ever removed.
  const closePane = useCallback((pane: number) => {
    const panes = paneTabIdsRef.current;
    if (panes.length < 2) return;
    setPaneTabIds(panes.filter((_, i) => i !== pane));
    setActivePane(0);
  }, []);

  const focusPane = useCallback((pane: number) => {
    setActivePane(pane);
  }, []);

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
    paneTabIds,
    activePane,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,

    // Tab operations
    addTab,
    toggleSideBySide,
    focusPane,
    closePane,
    closeTab,
    closeAllTabs,
    switchTab,
    handleSelectSession,
    handleNewTab,
    handleNewCodexTab,
    handleNewKimiTab,
    handleNewGlmTab,
    handleNewOllamaTab,
    handleNewDeepseekTab,
    handleOpenSession,
    updateTabState,
    updateTabEngine,
    updateTabOllamaModel,
    updateTabDeepseekModel,
    updateTabKimiModel,
    updateTabGlmModel,
    updateTabClaudeModel,
    updateTabClaudeEffort,
    updateTabClaudeContextWindow,
    updateTabClaudeFastMode,
    updateTabClaudeThinking,
    updateTabCodexModel,
    updateTabCodexReasoningEffort,
    updateTabPlanMode,
    updateTabNoHistory,

    // Drag operations
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  };
}
