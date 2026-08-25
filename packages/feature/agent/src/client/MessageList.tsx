'use client';

import { useEffect, useLayoutEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { useChatContextOptional } from './ChatContext';
import { ENGINE_LABELS, EngineIcon, isEngineAccentId } from './engineAccents';
import type { ChatMessage, ApiRetryInfo, ChatEngine, ToolCallInfo, LiveOutputTokens } from './types';
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
const STEP_PADDING = 8;
const STEP_EPSILON = STEP_PADDING + 4;

interface MessageListProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  cwd?: string;
  sessionId?: string | null;
  engine?: ChatEngine;
  apiRetryInfo?: ApiRetryInfo | null;
  liveOutputTokens?: LiveOutputTokens | null;
  runningStartedAt?: number | null;
  hasMoreHistory?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onFork?: (messageId: string, scope: 'prefix' | 'single') => void;
  isActive?: boolean; // Whether the tab is active (handles scroll issues for hidden tabs)
  onContentSearch?: (query: string) => void; // Selected text → project-wide search
  /** Show a message's file changes in the Explorer panel (panel 2) + auto-swipe */
  onShowFileDiff?: (messageId: string, toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string, runId?: string, live?: boolean) => void;
  /** AI reply Markdown local-file link → Explorer tree + optional line jump. */
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void;
  /** Plan mode: approve the presented plan → turn off plan mode and resend to execute */
  onApprovePlan?: () => void;
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
  scrollToMessage: (messageId: string) => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, isLoading, cwd, sessionId, engine, apiRetryInfo, liveOutputTokens, runningStartedAt, hasMoreHistory, isLoadingMore, onLoadMore, onFork, isActive = true, onContentSearch, onShowFileDiff, onOpenFileLink, onApprovePlan },
  ref
) {
  const { t, i18n } = useTranslation();
  // Passed down as a plain boolean, not `engine`, to keep MessageBubble's memo props stable.
  const forkSupported = true;
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [outerEl, setOuterEl] = useState<HTMLDivElement | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
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

  // Check if near the bottom (within 50px of the bottom)
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 50;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
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
    setShouldAutoScroll(atBottom);
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

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Scroll to a specific message
  const scrollToMessage = useCallback((messageId: string) => {
    const container = containerRef.current;
    if (!container) return;

    // Find the DOM element for the message
    const messageElement = container.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Add highlight effect
      messageElement.classList.add('ring-2', 'ring-brand', 'ring-offset-2');
      setTimeout(() => {
        messageElement.classList.remove('ring-2', 'ring-brand', 'ring-offset-2');
      }, 2000);
    }
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

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    scrollToMessage,
  }), [scrollToMessage]);

  // Flag for whether this is the initial load
  const isInitialLoadRef = useRef(true);

  // Keep following the bottom whenever rendered messages change, as long as the
  // user has not intentionally scrolled away. This covers streaming deltas and
  // disk reconcile updates where the message count does not change.
  useLayoutEffect(() => {
    if (isInitialLoadRef.current) return;
    if (!shouldAutoScroll) return;
    if (shouldRestoreScrollRef.current) return;

    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, shouldAutoScroll]);

  // Also check scroll on isLoading change (showing/hiding the "thinking" indicator)
  useLayoutEffect(() => {
    if (shouldAutoScroll && isLoading) {
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [isLoading, shouldAutoScroll]);

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
        className="relative flex-1 min-h-0 overflow-y-auto p-4"
      >
        {messages.length === 0 && !isLoading ? (
          <div className="flex items-center justify-center h-full text-foreground-subtle">
            <div className="text-center">
              <div className="text-4xl mb-4">💬</div>
              <div>{t('chat.startConversation')}</div>
            </div>
          </div>
        ) : (
          <>
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
                className="transition-[box-shadow] duration-300"
              >
                <MessageBubble
                  message={message}
                  cwd={cwd}
                  sessionId={sessionId}
                  onFork={onFork}
                  forkSupported={forkSupported}
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
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Jump controls. The prev/next pair lives on the bottom capsule only —
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

      {/* Scroll to latest + the user-message steps */}
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
