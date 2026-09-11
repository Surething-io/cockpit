'use client';

import { useEffect, useLayoutEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { useChatContextOptional } from './ChatContext';
import { ENGINE_LABELS, EngineIcon, isEngineAccentId } from './engineAccents';
import type { ChatMessage, ApiRetryInfo, BackgroundTaskInfo, ChatEngine, ToolCallInfo, LiveOutputTokens } from './types';
import { MessageBubble } from './MessageBubble';
// Tech debt: cross-package imports into the main shell.
//   - useChatSearch / useComments / useAllComments: hooks living in
//     src/hooks/, candidates for either feature-agent (if chat-only) or
//     shared (if reusable across panels). Decide when migrating hooks/.
//   - FloatingToolbar / CodeInputCards: chat-adjacent UI not yet migrated.
// Allowed by MODULES.md as transitional reverse imports.
import { useChatSearch } from './useChatSearch';
import { useComments } from '@cockpit/feature-comments';
import { fetchAllCommentsWithCode, buildAIMessage, clearAllComments, sendReferenceToAI, CHAT_COMMENT_FILE, type CodeReference } from '@cockpit/feature-comments';
import { ToolbarRenderer, ToolbarData, DEFAULT_QUICK_REPLY_KEYS, type QuickReplyTarget } from '@cockpit/shared-ui';
import { AddCommentInput, SendToAIInput } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadAgentSettings, saveAgentSettings } from './effect/agentClient';
import { QuickRepliesEditor } from './QuickRepliesEditor';
import {
  readQuickReplies,
  toQuickReplyLang,
  type QuickRepliesSetting,
} from './quickReplies';
import {
  reduceScroll,
  ownerForPosition,
  isContentEndVisible,
  type Geometry,
  type ScrollEvent,
  type ScrollOwner,
} from './scrollPlan';

// Migrated from src/components/project/MessageList.tsx.

// Geometry of a user-message jump, shared by the jump itself and by the
// enabled/disabled state of its buttons so the two can never disagree.
// STEP_EPSILON must stay WIDER than STEP_PADDING: a jump parks its target at
// +STEP_PADDING, and that row has to keep counting as "current" afterwards —
// otherwise `next` re-selects the row it just landed on and appears dead.
// How long a jump target stays lit once it has ARRIVED. The scroll that precedes
// it is instant, so this whole budget is spent on screen rather than on travel.
const FLASH_HOLD_MS = 2000;

const STEP_PADDING = 8;
const STEP_EPSILON = STEP_PADDING + 4;

/**
 * How long to wait for a smooth scroll to land before reclaiming the blank
 * anyway. Only a floor: `scrollend` normally gets there first, and this exists
 * because a scroll with nowhere to go never fires one.
 */
const SETTLE_FALLBACK_MS = 700;

/**
 * Scroll ownership (follow / pinned / reading / free), the reserved-blank formula and
 * every "is the end on screen" predicate live in `scrollPlan.ts` as a pure
 * reducer. This component reads geometry, hands the reducer an event, and
 * applies the plan it gets back — it makes no scrolling decision of its own.
 * That file's header records the three bugs this arrangement replaces.
 */
const RECENT_USER_MESSAGE_LIMIT = 10;


interface MessageListProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  cwd?: string;
  sessionId?: string | null;
  engine?: ChatEngine;
  apiRetryInfo?: ApiRetryInfo | null;
  /** Live background tasks holding the run resident after its result (see sdkLoop). */
  backgroundTasks?: BackgroundTaskInfo[];
  liveOutputTokens?: LiveOutputTokens | null;
  runningStartedAt?: number | null;
  hasMoreHistory?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onFork?: (messageId: string, scope: 'prefix' | 'single') => void;
  /** Permanently remove the complete human turn containing this message. */
  onDeleteTurn?: (messageId: string) => Promise<void> | void;
  /** Side-by-side: forward a message's text to the other column. Stable identity. */
  onSendToPeer?: (content: string) => void;
  /** Which side the other column is on. Undefined in single-pane mode, which hides the button. */
  peerSide?: 'left' | 'right';
  isActive?: boolean; // Whether the tab is active (handles scroll issues for hidden tabs)
  onContentSearch?: (query: string) => void; // Selected text → project-wide search
  /** Show a message's file changes in the Explorer panel (panel 2) + auto-swipe */
  onShowFileDiff?: (messageId: string, toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string, live?: boolean) => void;
  /** AI reply Markdown local-file link → Explorer tree + optional line jump. */
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void;
  /** Plan mode: approve the presented plan → turn off plan mode and resend to execute */
  onApprovePlan?: () => void;
  /** Open the whole-session user-message list. Lives on the jump capsule, next
      to prev/next — same job, one home. */
  onShowUserMessages?: () => void;
}

function AnimatedProgressNumber({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(value);
  const displayValueRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const from = displayValueRef.current;
    const to = value;
    if (to <= from) {
      displayValueRef.current = to;
      setDisplayValue(to);
      return;
    }

    const durationMs = 400;
    const maxFrames = 12;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      const frameProgress = Math.min(1, Math.ceil(progress * maxFrames) / maxFrames);
      const next = Math.round(from + (to - from) * frameProgress);
      displayValueRef.current = next;
      setDisplayValue(next);
      if (frameProgress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [value]);

  return <span className="tabular-nums">{displayValue}</span>;
}

// Methods exposed to parent component
export interface MessageListHandle {
  /**
   * Scroll a message into view and flash it. Returns false when no node carries
   * that id, so a caller that just paged in older turns can retry on the next
   * frame instead of having to know when React commits them.
   */
  scrollToMessage: (messageId: string) => boolean;
  /**
   * Ask for the next user turn to be pinned to the top of the viewport once it
   * renders. Called from the send path rather than inferred from `messages`,
   * because only the caller knows whether a new user row is a person pressing
   * enter or a scheduled task / peer pane writing into the transcript — and
   * only the first of those may take the viewport.
   */
  pinNextUserMessage: () => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, isLoading, cwd, sessionId, engine, apiRetryInfo, backgroundTasks, liveOutputTokens, runningStartedAt, hasMoreHistory, isLoadingMore, onLoadMore, onFork, onDeleteTurn, onSendToPeer, peerSide, isActive = true, onContentSearch, onShowFileDiff, onOpenFileLink, onApprovePlan, onShowUserMessages },
  ref
) {
  const { t, i18n } = useTranslation();
  // Passed down as a plain boolean, not `engine`, to keep MessageBubble's memo props stable.
  const forkSupported = true;
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Owns the in-flight jump flash, so a second jump cannot have its highlight
  // cut short by the timer the previous one left running.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTargetRef = useRef<Element | null>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [outerEl, setOuterEl] = useState<HTMLDivElement | null>(null);
  /**
   * Who owns the viewport. A ref, not state: every reader runs inside a layout
   * effect or a DOM handler, and a re-render per mode change would run the memo
   * comparison over every mounted bubble for a value no bubble reads.
   */
  const ownerRef = useRef<ScrollOwner>({ mode: 'follow', pinTop: null });
  /**
   * Reserved blank space below the last turn, in px. This is what makes a pin
   * possible at all: the browser caps scrollTop at `scrollHeight - clientHeight`,
   * so without roughly a viewport of content underneath it, the LAST message
   * physically cannot be moved to the top of the viewport.
   *
   * Written straight to the node, never through state: it is re-derived on
   * every streaming delta, and a setState there would re-render the whole list
   * twice per token for a number that nothing but this one element reads.
   *
   * The node is also the source of truth for its own height — read back out of
   * the DOM below rather than mirrored in a ref, so a re-created spacer (the
   * empty-transcript branch swaps this subtree) can never leave the bookkeeping
   * claiming blank that is not on screen.
   */
  const spacerRef = useRef<HTMLDivElement>(null);
  /**
   * Set when the reader leaves this tab during a run. Streaming in a hidden
   * pane must not decide that they have read the turn and return them at its
   * tail; activation consumes this flag by restoring the latest user row.
   */
  const restoreTurnStartRef = useRef(false);
  const previousActiveRef = useRef(isActive);

  /** Everything the reducer is allowed to know. One layout read per event. */
  const readGeometry = useCallback((): Geometry | null => {
    const container = containerRef.current;
    if (!container) return null;
    return {
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      spacer: spacerRef.current?.offsetHeight ?? 0,
    };
  }, []);

  /**
   * Cancels a spacer write that is waiting for a smooth scroll to land, so a
   * later plan cannot have a stale height dropped on top of it.
   */
  const deferredSpacerRef = useRef<(() => void) | null>(null);

  /**
   * The one funnel. Every automatic scroll in this file goes through here, so
   * "who moved the viewport" has exactly one answer — the bug this replaces was
   * five independent `scrollTop = scrollHeight` writers with no shared notion of
   * who was in charge, and a sixth that wrote the spacer behind their backs.
   *
   * Returns whether a plan ran, which is false for a pane with no layout box —
   * the caller may want to try again when it is visible.
   */
  const dispatchScroll = useCallback((event: ScrollEvent): boolean => {
    const g = readGeometry();
    if (!g) return false;
    const action = reduceScroll(ownerRef.current, event, g);
    // null = a hidden pane (no layout box) or an event that does not apply.
    // Touch nothing: measuring a display:none scroller returns zeroes that the
    // old formula fed back to itself as a fixed point, freezing the blank.
    if (!action) return false;

    // Whatever this plan does supersedes a pending one. Cancel WITHOUT writing:
    // the new plan carries its own spacer, derived from geometry that still
    // includes the old one.
    deferredSpacerRef.current?.();

    ownerRef.current = action.owner;
    const writeSpacer = () => {
      if (spacerRef.current) spacerRef.current.style.height = `${action.spacer}px`;
    };
    // Order matters: reserving blank must land BEFORE the scroll is asked for,
    // or the target is past the scrollable range and the browser silently
    // clamps it, landing the message short of the top. Reclaiming blank is the
    // mirror image and waits until the scroll has landed — see `deferSpacer`.
    if (!action.deferSpacer) writeSpacer();
    const container = containerRef.current;
    if (action.scrollTo !== null) {
      // scrollTo on the container, not scrollIntoView: the latter walks
      // ancestors, which in the three-panel layout can shift the panel itself.
      container?.scrollTo({ top: action.scrollTo, behavior: action.behavior });
    }
    if (action.deferSpacer && container) {
      // `scrollend` where it exists; a timer as the floor, because a smooth
      // scroll that had nowhere to go fires no event at all and the blank would
      // then never come back.
      const done = () => { cancel(); writeSpacer(); };
      const timer = setTimeout(done, SETTLE_FALLBACK_MS);
      const cancel = () => {
        clearTimeout(timer);
        container.removeEventListener('scrollend', done);
        deferredSpacerRef.current = null;
      };
      container.addEventListener('scrollend', done, { once: true });
      deferredSpacerRef.current = cancel;
    }
    return true;
  }, [readGeometry]);

  // A pending spacer write must not outlive the component.
  useEffect(() => () => deferredSpacerRef.current?.(), []);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);
  // The recent-message rail follows the turn nearest the viewport's reading
  // edge. Null is meaningful: when the reader is in history older than the ten
  // turns represented by the rail, none of those markers should pretend to be
  // current.
  const [activeUserMessageId, setActiveUserMessageId] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Sync outerRef to state so we can read it during render without violating ref rules
  useEffect(() => {
    setOuterEl(outerRef.current);
  }, []);

  useEffect(() => {
    if (!isLoading || !runningStartedAt) {
      setElapsedSeconds(0);
      return;
    }
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - runningStartedAt) / 1000)));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isLoading, runningStartedAt]);

  /* Same source as EngineBadge's tooltip — a missing engine is the historical default. */
  const runningEngineLabel = useMemo(
    () => (isEngineAccentId(engine) ? ENGINE_LABELS[engine] : ENGINE_LABELS.claude),
    [engine],
  );
  const runningEngine = isEngineAccentId(engine) ? engine : 'claude';

  const elapsedLabel = useMemo(() => {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
  }, [elapsedSeconds]);

  const {
    isSearchVisible,
    searchQuery,
    setSearchQuery,
    matches,
    currentMatchIndex,
    goToNextMatch,
    goToPrevMatch,
    closeSearch,
    searchInputRef,
    handleSearchKeyDown,
  } = useChatSearch(outerRef);
  const chatCtx = useChatContextOptional();

  // --- Selection toolbar & persistent comments ---
  const floatingToolbarRef = useRef<ToolbarData | null>(null);
  const bumpToolbarRef = useRef<() => void>(() => {});
  const { addComment, refresh: refreshComments } = useComments({ cwd: cwd || '', filePath: CHAT_COMMENT_FILE });
  const [commentInput, setCommentInput] = useState<{ x: number; y: number; text: string } | null>(null);
  const [sendAIInput, setSendAIInput] = useState<{ x: number; y: number; text: string } | null>(null);

  // Selection detection — text selection within the message area
  const handleSelectionMouseUp = useCallback((e: React.MouseEvent) => {
    if (commentInput || sendAIInput) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
      return;
    }
    // Only show the toolbar for AI reply bubbles
    const anchor = sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (anchor?.closest('[data-role="user"]')) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
      return;
    }
    // Chat selections aren't line-structured — there's no "whole line
    // expansion" concept, so `lineSnapshot` just mirrors `selectedText`.
    // The required-field shape on ToolbarData is what enforces this.
    floatingToolbarRef.current = {
      x: e.clientX,
      y: e.clientY,
      range: { start: 0, end: 0 },
      selectedText: text,
      lineSnapshot: text,
    };
    bumpToolbarRef.current();
  }, [commentInput, sendAIInput]);

  // Clear the toolbar on mousedown (unless clicking the toolbar/card itself)
  const handleSelectionMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.floating-toolbar') || target.closest('[class*="z-[200]"]')) return;
    if (floatingToolbarRef.current) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
    }
  }, []);

  // Toolbar button callbacks
  const handleAddComment = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb) return;
    setCommentInput({ x: tb.x, y: tb.y, text: tb.selectedText });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleSendToAI = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb) return;
    setSendAIInput({ x: tb.x, y: tb.y, text: tb.selectedText });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
  }, []);

  // One-click explain — no question card, and deliberately not routed through
  // sendSelectionToAI below (that one also ships and wipes the comment stack).
  const handleExplain = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb || !chatCtx) return;
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
    sendReferenceToAI(
      chatCtx.sendMessage,
      { filePath: CHAT_COMMENT_FILE, startLine: 0, endLine: 0, codeContent: tb.selectedText },
      t('explain.selectionMessage'),
    );
  }, [chatCtx, t]);

  const handleSearch = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb || !onContentSearch) return;
    const query = tb.selectedText.trim();
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
    if (query) onContentSearch(query);
  }, [onContentSearch]);

  // Comment submit — persist via useComments
  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!commentInput) return;
    await addComment(0, 0, content, commentInput.text);
    setCommentInput(null);
  }, [commentInput, addComment]);

  // Shared send-to-AI orchestration for both entries (standalone SendToAI
  // card / comment card button) — reuse fetchAllCommentsWithCode +
  // buildAIMessage + clearAllComments.
  const sendSelectionToAI = useCallback(async (selectedText: string, question: string) => {
    if (!chatCtx || !cwd) return;
    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = allComments.map(c => ({
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        codeContent: c.codeContent,
        note: c.content || undefined,
      }));
      // Treat the currently selected text as the last reference
      references.push({
        filePath: CHAT_COMMENT_FILE,
        startLine: 0,
        endLine: 0,
        codeContent: selectedText,
      });
      const message = buildAIMessage(references, question);
      chatCtx.sendMessage(message);
      await clearAllComments(cwd);
      refreshComments();
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [chatCtx, cwd, refreshComments]);

  // Quick reply — the canned-phrase shortcut past both cards' text input.
  // The two targets diverge on purpose:
  //   comment → parks the phrase on the comment stack, sends nothing
  //   ai      → ships the whole stack (this selection included) and, as that
  //             path always has, clears it once it has been handed over
  // Note this is the one one-click action that DOES go through
  // sendSelectionToAI. `handleExplain` above avoids it precisely to keep the
  // stack intact; here shipping the accumulated comments is the entire point,
  // which is what makes "annotate A, B, C, then send once" work.
  const handleQuickReply = useCallback((target: QuickReplyTarget, text: string) => {
    const tb = floatingToolbarRef.current;
    if (!tb) return;
    const selected = tb.selectedText;
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
    if (target === 'comment') {
      void addComment(0, 0, text, selected);
    } else {
      void sendSelectionToAI(selected, text);
    }
  }, [addComment, sendSelectionToAI]);

  // ── Quick-reply customization ───────────────────────────────────────────
  // Stored per language in ~/.cockpit/settings.json (see quickReplies.ts).
  // `null` means "not customized" — the toolbar then falls back to the i18n
  // defaults, which keep following a language switch.
  const quickReplyLang = toQuickReplyLang(i18n.language);
  const [customQuickReplies, setCustomQuickReplies] = useState<string[][] | null>(null);
  const [quickReplyEditorOpen, setQuickReplyEditorOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    BrowserRuntime.runPromiseExit(loadAgentSettings()).then((exit) => {
      if (cancelled) return;
      setCustomQuickReplies(
        exit._tag === 'Success' ? readQuickReplies(exit.value, quickReplyLang) : null
      );
    });
    return () => { cancelled = true; };
  }, [quickReplyLang]);

  /**
   * Persist one language's phrases (or clear them, restoring the defaults).
   *
   * Re-reads settings first and merges the whole `quickReplies` object by hand:
   * PUT /api/settings merges only at the TOP level, so sending
   * `{ quickReplies: { zh } }` would drop an existing `en`. A stale read is not
   * a real risk here — this is a local single-user app and the only other
   * writer of this key is this same dialog.
   */
  const persistQuickReplies = useCallback((rows: string[][] | null) => {
    void BrowserRuntime.runPromiseExit(loadAgentSettings()).then((exit) => {
      const current =
        exit._tag === 'Success'
          ? ((exit.value as { quickReplies?: QuickRepliesSetting }).quickReplies ?? {})
          : {};
      const next: QuickRepliesSetting = { ...current };
      if (rows) next[quickReplyLang] = rows;
      else delete next[quickReplyLang];
      return BrowserRuntime.runPromiseExit(saveAgentSettings({ quickReplies: next })).then(
        (saved) => {
          if (saved._tag === 'Success') setCustomQuickReplies(rows);
          else console.error('Failed to save quick replies:', saved.cause);
        }
      );
    });
  }, [quickReplyLang]);

  const handleEditQuickReplies = useCallback(() => {
    // Drop the toolbar up front. It would otherwise sit under the dialog's
    // backdrop until the first click dismissed it (see the mousedown handler
    // above), which reads as a rendering glitch.
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
    setQuickReplyEditorOpen(true);
  }, []);

  // What the panel shows: the custom set, else the built-in defaults resolved
  // in the current language.
  const quickReplyRows = useMemo(
    () => customQuickReplies ?? DEFAULT_QUICK_REPLY_KEYS.map((row) => row.map((key) => t(key))),
    [customQuickReplies, t]
  );

  // Both cards close themselves on submit — deliberately NO trailing state
  // reset after the async send (a late set(null) could clobber a card the
  // user opened in the meantime).
  const handleSendAISubmit = useCallback((question: string) => {
    if (!sendAIInput) return;
    void sendSelectionToAI(sendAIInput.text, question);
  }, [sendAIInput, sendSelectionToAI]);

  const handleCommentSendToAI = useCallback((question: string) => {
    if (!commentInput) return;
    void sendSelectionToAI(commentInput.text, question);
  }, [commentInput, sendSelectionToAI]);

  // Deduplicate messages (prevent duplicate key warnings), then drop assistant bubbles
  // that finished with nothing to show.
  //
  // Every send inserts an empty assistant placeholder (useChatStream) which the stream
  // then fills. A turn that ends without producing any assistant content — stopped early,
  // or failed before the first token — leaves that placeholder empty forever: the live
  // reducer only maps over messages and never removes one, and MessageBubble has no
  // empty-content early return, so it still paints its `bg-accent px-4 py-2` container
  // as a blank pill. The disk reconcile on run end would drop it, but it is skippable
  // (5s throttle / notModified fingerprint), so the blank row survives at random.
  //
  // `isStreaming` is the critical guard: a streaming empty bubble IS the loading
  // indicator, so filtering it would delete the "thinking" state of every in-flight turn.
  // Mirror MessageBubble's own content sources here (content / images / toolCalls /
  // parts) — anything it can render must count as non-empty.
  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      if (
        msg.role === 'assistant' &&
        !msg.isStreaming &&
        !msg.content &&
        !msg.images?.length &&
        !msg.toolCalls?.length &&
        !msg.parts?.length
      ) {
        return false;
      }
      return true;
    });
  }, [messages]);

  const allUserMessages = useMemo(
    () => uniqueMessages.filter((message) => message.role === 'user'),
    [uniqueMessages],
  );
  const recentUserMessages = useMemo(
    () => allUserMessages.slice(-RECENT_USER_MESSAGE_LIMIT),
    [allUserMessages],
  );
  const hasOlderUserMessages = hasMoreHistory || allUserMessages.length > RECENT_USER_MESSAGE_LIMIT;

  // Record scroll position before loading more, to restore it afterward
  const scrollHeightBeforeLoadRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);

  // Check if near the top (within 50px of the top)
  const checkIfAtTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 50;
    return container.scrollTop < threshold;
  }, []);

  // Follow the user turn nearest the viewport's reading edge. The rail has at
  // most ten entries, so its scroll work stays bounded even after older pages
  // have been loaded into the transcript.
  const refreshActiveUserMessage = useCallback((atContentEnd = false) => {
    const container = containerRef.current;
    if (!container) return;
    // At the transcript end there cannot be a later turn competing for the
    // reading position. The last user message owns everything through the end
    // of its answer, even when its row has not crossed the top-edge threshold.
    // Without this invariant a short final turn leaves the penultimate marker
    // highlighted while the complete final turn is already on screen.
    if (atContentEnd && recentUserMessages.length > 0) {
      setActiveUserMessageId(recentUserMessages[recentUserMessages.length - 1].id);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    let current: string | null = null;
    let firstVisible: string | null = null;

    for (const message of recentUserMessages) {
      const row = container.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
      if (!row) continue;
      const rowTop = row.getBoundingClientRect().top;
      if (!firstVisible && rowTop < containerRect.bottom) firstVisible = message.id;
      if (rowTop <= containerRect.top + STEP_EPSILON) current = message.id;
    }

    setActiveUserMessageId(current ?? firstVisible);
  }, [recentUserMessages]);

  // Listen to scroll events
  const handleScroll = useCallback(() => {
    // One layout read for the whole handler: this fires at scroll frequency, so
    // every extra `clientHeight`/`scrollHeight` touch is a forced reflow per
    // frame across every mounted tab.
    const g = readGeometry();
    /**
     * "The end is on screen" — of the CONTENT, not of the scroller: while a pin
     * is held the scroller ends a spacer below the last message, and measuring
     * against that would permanently arm the scroll-to-bottom button for a
     * reader looking straight at the last line.
     *
     * This drives the BUTTON only. Whether a reader has RESUMED FOLLOWING is a
     * stricter question (`modeForPosition`): sitting inside the reserved blank
     * passes the loose test but is a spacer's worth past the end, and following
     * from there yanked the viewport back on every streamed token.
     */
    const atBottom = g ? isContentEndVisible(g) : true;
    const atTop = checkIfAtTop();
    /**
     * `follow` and `free` are decided by position, exactly as the old
     * `setShouldAutoScroll(atBottom)` did. Anchored modes (`pinned` and
     * `reading`) are deliberately not: their programmatic scrolls carry no
     * user intent. Only a real gesture releases them; see below.
     */
    if (g) {
      ownerRef.current = ownerForPosition(ownerRef.current, g);
    }
    setShowTopButton(!atTop); // Show scroll-to-top button when not at the top
    setShowBottomButton(!atBottom);
    refreshActiveUserMessage(atBottom);

    // When scrolled to the top with more history available, trigger load-more
    if (atTop && hasMoreHistory && !isLoadingMore && onLoadMore) {
      // Record current scroll height to restore position after loading
      const container = containerRef.current;
      if (container) {
        scrollHeightBeforeLoadRef.current = container.scrollHeight;
        shouldRestoreScrollRef.current = true;
      }
      onLoadMore();
    }
  }, [checkIfAtTop, readGeometry, refreshActiveUserMessage, hasMoreHistory, isLoadingMore, onLoadMore]); // hasMoreHistory still needed for loading more logic

  // Scroll to top
  const scrollToTop = useCallback(() => {
    // A takeover, like any other explicit jump: end the pin first so its
    // reserved blank stops being derived from an offset nobody is looking at.
    dispatchScroll({ type: 'release' });
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [dispatchScroll]);

  /**
   * "Back to the end" means the end of the transcript, not the end of the
   * scroller: with a spacer standing, `bottomRef` sits below a screen of
   * reserved blank, and the button that promises the last message would deliver
   * an empty viewport.
   */
  const scrollToBottom = useCallback(() => {
    dispatchScroll({ type: 'toEnd' });
  }, [dispatchScroll]);

  // Scroll to a specific message.
  //
  // Reports miss/hit rather than holding the request for a later commit. A held
  // request has to be replayed from a layout effect, and that effect only beats
  // the follow-the-tail scroll if it is DEFINED after it — an ordering constraint
  // that lives in a comment, breaks silently when someone inserts an effect
  // between them, and no test can catch. A caller-side retry needs no such
  // constraint: requestAnimationFrame already runs after every layout effect of
  // the commit, so whichever frame the target appears in, the scroll wins.
  const scrollToMessage = useCallback((messageId: string): boolean => {
    const container = containerRef.current;
    if (!container) return false;
    const messageElement = container.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return false;

    // Land the message at the TOP, not centred: what you want to read after
    // jumping to a question is the answer under it, and centring spends half the
    // viewport on the conversation you jumped away from. Same landing formula as
    // the prev/next steppers below — one geometry (STEP_PADDING) for every jump,
    // so the two cannot drift apart.
    //
    // Instant, not smooth. A jump out of the message list is usually a long one
    // — tens of turns, thousands of pixels — and a smooth scroll of that length
    // is both slow and unreadable, everything in between merely blurring past.
    // It also broke the flash outright: the hold below starts counting when the
    // animation STARTS, so a long glide ate the whole 2s and the highlight was
    // over by the time the message arrived. CodeViewer's equivalent jump lands
    // instantly for the same reasons.
    //
    // scrollTo on the container rather than scrollIntoView: the latter walks
    // every scrollable ancestor, which in a three-panel shell can move more than
    // the thread.
    const offsetTop =
      messageElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({
      top: container.scrollTop + offsetTop - STEP_PADDING,
      behavior: 'auto',
    });
    // An explicit jump is a takeover: end any pin, and trim its reserved blank
    // to what this new position needs. Without it the pin would keep deriving
    // from the offset the reader just left, and would eventually converge and
    // haul them back down to the tail.
    dispatchScroll({ type: 'release' });

    // Flash the target. The class goes on the ROW — the only anchor we have —
    // and `.flash-turn .chat-turn` in globals.css projects it onto the bubble
    // nested inside. See that rule for why the highlight must not be drawn on
    // the row itself.
    //
    // Restart rather than extend: clear whatever the previous jump left behind,
    // drop the class, and re-add it a frame later so re-selecting the SAME row
    // replays the transition instead of doing nothing visible.
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTargetRef.current?.classList.remove('flash-turn');
    messageElement.classList.remove('flash-turn');
    // Force a reflow between remove and add so the transition restarts. Doing
    // this synchronously beats deferring the add to requestAnimationFrame: the
    // class is on the element before this function returns, so no React commit
    // can land in the gap and no caller has to reason about frames.
    void (messageElement as HTMLElement).offsetWidth;
    messageElement.classList.add('flash-turn');
    flashTargetRef.current = messageElement;
    flashTimerRef.current = setTimeout(() => {
      messageElement.classList.remove('flash-turn');
      flashTargetRef.current = null;
      flashTimerRef.current = null;
    }, FLASH_HOLD_MS);
    return true;
  }, [dispatchScroll]);


  /**
   * A send asks for the NEXT user row to be pinned; it cannot pin anything
   * itself, because the row does not exist in the DOM until the optimistic
   * message commits a tick later.
   */
  const pendingPinRef = useRef(false);

  const requestPin = useCallback(() => {
    pendingPinRef.current = true;
  }, []);

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    scrollToMessage,
    pinNextUserMessage: requestPin,
  }), [scrollToMessage, requestPin]);

  /**
   * Arm the pin on the first commit after a send, targeting the LAST USER row
   * rather than the last row.
   *
   * The send path appends the user message and the assistant placeholder in two
   * `setMessages` calls inside one event handler, so React batches them into a
   * single commit whose final element is the *assistant* placeholder. An
   * earlier version of this waited for the last row to be a user row and
   * therefore never fired at all.
   *
   * Timing is safe without any "is this the right commit" test: `requestPin`
   * runs inside the send handler, no effect can run between it and the commit
   * it triggers, and that commit is the one carrying the new user row.
   *
   * The row's id is read HERE and nowhere else. Holding the pin afterwards
   * needs only the offset, which is why a completed run swapping the optimistic
   * `user-<ts>` id for its canonical disk uuid (see mergeIncrementalMessages)
   * can no longer strand the pin on a node that has ceased to exist.
   */
  useLayoutEffect(() => {
    if (!pendingPinRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    // Search the RENDERED list: `messages` can carry rows that never reach the
    // DOM (uniqueMessages drops duplicate ids and empty assistant husks), and a
    // pin target with no node is a pin that measures nothing.
    let target: ChatMessage | undefined;
    for (let i = uniqueMessages.length - 1; i >= 0; i -= 1) {
      if (uniqueMessages[i].role === 'user') { target = uniqueMessages[i]; break; }
    }
    if (!target) return;
    const row = container.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
    if (!row) return;

    pendingPinRef.current = false;
    const rowTop =
      row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    // Same landing geometry as every other jump in this file.
    dispatchScroll({ type: 'pin', top: Math.max(0, rowTop - STEP_PADDING) });
  }, [uniqueMessages, dispatchScroll]);

  /**
   * Remember an explicit foreground → background transition during a run.
   * This is intentionally independent of geometry: by the time a parent hides
   * the pane, every DOM measurement may already be zero.
   */
  useLayoutEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = isActive;
    if (wasActive && !isActive && isLoading) {
      restoreTurnStartRef.current = true;
    }
  }, [isActive, isLoading]);

  /**
   * The transcript's height moved: streamed deltas, a disk reconcile, the
   * thinking indicator appearing. One event, one layout read; what it does
   * depends on who owns the viewport, and that is the reducer's business.
   */
  useLayoutEffect(() => {
    if (shouldRestoreScrollRef.current) return;
    dispatchScroll({ type: 'content' });
  }, [messages, isLoading, dispatchScroll]);

  /**
   * The scroller's own box moved: a pane resize, the mobile soft keyboard, or
   * this tab going from `display:none` back to visible. The last one is why
   * this observer is unconditional — a hidden pane measures every rect as zero,
   * so its state is left frozen exactly as it was and re-derived from real
   * numbers on the way back in, before the first paint the reader sees.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => dispatchScroll({ type: 'viewport' }));
    ro.observe(container);
    return () => ro.disconnect();
  }, [dispatchScroll]);

  /**
   * Leaving a pin is an intent question, not a position one. These events fire
   * only for a real gesture, so this cannot be tripped by our own scrolling the
   * way a scroll-position check would be. Either direction counts: scrolling
   * DOWN into the reserved blank is just as much a takeover as scrolling up.
   *
   * `keydown` is here because space / PageDown / the arrow keys scroll a
   * container without producing either of the other two, and a pin that only
   * mouse users could leave is a pin that fights the keyboard.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const release = () => dispatchScroll({ type: 'release' });
    container.addEventListener('wheel', release, { passive: true });
    container.addEventListener('touchmove', release, { passive: true });
    container.addEventListener('keydown', release);
    return () => {
      container.removeEventListener('wheel', release);
      container.removeEventListener('touchmove', release);
      container.removeEventListener('keydown', release);
    };
  }, [dispatchScroll]);

  /**
   * A pin belongs to one session. Carrying its spacer into another transcript
   * (fork, resume, session switch) would leave a hole under a conversation
   * nobody just sent to.
   */
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    /**
     * A NEW session has no id until the engine reports one, which happens while
     * the very first message is mid-flight — i.e. while it is pinned. Treating
     * that null → id transition as a session switch would cancel the pin on
     * exactly the turn most likely to be someone's first impression of this
     * behaviour. Only a switch between two established transcripts counts.
     */
    if (!prev || prev === sessionId) return;

    pendingPinRef.current = false;
    restoreTurnStartRef.current = false;
    dispatchScroll({ type: 'reset' });
  }, [sessionId, dispatchScroll]);

  // Restore scroll position after loading more history
  useLayoutEffect(() => {
    if (shouldRestoreScrollRef.current && !isLoadingMore) {
      const container = containerRef.current;
      if (container) {
        // Calculate the height delta of newly added content to preserve visual position
        const heightDiff = container.scrollHeight - scrollHeightBeforeLoadRef.current;
        container.scrollTop = heightDiff;
        shouldRestoreScrollRef.current = false;
      }
    }
  }, [messages, isLoadingMore]);

  /**
   * The run finished: hand the reserved blank back.
   *
   * A pin buys the reader a full viewport to read the answer in; once there is
   * no more answer coming, that blank is just wasted screen, so it is given
   * back with a short glide rather than left standing. A reader who has scrolled
   * away into history has no blank reserved and is left alone (see 'settle').
   *
   * A plain effect, not a layout one: the content event for this same commit
   * has to hold the pin first, and the movement is animated anyway.
   */
  const prevLoadingRef = useRef(isLoading);
  const pendingSettleRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;
    if (!wasLoading || isLoading) return;
    // A run can finish while its tab is hidden, where nothing can be measured.
    // Remember it and settle on the way back in.
    pendingSettleRef.current = !dispatchScroll({ type: 'settle' });
  }, [isLoading, dispatchScroll]);

  /**
   * Becoming visible is a viewport change like any other. Everything that
   * happened while this tab was hidden — a whole run streaming in, history
   * landing — moved no pixels, because a `display:none` scroller ignores writes
   * to `scrollTop` and reports zero for every rect. One event with real numbers
   * puts it back: a follower re-glues to the tail, a pin re-establishes itself.
   *
   * A layout effect, so this lands before the first paint the reader sees,
   * rather than in a ResizeObserver callback a frame later.
   */
  useLayoutEffect(() => {
    if (!isActive) return;

    if (restoreTurnStartRef.current) {
      const container = containerRef.current;
      const userRows = container?.querySelectorAll('[data-role="user"]');
      const row = userRows?.item((userRows?.length ?? 0) - 1);
      if (container && row) {
        const rowTop =
          row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        if (dispatchScroll({ type: 'readFrom', top: Math.max(0, rowTop - STEP_PADDING) })) {
          restoreTurnStartRef.current = false;
          // A run that completed in the background queued a settle. readFrom
          // has already reclaimed its blank while preserving the reading
          // position, so that settle would only pull the reader to the tail.
          pendingSettleRef.current = false;
          return;
        }
      }
    }

    dispatchScroll({ type: 'viewport' });
    if (pendingSettleRef.current) {
      pendingSettleRef.current = false;
      dispatchScroll({ type: 'settle' });
    }
    // Deliberately NOT keyed on message count: while a pin is held, a
    // 'viewport' event re-asserts the pinned offset, and firing that per
    // appended bubble would cut the pin's own smooth scroll short. Content
    // changes have their own event.
  }, [isActive, dispatchScroll]);

  // Scroll events alone would miss the cases where the geometry changes without
  // a scroll: streamed/appended messages, loaded history, a tab becoming
  // visible (rects are all zero while hidden).
  useEffect(() => {
    if (!isActive) return;
    const g = readGeometry();
    refreshActiveUserMessage(g ? isContentEndVisible(g) : false);
  }, [messages, isActive, readGeometry, refreshActiveUserMessage]);

  return (
    <div ref={outerRef} className="relative flex-1 min-h-0 overflow-hidden flex flex-col outline-none" tabIndex={-1} onMouseUp={handleSelectionMouseUp} onMouseDown={handleSelectionMouseDown}>
      {/* Search bar */}
      {isSearchVisible && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('codeViewer.searchChat')}
            className="flex-1 max-w-xs px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="text-xs text-muted-foreground">
            {matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : t('common.noMatch')}
          </span>
          <button onClick={goToPrevMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-hover disabled:opacity-50" title={t('codeViewer.prevShiftEnter')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button onClick={goToNextMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-hover disabled:opacity-50" title={t('codeViewer.nextEnter')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button onClick={closeSearch} className="p-1 rounded hover:bg-hover" title={t('codeViewer.closeEsc')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 min-h-0 overflow-y-auto px-8 py-4"
      >
        {messages.length === 0 && !isLoading ? (
          <div className="flex items-center justify-center h-full text-foreground-subtle">
            <div className="text-center">
              <div className="text-4xl mb-4">💬</div>
              <div>{t('chat.startConversation')}</div>
            </div>
          </div>
        ) : (
          /* One centred column for every row type, so turns, the load-more
             indicator and the thinking row all read against the same centre
             line. The scroller itself stays full-width: it owns the scrollbar
             and the absolutely-positioned jump capsules. */
          <div className="mx-auto w-full max-w-[var(--chat-column)]">
            <div ref={topRef} />
            {/* Load-more history indicator */}
            {hasMoreHistory && (
              <div className="flex justify-center py-3">
                {isLoadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    <span>{t('chat.loadMoreHistory')}</span>
                  </div>
                ) : (
                  <button
                    onClick={onLoadMore}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('chat.scrollUpForMore')}
                  </button>
                )}
              </div>
            )}
            {uniqueMessages.map((message) => (
              <div
                key={message.id}
                data-message-id={message.id}
                data-role={message.role}
              >
                <MessageBubble
                  message={message}
                  cwd={cwd}
                  sessionId={sessionId}
                  onFork={onFork}
                  onDeleteTurn={onDeleteTurn}
                  forkSupported={forkSupported}
                  onSendToPeer={onSendToPeer}
                  peerSide={peerSide}
                  onApprovePlan={onApprovePlan}
                  isLoading={isLoading}
                  onContentSearch={onContentSearch}
                  onShowFileDiff={onShowFileDiff}
                  onOpenFileLink={onOpenFileLink}
                />
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="px-1 py-1 max-w-[90%]">
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center" aria-hidden="true">
                      <EngineIcon engine={runningEngine} className="h-4 w-4" />
                    </span>
                    <span className="text-sm text-muted-foreground/80">
                      {runningEngineLabel} running {elapsedLabel} · processing{' '}
                      <AnimatedProgressNumber value={liveOutputTokens?.outputTokens ?? 0} />
                    </span>
                  </div>
                  {backgroundTasks && backgroundTasks.length > 0 && (
                    <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground border-t border-border/50 pt-2">
                      <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div>
                          Waiting on {backgroundTasks.length} background task
                          {backgroundTasks.length > 1 ? 's' : ''}
                        </div>
                        {backgroundTasks.map((task) => (
                          <div key={task.task_id} className="text-muted-foreground/80 break-words">
                            {task.description}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {apiRetryInfo && (
                    <div className="mt-2 flex items-start gap-2 text-xs text-amber-11 border-t border-border/50 pt-2">
                      <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div>
                          Retrying API call (attempt {apiRetryInfo.attempt}
                          {apiRetryInfo.maxRetries > 0 ? `/${apiRetryInfo.maxRetries}` : ''}
                          {apiRetryInfo.delayMs > 0 ? `, delay ${(apiRetryInfo.delayMs / 1000).toFixed(1)}s` : ''}
                          )
                        </div>
                        {(apiRetryInfo.errorStatus || apiRetryInfo.error) && (
                          <div className="text-muted-foreground/80 break-words">
                            {apiRetryInfo.errorStatus ? `${apiRetryInfo.errorStatus}` : ''}
                            {apiRetryInfo.errorStatus && apiRetryInfo.error ? ' · ' : ''}
                            {apiRetryInfo.error || ''}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Reserved space that lets the pinned turn reach the top of the
                viewport. It is DERIVED, never owned: every event recomputes it
                as exactly what the position being held needs and no more, so it
                shrinks as the reply grows into it and as the reader scrolls up,
                and it can never be left behind by the position that justified
                it. When the run finishes it is handed back entirely. See
                scrollPlan.ts. */}
            {/* Height is written to this node directly by dispatchScroll, and
                read back off it as the source of truth. No style prop: React
                would then hold its own idea of the height and the two writers
                would race on re-render. */}
            <div ref={spacerRef} aria-hidden />
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* The rail is deliberately inside this overflow-hidden panel shell. Its
          preview can cover chat content, but can never leak into the Explorer
          panel beside it in the three-panel layout. On wide panes it docks just
          outside the centred conversation column's right edge instead of clinging
          to the panel edge; on narrow panes max() keeps the original 8px inset. Oldest
          is at the top, newest at the bottom, matching the transcript's reading
          direction. */}
      {(recentUserMessages.length > 0 || showTopButton || showBottomButton) && (
        <nav
          className="absolute top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-2"
          style={{ right: 'max(0.5rem, calc(50% - var(--chat-column) / 2 - 2.25rem))' }}
          aria-label={t('chat.recentUserMessages')}
        >
          {showTopButton && messages.length > 0 && (
            <button
              onClick={scrollToTop}
              className="mb-1 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-hover hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={t('chat.jumpToStart')}
              aria-label={t('chat.jumpToStart')}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5h14M12 19V9m-5 5l5-5 5 5" />
              </svg>
            </button>
          )}
          {hasOlderUserMessages && onShowUserMessages && (
            <button
              onClick={onShowUserMessages}
              className="mb-1 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={t('chat.moreUserMessages')}
              aria-label={t('chat.moreUserMessages')}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          {recentUserMessages.map((message, index) => {
            const isActiveMessage = activeUserMessageId === message.id;
            const preview = message.content.replace(/\s+/g, ' ').trim()
              || (message.images?.length ? t('chat.imageMessage') : t('chat.userMessage'));
            const recentOrdinal = index + 1;
            return (
              <div key={message.id} className="group relative flex h-3 items-center">
                <button
                  onClick={(event) => {
                    scrollToMessage(message.id);
                    // A pointer click leaves the button focused; because the
                    // preview also supports keyboard focus, that focus would
                    // keep it open after the pointer had left the marker.
                    if (event.detail > 0) event.currentTarget.blur();
                  }}
                  className="flex h-3 w-7 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-current={isActiveMessage ? 'true' : undefined}
                  aria-label={t('chat.recentUserMessageNumber', {
                    index: recentOrdinal,
                    total: recentUserMessages.length,
                  })}
                >
                  <span
                    aria-hidden
                    className={`h-0.5 rounded-full transition-all ${
                      isActiveMessage
                        ? 'w-4 bg-foreground'
                        : 'w-3 bg-foreground/20 group-hover:w-4 group-hover:bg-foreground/45'
                    }`}
                  />
                </button>
                <div className="pointer-events-none absolute right-8 top-1/2 hidden w-72 -translate-y-1/2 rounded-xl border border-border bg-card px-3 py-2.5 text-left shadow-lv2 group-hover:block group-focus-within:block">
                  <div className="line-clamp-4 text-sm leading-5 text-foreground">
                    {preview}
                  </div>
                </div>
              </div>
            );
          })}
          {showBottomButton && messages.length > 0 && (
            <button
              onClick={scrollToBottom}
              className="mt-1 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-hover hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={t('chat.jumpToLatest')}
              aria-label={t('chat.jumpToLatest')}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 19H5m7-14v10m5-5l-5 5-5-5" />
              </svg>
            </button>
          )}
        </nav>
      )}

      {/* Selection toolbar */}
      {outerEl && (
        <ToolbarRenderer
          floatingToolbarRef={floatingToolbarRef}
          bumpRef={bumpToolbarRef}
          container={outerEl}
          onAddComment={handleAddComment}
          onSendToAI={handleSendToAI}
          onSearch={onContentSearch ? handleSearch : undefined}
          onExplain={chatCtx ? handleExplain : undefined}
          onQuickReply={handleQuickReply}
          quickReplyRows={quickReplyRows}
          onEditQuickReplies={handleEditQuickReplies}
          isChatLoading={chatCtx?.isLoading}
        />
      )}

      {/* Quick-reply editor. Mounted here, NOT inside the toolbar: the toolbar
          unmounts on the first mousedown outside it, which would take the
          dialog with it the moment the textarea was clicked. */}
      {quickReplyEditorOpen && (
        <QuickRepliesEditor
          initialRows={quickReplyRows}
          lang={quickReplyLang}
          isCustomized={customQuickReplies !== null}
          onSave={(rows) => persistQuickReplies(rows.length ? rows : null)}
          onRestoreDefault={() => persistQuickReplies(null)}
          onClose={() => setQuickReplyEditorOpen(false)}
        />
      )}

      {/* Add comment card (also hosts a Send-to-AI action) */}
      {commentInput && outerEl && (
        <AddCommentInput
          x={commentInput.x}
          y={commentInput.y}
          range={{ start: 0, end: 0 }}
          lineSnapshot={commentInput.text}
          container={outerEl}
          onSubmit={handleCommentSubmit}
          onSendToAI={chatCtx ? handleCommentSendToAI : undefined}
          onClose={() => setCommentInput(null)}
          isChatLoading={chatCtx?.isLoading}
        />
      )}

      {/* Send to AI card (standalone, from toolbar) */}
      {sendAIInput && outerEl && (
        <SendToAIInput
          x={sendAIInput.x}
          y={sendAIInput.y}
          range={{ start: 0, end: 0 }}
          lineSnapshot={sendAIInput.text}
          container={outerEl}
          onSubmit={handleSendAISubmit}
          onClose={() => setSendAIInput(null)}
          isChatLoading={chatCtx?.isLoading}
        />
      )}
    </div>
  );
});
