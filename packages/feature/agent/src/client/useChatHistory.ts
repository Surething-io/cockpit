'use client';

import { isToolUpdateEvent, type StreamEvent } from './applyStreamEvent';
import type { RecoveryDeletion } from '../shared/recoveryCopy';
import { acceptSessionTitle, effectiveTitle, titleSnapshot } from './sessionTitleState';
import type { SessionTitleInfo } from '../shared/sessionTitle';

import { useState, useCallback, useEffect, useRef } from 'react';
import { splitTurns } from '../shared/chatTurns';
import type { HistoryReference } from '../shared/historyReference';
import type { ChatMessage, TokenUsage, ChatEngine } from './types';
import { chatHistoryReducer, emptyChatHistory, locateHistoryRun, type ChatHistoryAction, type ChatHistoryState, type LiveHistoryRun, type HistoryFailure, type RunMessageUpdate } from './chatHistoryState';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';

// Shared: POST /api/session-by-path — returns null on failure (matches `!response.ok`).
// Also used by SubagentTranscript to fetch subagent transcripts (via toolUseId).
export const postSessionByPath = (body: Record<string, unknown>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    },
    catch: (cause) => new AppError({ message: 'session-by-path failed', cause }),
  });

// Migrated from src/components/project/useChatHistory.ts. Self-contained:
// only depends on React and on agent types (now local to this package).
// Server endpoints (/api/session-by-path, /api/session/:id/history) are
// referenced via fetch URLs at runtime — no module-level cross-package
// dependency.

// ============================================
// Constants
// ============================================

const TURNS_PER_PAGE = 10;
// Incremental fetch throttle interval (ms)
const INCREMENTAL_THROTTLE_MS = 5_000;

// ============================================
// First-page cache (stale-while-revalidate)
//
// A /api/session-by-path first-page response can be hundreds of KB with no
// HTTP caching — unnoticeable locally (<10ms), but over a tunnel (ngrok)
// every session open re-downloads it in full. Cache the latest first-page
// response per (cwd, sessionId): on a hit, paint the cached content
// immediately and revalidate in the background with ifFingerprint — if the
// session file is unchanged the server returns just { notModified } (a few
// dozen bytes); otherwise the full payload comes back and refreshes the
// cache. Module-level Map: lives as long as the SPA, no persistence (a page
// reload starts empty).
// ============================================
const FIRST_PAGE_CACHE_MAX = 20;
const firstPageCache = new Map<string, { data: SessionPageData; fingerprint: string }>();

// Shape of a /api/session-by-path response (fields the client consumes).
interface SessionPageData extends Partial<SessionTitleInfo> {
  stable?: boolean;
  notModified?: boolean;
  fingerprint?: string;
  beforeProof?: string;
  replacesWindow?: boolean;
  targetStatus?: "found" | "missing" | "stale";
  resolvedMessageId?: string;
  totalTurns?: number;
  hasMore?: boolean;
  startTurnIndex?: number;
  messages?: ChatMessage[];
  sessionId?: string;
  title?: string;
  /** Name of the Bot that dispatched this session; absent when a human opened it. */
  bot?: string;
  engine?: ChatEngine;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

// ============================================
// Types
// ============================================

interface UseChatHistoryOptions {
  /** Automatic disk reads run only while this conversation is visible. */
  enabled?: boolean;
  liveRunning?: boolean;
  /** null keeps the mobile full-history reconciliation contract. */
  reconcileLimit?: number | null;
  cwd?: string;
  initialSessionId?: string;
  onSessionId: (sid: string) => void;
  onTitleChange?: (title: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;

}

export type HistoryJumpResult = { status: "ready"; messageId?: string } | { status: "cancelled" | "failed" | "missing" | "stale" };

interface UseChatHistoryReturn {
  messages: ChatMessage[];
  recoveryCopies: import('./chatHistoryState').HistoryFailure[];
  onRecoveryDeleted: (deletion: RecoveryDeletion) => void;
  onRecoveryDismissed: (id: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onLiveSnapshotStart: (run: LiveHistoryRun) => void;
  setRunMessages: RunMessageUpdate;
  onRunAccepted: (run: LiveHistoryRun) => void;
  onSendFailure: (runId: string) => void;
  onInputRejected: (sessionId: string, copy: HistoryFailure) => void;
  onLiveRunEnd: (writerActive: boolean, runId: string, failed?: boolean) => void;
  onSenderStart: (run: LiveHistoryRun) => void;
  onWriterIdle: (sessionId: string) => void;
  isLoadingHistory: boolean;
  isLoadingMore: boolean;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  cancelTurnLoad: () => void;
  /**
   * Widen the loaded window backwards until `turnIndex` is on screen, then resolve.
   * Used by the user-message modal, whose index covers the whole session while
   * `messages` only holds the paged-in suffix — clicking an older row has to pull
   * the turns in first or the DOM jump has nothing to find.
   *
   * Reports data readiness; useMessageNavigation owns commit and scroll acknowledgement.
   */
  ensureTurnLoaded: (turnIndex: number, target?: HistoryReference) => Promise<HistoryJumpResult>;
  loadHistoryByCwdAndSessionId: (
    cwd: string,
    sid: string,
    incremental?: boolean,
    limit?: number,
    beforeTurnIndex?: number,
    // Bypass the incremental throttle — used by explicit user jumps
    // (scheduled-tasks panel / recent / pinned sessions), which must always
    // see the latest disk state even if another incremental fetch just ran.
    force?: boolean
  ) => Promise<void>;
  // The sessionId of the JSONL file whose contents are currently
  // displayed in `messages`. Differs from the live `sessionId` (which
  // drifts every time the SDK emits a `system.init`) — operations that
  // reference rendered message ids (e.g. fork) MUST use this one so the
  // server reads the same file the client is looking at.
  loadedSessionId: string | null;
  // Authoritative engine of the loaded session, echoed by /api/session-by-path
  // (resolved server-side by file location). Callers send on the session's native
  // engine instead of the undefined-means-claude default. null until the first
  // successful load.
  loadedEngine: ChatEngine | null;
  loadedModel: string | null;
  // Bot behind the loaded session, echoed by /api/session-by-path (derived there from
  // the session's first human message). null until a load lands, and for every session
  // a human started. Travels with loadedEngine because both answer "who is driving
  // this transcript" and both are only knowable once the file has been read.
  loadedBot: string | null;
}

// ============================================
// Hook
// ============================================

/** Pending work is derived from history, independently of React's render batching. */
function reconciliationDemand(history: ChatHistoryState): string | null {
  const released = history.runs.filter((run) => run.phase === 'released').map((run) => run.id);
  const unsettledIdle = history.needsStableRead && history.writerIdle
    && !history.runs.some((run) => run.phase === 'pending' || run.phase === 'active' || run.phase === 'draining');
  // Failed reads retain released runs too. A new idle observation grants one
  // attempt for either kind of unfinished work; read failure itself grants none.
  return released.length || unsettledIdle ? JSON.stringify([released, history.writerIdleRevision]) : null;
}

export function useChatHistory(
  sessionId: string | null,
  { cwd, initialSessionId, onSessionId, onTitleChange, onTokenUsage, reconcileLimit = TURNS_PER_PAGE, enabled = true, liveRunning = false }: UseChatHistoryOptions
): UseChatHistoryReturn {
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [history, setHistory] = useState(emptyChatHistory);
  const historyRef = useRef(history);
  const writerWaiters = useRef(new Set<() => void>());
  const lastReconcileRef = useRef<{ demand: string; requestId: number } | null>(null);
  // A page was observed before these events. Replay only updates admitted during
  // its read, then release them with that request; this is not a history cache.
  const activeReadRef = useRef<{
    requestId: number; navigation?: number;
    toolUpdates: Array<{ event: StreamEvent; engine?: string; assistantId: string }>;
  } | null>(null);
  const dispatchHistory = useCallback((action: ChatHistoryAction) => {
    if (action.type === 'run-messages') {
      const { runId, update } = action;
      const owner = historyRef.current.runs.find(run => run.id === runId);
      if (owner && !owner.recovery && activeReadRef.current && typeof update === 'object'
        && !Array.isArray(update) && isToolUpdateEvent(update.event)) activeReadRef.current.toolUpdates.push(update);
    }
    if (action.type === 'page' && !action.fromCache) action = { ...action, toolUpdates: activeReadRef.current?.toolUpdates };
    const next = chatHistoryReducer(historyRef.current, action);
    // A completed demand must stop owning the retry guard, even if retirement
    // and recreation of the same run are batched into a single React commit.
    if (reconciliationDemand(next) !== reconciliationDemand(historyRef.current)) lastReconcileRef.current = null;
    historyRef.current = next;
    setHistory(next);
    for (const check of writerWaiters.current) check();
  }, []);
  const { messages, hasMore: hasMoreHistory } = history;
  const requestIdRef = useRef(0);
  const pendingPageRef = useRef<{ requestId: number; start: number } | undefined>(undefined);
  // A completion wakes reconciliation even when the history demand itself did not change.
  const [settledReadId, setSettledReadId] = useState(0);
  const releaseRead = useCallback((requestId: number) => {
    if (activeReadRef.current?.requestId !== requestId) return;
    activeReadRef.current = null;
    setIsLoadingMore(false);
    setIsLoadingHistory(false);
    setSettledReadId(requestIdRef.current);
  }, []);
  const navigationEpoch = useRef(0);
  const cancelTurnLoad = useCallback(() => {
    const cancelled = navigationEpoch.current++;
    const boundary = activeReadRef.current;
    if (boundary?.navigation === cancelled) {
      if (requestIdRef.current === boundary.requestId) ++requestIdRef.current;
      releaseRead(boundary.requestId);
    }
    for (const check of writerWaiters.current) check();
  }, [releaseRead]);
  const invalidateReads = useCallback(() => {
    cancelTurnLoad();
    ++requestIdRef.current;
    if (activeReadRef.current) releaseRead(activeReadRef.current.requestId);
    pendingPageRef.current = undefined;
  }, [cancelTurnLoad, releaseRead]);
  const setMessages = useCallback<React.Dispatch<React.SetStateAction<ChatMessage[]>>>((update) => {
    dispatchHistory({ type: 'messages', update });
  }, [dispatchHistory]);
  const setRunMessages = useCallback<RunMessageUpdate>((runId, update) => {
    dispatchHistory({ type: 'run-messages', runId, update });
  }, [dispatchHistory]);
  // sessionId of the file whose contents currently populate `messages`.
  // Updated whenever a load successfully returns messages.
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  // Engine echoed by /api/session-by-path for the loaded session.
  const [loadedModel, setLoadedModel] = useState<string | null>(null);
  const [loadedEngine, setLoadedEngine] = useState<ChatEngine | null>(null);
  // Bot echoed by the same payload (undefined there = a human's session).
  const [loadedBot, setLoadedBot] = useState<string | null>(null);
  // Ref mirror of loadedSessionId: ensureTurnLoaded is handed down to a memo'd
  // modal, so it must not take a new identity every time a page lands.
  const loadedSessionIdRef = useRef<string | null>(null);
  loadedSessionIdRef.current = loadedSessionId;
  // Painting a cached page is not a completed initial validation. In particular,
  // React's effect replay must repeat that first page, not expand it to a tail read.
  const initializedHistoryRef = useRef<string | null>(null);
  const displayedSessionId = loadedSessionId ?? sessionId ?? initialSessionId;
  const displayedSessionIdRef = useRef(displayedSessionId);
  displayedSessionIdRef.current = displayedSessionId;
  // Loading a target selects the session; painting its cache/response only hydrates it.
  // SDK session ids may drift, so they do not invalidate the displayed transcript.
  const readTargetRef = useRef({ cwd, sessionId: initialSessionId ?? sessionId });
  const wasVisibleRef = useRef(false);
  const pendingActivationRef = useRef(false);
  useEffect(() => () => {
    wasVisibleRef.current = false;
    pendingActivationRef.current = false;
    invalidateReads();
  }, [cwd, invalidateReads]);

  // Use ref to ensure callbacks use the latest reference
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onTokenUsageRef = useRef(onTokenUsage);
  onTokenUsageRef.current = onTokenUsage;

  // File fingerprint: used for incremental check if file has changed
  const fingerprintRef = useRef<string | undefined>(undefined);
  const onSenderStart = useCallback((run: LiveHistoryRun) => {
    ++requestIdRef.current;
    if (activeReadRef.current) releaseRead(activeReadRef.current.requestId);
    fingerprintRef.current = undefined;
    dispatchHistory({ type: 'sender-start', run });
  }, [dispatchHistory, releaseRead]);
  const onRunAccepted = useCallback((run: LiveHistoryRun) => {
    fingerprintRef.current = undefined;
    dispatchHistory({ type: 'run-accepted', run });
  }, [dispatchHistory]);
  const onSendFailure = useCallback((runId: string) => dispatchHistory({ type: 'send-failed', runId }), [dispatchHistory]);
  const onInputRejected = useCallback((sessionId: string, copy: HistoryFailure) => {
    if (displayedSessionIdRef.current !== sessionId
      || (readTargetRef.current.sessionId !== null && readTargetRef.current.sessionId !== sessionId)) return;
    dispatchHistory({ type: 'input-rejected', sessionId, copy });
  }, [dispatchHistory]);
  const onLiveSnapshotStart = useCallback((run: LiveHistoryRun) => {
    fingerprintRef.current = undefined;
    dispatchHistory({ type: 'replay-start', run });
  }, [dispatchHistory]);
  const onLiveRunEnd = useCallback((writerActive: boolean, runId: string, failed = false) => {
    fingerprintRef.current = undefined;
    dispatchHistory({ type: 'run-end', runId, writerActive, failed });
  }, [dispatchHistory]);
  const onRecoveryDeleted = useCallback((deletion: RecoveryDeletion) => dispatchHistory({ type: 'recovery-deleted', deletion }), [dispatchHistory]);
  const onRecoveryDismissed = useCallback((id: string) => dispatchHistory({ type: 'recovery-dismissed', id }), [dispatchHistory]);
  const onWriterIdle = useCallback((sessionId: string) => dispatchHistory({ type: 'writer-idle', sessionId }), [dispatchHistory]);
  // Last incremental fetch time: used for throttling
  const lastIncrementalFetchRef = useRef(0);

  // Load history messages by cwd + sessionId
  const loadHistoryByCwdAndSessionId = useCallback(async (
    cwdPath: string,
    sid: string,
    incremental = false,
    limit?: number,
    beforeTurnIndex?: number,
    force = false
  ) => {
    if (readTargetRef.current.cwd !== cwdPath || readTargetRef.current.sessionId !== sid) {
      if (readTargetRef.current.cwd !== cwdPath || readTargetRef.current.sessionId !== null) invalidateReads();
      readTargetRef.current = { cwd: cwdPath, sessionId: sid };
      fingerprintRef.current = undefined;
      lastIncrementalFetchRef.current = 0;
    }
    // Reads can refresh stable history while a writer drains. Source projections
    // retain ownership of the unfinished run until its post-release read applies.
    // Direction 2: incremental time throttle — skip if less than N seconds since last fetch.
    // `force` (explicit user jump) bypasses the throttle but still stamps the clock, so the
    // jump can never be silently swallowed by an unrelated fetch that ran moments earlier.
    if (incremental) {
      const now = Date.now();
      if (!force && now - lastIncrementalFetchRef.current < INCREMENTAL_THROTTLE_MS) {
        return;
      }
      lastIncrementalFetchRef.current = now;
    }

    const requestId = ++requestIdRef.current;
    const reconciles = historyRef.current.runs.filter((run) => run.phase === 'released').map((run) => run.id);
    activeReadRef.current = { requestId, toolUpdates: [] };
    if (!incremental) pendingPageRef.current = undefined;
    const requestedPage = pendingPageRef.current;
    // Apply one /api/session-by-path payload to local state. Shared by the
    // cache-hit fast path and the network response path.
    const applyPage = (data: SessionPageData, viaIncremental: boolean, authoritative = false) => {
        if (data.replacesWindow) pendingPageRef.current = undefined;
        fingerprintRef.current = authoritative && historyRef.current.runs.length === 0 && data.stable !== false
          ? data.fingerprint : undefined;
        if (data.messages) {
          dispatchHistory({
            type: 'page', sessionId: sid,
            page: { ...data, messages: data.messages },
            mode: viaIncremental ? 'incremental' : 'replace',
            endTurnIndex: beforeTurnIndex,
            reconciles: authoritative ? reconciles : undefined, fromCache: !authoritative,
          });
          setLoadedSessionId(sid);
          loadedSessionIdRef.current = sid;
        }
        if (data.sessionId) {
          onSessionId(data.sessionId);
        }
        if (data.engine) {
          setLoadedEngine(data.engine);
          setLoadedModel(data.model ?? null);
        }
        // Assigned unconditionally, unlike engine: "no bot" is a real answer the
        // payload gives, and a stale robot on a human session is worse than none.
        setLoadedBot(data.bot ?? null);
        // Notify parent component of title change
        if (data.title) {
          if (typeof data.titleRevision === 'number' && data.defaultTitle !== undefined && data.customTitle !== undefined) {
            acceptSessionTitle({ cwd: cwdPath, sessionId: sid, title: data.title, defaultTitle: data.defaultTitle, customTitle: data.customTitle, titleRevision: data.titleRevision });
          }
          onTitleChangeRef.current?.(effectiveTitle(titleSnapshot(), cwdPath, sid, data.title, data.titleRevision));
        }
        // Set token usage info (from last assistant message in history)
        if (data.usage) {
          onTokenUsageRef.current?.({
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheCreationInputTokens: data.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: data.usage.cache_read_input_tokens || 0,
            totalCostUsd: 0, // No cost info in history records
          });
        }
    };

    // First-page cache: only the plain initial load shape (no incremental, no
    // pagination cursor) is cached — that's the request every "open a session"
    // fires and the one that hurts over high-latency links.
    const cacheKey = `${cwdPath}::${sid}`;
    // A mutation such as deleting a turn must not repaint the old transcript from the
    // stale-while-revalidate cache. Drop it first; the response below becomes the new entry.
    if (force) firstPageCache.delete(cacheKey);
    const cacheable = !incremental && beforeTurnIndex === undefined;
    const cached = cacheable ? firstPageCache.get(cacheKey) : undefined;

    if (!incremental) {
      if (cached && historyRef.current.runs.length === 0) {
        // Stale-while-revalidate: paint cached content immediately, then
        // revalidate below with its fingerprint (no loading spinner).
        applyPage(cached.data, false);
      } else {
        setIsLoadingHistory(true);
      }
    }
    try {
      // Direction 3: carry a fingerprint so the server can short-circuit with
      // { notModified } when the session file is unchanged.
      const requestBody: Record<string, unknown> = { cwd: cwdPath, sessionId: sid, limit, beforeTurnIndex };
      // Preserve a pending prefix page when a background read supersedes it.
      // Navigation retries its own reference-checked request instead of lending
      // an unvalidated target boundary to unrelated background reads.
      // Reload the committed window too: late tool results can change earlier
      // rendered turns. A fixed tail alone cannot refresh those loaded rows.
      if (incremental && limit !== undefined && beforeTurnIndex === undefined) {
        const starts = [historyRef.current.diskCursor?.index, requestedPage?.start, ...historyRef.current.runs.filter((run) => reconciles.includes(run.id)).map((run) => run.start)].filter((value): value is number => value !== undefined);
        if (starts.length > 0) requestBody.fromTurnIndex = Math.min(...starts);
        if (requestBody.fromTurnIndex === historyRef.current.diskCursor?.index) requestBody.expectedStartProof = historyRef.current.diskCursor?.proof;
      }
      // File equality says nothing about a range we have not loaded yet.
      const viewStart = historyRef.current.startTurnIndex;
      const expandsWindow = beforeTurnIndex !== undefined || (limit === undefined
        ? viewStart !== 0
        : typeof requestBody.fromTurnIndex === 'number' && (viewStart === undefined || requestBody.fromTurnIndex < viewStart));
      if (incremental && !expandsWindow && fingerprintRef.current && historyRef.current.runs.length === 0) {
        requestBody.ifFingerprint = fingerprintRef.current;
      } else if (cached && historyRef.current.runs.length === 0) {
        requestBody.ifFingerprint = cached.fingerprint;
      }

      const exit = await BrowserRuntime.runPromiseExit(postSessionByPath(requestBody));
      if (requestId !== requestIdRef.current) return;
      if (exit._tag === 'Success' && exit.value) {
        const data = exit.value as SessionPageData;
        if (data.messages || data.notModified) initializedHistoryRef.current = JSON.stringify([cwdPath, sid]);

        // Content equality does not prove that its writer has finished.
        if (data.notModified) {
          if (typeof data.stable === 'boolean') {
            fingerprintRef.current = data.stable ? data.fingerprint : undefined;
            dispatchHistory({ type: 'validated', sessionId: sid, stable: data.stable });
          }
          return;
        }

        applyPage(data, incremental, true);
        if (pendingPageRef.current === requestedPage) pendingPageRef.current = undefined;

        // Refresh the first-page cache (LRU: re-insert, evict oldest over cap)
        if (cacheable && data.fingerprint && data.messages && data.stable !== false) {
          firstPageCache.delete(cacheKey);
          firstPageCache.set(cacheKey, { data, fingerprint: data.fingerprint });
          if (firstPageCache.size > FIRST_PAGE_CACHE_MAX) {
            const oldest = firstPageCache.keys().next().value;
            if (oldest !== undefined) firstPageCache.delete(oldest);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load history by cwd and sessionId:', error);
    } finally {
      releaseRead(requestId);
    }
  }, [onSessionId, invalidateReads, releaseRead]);

  const pendingReconciliation = reconciliationDemand(history);
  const pendingAdmission = history.runs.some((run) => run.phase === 'pending');
  useEffect(() => {
    const becomingVisible = enabled && !wasVisibleRef.current;
    wasVisibleRef.current = enabled;
    if (!enabled) { pendingActivationRef.current = false; return; }
    if (!becomingVisible && !pendingActivationRef.current) return;
    // A new visit may retry a failed final read, without polling while hidden.
    if (becomingVisible) lastReconcileRef.current = null;
    const sid = loadedSessionIdRef.current ?? initialSessionId;
    if (!cwd || !sid) return;
    // A response admitted before leaving may predate work done while hidden.
    // Let it settle, then validate this return visit once instead of racing it.
    if (activeReadRef.current) { pendingActivationRef.current = true; return; }
    pendingActivationRef.current = false;
    if (pendingReconciliation) return;
    const runs = historyRef.current.runs;
    const initialized = initializedHistoryRef.current === JSON.stringify([cwd, sid]);
    // A first read still supplies the preceding disk history while live replay
    // owns the current run. Only revisits defer their ordinary refresh to it.
    if (initialized && (liveRunning || runs.some((run) => run.phase !== 'released'))) return;
    void loadHistoryByCwdAndSessionId(cwd, sid, initialized, initialized ? reconcileLimit ?? undefined : TURNS_PER_PAGE);
  }, [enabled, settledReadId, cwd, initialSessionId, liveRunning, pendingReconciliation, reconcileLimit, loadHistoryByCwdAndSessionId]);

  useEffect(() => {
    if (!enabled || !pendingReconciliation || activeReadRef.current || !cwd || !displayedSessionId) return;
    if (readTargetRef.current.cwd !== cwd || (readTargetRef.current.sessionId && readTargetRef.current.sessionId !== displayedSessionId)) return;
    const demand = JSON.stringify([cwd, displayedSessionId, pendingReconciliation]);
    const previous = lastReconcileRef.current;
    // Resume an interrupted attempt after admission resolves, without polling a
    // failed response. A newly observed release is independent work and can be
    // read while another send is pending; the reducer preserves that live run.
    if (previous?.demand === demand && (pendingAdmission || previous.requestId === requestIdRef.current)) return;
    void loadHistoryByCwdAndSessionId(cwd, displayedSessionId, true, reconcileLimit ?? undefined, undefined, true);
    lastReconcileRef.current = { demand, requestId: requestIdRef.current };
  }, [enabled, pendingReconciliation, pendingAdmission, settledReadId, cwd, displayedSessionId, reconcileLimit, loadHistoryByCwdAndSessionId]);

  // Load more history messages (called when scrolling up)
  const loadMoreHistory = useCallback(async () => {
    const view = historyRef.current;
    if (!cwd || !sessionId || activeReadRef.current || !view.hasMore || !view.diskCursor?.index) return;
    const beforeIndex = view.diskCursor.index;
    const reconciles = view.runs.filter((run) => run.phase === 'released').map((run) => run.id);
    const requestId = ++requestIdRef.current;
    activeReadRef.current = { requestId, toolUpdates: [] };
    pendingPageRef.current = { requestId, start: Math.max(0, beforeIndex - TURNS_PER_PAGE) };
    setIsLoadingMore(true);
    try {
      const exit = await BrowserRuntime.runPromiseExit(
        postSessionByPath({
          cwd,
          sessionId,
          limit: TURNS_PER_PAGE,
          beforeTurnIndex: beforeIndex,
          expectedBeforeProof: view.diskCursor.proof,
        })
      );

      if (requestId !== requestIdRef.current) return;
      if (exit._tag === 'Success' && exit.value) {
        const data = exit.value as SessionPageData;
        if (data.messages) {
          if (!data.beforeProof && data.totalTurns !== undefined && data.totalTurns < view.totalTurns) {
            // Older servers cannot validate the retained cursor after a shrink.
            await loadHistoryByCwdAndSessionId(cwd, sessionId, false, TURNS_PER_PAGE, undefined, true);
            return;
          }
          if (data.replacesWindow) pendingPageRef.current = undefined;
          dispatchHistory({
            type: 'page', sessionId, page: { ...data, messages: data.messages },
            mode: 'prepend', endTurnIndex: beforeIndex, reconciles,
          });
          setLoadedSessionId(sessionId);
          // An older page can reveal writes beyond the cached/loaded tail, but
          // cannot supply them. Read the tail while run records keep ownership
          // of their live messages until post-release reconciliation.
          if (!data.replacesWindow && data.totalTurns !== undefined && data.totalTurns > view.totalTurns) {
            await loadHistoryByCwdAndSessionId(cwd, sessionId, true, TURNS_PER_PAGE, undefined, true);
          }
        }
      } else if (exit._tag === 'Failure') {
        console.error('Failed to load more history:', exit.cause);
      }
    } finally {
      if (pendingPageRef.current?.requestId === requestId) pendingPageRef.current = undefined;
      releaseRead(requestId);
    }
  }, [cwd, sessionId, loadHistoryByCwdAndSessionId, releaseRead]);

  // Pull every turn from `turnIndex` to the end of the session into view.
  //
  // One request, not a loop of loadMoreHistory calls: `fromTurnIndex` is resolved
  // against the server's own totalTurns, so it stays exact even if the session grew
  // since the modal read its index — a client-side `limit` would slide forward by
  // however many turns arrived and drop the target off the front of the window.
  //
  // The window is contiguous with what is already rendered (it ends at the session
  // tail either way), so this replaces `messages` wholesale instead of splicing.
  const ensureTurnLoaded = useCallback(async function loadTarget(turnIndex: number, target?: HistoryReference, waitForRun?: string): Promise<HistoryJumpResult> {
    cancelTurnLoad();
    const navigation = navigationEpoch.current;
    const sid = loadedSessionIdRef.current ?? sessionId;
    if (!cwd || !sid || turnIndex < 0) return { status: 'cancelled' };
    if (readTargetRef.current.sessionId && readTargetRef.current.sessionId !== sid) return { status: 'cancelled' };
    readTargetRef.current = { cwd, sessionId: sid };
    const run = historyRef.current.runs.findLast((run) => {
      if (waitForRun) return run.id === waitForRun;
      const start = locateHistoryRun(run, historyRef.current.diskTurns);
      return start !== undefined && turnIndex >= start;
    });
    if (run && run.phase !== 'released') {
      const waiting = await BrowserRuntime.runPromiseExit(Effect.async<void, AppError>((resume) => {
        const check = () => {
          const cancelled = navigation !== navigationEpoch.current;
          const ready = !historyRef.current.runs.some((current) => current.id === run.id && current.phase !== 'released');
          if (cancelled || ready) {
            writerWaiters.current.delete(check);
            resume(cancelled ? Effect.fail(new AppError({ message: 'History navigation cancelled' })) : Effect.void);
          }
        };
        writerWaiters.current.add(check);
        check();
        return Effect.sync(() => { writerWaiters.current.delete(check); });
      }));
      if (waiting._tag === 'Failure' || navigation !== navigationEpoch.current) return { status: 'cancelled' };
    }
    const requestId = ++requestIdRef.current;
    const reconciles = historyRef.current.runs.filter((run) => run.phase === 'released').map((run) => run.id);
    activeReadRef.current = { requestId, navigation, toolUpdates: [] };
    setIsLoadingMore(true);
    try {
      const exit = await BrowserRuntime.runPromiseExit(
        postSessionByPath({ cwd, sessionId: sid, fromTurnIndex: Math.min(turnIndex, ...historyRef.current.runs.filter((run) => reconciles.includes(run.id)).map((run) => run.start)), target }).pipe(
          Effect.raceFirst(Effect.async<never, AppError>((resume) => {
            const check = () => {
              if (navigation !== navigationEpoch.current) resume(Effect.fail(new AppError({ message: 'History navigation cancelled' })));
            };
            writerWaiters.current.add(check);
            check();
            return Effect.sync(() => { writerWaiters.current.delete(check); });
          })),
        )
      );
      if (navigation !== navigationEpoch.current) return { status: "cancelled" };
      if (requestId !== requestIdRef.current) return loadTarget(turnIndex, target);
      if (exit._tag === 'Failure') {
        console.error('Failed to load turns for jump:', exit.cause);
        return { status: 'failed' };
      }
      if (!exit.value) return { status: "failed" };
      // The rendered session can change while this request is in flight (fork, or
      // opening another session into this tab). Everything below is scoped to
      // `sid`, so applying it to a list that has since moved on would splice two
      // transcripts together — drop the response instead.
      if (loadedSessionIdRef.current && loadedSessionIdRef.current !== sid) return { status: "cancelled" };
      const data = exit.value as SessionPageData;
      if (data.targetStatus === "missing" || data.targetStatus === "stale") return { status: data.targetStatus };
      if (data.messages) {
        dispatchHistory({
          type: 'page', sessionId: sid,
          page: { ...data, messages: data.messages, startTurnIndex: data.startTurnIndex ?? turnIndex },
          mode: 'jump', reconciles,
        });
        setLoadedSessionId(sid);
      }
      if (target && data.resolvedMessageId && !historyRef.current.messages.some((row) => row.id === data.resolvedMessageId)) {
        const targetOffset = splitTurns(data.messages ?? []).findIndex((turn) => turn.some((row) => row.id === data.resolvedMessageId));
        const targetIndex = (data.startTurnIndex ?? turnIndex) + Math.max(0, targetOffset);
        const owner = historyRef.current.runs.findLast((run) => run.start <= targetIndex);
        if (owner && owner.phase !== 'released') return loadTarget(turnIndex, target, owner.id);
        return { status: 'failed' };
      }
      fingerprintRef.current = historyRef.current.runs.length ? undefined : data.fingerprint;
      return data.messages ? { status: "ready", messageId: data.resolvedMessageId } : { status: "failed" };
    } finally {
      releaseRead(requestId);
    }
  }, [cwd, sessionId, cancelTurnLoad, releaseRead]);

  return {
    messages,
    recoveryCopies: history.failures,
    onRecoveryDeleted,
    onRecoveryDismissed,
    setMessages,
    onLiveSnapshotStart,
    setRunMessages,
    onRunAccepted,
    onSendFailure,
    onInputRejected,
    onLiveRunEnd,
    onSenderStart,
    onWriterIdle,
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    ensureTurnLoaded,
    cancelTurnLoad,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
    loadedEngine,
    loadedModel,
    loadedBot,
  };
}
