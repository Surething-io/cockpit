'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { type BundledLanguage } from 'shiki';
import { getHighlighter, getLanguageFromPath } from './CodeViewer';
import { useComments, type CodeComment } from '@/hooks/useComments';

// ============================================
// Types
// ============================================

export interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

interface HighlightedLine {
  tokens: Array<{ content: string; style?: string }>;
}

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew?: boolean;
  isDeleted?: boolean;
  // Comment support
  cwd?: string;
  enableComments?: boolean;
}

// ============================================
// LCS-based Line Diff Algorithm
// ============================================

export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];

  const m = oldLines.length;
  const n = newLines.length;

  // Build DP table for LCS
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to generate diff
  let i = m, j = n;
  const diffStack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffStack.push({ type: 'unchanged', content: oldLines[i - 1], oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffStack.push({ type: 'added', content: newLines[j - 1], newLineNum: j });
      j--;
    } else {
      diffStack.push({ type: 'removed', content: oldLines[i - 1], oldLineNum: i });
      i--;
    }
  }

  // Reverse to get correct order
  while (diffStack.length > 0) {
    result.push(diffStack.pop()!);
  }

  return result;
}

// ============================================
// Line Highlight Hook
// ============================================

function useLineHighlight(lines: string[], filePath: string): Map<number, HighlightedLine> {
  const [highlightedLines, setHighlightedLines] = useState<Map<number, HighlightedLine>>(new Map());
  const [isDark, setIsDark] = useState(false);
  const prevLinesKeyRef = useRef<string>('');

  // Detect dark mode
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();

    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  const linesKey = lines.join('\n');

  useEffect(() => {
    if (lines.length === 0) return;

    // Skip if content hasn't changed
    const currentKey = `${linesKey}:${filePath}:${isDark}`;
    if (currentKey === prevLinesKeyRef.current) {
      return;
    }
    prevLinesKeyRef.current = currentKey;

    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const result = new Map<number, HighlightedLine>();

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) {
            result.set(i, { tokens: [{ content: '' }] });
            continue;
          }

          const tokens = highlighter.codeToTokens(line, {
            lang: language as BundledLanguage,
            theme: theme,
          });

          const highlightedTokens = tokens.tokens[0]?.map(token => ({
            content: token.content,
            style: token.color ? `color: ${token.color}` : undefined,
          })) || [{ content: line }];

          result.set(i, { tokens: highlightedTokens });
        }

        setHighlightedLines(result);
      } catch (err) {
        console.error('Line highlight error:', err);
      }
    };

    highlight();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, filePath, isDark]);

  return highlightedLines;
}

// ============================================
// Highlighted Content Component
// ============================================

function HighlightedContent({
  content,
  highlightedLine,
  className
}: {
  content: string;
  highlightedLine?: HighlightedLine;
  className?: string;
}) {
  if (!highlightedLine || highlightedLine.tokens.length === 0) {
    return <span className={className}>{content || ' '}</span>;
  }

  return (
    <span className={className}>
      {highlightedLine.tokens.map((token, i) => (
        <span key={i} style={token.style ? { color: token.style.replace('color: ', '') } : undefined}>
          {token.content}
        </span>
      ))}
    </span>
  );
}

// ============================================
// Diff Minimap Component
// ============================================

function DiffMinimap({
  lines,
  containerRef,
}: {
  lines: Array<{ type: 'unchanged' | 'removed' | 'added' }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewportInfo, setViewportInfo] = useState({ top: 0, height: 0 });

  // Update viewport indicator position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewport = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const minimapHeight = minimapRef.current?.clientHeight || 0;

      if (scrollHeight <= clientHeight) {
        // Content doesn't overflow, viewport covers entire minimap
        setViewportInfo({ top: 0, height: minimapHeight });
      } else {
        const ratio = minimapHeight / scrollHeight;
        setViewportInfo({
          top: scrollTop * ratio,
          height: clientHeight * ratio,
        });
      }
    };

    updateViewport();
    container.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      container.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [containerRef]);

  // Click to jump
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const minimap = minimapRef.current;
    if (!container || !minimap) return;

    const rect = minimap.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = clickY / rect.height;

    const targetScroll = ratio * container.scrollHeight - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  };

  if (lines.length === 0) return null;

  // Calculate line height percentage for minimap
  const lineHeight = 100 / lines.length;

  return (
    <div
      ref={minimapRef}
      className="w-4 flex-shrink-0 bg-secondary border-l border-border relative cursor-pointer"
      onClick={handleClick}
    >
      {/* Change markers with percentage positioning */}
      {lines.map((line, idx) => (
        line.type !== 'unchanged' && (
          <div
            key={idx}
            className={`absolute left-0 right-0 ${
              line.type === 'removed' ? 'bg-red-9' : 'bg-green-9'
            }`}
            style={{
              top: `${idx * lineHeight}%`,
              height: `${Math.max(lineHeight, 0.5)}%`,
              minHeight: '2px',
            }}
          />
        )
      ))}
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 bg-muted/60 border-y border-border"
        style={{
          top: `${viewportInfo.top}px`,
          height: `${Math.max(viewportInfo.height, 10)}px`,
        }}
      />
    </div>
  );
}

// ============================================
// Comment Components for DiffView
// ============================================

interface ViewCommentCardProps {
  x: number;
  y: number;
  comment: CodeComment;
  onClose: () => void;
  onUpdateComment: (id: string, content: string) => Promise<boolean>;
  onDeleteComment: (id: string) => Promise<boolean>;
}

function ViewCommentCard({
  x,
  y,
  comment,
  onClose,
  onUpdateComment,
  onDeleteComment,
}: ViewCommentCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    if (cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let newX = x, newY = y;
      if (x + rect.width > viewportWidth - 16) newX = viewportWidth - rect.width - 16;
      if (newX < 16) newX = 16;
      if (y + rect.height > viewportHeight - 16) newY = y - rect.height - 8;
      if (newY < 16) newY = 16;
      setPosition({ x: newX, y: newY });
    }
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSave = async () => {
    if (editContent.trim()) {
      await onUpdateComment(comment.id, editContent.trim());
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    await onDeleteComment(comment.id);
    onClose();
  };

  return (
    <div
      ref={cardRef}
      className="fixed z-50 w-96 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
      style={{ left: position.x, top: position.y }}
    >
      <div className="p-3">
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              rows={3}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave(); }
                if (e.key === 'Escape') { setIsEditing(false); setEditContent(comment.content); }
              }}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setIsEditing(false); setEditContent(comment.content); }} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">取消</button>
              <button onClick={handleSave} className="px-2 py-1 text-xs bg-brand text-white rounded hover:bg-brand/90">保存</button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-foreground whitespace-pre-wrap">{comment.content}</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">行 {comment.startLine}-{comment.endLine}</span>
              <div className="flex gap-1">
                <button onClick={() => setIsEditing(true)} className="p-1 rounded hover:bg-accent text-muted-foreground" title="编辑">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button onClick={handleDelete} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-red-9" title="删除">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface AddCommentInputProps {
  x: number;
  y: number;
  range: { start: number; end: number };
  onSubmit: (content: string) => void;
  onClose: () => void;
}

function AddCommentInput({ x, y, range, onSubmit, onClose }: AddCommentInputProps) {
  const [content, setContent] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    if (cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let newX = x, newY = y;
      if (x + rect.width > viewportWidth - 16) newX = viewportWidth - rect.width - 16;
      if (newX < 16) newX = 16;
      if (y + rect.height > viewportHeight - 16) newY = y - rect.height - 8;
      if (newY < 16) newY = 16;
      setPosition({ x: newX, y: newY });
    }
  }, [x, y]);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSubmit = () => { if (content.trim()) onSubmit(content.trim()); };

  return (
    <div ref={cardRef} className="fixed z-50 w-80 bg-card border border-border rounded-lg shadow-lg overflow-hidden" style={{ left: position.x, top: position.y }}>
      <div className="px-3 py-2 bg-secondary border-b border-border">
        <span className="text-xs text-muted-foreground">行 {range.start}-{range.end}</span>
      </div>
      <div className="p-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="输入评论..."
          className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="mt-1 text-xs text-muted-foreground">Enter 提交 · Shift+Enter 换行</div>
      </div>
    </div>
  );
}

// ============================================
// Main DiffView Component (Split View)
// ============================================

export function DiffView({ oldContent, newContent, filePath, isNew = false, isDeleted = false, cwd, enableComments = false }: DiffViewProps) {
  const diffLines = computeLineDiff(oldContent, newContent);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const [isMounted, setIsMounted] = useState(false);

  // Comment state
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  const [addCommentButton, setAddCommentButton] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
  } | null>(null);

  const [addCommentInput, setAddCommentInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
  } | null>(null);

  // Track mount state for Portal
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Lines with comments (based on new file line numbers)
  const linesWithComments = useMemo(() => {
    const set = new Set<number>();
    for (const comment of comments) {
      for (let i = comment.startLine; i <= comment.endLine; i++) {
        set.add(i);
      }
    }
    return set;
  }, [comments]);

  // Comments grouped by end line
  const commentsByEndLine = useMemo(() => {
    const map = new Map<number, CodeComment[]>();
    for (const comment of comments) {
      const line = comment.endLine;
      if (!map.has(line)) map.set(line, []);
      map.get(line)!.push(comment);
    }
    return map;
  }, [comments]);

  // Handle text selection in right panel
  useEffect(() => {
    if (!commentsEnabled) return;

    const handleMouseUp = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setAddCommentButton(null);
        return;
      }

      const range = selection.getRangeAt(0);
      const container = rightPanelRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) return;

      // Find line numbers from DOM
      const getLineFromNode = (node: Node): number | null => {
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
        while (el && el !== container) {
          const lineRow = el.closest('[data-new-line]');
          if (lineRow) {
            return parseInt(lineRow.getAttribute('data-new-line') || '0', 10);
          }
          el = el.parentElement;
        }
        return null;
      };

      const startLine = getLineFromNode(range.startContainer);
      const endLine = getLineFromNode(range.endContainer);

      if (startLine && endLine) {
        const minLine = Math.min(startLine, endLine);
        const maxLine = Math.max(startLine, endLine);
        setAddCommentButton({ x: e.clientX, y: e.clientY, range: { start: minLine, end: maxLine } });
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [commentsEnabled]);

  const handleCommentBubbleClick = useCallback((comment: CodeComment, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewingComment({ comment, x: e.clientX, y: e.clientY });
    setAddCommentButton(null);
    setAddCommentInput(null);
  }, []);

  const handleAddCommentButtonClick = useCallback(() => {
    if (!addCommentButton) return;
    setAddCommentInput({ x: addCommentButton.x, y: addCommentButton.y, range: addCommentButton.range });
    setAddCommentButton(null);
    window.getSelection()?.removeAllRanges();
  }, [addCommentButton]);

  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!addCommentInput) return;
    await addComment(addCommentInput.range.start, addCommentInput.range.end, content);
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Sync both vertical and horizontal scroll between left and right panels
  useEffect(() => {
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!leftPanel || !rightPanel) return;

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    };

    const handleLeftScroll = () => syncScroll(leftPanel, rightPanel);
    const handleRightScroll = () => syncScroll(rightPanel, leftPanel);

    leftPanel.addEventListener('scroll', handleLeftScroll);
    rightPanel.addEventListener('scroll', handleRightScroll);

    return () => {
      leftPanel.removeEventListener('scroll', handleLeftScroll);
      rightPanel.removeEventListener('scroll', handleRightScroll);
    };
  }, []);

  // Split into left and right columns
  const leftLines: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
  const rightLines: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

  let leftIdx = 0;
  let rightIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type === 'unchanged') {
      // Align: pad with empty lines if needed
      while (leftLines.length < rightLines.length) {
        leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      }
      while (rightLines.length < leftLines.length) {
        rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      }
      leftIdx++;
      rightIdx++;
      leftLines.push({ lineNum: leftIdx, content: line.content, type: 'unchanged', originalIdx: i });
      rightLines.push({ lineNum: rightIdx, content: line.content, type: 'unchanged', originalIdx: i });
    } else if (line.type === 'removed') {
      leftIdx++;
      leftLines.push({ lineNum: leftIdx, content: line.content, type: 'removed', originalIdx: i });
    } else if (line.type === 'added') {
      rightIdx++;
      rightLines.push({ lineNum: rightIdx, content: line.content, type: 'added', originalIdx: i });
    }
  }

  // Final alignment
  while (leftLines.length < rightLines.length) {
    leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }

  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // Adjust left/right width based on file status: new file 25%/75%, deleted 75%/25%, otherwise 50%/50%
  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  // Prepare minimap line types
  const minimapLines = leftLines.map((leftLine, idx) => {
    const rightLine = rightLines[idx];
    if (leftLine.type === 'removed') return { type: 'removed' as const };
    if (rightLine?.type === 'added') return { type: 'added' as const };
    return { type: 'unchanged' as const };
  });

  return (
    <div className="font-mono flex flex-col h-full" style={{ fontSize: '0.8125rem' }}>
      {/* Header row - fixed */}
      <div className="flex flex-shrink-0 border-b border-border">
        <div className={`${leftWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium border-r border-border`}>
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        <div className={`${rightWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium`}>
          {isDeleted ? '(Deleted)' : 'New'}
        </div>
        <div className="w-4 flex-shrink-0 bg-accent" />
      </div>
      {/* Content row - two independent scroll panels with synced vertical scroll */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel - Old */}
        <div
          ref={leftPanelRef}
          className={`${leftWidth} overflow-auto border-r border-border`}
        >
          <div className="min-w-max">
            {leftLines.map((line, idx) => (
              <div
                key={idx}
                className={`flex ${line.type === 'removed' ? 'bg-red-9/15 dark:bg-red-9/25' : ''}`}
              >
                <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                  {line.lineNum || ''}
                </span>
                <HighlightedContent
                  content={line.content}
                  highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
                  className="whitespace-pre pl-2"
                />
              </div>
            ))}
          </div>
        </div>
        {/* Right Panel - New */}
        <div
          ref={rightPanelRef}
          className={`${rightWidth} overflow-auto`}
        >
          <div className="min-w-max">
            {rightLines.map((line, idx) => {
              const lineNum = line?.lineNum || 0;
              const hasComments = lineNum > 0 && linesWithComments.has(lineNum);
              const lineComments = commentsByEndLine.get(lineNum);
              const firstComment = lineComments?.[0];
              const isInRange = addCommentInput && lineNum >= addCommentInput.range.start && lineNum <= addCommentInput.range.end;

              return (
                <div
                  key={idx}
                  data-new-line={lineNum || undefined}
                  className={`flex ${
                    isInRange ? 'bg-blue-9/20' :
                    hasComments ? 'bg-amber-9/10' :
                    line?.type === 'added' ? 'bg-green-9/15 dark:bg-green-9/25' : ''
                  }`}
                >
                  <span className={`flex-shrink-0 flex items-center gap-0.5 pr-1 text-slate-9 select-none border-r border-border ${
                    isInRange ? 'bg-blue-9/30' : ''
                  }`} style={{ width: commentsEnabled ? '52px' : '40px' }}>
                    {/* Comment bubble */}
                    {commentsEnabled && lineNum > 0 && hasComments && firstComment && (
                      <button
                        onClick={(e) => handleCommentBubbleClick(firstComment, e)}
                        className="w-4 h-4 flex items-center justify-center rounded hover:bg-accent text-amber-9"
                        title={`${lineComments?.length} 条评论`}
                      >
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                    {commentsEnabled && lineNum > 0 && !hasComments && <span className="w-4" />}
                    <span className="flex-1 text-right pr-1">{lineNum || ''}</span>
                  </span>
                  <HighlightedContent
                    content={line?.content || ''}
                    highlightedLine={line?.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
                    className="whitespace-pre pl-2"
                  />
                </div>
              );
            })}
          </div>
        </div>
        {/* Minimap */}
        <DiffMinimap
          lines={minimapLines}
          containerRef={leftPanelRef}
        />
      </div>

      {/* Floating elements via Portal */}
      {isMounted && createPortal(
        <>
          {addCommentButton && (
            <button
              className="fixed z-50 px-2 py-1 text-xs bg-brand text-white rounded shadow-lg hover:bg-brand/90"
              style={{ left: addCommentButton.x, top: addCommentButton.y }}
              onClick={handleAddCommentButtonClick}
            >
              添加评论
            </button>
          )}
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              onSubmit={handleCommentSubmit}
              onClose={() => setAddCommentInput(null)}
            />
          )}
          {viewingComment && (
            <ViewCommentCard
              x={viewingComment.x}
              y={viewingComment.y}
              comment={viewingComment.comment}
              onClose={() => setViewingComment(null)}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          )}
        </>,
        document.body
      )}
    </div>
  );
}

// ============================================
// Unified Diff View Component (optional export)
// ============================================

export function DiffUnifiedView({ oldContent, newContent, filePath }: Omit<DiffViewProps, 'isNew' | 'isDeleted'>) {
  const diffLines = computeLineDiff(oldContent, newContent);

  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  return (
    <div className="font-mono" style={{ fontSize: '0.8125rem' }}>
      {diffLines.map((line, idx) => (
        <div
          key={idx}
          className={`flex ${
            line.type === 'removed'
              ? 'bg-red-9/15 dark:bg-red-9/25'
              : line.type === 'added'
              ? 'bg-green-9/15 dark:bg-green-9/25'
              : ''
          }`}
        >
          {/* Line numbers */}
          <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
            {line.type !== 'added' ? line.oldLineNum : ''}
          </span>
          <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
            {line.type !== 'removed' ? line.newLineNum : ''}
          </span>
          {/* Symbol */}
          <span
            className={`w-6 flex-shrink-0 text-center select-none ${
              line.type === 'removed'
                ? 'text-red-11'
                : line.type === 'added'
                ? 'text-green-11'
                : 'text-slate-9'
            }`}
          >
            {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
          </span>
          {/* Content with syntax highlighting */}
          <HighlightedContent
            content={line.content}
            highlightedLine={highlightedLines.get(idx)}
            className="flex-1 whitespace-pre pl-1"
          />
        </div>
      ))}
    </div>
  );
}

// Default export is the split view
export default DiffView;
