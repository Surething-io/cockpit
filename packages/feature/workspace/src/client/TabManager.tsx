'use client';

import { useState, useEffect, useCallback, useRef , useMemo} from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectSessionsModal, ComposerSlotProvider } from '@cockpit/feature-agent';
import { FileBrowserModal } from '@cockpit/feature-explorer';
import { GitWorktreeModal } from '@cockpit/feature-explorer';
import { ConsoleView, AliasManager } from '@cockpit/feature-console';
import { ChatProvider, FileDiffViewer } from '@cockpit/feature-agent';
import type { ToolCallInfo } from '@cockpit/feature-agent';
import { nextFileDiffRequest, type FileDiffRequest } from './fileDiffRequest';
import { paneLayout, paneClass, maximizedTabId, type PaneLayout } from './paneLayout';
import { SwipeableViewContainer, SwipeableContent, type ViewType } from '@cockpit/shared-ui';
import { PanelPortalProvider } from '@cockpit/shared-ui';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { Maximize, Minimize } from 'lucide-react';
import { ChatPanel } from '@cockpit/feature-agent';
import { useWebSocket } from '@cockpit/shared-ui';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { Effect } from 'effect';
import { IframeBus, Topics } from '@cockpit/effect-services';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadProjectSettings,
  saveProjectSettings,
  loadGitWorktrees,
} from './effect/workspaceClient';
import { updateSessionStatus, markScheduledTasksReadBySession } from './effect/stateClient';

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
  /** View to force on mount (from the URL). When set, it overrides the saved project view. */
  initialView?: ViewType;
}

/**
 * The props a pane needs to describe its NEIGHBOUR to the chat inside it.
 *
 * Feeds the message footer's "send this message to the other column" button.
 * Layout is a workspace concern and Chat does not know it sits in a column, so
 * rather than pushing pane state down into the chat domain we hand each Chat
 * only the two facts it needs: who the neighbour is (an opaque tab id it can
 * address through ChatContext.sendToTab) and which side that neighbour is on
 * (so the button can point an arrow at it).
 *
 * `layout.panes` is indexed BY SIDE, so `1 - at` is the neighbour and `at === 0`
 * means this pane is the left one. Both are undefined outside split mode, which
 * is exactly what hides the button in the single-pane case.
 */
function peerProps(tabId: string, layout: PaneLayout): { peerTabId?: string; peerSide?: 'left' | 'right' } {
  if (!layout.split) return {};
  const at = layout.panes.indexOf(tabId);
  if (at === -1) return {};
  return { peerTabId: layout.panes[1 - at], peerSide: at === 0 ? 'right' : 'left' };
}

/**
 * One column of the split, plus the hover-only ✕ that closes it.
 *
 * The ✕ closes the COLUMN, not the chat: the pane is dropped, the survivor
 * takes the whole panel, and the tab stays in the bar exactly where it was.
 * Closing the session is still the tab bar's own ✕. Two different destructive
 * actions, so they live on two different controls rather than one that means
 * whichever the layout happens to be in.
 *
 * It is an overlay owned here rather than a button inside Chat's toolbar
 * because panes are a workspace concern — Chat does not know it is in a column,
 * and threading a close callback through ChatPanel → Chat → every engine's
 * toolbar row would push layout state down into the chat domain. The cost is
 * that it floats over the top-right of whatever row Chat renders there, so it
 * stays a bare icon — small, and invisible until the pane is hovered.
 *
 * Small is not enough on its own: it still drew directly on top of that row's
 * rightmost control. The row keeps clear by reserving the width instead
 * (ENGINE_OPTIONS_ROW in Chat.tsx), which means the corner group's geometry
 * here — `right-1`, two `w-6` buttons, `gap-0.5` — is load bearing over there.
 * Adding, removing or resizing a control here means changing that reservation
 * in the same commit; it has already had to grow once.
 *
 * Hidden with opacity rather than `hidden`, so a keyboard Tab can still reach
 * it (display:none would take it out of the tab order entirely).
 *
 * The group is NAMED (`group/pane`), and that is load-bearing rather than
 * stylistic. Tailwind compiles a bare `group-hover:x` to
 * `.group-hover\:x:is(:where(.group):hover *)` — a descendant selector that
 * matches ANY `.group` ancestor, not the nearest one. An unnamed group on a
 * container therefore does not scope hover to that container; it seizes the
 * hover scope of everything below it. Bare `group` shipped here once and made
 * every message in the pane show its hover footer at once, because a pane is an
 * ancestor of every bubble. Every other `group` in this codebase sits on a leaf
 * row or card, where "nearest" and "any" coincide; a panel-level one must be
 * named.
 */
function PaneShell({
  tabId,
  panes,
  activePane,
  row,
  maximized,
  onFocusPane,
  onClosePane,
  onToggleMaximize,
  children,
}: {
  tabId: string;
  panes: string[];
  activePane: number;
  row: boolean;
  maximized: boolean;
  onFocusPane: (pane: number) => void;
  onClosePane: (pane: number) => void;
  onToggleMaximize: (pane: number) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const at = panes.indexOf(tabId);
  const split = panes.length > 1;
  // `at` indexes `panes`, while onFocusPane/onClosePane index `paneTabIds`.
  // They are the same array whenever `split` holds: the only thing that
  // narrows `panes` is an open diff column, and that leaves exactly one pane.
  // Both callbacks are wired only under `split`, so the indices always agree.
  return (
    <div
      onMouseDownCapture={split ? () => onFocusPane(at) : undefined}
      style={row && at !== -1 && !maximized ? { order: at } : undefined}
      className={`group/pane ${paneClass(tabId, panes, activePane, row, maximized)}`}
    >
      {split && at !== -1 && (
        // Both corner controls in one hover-revealed group. The reveal moved
        // from the buttons to this container so the two cannot fade
        // independently, and `focus-within` replaces the per-button
        // `focus-visible` for the same reason — opacity-0 keeps them in the tab
        // order, and a Tab into either one must bring the pair into view.
        <div className="absolute top-1 right-1 z-20 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity focus-within:opacity-100 focus-within:pointer-events-auto group-hover/pane:opacity-100 group-hover/pane:pointer-events-auto">
          <button
            type="button"
            onClick={() => onToggleMaximize(at)}
            title={maximized ? t('chat.restorePane') : t('chat.maximizePane')}
            aria-label={maximized ? t('chat.restorePane') : t('chat.maximizePane')}
            aria-pressed={maximized}
            className="flex items-center justify-center w-6 h-6 text-muted-foreground transition-colors hover:text-foreground"
          >
            {maximized ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => onClosePane(at)}
            title={t('chat.closePane')}
            aria-label={t('chat.closePane')}
            className="flex items-center justify-center w-6 h-6 text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

export function TabManager({ initialCwd, initialSessionId, initialView }: TabManagerProps) {
  const { t } = useTranslation();
  // activeView must be declared before useTabState, as useTabState needs it to determine unread state
  const [activeView, setActiveView] = useState<ViewType>(initialView ?? 'agent');
  // Mount node for the shared composer, published to Chat through
  // ComposerSlotProvider. State rather than a ref: the panes must re-render
  // once the node exists, or the focused Chat portals into null on first paint.
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);

  // Tab state management
  const {
    tabs,
    activeTabId,
    activeTab,
    paneTabIds,
    activePane,
    toggleSideBySide,
    focusPane,
    closePane,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,
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
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  } = useTabState({ initialCwd, initialSessionId, activeView });



  // Pin state management
  const { isPinned, pinSession, unpinSession } = usePinnedSessions();

  // Scheduled tasks
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

  // UI state
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isWorktreeOpen, setIsWorktreeOpen] = useState(false);
  const [isAliasManagerOpen, setIsAliasManagerOpen] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [fileBrowserInitialTab, setFileBrowserInitialTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');
  const [tabSwitchTrigger, setTabSwitchTrigger] = useState(0);
  const [fileBrowserSearchQuery, setFileBrowserSearchQuery] = useState<string | null>(null);
  const [searchQueryTrigger, setSearchQueryTrigger] = useState(0);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ path: string; lineNumber?: number; nonce: number } | null>(null);
  // Message-level "view all file changes": a column in the RIGHT HALF of the
  // agent panel, beside the chat that opened it. Null = not showing.
  //
  // It used to overlay the FileBrowser on panel 2, which meant every viewing of
  // a diff swiped the chat you were reading off screen — the one thing you want
  // beside a diff is the turn that produced it.
  const [fileDiffRequest, setFileDiffRequest] = useState<FileDiffRequest | null>(null);

  // A diff column and a second chat pane are the same right half of the panel,
  // so they are mutually exclusive — derived in paneLayout, enforced nowhere.
  const diffOpen = fileDiffRequest !== null;
  const layout = useMemo(
    () => paneLayout(paneTabIds, activePane, activeTabId, diffOpen),
    [paneTabIds, activePane, activeTabId, diffOpen],
  );
  // Forced chat refresh signal: bumped when a SWITCH_SESSION jump targets a session whose
  // tab already exists. Activating an already-active tab produces no isActive rising edge
  // in Chat, so without this a jump from the scheduled-tasks / recent / pinned panels would
  // never re-fetch messages appended externally (e.g. a scheduled-task run).
  const [sessionRefresh, setSessionRefresh] = useState<{ sessionId: string; nonce: number } | null>(null);
  const [projectNumber, setProjectNumber] = useState<number | undefined>();

  useEffect(() => {
    // The parent's initial visibility message may precede this frame's listener.
    // Request the current number explicitly so project badges never depend on mount timing.
    // eslint-disable-next-line no-restricted-syntax
    window.parent.postMessage({ type: 'GET_PROJECT_NUMBER', cwd: initialCwd }, '*');
  }, [initialCwd]);

  // Restore activeView from project-settings. Skip when the URL forced a view
  // (initialView): a "jump into a session" open must land on the requested view
  // rather than whatever view this project was last left on.
  useEffect(() => {
    if (!initialCwd || initialView) return;
    BrowserRuntime.runPromiseExit(loadProjectSettings(initialCwd)).then((exit) => {
      if (exit._tag === 'Success') {
        const settings = exit.value.settings as { activeView?: ViewType } | undefined;
        if (settings?.activeView) setActiveView(settings.activeView);
      }
    });
  }, [initialCwd, initialView]);

  // Screenshot state: auto-switch to console view + top banner + restore after screenshot completes
  const [screenshotActive, setScreenshotActive] = useState(false);
  const preScreenshotViewRef = useRef<ViewType | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { active } = (e as CustomEvent).detail;
      if (active) {
        // Screenshot started: save current view and switch to console
        preScreenshotViewRef.current = activeView;
        setActiveView('console');
        setScreenshotActive(true);
      } else {
        // Screenshot finished: restore previous view
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

  // Persist activeView on panel switch and notify parent Workspace
  const handleViewChange = useCallback((view: ViewType) => {
    setActiveView(view);
    if (!initialCwd) return;
    BrowserRuntime.runFork(
      saveProjectSettings({ cwd: initialCwd, settings: { activeView: view } }).pipe(
        Effect.orElse(() => Effect.void)
      )
    );
    // v2: publish via IframeBus; automatically emits both v1-compat and v2 formats.
    BrowserRuntime.runFork(
      Effect.flatMap(IframeBus, (bus) =>
        bus.publish(Topics.ViewChange, { cwd: initialCwd, view })
      )
    );
  }, [initialCwd]);

  // Swipe to the console panel when another panel asks to open a browser bubble
  // there (chat HTML preview's "open in Console" button). ConsoleView is always
  // mounted and creates the bubble off the same window event; here we just make
  // the console panel visible.
  useEffect(() => {
    const handler = () => handleViewChange('console');
    window.addEventListener('console-open-browser', handler);
    return () => window.removeEventListener('console-open-browser', handler);
  }, [handleViewChange]);

  // Load Git repository info (branch)
  const loadGitInfo = useCallback(async () => {
    if (!initialCwd) return;
    const exit = await BrowserRuntime.runPromiseExit(loadGitWorktrees(initialCwd));
    if (exit._tag === 'Success') {
      const data = exit.value as {
        isGitRepo?: boolean;
        worktrees?: Array<{ path: string; branch: string }>;
      };
      setIsGitRepo(!!data.isGitRepo);
      if (data.isGitRepo && data.worktrees && data.worktrees.length > 0) {
        const currentWorktree = data.worktrees.find((w) => w.path === initialCwd);
        if (currentWorktree) {
          setCurrentBranch(currentWorktree.branch);
        }
      }
    } else {
      console.error('Failed to load git info:', exit.cause);
    }
  }, [initialCwd]);

  useEffect(() => { queueMicrotask(() => loadGitInfo()); }, [loadGitInfo]);

  // Listen for git change events and update branch name in real time
  const handleWatchMessage = useCallback((msg: unknown) => {
    // `/ws/watch` carries more than file events (e.g. `graphProgress`, whose
    // `data` is an object) — guard the shape instead of assuming an array.
    const { data } = msg as { type: string; data: unknown };
    if (Array.isArray(data) && data.some((e: { type?: string }) => e.type === 'git')) {
      loadGitInfo();
    }
  }, [loadGitInfo]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(initialCwd || '')}`,
    onMessage: handleWatchMessage,
    enabled: !!initialCwd,
  });

  // Keyboard shortcuts: Cmd+1/2/3 to switch views;
  // also globally swallow Cmd+S so the browser's "Save Page As..." never leaks
  // through on panels without an active editor. When a CodeViewer/FileEditorModal
  // is mounted, it registers its own document-level listener and still receives
  // the event to actually save.
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
        } else if (e.key === 's') {
          // no-op: prevent browser "Save Page As..." default.
          // Editors (CodeViewer/FileEditorModal) handle Cmd+S themselves when open.
          e.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Push this frame's tab order up on every change (open / close / drag reorder).
  // The parent's sidebar numbers its session badges from this; polling on demand
  // would leave them stale for as long as a drag goes unnoticed, and state.json
  // cannot substitute (its session list is merged as a union, stored order first,
  // so a pure reorder round-trips unchanged).
  useEffect(() => {
    if (!initialCwd || window.parent === window) return;
    // eslint-disable-next-line no-restricted-syntax
    window.parent.postMessage({
      type: 'SESSION_NUMBERS',
      cwd: initialCwd,
      sessionIds: tabs.map((tab) => tab.sessionId ?? null),
    }, '*');
  }, [initialCwd, tabs]);

  // Listen for messages from the parent window (used by Workspace to switch sessions)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'PROJECT_NUMBER' && typeof event.data?.projectNumber === 'number') {
        setProjectNumber(event.data.projectNumber);
        return;
      }
      if (event.data?.type === 'IFRAME_VISIBILITY' && typeof event.data?.projectNumber === 'number') {
        setProjectNumber(event.data.projectNumber);
      }
      if (event.data?.type === 'GET_SESSION_NUMBERS' && event.data?.requestId && initialCwd) {
        // Cross-iframe request/reply: the parent cannot observe this frame's live
        // tab order through the app-level topic bus.
        // eslint-disable-next-line no-restricted-syntax
        window.parent.postMessage({
          type: 'SESSION_NUMBERS',
          requestId: event.data.requestId,
          cwd: initialCwd,
          sessionIds: tabs.map((tab) => tab.sessionId ?? null),
        }, '*');
        return;
      }
      if (event.data?.type === 'SWITCH_SESSION') {
        const { sessionId, switchToAgent } = event.data;
        if (sessionId) {
          handleSelectSession(sessionId);
          // When navigating from sidebar (recent/pinned sessions/scheduled tasks), auto-switch to Agent view
          if (switchToAgent) {
            handleViewChange('agent');
          }
          // User viewed this session → write state.json as normal (skip sessions still loading to avoid clearing the unread indicator prematurely)
          const targetTab = tabs.find(t => t.sessionId === sessionId);
          // Existing tab (possibly already active → no rising edge): force Chat to
          // re-fetch the latest messages from disk. New tabs load history in full anyway.
          if (targetTab) {
            setSessionRefresh(prev => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
          }
          if (initialCwd && !targetTab?.isLoading) {
            BrowserRuntime.runFork(
              updateSessionStatus(initialCwd, sessionId, 'normal').pipe(
                Effect.orElse(() => Effect.void)
              )
            );
            // Also clear scheduled-task unread for this session: jumping in via
            // SWITCH_SESSION (recent/pinned sessions) otherwise never decrements
            // the scheduled-task unread badge — only the scheduled-tasks panel did.
            BrowserRuntime.runFork(
              markScheduledTasksReadBySession(sessionId).pipe(
                Effect.orElse(() => Effect.void)
              )
            );
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleSelectSession, handleViewChange, initialCwd, tabs]);

  // Open the Git Status view
  const handleShowGitStatus = useCallback(() => {
    setFileBrowserInitialTab('status');
    setTabSwitchTrigger(n => n + 1);
    handleViewChange('explorer');
  }, [handleViewChange]);

  // Project-wide content search (triggered from Chat)
  const handleContentSearch = useCallback((query: string) => {
    setFileBrowserSearchQuery(query);
    setSearchQueryTrigger(n => n + 1);
    handleViewChange('explorer');
  }, [handleViewChange]);

  // Stable onClose for the (memoized) Explorer panel so a chat-tab/session switch
  // — which re-renders TabManager — doesn't re-render the whole FileBrowser subtree.
  const handleExplorerClose = useCallback(() => handleViewChange('agent'), [handleViewChange]);

  // Whether the diff column is currently taking the whole pane row instead of
  // half of it. Deliberately NOT a third case in paneLayout: full-width is done
  // by lifting the diff column out of the flex row (`absolute inset-0`) rather
  // than by shrinking the panes to none, so the panes never move. Nothing about
  // this reaches the layout model — the new state stays inside the one element
  // whose geometry it describes.
  //
  // Not collapsing the panes is what makes it safe as well as simple. Hiding a
  // live chat that Chat still believes is active is a state this app has never
  // been in, and Chat's `isActive` carries known scroll behaviour for hidden
  // tabs; covering the panes leaves them laid out exactly as they were.
  const [diffFullscreen, setDiffFullscreen] = useState(false);
  // Full width is per-viewing, not a remembered preference: reopening a diff
  // should land in the column it lives in, or the next FileDiff click would take
  // over the panel on the strength of a choice made minutes ago.
  //
  // Cleared on the EDGE rather than inside the close handler. Today there is
  // exactly one path that empties `fileDiffRequest`, so a paired statement in
  // that handler would also be correct — but it would be encoding "there is
  // currently one close path", not "any close clears this". The pane maximise
  // below already had to learn that difference the expensive way.
  useEffect(() => {
    if (!diffOpen) setDiffFullscreen(false);
  }, [diffOpen]);

  // Whether a pane is blown up to cover the row. WHICH pane is not stored —
  // `maximizedTabId` derives it from the focus, so the two cannot disagree.
  // See that function for the bug this shape exists to make unrepresentable.
  const [maximized, setMaximized] = useState(false);
  //
  // Two mechanisms, two jobs. The gate inside `maximizedTabId` keeps the DERIVED
  // value honest in the very frame the split disappears; the effect keeps the
  // STATE from going stale afterwards. The diff column above needs only the
  // effect, because its whole subtree is already gated on `fileDiffRequest`
  // being non-null — a stale `true` there cannot render anything.
  const maximizedTab = maximizedTabId(layout, maximized);
  useEffect(() => {
    if (!layout.split) setMaximized(false);
  }, [layout.split]);

  // Focus follows, always. The shared composer belongs to the FOCUSED pane, so
  // blowing up a pane you are not focused on would leave you reading one column
  // and typing into the one it just covered.
  //
  // A plain toggle is unambiguous here: the button only exists on a pane that
  // is on screen, and while maximised the only pane on screen is the focused
  // one — so there is no "maximise the OTHER pane" press to disambiguate.
  const handleToggleMaximizePane = useCallback((pane: number) => {
    setMaximized((m) => !m);
    focusPane(pane);
  }, [focusPane]);
  const handleToggleDiffFullscreen = useCallback(() => setDiffFullscreen((f) => !f), []);

  // Closing is just this: `diffFullscreen` follows on the effect above.
  const handleCloseFileDiff = useCallback(() => setFileDiffRequest(null), []);

  // The tab bar's layout button restores your layout before it toggles it.
  // With a diff column open the split is only hidden, so pressing the button
  // would otherwise rearrange something off screen and look like it did
  // nothing. First press closes the diff and hands back whatever was
  // underneath; the next press toggles that.
  //
  // diffOpen is read through a ref so this callback's identity stays stable
  // across every open/close (React performance conventions, CLAUDE.md).
  // A maximised pane hides the split the same way, and gets the same treatment
  // and the same order: restore what is covering the layout, THEN toggle it.
  const diffOpenRef = useRef(diffOpen);
  useEffect(() => { diffOpenRef.current = diffOpen; }, [diffOpen]);
  const maximizedRef = useRef(maximizedTab);
  useEffect(() => { maximizedRef.current = maximizedTab; }, [maximizedTab]);
  const handleToggleLayout = useCallback(() => {
    if (diffOpenRef.current) {
      handleCloseFileDiff();
      return;
    }
    if (maximizedRef.current !== null) {
      setMaximized(false);
      return;
    }
    toggleSideBySide();
  }, [toggleSideBySide, handleCloseFileDiff]);

  // Message "view all file changes": open the diff column and assert the agent
  // panel, which is where that column lives. Re-firing with a new message just
  // replaces its content.
  //
  // `live` = the source message is still streaming and just appended a tool
  // call; it refreshes the column in place (no swipe) and is dropped unless
  // that message is the one on screen. See fileDiffRequest.ts.
  const handleShowFileDiff = useCallback((messageId: string, toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string, runId?: string, live?: boolean) => {
    setFileDiffRequest((prev) => nextFileDiffRequest(prev, { messageId, toolCalls, cwd, sessionId, runId }, live === true));
    if (!live) handleViewChange('agent');
  }, [handleViewChange]);

  const handleOpenFileLink = useCallback((target: { path: string; lineNumber?: number }) => {
    setFileOpenRequest({ ...target, nonce: Date.now() });
    handleViewChange('explorer');
  }, [handleViewChange]);

  // Nothing dismisses the diff column on the user's behalf any more. Every rule
  // that used to — a FileBrowser-driving command, a search fired from inside the
  // diff, a file link — existed because the diff overlaid the FileBrowser and
  // would have hidden what those commands went to show. On its own column it
  // occludes nothing, so a git-status or a search now swipes to the Explorer and
  // leaves the diff where the user put it, still there when they swipe back.

  // Open note
  const handleOpenNote = useCallback(() => {
    if (!initialCwd) return;
    BrowserRuntime.runFork(
      Effect.flatMap(IframeBus, (bus) =>
        bus.publish(Topics.OpenNote, { cwd: initialCwd })
      )
    );
  }, [initialCwd]);

  return (
    <ChatProvider>
    <SwipeableViewContainer activeView={activeView} onViewChange={handleViewChange}>
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar - always visible */}
        <TabManagerTopBar
          initialCwd={initialCwd}
          activeTab={activeTab}
          isGitRepo={isGitRepo}
          currentBranch={currentBranch}
          onOpenWorktree={() => setIsWorktreeOpen(true)}
          onOpenAliasManager={() => setIsAliasManagerOpen(true)}
          onBranchSwitched={loadGitInfo}
        />

        {/* Screenshot in progress banner */}
        {screenshotActive && (
          <div className="flex items-center justify-center gap-2 py-1 bg-brand/15 text-brand text-xs font-medium border-b border-brand/20">
            <span className="animate-pulse">●</span>
            {t('console.screenshotting')}
          </div>
        )}

        {/* Content area - switches based on activeView (swipe effect) */}
        {initialCwd ? (
          <SwipeableContent>
            {/* AGENT view: Tab bar + Chat */}
            <div className="w-1/3 h-full flex flex-col overflow-hidden">
              <PanelPortalProvider>
                <div className="w-full h-full flex flex-col">
                  <TabBar
                    tabs={tabs}
                    selectedTabId={activeTabId}
                    sideBySide={layout.split}
                    onToggleSideBySide={handleToggleLayout}
                    unreadTabs={unreadTabs}
                    dragTabIndex={dragTabIndex}
                    dragOverTabIndex={dragOverTabIndex}
                    isPinned={isTabPinned}
                    onTogglePin={handleTogglePin}
                    onSwitchTab={switchTab}
                    onCloseTab={closeTab}
                    onCloseAllTabs={closeAllTabs}
                    onNewTab={handleNewTab}
                    onNewCodexTab={handleNewCodexTab}
                    onNewKimiTab={handleNewKimiTab}
                    onNewGlmTab={handleNewGlmTab}
                    onNewOllamaTab={handleNewOllamaTab}
                    onNewDeepseekTab={handleNewDeepseekTab}
                    onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
                    onDragStart={handleTabDragStart}
                    onDragOver={handleTabDragOver}
                    onDrop={handleTabDrop}
                    onDragEnd={handleTabDragEnd}
                  />
                  <ComposerSlotProvider value={layout.split ? composerSlot : null}>
                  <div className={`flex-1 overflow-hidden relative ${layout.row ? 'flex' : ''}`}>
                    {tabs.map((tab) => (
                      <PaneShell
                        key={tab.id}
                        tabId={tab.id}
                        panes={layout.panes}
                        activePane={layout.activePane}
                        row={layout.row}
                        maximized={maximizedTab === tab.id}
                        onFocusPane={focusPane}
                        onClosePane={closePane}
                        onToggleMaximize={handleToggleMaximizePane}
                      >
                        <ChatPanel
                          tabId={tab.id}
                          {...peerProps(tab.id, layout)}
                          cwd={tab.cwd}
                          sessionId={tab.sessionId}
                          engine={tab.engine}
                          onEngineChange={updateTabEngine}
                          ollamaModel={tab.ollamaModel}
                          onOllamaModelChange={updateTabOllamaModel}
                          deepseekModel={tab.deepseekModel}
                          onDeepseekModelChange={updateTabDeepseekModel}
                          kimiModel={tab.kimiModel}
                          onKimiModelChange={updateTabKimiModel}
                          glmModel={tab.glmModel}
                          onGlmModelChange={updateTabGlmModel}
                          claudeModel={tab.claudeModel}
                          onClaudeModelChange={updateTabClaudeModel}
                          claudeEffort={tab.claudeEffort}
                          onClaudeEffortChange={updateTabClaudeEffort}
                          claudeContextWindow={tab.claudeContextWindow}
                          onClaudeContextWindowChange={updateTabClaudeContextWindow}
                          claudeFastMode={tab.claudeFastMode}
                          onClaudeFastModeChange={updateTabClaudeFastMode}
                          claudeThinking={tab.claudeThinking}
                          onClaudeThinkingChange={updateTabClaudeThinking}
                          codexModel={tab.codexModel}
                          onCodexModelChange={updateTabCodexModel}
                          codexReasoningEffort={tab.codexReasoningEffort}
                          onCodexReasoningEffortChange={updateTabCodexReasoningEffort}
                          planMode={tab.planMode}
                          onPlanModeChange={updateTabPlanMode}
                          noHistory={tab.noHistory}
                          onNoHistoryChange={updateTabNoHistory}
                          isActive={paneTabIds.includes(tab.id) && activeView === 'agent'}
                          isFocused={tab.id === activeTabId}
                          refreshSignal={sessionRefresh}
                          onStateChange={updateTabState}
                          onShowGitStatus={handleShowGitStatus}
                          onContentSearch={handleContentSearch}
                          onShowFileDiff={handleShowFileDiff}
                          onOpenFileLink={handleOpenFileLink}
                          onOpenNote={handleOpenNote}
                          onCreateScheduledTask={createScheduledTask}
                          onOpenSession={handleOpenSession}
                        />
                      </PaneShell>
                    ))}
                    {/* The diff column: right half of the agent panel, beside the
                        chat that opened it. Its `order` is past every pane's, so
                        it is always the rightmost column no matter which pane
                        survived — panes and this share one flex row, and DOM
                        position is not what decides sides here (see paneClass). */}
                    {fileDiffRequest && (
                      <div
                        className={
                          diffFullscreen
                            // Covers the pane row and nothing above it: the tab
                            // bar stays reachable, so the way out is never the
                            // only button on screen. `bg-card` because the
                            // viewer's root is rounded and the panes are still
                            // laid out underneath, showing through the corners.
                            //
                            // z-30 has one job: beat PaneShell's close-column ✕
                            // at z-20. `position: relative` with no z-index does
                            // not open a stacking context, so that ✕ competes
                            // directly with this element rather than being
                            // trapped inside its own pane. It stays below the
                            // z-50 popover tier, which is not in this row.
                            ? 'absolute inset-0 z-30 bg-card'
                            : 'h-full flex-1 min-w-0 border-l border-border'
                        }
                        style={diffFullscreen ? undefined : { order: layout.diffOrder }}
                      >
                        <FileDiffViewer
                          // Switching to a different message must reset the viewer
                          // (first commit / first file, or empty state). Key on the
                          // MESSAGE, not its tool-call ids: a streaming message keeps
                          // appending calls, and remounting on each one would throw
                          // away the selected commit / file / scroll position.
                          key={fileDiffRequest.messageId}
                          toolCalls={fileDiffRequest.toolCalls}
                          cwd={fileDiffRequest.cwd}
                          sessionId={fileDiffRequest.sessionId}
                          runId={fileDiffRequest.runId}
                          onClose={handleCloseFileDiff}
                          onContentSearch={handleContentSearch}
                          fullscreen={diffFullscreen}
                          onToggleFullscreen={handleToggleDiffFullscreen}
                        />
                      </div>
                    )}
                  </div>
                  </ComposerSlotProvider>
                  {/* Shared composer. Sits BELOW both panes so neither pane spends
                      column height on it and their token bars stay on one line; the
                      focused Chat portals into it (see ComposerSlot). */}
                  {layout.split && <div ref={setComposerSlot} className="flex-shrink-0" />}
                </div>
              </PanelPortalProvider>
            </div>

            {/* EXPLORER view: FileBrowser (+ optional message file-diff overlay) */}
            <div className="w-1/3 h-full overflow-hidden relative">
              <PanelPortalProvider>
                <FileBrowserModal
                  onClose={handleExplorerClose}
                  cwd={initialCwd}
                  initialTab={fileBrowserInitialTab}
                  tabSwitchTrigger={tabSwitchTrigger}
                  initialSearchQuery={fileBrowserSearchQuery}
                  searchQueryTrigger={searchQueryTrigger}
                  fileOpenRequest={fileOpenRequest}
                />
              </PanelPortalProvider>
            </div>

            {/* CONSOLE view: command execution + browser */}
            <div className="w-1/3 h-full overflow-hidden">
              <PanelPortalProvider>
                <ConsoleView cwd={initialCwd} tabId="default" onOpenNote={handleOpenNote} />
              </PanelPortalProvider>
            </div>
          </SwipeableContent>
        ) : (
          /* When no cwd is set, only show Tab bar + Chat */
          <div className="flex-1 flex flex-col overflow-hidden">
            <TabBar
              tabs={tabs}
              selectedTabId={activeTabId}
              sideBySide={layout.split}
              onToggleSideBySide={handleToggleLayout}
              unreadTabs={unreadTabs}
              dragTabIndex={dragTabIndex}
              dragOverTabIndex={dragOverTabIndex}
              isPinned={isTabPinned}
              onTogglePin={handleTogglePin}
              onSwitchTab={switchTab}
              onCloseTab={closeTab}
              onCloseAllTabs={closeAllTabs}
              onNewTab={handleNewTab}
              onNewCodexTab={handleNewCodexTab}
              onNewKimiTab={handleNewKimiTab}
              onNewGlmTab={handleNewGlmTab}
              onNewDeepseekTab={handleNewDeepseekTab}
              onDragStart={handleTabDragStart}
              onDragOver={handleTabDragOver}
              onDrop={handleTabDrop}
              onDragEnd={handleTabDragEnd}
            />
            <ComposerSlotProvider value={layout.split ? composerSlot : null}>
            <div className={`flex-1 overflow-hidden relative ${layout.row ? 'flex' : ''}`}>
              {tabs.map((tab) => (
                <PaneShell
                  key={tab.id}
                  tabId={tab.id}
                  panes={layout.panes}
                  activePane={layout.activePane}
                  row={layout.row}
                  maximized={maximizedTab === tab.id}
                  onFocusPane={focusPane}
                  onClosePane={closePane}
                  onToggleMaximize={handleToggleMaximizePane}
                >
                  <ChatPanel
                    tabId={tab.id}
                    {...peerProps(tab.id, layout)}
                    cwd={tab.cwd}
                    sessionId={tab.sessionId}
                    engine={tab.engine}
                    onEngineChange={updateTabEngine}
                    ollamaModel={tab.ollamaModel}
                    onOllamaModelChange={updateTabOllamaModel}
                    deepseekModel={tab.deepseekModel}
                    onDeepseekModelChange={updateTabDeepseekModel}
                    kimiModel={tab.kimiModel}
                    onKimiModelChange={updateTabKimiModel}
                    glmModel={tab.glmModel}
                    onGlmModelChange={updateTabGlmModel}
                    claudeModel={tab.claudeModel}
                    onClaudeModelChange={updateTabClaudeModel}
                    claudeEffort={tab.claudeEffort}
                    onClaudeEffortChange={updateTabClaudeEffort}
                    claudeContextWindow={tab.claudeContextWindow}
                    onClaudeContextWindowChange={updateTabClaudeContextWindow}
                    claudeFastMode={tab.claudeFastMode}
                    onClaudeFastModeChange={updateTabClaudeFastMode}
                    claudeThinking={tab.claudeThinking}
                    onClaudeThinkingChange={updateTabClaudeThinking}
                    codexModel={tab.codexModel}
                    onCodexModelChange={updateTabCodexModel}
                    codexReasoningEffort={tab.codexReasoningEffort}
                    onCodexReasoningEffortChange={updateTabCodexReasoningEffort}
                    planMode={tab.planMode}
                    onPlanModeChange={updateTabPlanMode}
                    noHistory={tab.noHistory}
                    onNoHistoryChange={updateTabNoHistory}
                    isActive={paneTabIds.includes(tab.id)}
                    isFocused={tab.id === activeTabId}
                    refreshSignal={sessionRefresh}
                    onStateChange={updateTabState}
                    onCreateScheduledTask={createScheduledTask}
                    onOpenSession={handleOpenSession}
                  />
                </PaneShell>
              ))}
            </div>
                  </ComposerSlotProvider>
            {/* Shared composer. Sits BELOW both panes so neither pane spends
                column height on it and their token bars stay on one line; the
                focused Chat portals into it (see ComposerSlot). */}
            {layout.split && <div ref={setComposerSlot} className="flex-shrink-0" />}
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
          projectNumber={projectNumber}
          openSessionIds={tabs.map((tab) => tab.sessionId)}
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
