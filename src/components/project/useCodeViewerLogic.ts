'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useComments, type CodeComment } from '@/hooks/useComments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { useChatContextOptional } from './ChatContext';
import { useLineHighlight } from '@/hooks/useLineHighlight';
import { escapeHtml, findMatches, type SearchMatch } from '@/lib/codeHighlighter';
import type { BlameLine } from './fileBrowser/types';
import type { CommitInfo } from './CommitDetailPanel';

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
  /** 跳转对齐方式：'center'（默认，导航跳转）或 'start'（编辑模式返回） */
  scrollToLineAlign?: 'center' | 'start';
  onScrollToLineComplete?: () => void;
  highlightKeyword?: string | null;
  /** 外部传入的 ref，CodeViewer 会持续更新为当前可见首行号（1-based） */
  visibleLineRef?: React.MutableRefObject<number>;
  /** LSP: Cmd+Click 跳转定义回调 */
  onCmdClick?: (line: number, column: number) => void;
  /** LSP: 悬浮 token 回调 */
  onTokenHover?: (line: number, column: number, rect: { x: number; y: number }) => void;
  /** LSP: 悬浮离开回调（150ms 延迟，给用户移向卡片留时间） */
  onTokenHoverLeave?: () => void;
  /** LSP: 立即取消 hover（mousedown 等场景，不需要延迟） */
  onTokenHoverCancel?: () => void;
  /** Blame 数据（传入时显示 blame 列） */
  blameLines?: BlameLine[];
  /** Inline blame 数据（行内注释用，文件打开时自动加载） */
  inlineBlameLines?: BlameLine[];
  /** Blame: 点击 commit 回调 */
  onSelectCommit?: (commit: CommitInfo) => void;
  // ---- 编辑模式 ----
  /** 是否处于编辑模式 */
  editable?: boolean;
  /** 文件 mtime（保存冲突检测） */
  initialMtime?: number;
  /** 编辑器关闭回调（传回当前行号） */
  onEditorClose?: (currentLine: number) => void;
  /** 保存成功回调 */
  onSaved?: () => void;
  /** 编辑器状态变化回调 */
  onEditorStateChange?: (state: { isDirty: boolean; isSaving: boolean }) => void;
  // ---- Vi 模式 ----
  /** 启用 vi 键盘模式（默认 false） */
  viMode?: boolean;
  /** Vi Normal 模式下内容修改回调（dd/p/x/o/O 只改内存，不写磁盘） */
  onContentMutate?: (newContent: string) => void;
  /** Vi: 进入 Insert 模式回调（触发父组件设置 editable=true） */
  onEnterInsertMode?: (line: number) => void;
  /** Vi: :w 保存回调 */
  onViSave?: () => void;
  /** 外部传入的 ref，CodeViewer 持续更新为当前 vi 光标位置（0-based） */
  viStateRef?: React.MutableRefObject<{ cursorLine: number; cursorCol: number } | null>;
  /** 还原光标行（1-based，文件切换回来时使用） */
  initialCursorLine?: number | null;
  /** 还原光标列（1-based） */
  initialCursorCol?: number | null;
  /** 光标还原完成回调 */
  onInitialCursorSet?: () => void;
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
// 选区逻辑坐标工具
// ============================================

/** 计算 node+offset 在 [data-line] 行内的字符偏移 */
function charOffsetInLine(lineEl: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let chars = 0;
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    if (cur === node) return chars + offset;
    chars += cur.textContent!.length;
  }
  return chars + offset; // fallback
}

/** 根据字符偏移找到 [data-line] 行内的 text node + offset */
export function resolveCharOffset(lineEl: Element, charOffset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let remaining = charOffset;
  let last: Node | null = null;
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    last = cur;
    const len = cur.textContent!.length;
    if (remaining <= len) return { node: cur, offset: remaining };
    remaining -= len;
  }
  // 超出末尾，定位到最后一个 text node 的末端
  if (last) return { node: last, offset: last.textContent!.length };
  return null;
}

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
  scrollToLineAlign = 'center',
  onScrollToLineComplete,
  visibleLineRef,
}: Pick<CodeViewerProps, 'content' | 'filePath' | 'showSearch' | 'cwd' | 'enableComments' | 'scrollToLine' | 'scrollToLineAlign' | 'onScrollToLineComplete' | 'visibleLineRef'>) {
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

  // Cmd key state (for LSP Cmd+Click)
  const [cmdHeld, setCmdHeld] = useState(false);

  // Flash line state (跳转目标行高亮 3 秒)
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search state
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [matchScrollTrigger, setMatchScrollTrigger] = useState(0);
  const suppressMatchScrollRef = useRef(false);

  // Comment UI state
  const [viewingComment, setViewingComment] = useState<ViewingCommentData | null>(null);

  // Floating toolbar - 使用 ref 存储数据，避免触发 CodeViewer 重渲染
  const floatingToolbarRef = useRef<FloatingToolbarData | null>(null);
  // bumpToolbarRef: 由 CodeViewer 中的 ToolbarRenderer 注入，调用后只触发 ToolbarRenderer re-render
  const bumpToolbarRef = useRef<() => void>(() => {});

  // 当浮层（toolbar / addComment / sendToAI）活跃时，抑制 hover 和 cmd+click
  const suppressHoverRef = useRef(false);

  // 选区逻辑坐标：re-render 后 DOM 节点被替换时用于恢复选区
  const savedSelectionRef = useRef<{ startLine: number; startOffset: number; endLine: number; endOffset: number } | null>(null);

  const [addCommentInput, setAddCommentInput] = useState<InputCardData | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<InputCardData | null>(null);

  // Inline blame annotation — 当前 mouseup 所在行号
  const inlineBlameLineRef = useRef<number | null>(null);
  const [inlineBlameVersion, setInlineBlameVersion] = useState(0);

  // Comments hook
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const lines = useMemo(() => content.split('\n'), [content]);
  const highlightedLines = useLineHighlight(lines, filePath);

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

  // Track Cmd key for LSP Cmd+Click visual feedback
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta') setCmdHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') setCmdHeld(false);
    };
    const handleBlur = () => setCmdHeld(false);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

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
          bumpToolbarRef.current();
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
    if (suppressMatchScrollRef.current) {
      suppressMatchScrollRef.current = false;
      return;
    }
    if (matches.length > 0 && currentMatchIndex >= 0 && currentMatchIndex < matches.length) {
      const match = matches[currentMatchIndex];
      const rowIndex = rowData.findIndex(r => r.type === 'code' && r.lineIndex === match.lineIndex);
      if (rowIndex >= 0) {
        virtualizer.scrollToIndex(rowIndex, { align: 'center' });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatchIndex, matches, virtualizer, rowData, matchScrollTrigger]);

  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev + 1) % matches.length);
    // Always bump trigger so single-match n/N still re-centers
    setMatchScrollTrigger(prev => prev + 1);
  }, [matches.length]);

  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev - 1 + matches.length) % matches.length);
    setMatchScrollTrigger(prev => prev + 1);
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
        const doScroll = () => {
          virtualizer.scrollToIndex(rowIndex, { align: scrollToLineAlign });

          // 仅导航跳转（center）时闪烁高亮，编辑返回（start）不闪
          if (scrollToLineAlign === 'center') {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            setFlashLine(targetLine);
            flashTimerRef.current = setTimeout(() => setFlashLine(null), 500);
          }

          onScrollToLineComplete?.();
        };

        if (scrollToLineAlign === 'start') {
          // 编辑模式返回：无延迟，立即滚动
          requestAnimationFrame(doScroll);
        } else {
          // 导航跳转：等虚拟滚动布局就绪
          setTimeout(doScroll, 150);
        }
      }
    }
  }, [scrollToLine, scrollToLineAlign, rowData.length, virtualizer, onScrollToLineComplete]);

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
    bumpToolbarRef.current();
    setAddCommentInput(null);
    setSendToAIInput(null);
  }, [commentsEnabled]);

  // Text selection handler - show floating toolbar
  useEffect(() => {
    if (!commentsEnabled) return;

    const codeArea = parentRef.current;
    let isDragging = false;
    let downX = 0, downY = 0;

    // mousedown：标记拖选开始，抑制 hover，清除旧 toolbar + 保存的选区
    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      savedSelectionRef.current = null;
      suppressHoverRef.current = true; // 拖动期间抑制 hover，防止 LSP hover 触发父组件 re-render
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    // mouseup：标记拖选结束，计算选区并显示 toolbar
    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      // 点击 FloatingToolbar 按钮时，不清除 toolbar，让 onClick 正常触发
      const target = e.target as HTMLElement;
      if (target.closest?.('.floating-toolbar')) return;

      // 移动 ≤ 5px 视为点击（含双击/三击），不弹出 toolbar
      const moved = Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        suppressHoverRef.current = false;
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          bumpToolbarRef.current();
        }
        return;
      }

      const selectedText = selection.toString();
      if (!selectedText.trim() || !moved) {
        suppressHoverRef.current = false;
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          bumpToolbarRef.current();
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
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
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

        floatingToolbarRef.current = {
          x: e.clientX,
          y: e.clientY,
          range: { start: minLine, end: maxLine },
          selectedText,
        };
        suppressHoverRef.current = true;
        bumpToolbarRef.current();

        // 保存选区逻辑坐标：re-render 后 DOM 被替换时用于恢复
        const startLineEl = startNode.nodeType === Node.TEXT_NODE
          ? startNode.parentElement?.closest('[data-line]')
          : (startNode as Element).closest('[data-line]');
        const endLineEl = endNode.nodeType === Node.TEXT_NODE
          ? endNode.parentElement?.closest('[data-line]')
          : (endNode as Element).closest('[data-line]');
        if (startLineEl && endLineEl) {
          savedSelectionRef.current = {
            startLine,
            startOffset: charOffsetInLine(startLineEl, range.startContainer, range.startOffset),
            endLine,
            endOffset: charOffsetInLine(endLineEl, range.endContainer, range.endOffset),
          };
        }
      }
    };

    // selectionchange：选区消失时隐藏 toolbar
    // 拖选期间跳过，避免高频触发不必要的 re-render
    const handleSelectionChange = () => {
      if (isDragging) return;
      if (!floatingToolbarRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        floatingToolbarRef.current = null;
        savedSelectionRef.current = null;
        suppressHoverRef.current = false;
        bumpToolbarRef.current();
      }
    };

    codeArea?.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      codeArea?.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [commentsEnabled]);

  // Inline blame annotation — mouseup 时记录所在行号
  useEffect(() => {
    const codeArea = parentRef.current;
    if (!codeArea) return;

    const getLineFromEvent = (e: MouseEvent): number | null => {
      const target = e.target as HTMLElement;
      const lineRow = target.closest?.('[data-line]');
      if (lineRow) {
        return parseInt(lineRow.getAttribute('data-line') || '0', 10);
      }
      return null;
    };

    const handleMouseUp = (e: MouseEvent) => {
      // 只处理代码区内的 mouseup
      if (!codeArea.contains(e.target as Node)) {
        // 如果 mouseup 在 inline blame tooltip 内，不清除行号（tooltip portal 在 document.body 上）
        if ((e.target as HTMLElement).closest?.('[data-inline-blame-tip]')) return;
        if (inlineBlameLineRef.current !== null) {
          inlineBlameLineRef.current = null;
          setInlineBlameVersion(v => v + 1);
        }
        return;
      }

      // 有文本选区时跳过 inline blame 更新：
      // mouseup 所在行的 CodeLine 会因 inlineBlameData prop 变化而 re-render，
      // 导致该行 DOM 重建、选区锚点丢失。
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        return;
      }

      const line = getLineFromEvent(e);
      if (line !== inlineBlameLineRef.current) {
        inlineBlameLineRef.current = line;
        // 延迟到下一帧再触发 re-render，避免在 mouseup→click 之间
        // 的 microtask checkpoint 中 React flush 导致 fiber 树重建，
        // 使紧随的 click 事件丢失 onClick 路由
        requestAnimationFrame(() => setInlineBlameVersion(v => v + 1));
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, []);

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
    bumpToolbarRef.current();
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
    bumpToolbarRef.current();
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
    suppressHoverRef,
    savedSelectionRef,

    // State
    highlightedLines,
    isMounted,
    cmdHeld,
    flashLine,
    isSearchVisible,
    searchQuery,
    caseSensitive,
    wholeWord,
    currentMatchIndex,
    viewingComment,
    bumpToolbarRef,
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
    suppressMatchScrollRef,
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

    // Inline blame
    inlineBlameLineRef,
    inlineBlameVersion,
  };
}
