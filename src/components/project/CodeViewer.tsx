'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { BundledLanguage } from 'shiki';
import { useMenuContainer } from './FileContextMenu';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { getHighlighter, getLanguageFromPath, escapeHtml } from './codeHighlighter';
import { FloatingToolbar } from './FloatingToolbar';
import { ViewCommentCard } from './ViewCommentCard';
import { CodeLine } from './CodeLine';
import { useCodeViewerLogic, type CodeViewerProps } from './useCodeViewerLogic';

// Re-export utilities used by other modules
export { getHighlighter, getLanguageFromPath } from './codeHighlighter';

// ============================================
// CodeViewer Component
// ============================================

export function CodeViewer({
  content,
  filePath,
  showLineNumbers = true,
  showSearch = true,
  className = '',
  cwd,
  enableComments = false,
  scrollToLine = null,
  onScrollToLineComplete,
  highlightKeyword = null,
}: CodeViewerProps) {
  const {
    // Refs
    parentRef,
    containerRef,
    searchInputRef,
    floatingToolbarRef,

    // State
    highlightedLines,
    isMounted,
    isSearchVisible,
    searchQuery,
    caseSensitive,
    wholeWord,
    currentMatchIndex,
    viewingComment,
    toolbarVersion,
    addCommentInput,
    sendToAIInput,
    chatContext,
    commentsEnabled,
    updateComment,
    deleteComment,

    // Computed
    lines,
    matches,
    rowData,
    virtualizer,
    commentsByEndLine,
    linesWithComments,

    // Handlers
    setIsSearchVisible,
    setSearchQuery,
    setCaseSensitive,
    setWholeWord,
    setViewingComment,
    setAddCommentInput,
    setSendToAIInput,
    goToNextMatch,
    goToPrevMatch,
    handleSearchKeyDown,
    handleCommentBubbleClick,
    handleToolbarAddComment,
    handleToolbarSendToAI,
    handleCommentSubmit,
    handleSendToAISubmit,
    getHighlightedLineHtml,
  } = useCodeViewerLogic({
    content,
    filePath,
    showSearch,
    cwd,
    enableComments,
    scrollToLine,
    onScrollToLineComplete,
  });

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  const lineNumberWidth = showLineNumbers ? Math.max(3, String(lines.length).length) * 10 + 24 : 0;

  return (
    <div ref={containerRef} className={`h-full flex flex-col ${className}`} tabIndex={0}>
      {/* Search Bar */}
      {showSearch && isSearchVisible && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-secondary border-b border-border">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索..."
            className="flex-1 max-w-xs px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              caseSensitive
                ? 'bg-brand text-white border-brand'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
            title="区分大小写"
          >
            Aa
          </button>
          <button
            onClick={() => setWholeWord(!wholeWord)}
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              wholeWord
                ? 'bg-brand text-white border-brand'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
            title="全字匹配"
          >
            [ab]
          </button>
          <span className="text-xs text-muted-foreground">
            {matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : '无匹配'}
          </span>
          <button onClick={goToPrevMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title="上一个">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button onClick={goToNextMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title="下一个">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button onClick={() => { setIsSearchVisible(false); setSearchQuery(''); }} className="p-1 rounded hover:bg-accent" title="关闭">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Code Content */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto font-mono text-sm bg-secondary"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const row = rowData[virtualItem.index];
            if (row.type !== 'code') return null;

            const lineIndex = row.lineIndex;
            const lineNum = lineIndex + 1;
            const html = highlightedLines[lineIndex] || escapeHtml(lines[lineIndex] || '');
            const highlightedHtml = getHighlightedLineHtml(lineIndex, html, highlightKeyword);

            const hasComments = linesWithComments.has(lineNum);
            const lineComments = commentsByEndLine.get(lineNum);
            const firstComment = lineComments?.[0];
            const isInRange = !!(addCommentInput && lineNum >= addCommentInput.range.start && lineNum <= addCommentInput.range.end);

            return (
              <CodeLine
                key={virtualItem.key}
                virtualKey={virtualItem.key}
                lineNum={lineNum}
                highlightedHtml={highlightedHtml}
                hasComments={hasComments}
                firstComment={firstComment}
                lineCommentsCount={lineComments?.length}
                isInRange={isInRange}
                showLineNumbers={showLineNumbers}
                lineNumberWidth={lineNumberWidth}
                commentsEnabled={commentsEnabled}
                virtualItemSize={virtualItem.size}
                virtualItemStart={virtualItem.start}
                onCommentBubbleClick={handleCommentBubbleClick}
              />
            );
          })}
        </div>
      </div>

      {/* Floating elements via Portal to menu container (keeps within second screen) */}
      {isMounted && menuContainer && createPortal(
        <>
          {/* Floating Toolbar */}
          {floatingToolbarRef.current && (
            <FloatingToolbar
              key={toolbarVersion}
              x={floatingToolbarRef.current.x}
              y={floatingToolbarRef.current.y}
              container={menuContainer}
              onAddComment={handleToolbarAddComment}
              onSendToAI={handleToolbarSendToAI}
              isChatLoading={chatContext?.isLoading}
            />
          )}

          {/* Add Comment Input */}
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              codeContent={addCommentInput.codeContent}
              container={menuContainer}
              onSubmit={handleCommentSubmit}
              onClose={() => setAddCommentInput(null)}
            />
          )}

          {/* Send to AI Input */}
          {sendToAIInput && (
            <SendToAIInput
              x={sendToAIInput.x}
              y={sendToAIInput.y}
              range={sendToAIInput.range}
              filePath={filePath}
              codeContent={sendToAIInput.codeContent}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
              isChatLoading={chatContext?.isLoading}
            />
          )}

          {/* View Comment Card */}
          {viewingComment && (
            <ViewCommentCard
              x={viewingComment.x}
              y={viewingComment.y}
              comment={viewingComment.comment}
              container={menuContainer}
              onClose={() => setViewingComment(null)}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          )}
        </>,
        menuContainer
      )}
    </div>
  );
}

// ============================================
// Simple Code Block (non-virtual, for small content)
// ============================================

interface SimpleCodeBlockProps {
  content: string;
  filePath: string;
  className?: string;
}

export function SimpleCodeBlock({ content, filePath, className = '' }: SimpleCodeBlockProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const lines = content.split('\n');
        const lineNumberWidth = String(lines.length).length;

        const html = highlighter.codeToHtml(content, {
          lang: language as BundledLanguage,
          theme,
          transformers: [
            {
              line(node, line) {
                const lineNum = String(line).padStart(lineNumberWidth, ' ');
                node.children.unshift({
                  type: 'element',
                  tagName: 'span',
                  properties: { class: 'line-number' },
                  children: [{ type: 'text', value: lineNum }],
                });
              },
            },
          ],
        });

        setHighlightedHtml(html);
      } catch (err) {
        console.error('Highlight error:', err);
        setHighlightedHtml(null);
      }
    };

    highlight();
  }, [content, filePath, isDark]);

  if (highlightedHtml) {
    return (
      <div
        className={`overflow-auto text-sm font-mono ${className}`}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  const lines = content.split('\n');
  const lineNumberWidth = String(lines.length).length;

  return (
    <pre className={`overflow-auto text-sm font-mono bg-secondary p-2 ${className}`}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="text-slate-9 select-none pr-4 text-right" style={{ minWidth: `${lineNumberWidth + 2}ch` }}>
            {i + 1}
          </span>
          <span className="flex-1">{line}</span>
        </div>
      ))}
    </pre>
  );
}
