'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BundledLanguage } from 'shiki';
import { useComments, type CodeComment } from '@/hooks/useComments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { useChatContextOptional } from './ChatContext';
import { getHighlighter, getLanguageFromPath, escapeHtml, findMatches, type SearchMatch } from './codeHighlighter';

// ============================================
// Types
// ============================================

export interface CodeViewerProps {
  content: string;
  filePath: string;
  showLineNumbers?: boolean;
  showSearch?: boolean;
  className?: string;
  cwd?: string;
  enableComments?: boolean;
  scrollToLine?: number | null;
  onScrollToLineComplete?: () => void;
  highlightKeyword?: string | null;
  /** 外部传入的 ref，CodeViewer 会持续更新为当前可见首行号（1-based） */
  visibleLineRef?: React.MutableRefObject<number>;
}

export interface FloatingToolbarData {
  x: number;
  y: number;
  range: { start: number; end: number };
  selectedText: string;
}

export interface InputCardData {
  x: number;
  y: number;
  range: { start: number; end: number };
  codeContent: string;
}

export interface ViewingCommentData {
  comment: CodeComment;
  x: number;
  y: number;
}

export type RowData =
  | { type: 'code'; lineIndex: number }
  | { type: 'comment'; lineNum: number; comments: CodeComment[] }
  | { type: 'add-comment'; startLine: number; endLine: number };

// ============================================
// Hook
// ============================================

export function useCodeViewerLogic({
  content,
  filePath,
  showSearch = true,
  cwd,
  enableComments = false,
  scrollToLine = null,
  onScrollToLineComplete,
  visibleLineRef,
}: Pick<CodeViewerProps, 'content' | 'filePath' | 'showSearch' | 'cwd' | 'enableComments' | 'scrollToLine' | 'onScrollToLineComplete' | 'visibleLineRef'>) {
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const [isDark, setIsDark] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ChatContext for sending messages to AI
  const chatContext = useChatContextOptional();

  // Track mount state for Portal rendering
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Search state
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // Comment UI state
  const [viewingComment, setViewingComment] = useState<ViewingCommentData | null>(null);

  // Floating toolbar - 使用 ref 存储数据，避免触发 CodeViewer 重渲染
  const floatingToolbarRef = useRef<FloatingToolbarData | null>(null);
  const [toolbarVersion, setToolbarVersion] = useState(0);

  const [addCommentInput, setAddCommentInput] = useState<InputCardData | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<InputCardData | null>(null);

  // Comments hook
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const lines = useMemo(() => content.split('\n'), [content]);

  // Group comments by their end line
  const commentsByEndLine = useMemo(() => {
    const map = new Map<number, CodeComment[]>();
    for (const comment of comments) {
      const line = comment.endLine;
      if (!map.has(line)) {
        map.set(line, []);
      }
      map.get(line)!.push(comment);
    }
    return map;
  }, [comments]);

  // Lines that have comments
  const linesWithComments = useMemo(() => {
    const set = new Set<number>();
    for (const comment of comments) {
      for (let i = comment.startLine; i <= comment.endLine; i++) {
        set.add(i);
      }
    }
    return set;
  }, [comments]);

  // Find matches
  const matches = useMemo(() => {
    return findMatches(lines, searchQuery, caseSensitive, wholeWord);
  }, [lines, searchQuery, caseSensitive, wholeWord]);

  // Reset current match when matches change
  useEffect(() => {
    if (matches.length > 0) {
      setCurrentMatchIndex(0);
    }
  }, [matches.length, searchQuery, caseSensitive, wholeWord]);

  // Dark mode detection
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Syntax highlighting
  useEffect(() => {
    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const highlighted = lines.map(line => {
          try {
            const html = highlighter.codeToHtml(line || ' ', {
              lang: language as BundledLanguage,
              theme,
            });
            const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
            return match ? match[1] : escapeHtml(line);
          } catch {
            return escapeHtml(line);
          }
        });

        setHighlightedLines(highlighted);
      } catch (err) {
        console.error('Highlight error:', err);
        setHighlightedLines(lines.map(line => escapeHtml(line)));
      }
    };

    highlight();
  }, [content, filePath, isDark, lines]);

  // Row data for virtualizer
  const rowData = useMemo(() => {
    const rows: RowData[] = [];
    for (let i = 0; i < lines.length; i++) {
      rows.push({ type: 'code', lineIndex: i });
    }
    return rows;
  }, [lines.length]);

  const LINE_HEIGHT = 20;

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: rowData.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 10,
  });

  // 持续更新外部 visibleLineRef：从 virtualizer 的可见范围中取第一个 code 行
  useEffect(() => {
    if (!visibleLineRef) return;
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const range = virtualizer.range;
      if (!range) return;
      // range.startIndex 包含 overscan，需要从 scrollTop 反推真正可见的第一行
      const scrollTop = el.scrollTop;
      const items = virtualizer.getVirtualItems();
      for (const item of items) {
        // 找到第一个 start >= scrollTop 的 item（即真正可见，不是 overscan）
        if (item.start >= scrollTop) {
          const row = rowData[item.index];
          if (row?.type === 'code') {
            visibleLineRef.current = row.lineIndex + 1;
          }
          return;
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // 初始化
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleLineRef, rowData]);

  // Keyboard shortcut for search
  useEffect(() => {
    if (!showSearch) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchVisible(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === 'Escape') {
        if (isSearchVisible) {
          setIsSearchVisible(false);
          setSearchQuery('');
        } else if (sendToAIInput) {
          setSendToAIInput(null);
        } else if (addCommentInput) {
          setAddCommentInput(null);
        } else if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          setToolbarVersion(v => v + 1);
        } else if (viewingComment) {
          setViewingComment(null);
        }
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
      return () => container.removeEventListener('keydown', handleKeyDown);
    }
  }, [showSearch, isSearchVisible, sendToAIInput, addCommentInput, viewingComment]);

  // Navigate to current match
  useEffect(() => {
    if (matches.length > 0 && currentMatchIndex >= 0 && currentMatchIndex < matches.length) {
      const match = matches[currentMatchIndex];
      const rowIndex = rowData.findIndex(r => r.type === 'code' && r.lineIndex === match.lineIndex);
      if (rowIndex >= 0) {
        virtualizer.scrollToIndex(rowIndex, { align: 'center' });
      }
    }
  }, [currentMatchIndex, matches, virtualizer, rowData]);

  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  // 跳转到指定行号
  const scrollToLineRef = useRef(scrollToLine);
  scrollToLineRef.current = scrollToLine;

  useEffect(() => {
    if (scrollToLineRef.current !== null && scrollToLineRef.current > 0 && rowData.length > 0) {
      const targetLine = scrollToLineRef.current;
      const targetLineIndex = targetLine - 1;
      const rowIndex = rowData.findIndex(r => r.type === 'code' && r.lineIndex === targetLineIndex);
      if (rowIndex >= 0) {
        setTimeout(() => {
          virtualizer.scrollToIndex(rowIndex, { align: 'start' });
          onScrollToLineComplete?.();
        }, 150);
      }
    }
  }, [scrollToLine, rowData.length, virtualizer, onScrollToLineComplete]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    }
    if (e.key === 'Escape') {
      setIsSearchVisible(false);
      setSearchQuery('');
    }
  }, [goToNextMatch, goToPrevMatch]);

  // Comment bubble click
  const handleCommentBubbleClick = useCallback((comment: CodeComment, e: React.MouseEvent) => {
    if (!commentsEnabled) return;
    e.stopPropagation();
    setViewingComment({ comment, x: e.clientX, y: e.clientY });
    floatingToolbarRef.current = null;
    setToolbarVersion(v => v + 1);
    setAddCommentInput(null);
    setSendToAIInput(null);
  }, [commentsEnabled]);

  // Text selection handler - show floating toolbar
  useEffect(() => {
    if (!commentsEnabled) return;

    const handleMouseUp = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          setToolbarVersion(v => v + 1);
        }
        return;
      }

      const selectedText = selection.toString();
      if (!selectedText.trim()) {
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          setToolbarVersion(v => v + 1);
        }
        return;
      }

      const range = selection.getRangeAt(0);
      const container = parentRef.current;
      if (!container) return;

      if (!container.contains(range.commonAncestorContainer)) {
        return;
      }

      const startNode = range.startContainer;
      const endNode = range.endContainer;

      const getLineFromNode = (node: Node): number | null => {
        if (!document.contains(node)) return null;
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
        if (!el) return null;
        const lineRow = el.closest('[data-line]');
        if (lineRow) {
          return parseInt(lineRow.getAttribute('data-line') || '0', 10);
        }
        return null;
      };

      const startLine = getLineFromNode(startNode);
      const endLine = getLineFromNode(endNode);

      if (startLine && endLine) {
        const minLine = Math.min(startLine, endLine);
        const maxLine = Math.max(startLine, endLine);

        requestAnimationFrame(() => {
          floatingToolbarRef.current = {
            x: e.clientX,
            y: e.clientY,
            range: { start: minLine, end: maxLine },
            selectedText,
          };
          setToolbarVersion(v => v + 1);
        });
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [commentsEnabled]);

  // Click "add comment" in toolbar
  const handleToolbarAddComment = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setAddCommentInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.selectedText,
    });
    floatingToolbarRef.current = null;
    setToolbarVersion(v => v + 1);
  }, []);

  // Click "send to AI" in toolbar
  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    const codeContent = toolbar.selectedText;

    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent,
    });
    floatingToolbarRef.current = null;
    setToolbarVersion(v => v + 1);
  }, []);

  // Submit new comment
  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!addCommentInput) return;
    await addComment(addCommentInput.range.start, addCommentInput.range.end, content);
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Submit question to AI
  const handleSendToAISubmit = useCallback(async (question: string) => {
    if (!sendToAIInput || !chatContext || !cwd) return;

    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = [];

      for (const comment of allComments) {
        references.push({
          filePath: comment.filePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          codeContent: comment.codeContent,
          note: comment.content || undefined,
        });
      }

      references.push({
        filePath,
        startLine: sendToAIInput.range.start,
        endLine: sendToAIInput.range.end,
        codeContent: sendToAIInput.codeContent,
      });

      const message = buildAIMessage(references, question);
      chatContext.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, chatContext, filePath, cwd, refreshComments]);

  // Highlight match in line — 基于纯文本位置拼接，避免在 HTML 上做正则替换导致指数膨胀
  const getHighlightedLineHtml = useCallback((lineIndex: number, html: string, highlightKeyword: string | null | undefined): string => {
    const line = lines[lineIndex];
    if (!line) return html;

    // 收集需要高亮的区间 [startCol, endCol, className]
    type Segment = { start: number; end: number; cls: string };
    const segments: Segment[] = [];

    // 1. 内部搜索高亮
    if (searchQuery && matches.length > 0) {
      const lineMatches = matches.filter(m => m.lineIndex === lineIndex);
      for (const match of lineMatches) {
        const isCurrent = matches[currentMatchIndex]?.lineIndex === lineIndex &&
          matches[currentMatchIndex]?.startCol === match.startCol;
        segments.push({ start: match.startCol, end: match.endCol, cls: isCurrent ? 'hl-cur' : 'hl-m' });
      }
    }

    // 2. 外部关键词高亮（搜索不活跃时）
    if (highlightKeyword && !searchQuery && highlightKeyword.length >= 1) {
      const kwLower = highlightKeyword.toLowerCase();
      const lineLower = line.toLowerCase();
      let idx = 0;
      while ((idx = lineLower.indexOf(kwLower, idx)) !== -1) {
        segments.push({ start: idx, end: idx + highlightKeyword.length, cls: 'hl-kw' });
        idx += 1;
      }
    }

    if (segments.length === 0) return html;

    // 按位置排序，去重重叠
    segments.sort((a, b) => a.start - b.start || a.end - b.end);

    // 基于纯文本位置切分，逐段 escapeHtml + 包裹高亮标签
    const parts: string[] = [];
    let cursor = 0;
    for (const seg of segments) {
      if (seg.start < cursor) continue; // 跳过重叠
      if (seg.start > cursor) {
        parts.push(escapeHtml(line.substring(cursor, seg.start)));
      }
      const matchText = escapeHtml(line.substring(seg.start, seg.end));
      parts.push(`<span class="${seg.cls}">${matchText}</span>`);
      cursor = seg.end;
    }
    if (cursor < line.length) {
      parts.push(escapeHtml(line.substring(cursor)));
    }

    // 如果有 Shiki 高亮的 HTML（含 <span style=...> 标签），则保留 Shiki HTML；
    // 只有当 html !== escapeHtml(line) 时才表示有语法高亮
    const plainHtml = escapeHtml(line);
    if (html !== plainHtml) {
      // Shiki HTML 模式：用安全的单次正则替换纯文本段
      // 为避免在 HTML 标签上误替换，采用混合策略：
      // 对每个高亮段，精确替换第一个纯文本匹配
      let result = html;
      for (const seg of segments) {
        const matchText = line.substring(seg.start, seg.end);
        const escapedMatch = escapeHtml(matchText);
        const escapedForRegex = escapedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 只替换不在 HTML 标签内的第一个匹配（不用 'g' 标志）
        const safeRegex = new RegExp(`(?<=>)([^<]*?)(${escapedForRegex})`, '');
        const replacement = `$1<span class="${seg.cls}">${escapedMatch}</span>`;
        const newResult = result.replace(safeRegex, replacement);
        // 安全检查：如果替换后字符串长度异常增长则跳过
        if (newResult.length > result.length + 200) {
          // 单次替换不应增长超过 ~100 字符，如果超过说明匹配到了错误位置
          continue;
        }
        result = newResult;
      }
      return result;
    }

    // 纯文本模式（没有 Shiki 高亮）：直接用拼接结果
    return parts.join('');
  }, [searchQuery, matches, currentMatchIndex, lines]);

  return {
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
    comments,
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
  };
}
