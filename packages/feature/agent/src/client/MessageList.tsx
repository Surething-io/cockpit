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
 * Scroll ownership. Exactly one of these is true at a time, and every automatic
 * scroll in this file has to name the mode it belongs to — the bug this replaces
 * was five independent `scrollTop = scrollHeight` effects with no shared notion
 * of who was in charge.
 *
 *   follow → glue the viewport to the end of the transcript (the old default)
 *   pinned → the turn the user just sent sits at the top of the viewport, and
 *            the reply grows downward into reserved blank space below it
 *   free   → the user took over by hand; touch nothing
 *
 * follow ──send──▶ pinned ──reply outgrows viewport──▶ follow
 *   ▲                │                                    │
 *   │           manual scroll                     manual scroll
 *   │                ▼                                    ▼
 *   └── scroll to content bottom ──────────────────────  free
 */
type ScrollMode = 'follow' | 'pinned' | 'free';

// How close to the bottom of the CONTENT (not of the scroller — see the spacer)
// still counts as "at the end".
const AT_BOTTOM_THRESHOLD = 50;


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
  { messages, isLoading, cwd, sessionId, engine, apiRetryInfo, backgroundTasks, liveOutputTokens, runningStartedAt, hasMoreHistory, isLoadingMore, onLoadMore, onFork, onSendToPeer, peerSide, isActive = true, onContentSearch, onShowFileDiff, onOpenFileLink, onApprovePlan, onShowUserMessages },
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
  const [scrollMode, setScrollMode] = useState<ScrollMode>('follow');
  /**
   * The mode, readable SYNCHRONOUSLY. A pin is armed from a layout effect, and
   * the follow-the-bottom effects run later in that same commit still seeing
   * `scrollMode === 'follow'` from the pre-send render — they would slam
   * scrollTop to the end of the freshly reserved blank and cancel the pin's
   * animation before it drew a frame. State drives re-subscription; this drives
   * the guards.
   */
  const scrollModeRef = useRef<ScrollMode>('follow');
  const setMode = useCallback((next: ScrollMode) => {
    scrollModeRef.current = next;
    setScrollMode(next);
  }, []);
  /**
   * Reserved blank space below the last turn, in px. This is what makes a pin
   * possible at all: the browser caps scrollTop at `scrollHeight - clientHeight`,
   * so without roughly a viewport of content underneath it, the LAST message
   * physically cannot be moved to the top of the viewport.
   *
   * Held in a ref and written straight to the node, NOT in state: it is
   * re-derived on every streaming delta, and a setState there would re-render
   * the whole list twice per token — once for the delta, once for the spacer —
   * running the memo comparison over every mounted bubble for a number that
   * nothing but this one element reads.
   */
  const spacerRef = useRef<HTMLDivElement>(null);
  const spacerHeightRef = useRef(0);
  const applySpacer = useCallback((px: number) => {
    spacerHeightRef.current = px;
    if (spacerRef.current) spacerRef.current.style.height = `${px}px`;
  }, []);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);
  // Is there a user message above / below the current viewport top? Drives the
  // greyed-out state of the prev/next buttons.
  const [canStepPrev, setCanStepPrev] = useState(false);
  const [canStepNext, setCanStepNext] = useState(false);
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

  // Record scroll position before loading more, to restore it afterward
  const scrollHeightBeforeLoadRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);

  /**
   * Near the end of the CONTENT — deliberately not the end of the scroller.
   * While a pin is held, the scroller ends a spacer below the last message, and
   * measuring against that would report "not at the bottom" for a reader who is
   * looking straight at the last line of the transcript, permanently arming the
   * scroll-to-bottom button and blocking the return to follow mode.
   */
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const contentHeight = container.scrollHeight - spacerHeightRef.current;
    return contentHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_THRESHOLD;
  }, []);

  // Check if near the top (within 50px of the top)
  const checkIfAtTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 50;
    return container.scrollTop < threshold;
  }, []);

  // Whether a prev/next user message exists from where we are now. Only the
  // FIRST and LAST user rows are measured — if the first one is not above the
  // viewport top there is nothing to step back to, and likewise for the last
  // one below. Measuring every row here would mean an O(messages) burst of
  // layout reads on every scroll event.
  const refreshStepAvailability = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const rows = container.querySelectorAll('[data-message-id][data-role="user"]');
    const first = rows[0];
    const last = rows[rows.length - 1];
    const containerTop = container.getBoundingClientRect().top;
    setCanStepPrev(!!first && first.getBoundingClientRect().top - containerTop < -STEP_EPSILON);
    setCanStepNext(!!last && last.getBoundingClientRect().top - containerTop > STEP_EPSILON);
  }, []);

  // Listen to scroll events
  const handleScroll = useCallback(() => {
    const atBottom = checkIfAtBottom();
    const atTop = checkIfAtTop();
    /**
     * `follow` and `free` are decided by position, exactly as the old
     * `setShouldAutoScroll(atBottom)` did. `pinned` is deliberately NOT: while
     * a pin is held nothing here ever moves scrollTop (the spacer absorbs the
     * reply instead), so position carries no signal, and a short reply parks
     * the pinned message BOTH at the viewport top and within 50px of the
     * content end — which position alone would misread as "resume following".
     * A pin is left by user INTENT only; see the wheel/touch effect below.
     */
    if (scrollModeRef.current !== 'pinned') {
      setMode(atBottom ? 'follow' : 'free');
    }
    setShowTopButton(!atTop); // Show scroll-to-top button when not at the top
    setShowBottomButton(!atBottom);
    refreshStepAvailability();

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
  }, [checkIfAtBottom, checkIfAtTop, refreshStepAvailability, hasMoreHistory, isLoadingMore, onLoadMore]); // hasMoreHistory still needed for loading more logic

  // Scroll to top
  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  /**
   * "Back to the end" means the end of the transcript, not the end of the
   * scroller: with a spacer standing, `bottomRef` sits below a screen of
   * reserved blank, and the button that promises the last message would deliver
   * an empty viewport.
   */
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setMode('follow');
    // Drop the spacer FIRST, then read scrollHeight: the read forces layout, so
    // the target below is already the end of the real content rather than the
    // end of the blank that is on its way out.
    applySpacer(0);
    container.scrollTo({
      top: container.scrollHeight - container.clientHeight,
      behavior: 'smooth',
    });
  }, [applySpacer]);

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
  }, []);


  // Jump to the previous / next user message, top-aligned so the reply that
  // follows it stays in view. No highlight: the jump is a reading move, and the
  // message landing at the top edge already says where it went.
  //
  // Deliberately stateless: the target is recomputed from the live scroll
  // position on every click, so manual scrolling, streaming appends and
  // load-more never leave a stale cursor behind. Boundaries are a no-op — the
  // earliest loaded user message is the end of the line; loading older history
  // stays the job of the scroll-to-top handler.
  const jumpToUserMessage = useCallback((direction: 'prev' | 'next') => {
    const container = containerRef.current;
    if (!container) return;

    const containerTop = container.getBoundingClientRect().top;
    const rows = Array.from(container.querySelectorAll('[data-message-id][data-role="user"]'));
    const offsetOf = (el: Element) => el.getBoundingClientRect().top - containerTop;

    const target =
      direction === 'prev'
        ? [...rows].reverse().find((el) => offsetOf(el) < -STEP_EPSILON)
        : rows.find((el) => offsetOf(el) > STEP_EPSILON);
    if (!target) return;

    // Scroll the container itself rather than scrollIntoView(): the latter also
    // walks ancestors, which in the three-panel layout can shift the panel.
    container.scrollTo({
      top: container.scrollTop + offsetOf(target) - STEP_PADDING,
      behavior: 'smooth',
    });
  }, []);

  /**
   * A send asks for the NEXT user row to be pinned; it cannot pin anything
   * itself, because the row does not exist in the DOM until the optimistic
   * message commits a tick later.
   */
  const pendingPinRef = useRef(false);
  const pinnedIdRef = useRef<string | null>(null);

  const requestPin = useCallback(() => {
    pendingPinRef.current = true;
  }, []);

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    scrollToMessage,
    pinNextUserMessage: requestPin,
  }), [scrollToMessage, requestPin]);

  /**
   * The whole pin, in one formula.
   *
   * `rowTop` (the pinned row's offset inside the scrolled content) and
   * `clientHeight` are both fixed for the duration of a turn, so
   *
   *     spacer = (rowTop - STEP_PADDING + clientHeight) - contentHeight
   *
   * makes `scrollHeight` a CONSTANT: every pixel the reply grows is a pixel the
   * spacer gives back. That is the point — the pin is held by never scrolling,
   * not by re-scrolling to the same place each frame. Re-scrolling is what
   * makes streaming chat views jitter, and it fights the user for the scrollbar.
   *
   * When the reply finally outgrows the reserved space the formula goes
   * negative, clamps to 0, and the pinned position has by then converged
   * exactly onto the bottom — so handing back to follow mode is seamless.
   */
  const measurePin = useCallback(() => {
    const container = containerRef.current;
    const id = pinnedIdRef.current;
    if (!container || !id) return null;
    const row = container.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (!row) return null;

    const rowTop =
      row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const contentHeight = container.scrollHeight - spacerHeightRef.current;
    const desiredScrollTop = Math.max(0, rowTop - STEP_PADDING);
    const spacer = Math.max(0, desiredScrollTop + container.clientHeight - contentHeight);
    return { desiredScrollTop, spacer };
  }, []);

  // Flag for whether this is the initial load
  const isInitialLoadRef = useRef(true);

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
   */
  useLayoutEffect(() => {
    if (!pendingPinRef.current) return;
    // Search the RENDERED list: `messages` can carry rows that never reach the
    // DOM (uniqueMessages drops duplicate ids and empty assistant husks), and a
    // pin target with no node is a pin that measures nothing.
    let target: ChatMessage | undefined;
    for (let i = uniqueMessages.length - 1; i >= 0; i -= 1) {
      if (uniqueMessages[i].role === 'user') { target = uniqueMessages[i]; break; }
    }
    if (!target) return;

    pendingPinRef.current = false;
    pinnedIdRef.current = target.id;
    const m = measurePin();
    if (!m) return;

    // Order matters: the spacer must be in the layout BEFORE the scroll is
    // asked for, or the target is past the scrollable range and the browser
    // silently clamps it, landing the message short of the top. Writing the
    // node directly (rather than via state) is what makes "before" possible
    // inside a single layout effect.
    applySpacer(m.spacer);
    setMode('pinned');
    // scrollTo on the container, not scrollIntoView: the latter walks ancestors,
    // which in the three-panel layout can shift the panel itself.
    containerRef.current?.scrollTo({ top: m.desiredScrollTop, behavior: 'smooth' });
  }, [uniqueMessages, measurePin, applySpacer]);

  /**
   * Hold the pin: re-derive the spacer from the reply's current height. Runs on
   * every streaming delta and costs one layout read — no scrolling, no render.
   *
   * Safe to run while the entry animation is still in flight: `measurePin`
   * derives everything from `getBoundingClientRect` offsets plus `scrollTop`,
   * which is invariant under scrolling, so a mid-animation measurement returns
   * the same numbers as a settled one.
   */
  useLayoutEffect(() => {
    if (scrollMode !== 'pinned') return;
    const m = measurePin();
    if (!m) return;
    if (m.spacer <= 0) {
      // The reply outgrew the reserved space; the two positions have converged,
      // so follow mode takes over without a visible jump.
      applySpacer(0);
      setMode('follow');
      return;
    }
    applySpacer(m.spacer);
  }, [messages, isLoading, scrollMode, measurePin, applySpacer]);

  /**
   * Re-establish the pin when the viewport itself changes size — the reserved
   * space is derived from `clientHeight`, and on mobile the soft keyboard
   * changes that out from under a held pin. Re-scroll instantly rather than
   * smoothly: this follows a resize the user just caused, so it should look
   * like the layout settling, not like a second animated jump.
   */
  useEffect(() => {
    if (scrollMode !== 'pinned') return;
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const m = measurePin();
      if (!m) return;
      applySpacer(m.spacer);
      container.scrollTop = m.desiredScrollTop;
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [scrollMode, measurePin, applySpacer]);

  /**
   * Leaving a pin is an intent question, not a position one. wheel/touchmove
   * fire only for a real gesture, so this cannot be tripped by our own scrolling
   * the way a scroll-position check would be. Either direction counts: scrolling
   * DOWN into the reserved blank is just as much a takeover as scrolling up.
   */
  useEffect(() => {
    if (scrollMode !== 'pinned') return;
    const container = containerRef.current;
    if (!container) return;
    const release = () => setMode('free');
    container.addEventListener('wheel', release, { passive: true });
    container.addEventListener('touchmove', release, { passive: true });
    return () => {
      container.removeEventListener('wheel', release);
      container.removeEventListener('touchmove', release);
    };
  }, [scrollMode]);

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
    pinnedIdRef.current = null;
    applySpacer(0);
    setMode('follow');
  }, [sessionId, applySpacer, setMode]);

  // Keep following the bottom whenever rendered messages change, as long as the
  // user has not intentionally scrolled away. This covers streaming deltas and
  // disk reconcile updates where the message count does not change.
  useLayoutEffect(() => {
    if (isInitialLoadRef.current) return;
    if (scrollModeRef.current !== 'follow') return;
    if (shouldRestoreScrollRef.current) return;

    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, scrollMode]);

  // Also check scroll on isLoading change (showing/hiding the "thinking" indicator)
  useLayoutEffect(() => {
    if (scrollModeRef.current === 'follow' && isLoading) {
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [isLoading, scrollMode]);

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

  // Flag whether a scroll-to-bottom is needed when the tab becomes active
  const needsScrollOnActivateRef = useRef(false);

  // When the tab activates, compensate for any scroll that was blocked while hidden
  useLayoutEffect(() => {
    if (isActive && needsScrollOnActivateRef.current && messages.length > 0) {
      needsScrollOnActivateRef.current = false;
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [isActive, messages.length]);

  // Initial load logic: if the tab is hidden, mark that scroll is needed on activation
  useLayoutEffect(() => {
    if (isInitialLoadRef.current && messages.length > 0) {
      isInitialLoadRef.current = false;
      if (isActive) {
        const container = containerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      } else {
        // Tab is hidden — mark that scroll should happen on activation
        needsScrollOnActivateRef.current = true;
      }
    }
  }, [messages.length, isActive]);

  // Scroll events alone would miss the cases where the geometry changes without
  // a scroll: streamed/appended messages, loaded history, a tab becoming
  // visible (rects are all zero while hidden).
  useEffect(() => {
    if (!isActive) return;
    refreshStepAvailability();
  }, [messages, isActive, refreshStepAvailability]);

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
                      <EngineIcon engine={runningEngine} className="h-4 w-4 animate-pulse" />
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
                viewport. Left standing after a short reply on purpose:
                collapsing it the moment the answer finishes would yank the
                page down by up to a screen exactly as the reader starts
                reading. It is reclaimed by the next send, by scrolling to the
                content end, or by switching session. */}
            {/* Height is owned by `applySpacer`, which writes this node
                directly. No style prop: React would then hold its own idea of
                the height and the two writers would race on re-render. */}
            <div ref={spacerRef} aria-hidden />
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Jump controls, centred over the conversation. The column is itself
          centred in the panel, so left-1/2 is the middle of the messages.

          These capsules are opaque and they do float over whatever text scrolls
          under them — a real finding, and the reason they were briefly moved to
          the panel edge and then to the column edge. Both were worse: at the
          panel edge they strand themselves against the window on a wide display,
          far from the content they scroll. Centred and transient is the
          conventional place for a scroll control, and it is where they belong.

          The prev/next pair lives on the bottom capsule only —
          one home for it, near where the hand already is; the top capsule stays
          the single-purpose "back to the beginning" button it always was.
          Icon language: chevron = run to the end of the list, bar-arrow = land
          on one message (the bar is the row you stop at). */}
      {showTopButton && messages.length > 0 && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center bg-card shadow-lv2 rounded-full">
          <button
            onClick={scrollToTop}
            className="p-2 text-muted-foreground hover:text-foreground rounded-full transition-all active:scale-95"
            title={t('chat.jumpToStart')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        </div>
      )}

      {/* Scroll to latest + the user-message steps + the whole-session list.
          The list button rides the same transient rule as the rest of the capsule
          rather than pinning itself on top: these capsules are opaque and sit over
          the text (see the note above), and one button held there permanently was
          worse than the trip it saves. Consequence to keep in mind — at the bottom
          of a thread the list has no entry until you scroll up. */}
      {showBottomButton && messages.length > 0 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center bg-card shadow-lv2 rounded-full">
          <button
            onClick={scrollToBottom}
            className="p-2 text-muted-foreground hover:text-foreground rounded-full transition-all active:scale-95"
            title={t('chat.jumpToLatest')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <span className="w-px h-4 bg-border" />
          <button
            onClick={() => jumpToUserMessage('prev')}
            disabled={!canStepPrev}
            className="p-2 text-muted-foreground hover:text-foreground rounded-full transition-all active:scale-95 disabled:opacity-40 disabled:hover:text-muted-foreground disabled:active:scale-100 disabled:cursor-default"
            title={t('chat.jumpToPrevUserMessage')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5h14M12 19V9m-5 5l5-5 5 5" />
            </svg>
          </button>
          <button
            onClick={() => jumpToUserMessage('next')}
            disabled={!canStepNext}
            className="p-2 text-muted-foreground hover:text-foreground rounded-full transition-all active:scale-95 disabled:opacity-40 disabled:hover:text-muted-foreground disabled:active:scale-100 disabled:cursor-default"
            title={t('chat.jumpToNextUserMessage')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 19H5m7-14v10m5-5l-5 5-5-5" />
            </svg>
          </button>
          {onShowUserMessages && (
            <>
              {/* Stepping through messages and opening a panel are different acts,
                  so they do not sit flush against each other. */}
              <span className="w-px h-4 bg-border" />
              <button
                onClick={onShowUserMessages}
                className="p-2 text-muted-foreground hover:text-foreground rounded-full transition-all active:scale-95"
                title={t('chat.userMessages')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </>
          )}
        </div>
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
