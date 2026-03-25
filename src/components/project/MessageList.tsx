'use client';

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { ChatMessage } from '@/types/chat';
import { MessageBubble } from './MessageBubble';
import { useChatSearch } from '@/hooks/useChatSearch';
import { ToolbarRenderer, ToolbarData } from './FloatingToolbar';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { useChatContextOptional } from './ChatContext';
import { useComments } from '@/hooks/useComments';
import { fetchAllCommentsWithCode, buildAIMessage, clearAllComments, CHAT_COMMENT_FILE, type CodeReference } from '@/hooks/useAllComments';
import { useTranslation } from 'react-i18next';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  cwd?: string;
  sessionId?: string | null;
  hasMoreHistory?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onFork?: (messageId: string) => void;
  isActive?: boolean; // Whether the tab is active (handles scroll issues for hidden tabs)
  onContentSearch?: (query: string) => void; // Selected text → project-wide search
}

// Methods exposed to parent component
export interface MessageListHandle {
  scrollToMessage: (messageId: string) => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, isLoading, cwd, sessionId, hasMoreHistory, isLoadingMore, onLoadMore, onFork, isActive = true, onContentSearch },
  ref
) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [outerEl, setOuterEl] = useState<HTMLDivElement | null>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);

  // Sync outerRef to state so we can read it during render without violating ref rules
  useEffect(() => {
    setOuterEl(outerRef.current);
  }, []);

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
    floatingToolbarRef.current = {
      x: e.clientX,
      y: e.clientY,
      range: { start: 0, end: 0 },
      selectedText: text,
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

  // Send to AI submit — reuse fetchAllCommentsWithCode + buildAIMessage + clearAllComments
  const handleSendAISubmit = useCallback(async (question: string) => {
    if (!sendAIInput || !chatCtx || !cwd) return;
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
        codeContent: sendAIInput.text,
      });
      const message = buildAIMessage(references, question);
      chatCtx.sendMessage(message);
      await clearAllComments(cwd);
      refreshComments();
      setSendAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendAIInput, chatCtx, cwd, refreshComments]);

  // Deduplicate messages (prevent duplicate key warnings)
  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
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

  // Listen to scroll events
  const handleScroll = useCallback(() => {
    const atBottom = checkIfAtBottom();
    const atTop = checkIfAtTop();
    setShouldAutoScroll(atBottom);
    setShowTopButton(!atTop); // Show scroll-to-top button when not at the top
    setShowBottomButton(!atBottom);

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
  }, [checkIfAtBottom, checkIfAtTop, hasMoreHistory, isLoadingMore, onLoadMore]); // hasMoreHistory still needed for loading more logic

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

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    scrollToMessage,
  }), [scrollToMessage]);

  // Track the previous message count to detect new messages
  const prevMessageCountRef = useRef(0);
  // Flag for whether this is the initial load
  const isInitialLoadRef = useRef(true);

  // Scroll logic on message change (new messages only; initial load handled by a separate useEffect)
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const currentCount = messages.length;
    prevMessageCountRef.current = currentCount;

    // Initial load is handled by a separate useEffect
    if (isInitialLoadRef.current) {
      return;
    }

    // New messages arrived while at the bottom: smooth scroll
    if (shouldAutoScroll && currentCount > prevCount) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, shouldAutoScroll]);

  // Also check scroll on isLoading change (showing/hiding the "thinking" indicator)
  useEffect(() => {
    if (shouldAutoScroll && isLoading) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isLoading, shouldAutoScroll]);

  // Restore scroll position after loading more history
  useEffect(() => {
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
  useEffect(() => {
    if (isActive && needsScrollOnActivateRef.current && messages.length > 0) {
      needsScrollOnActivateRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [isActive, messages.length]);

  // Initial load logic: if the tab is hidden, mark that scroll is needed on activation
  useEffect(() => {
    if (isInitialLoadRef.current && messages.length > 0) {
      isInitialLoadRef.current = false;
      if (isActive) {
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      } else {
        // Tab is hidden — mark that scroll should happen on activation
        needsScrollOnActivateRef.current = true;
      }
    }
  }, [messages.length, isActive]);

  return (
    <div ref={outerRef} className="relative flex-1 min-h-0 overflow-hidden flex flex-col outline-none" tabIndex={-1} onMouseUp={handleSelectionMouseUp} onMouseDown={handleSelectionMouseDown}>
      {/* Search bar */}
      {isSearchVisible && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-secondary border-b border-border">
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
          <button onClick={goToPrevMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title={t('codeViewer.prevShiftEnter')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button onClick={goToNextMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title={t('codeViewer.nextEnter')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button onClick={closeSearch} className="p-1 rounded hover:bg-accent" title={t('codeViewer.closeEsc')}>
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
          <div className="flex items-center justify-center h-full text-slate-9">
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
              <div key={message.id} data-message-id={message.id} className="transition-[box-shadow] duration-300">
                <MessageBubble
                  message={message}
                  cwd={cwd}
                  sessionId={sessionId}
                  onFork={onFork}
                />
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="bg-accent rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-block w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">{t('chat.claudeThinking')}</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Scroll to top button */}
      {showTopButton && messages.length > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95"
          title={t('chat.jumpToStart')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      {/* Scroll to bottom button */}
      {showBottomButton && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95"
          title={t('chat.jumpToLatest')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
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
          isChatLoading={chatCtx?.isLoading}
        />
      )}

      {/* Add comment card */}
      {commentInput && outerEl && (
        <AddCommentInput
          x={commentInput.x}
          y={commentInput.y}
          range={{ start: 0, end: 0 }}
          codeContent={commentInput.text}
          container={outerEl}
          onSubmit={handleCommentSubmit}
          onClose={() => setCommentInput(null)}
        />
      )}

      {/* Send to AI card */}
      {sendAIInput && outerEl && (
        <SendToAIInput
          x={sendAIInput.x}
          y={sendAIInput.y}
          range={{ start: 0, end: 0 }}
          codeContent={sendAIInput.text}
          container={outerEl}
          onSubmit={handleSendAISubmit}
          onClose={() => setSendAIInput(null)}
          isChatLoading={chatCtx?.isLoading}
        />
      )}
    </div>
  );
});
