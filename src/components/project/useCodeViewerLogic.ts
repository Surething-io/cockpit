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
  /** Scroll alignment: 'center' (default, navigation jump) or 'start' (return from edit mode) */
  scrollToLineAlign?: 'center' | 'start';
  onScrollToLineComplete?: () => void;
  highlightKeyword?: string | null;
  /** External ref, CodeViewer continuously updates it with the current visible first line number (1-based) */
  visibleLineRef?: React.MutableRefObject<number>;
  /** LSP: Cmd+Click go-to-definition callback */
  onCmdClick?: (line: number, column: number) => void;
  /** LSP: hover token callback */
  onTokenHover?: (line: number, column: number, rect: { x: number; y: number }) => void;
  /** LSP: hover leave callback (150ms delay to give user time to move toward card) */
  onTokenHoverLeave?: () => void;
  /** LSP: cancel hover immediately (mousedown etc., no delay needed) */
  onTokenHoverCancel?: () => void;
  /** Blame data (shows blame column when provided) */
  blameLines?: BlameLine[];
  /** Inline blame data (for inline annotations, auto-loaded on file open) */
  inlineBlameLines?: BlameLine[];
  /** Blame: click commit callback */
  onSelectCommit?: (commit: CommitInfo) => void;
  // ---- Edit mode ----
  /** Whether in edit mode */
  editable?: boolean;
  /** File mtime (save conflict detection) */
  initialMtime?: number;
  /** Editor close callback (passes back current line number) */
  onEditorClose?: (currentLine: number) => void;
  /** Save success callback */
  onSaved?: () => void;
  /** Editor state change callback */
  onEditorStateChange?: (state: { isDirty: boolean; isSaving: boolean }) => void;
  // ---- Vi mode ----
  /** Enable vi keyboard mode (default false) */
  viMode?: boolean;
  /** Vi Normal mode content mutation callback (dd/p/x/o/O only modify memory, not disk) */
  onContentMutate?: (newContent: string) => void;
  /** Vi: enter Insert mode callback (triggers parent to set editable=true) */
  onEnterInsertMode?: (line: number) => void;
  /** Vi: :w save callback */
  onViSave?: () => void;
  /** External ref, CodeViewer continuously updates to current vi cursor position (0-based) */
  viStateRef?: React.MutableRefObject<{ cursorLine: number; cursorCol: number } | null>;
  /** Restore cursor line (1-based, used when switching back to file) */
  initialCursorLine?: number | null;
  /** Restore cursor column (1-based) */
  initialCursorCol?: number | null;
  /** Cursor restore complete callback */
  onInitialCursorSet?: () => void;
  /** Content search callback (selected text → project-wide search) */
  onContentSearch?: (query: string) => void;
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
// Selection logical coordinate utilities
// ============================================

/** Compute the character offset of node+offset within a [data-line] row element */
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

/** Resolve a character offset to a text node + offset within a [data-line] row element */
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
  // Past the end: position at the tail of the last text node
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
  onContentSearch,
}: Pick<CodeViewerProps, 'content' | 'filePath' | 'showSearch' | 'cwd' | 'enableComments' | 'scrollToLine' | 'scrollToLineAlign' | 'onScrollToLineComplete' | 'visibleLineRef' | 'onContentSearch'>) {
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

  // Flash line state (highlight jump target line for 3 seconds)
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

  // Floating toolbar - store data in ref to avoid triggering CodeViewer re-render
  const floatingToolbarRef = useRef<FloatingToolbarData | null>(null);
  // bumpToolbarRef: injected by ToolbarRenderer in CodeViewer; calling it triggers only a ToolbarRenderer re-render
  const bumpToolbarRef = useRef<() => void>(() => {});

  // Suppress hover and cmd+click when float layer (toolbar / addComment / sendToAI) is active
  const suppressHoverRef = useRef(false);

  // Selection logical coordinates: used to restore selection when DOM nodes are replaced after re-render
  const savedSelectionRef = useRef<{ startLine: number; startOffset: number; endLine: number; endOffset: number } | null>(null);

  const [addCommentInput, setAddCommentInput] = useState<InputCardData | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<InputCardData | null>(null);

  // Inline blame annotation — line number at current mouseup
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

  // Continuously update external visibleLineRef: take first code line from virtualizer's visible range
  useEffect(() => {
    if (!visibleLineRef) return;
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const range = virtualizer.range;
      if (!range) return;
      // range.startIndex includes overscan, derive truly visible first line from scrollTop
      const scrollTop = el.scrollTop;
      const items = virtualizer.getVirtualItems();
      for (const item of items) {
        // Find first item with start >= scrollTop (truly visible, not overscan)
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
    // Initialize
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

  // Jump to specified line number
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

          // Flash highlight only for navigation jumps (center); not for returning from edit (start)
          if (scrollToLineAlign === 'center') {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            setFlashLine(targetLine);
            flashTimerRef.current = setTimeout(() => setFlashLine(null), 500);
          }

          onScrollToLineComplete?.();
        };

        if (scrollToLineAlign === 'start') {
          // Returning from edit mode: scroll immediately without delay
          requestAnimationFrame(doScroll);
        } else {
          // Navigation jump: wait for virtual scroll layout to be ready
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

    // mousedown: mark drag-select start, suppress hover, clear old toolbar + saved selection
    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      savedSelectionRef.current = null;
      suppressHoverRef.current = true; // Suppress hover during drag to prevent LSP hover triggering parent re-render
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    // mouseup: mark drag-select end, compute selection and show toolbar
    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      // When clicking FloatingToolbar button, don't clear toolbar, let onClick fire normally
      const target = e.target as HTMLElement;
      if (target.closest?.('.floating-toolbar')) return;

      // Movement ≤ 5px treated as click (including double/triple click), do not show toolbar
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

        // Save selection logical coordinates: used to restore when DOM is replaced after re-render
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

    // selectionchange: hide toolbar when selection disappears
    // Skip during drag-select to avoid high-frequency unnecessary re-renders
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

  // Inline blame annotation — record line number on mouseup
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
      // Only handle mouseup within the code area
      if (!codeArea.contains(e.target as Node)) {
        // If mouseup is inside inline blame tooltip, don't clear line number (tooltip portal is on document.body)
        if ((e.target as HTMLElement).closest?.('[data-inline-blame-tip]')) return;
        if (inlineBlameLineRef.current !== null) {
          inlineBlameLineRef.current = null;
          setInlineBlameVersion(v => v + 1);
        }
        return;
      }

      // Skip inline blame update when there's a text selection:
      // The CodeLine at the mouseup line would re-render due to inlineBlameData prop change,
      // causing DOM rebuild for that line and losing selection anchor.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        return;
      }

      const line = getLineFromEvent(e);
      if (line !== inlineBlameLineRef.current) {
        inlineBlameLineRef.current = line;
        // Defer re-render to next frame to avoid React flush during mouseup→click
        // microtask checkpoint rebuilding the fiber tree,
        // which would cause the subsequent click event to lose its onClick route
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

  // Click "search" in toolbar → trigger content search
  const handleToolbarSearch = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar || !onContentSearch) return;
    const query = toolbar.selectedText.trim();
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    if (query) onContentSearch(query);
  }, [onContentSearch]);

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

  // Highlight match in line — splice by plain text position to avoid exponential growth from regex on HTML
  const getHighlightedLineHtml = useCallback((lineIndex: number, html: string, highlightKeyword: string | null | undefined): string => {
    const line = lines[lineIndex];
    if (!line) return html;

    // Collect intervals to highlight [startCol, endCol, className]
    type Segment = { start: number; end: number; cls: string };
    const segments: Segment[] = [];

    // 1. Internal search highlight
    if (searchQuery && matches.length > 0) {
      const lineMatches = matches.filter(m => m.lineIndex === lineIndex);
      for (const match of lineMatches) {
        const isCurrent = matches[currentMatchIndex]?.lineIndex === lineIndex &&
          matches[currentMatchIndex]?.startCol === match.startCol;
        segments.push({ start: match.startCol, end: match.endCol, cls: isCurrent ? 'hl-cur' : 'hl-m' });
      }
    }

    // 2. External keyword highlight (when search is not active)
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

    // Sort by position, deduplicate overlaps
    segments.sort((a, b) => a.start - b.start || a.end - b.end);

    // Split by plain text position, escapeHtml each segment + wrap with highlight tag
    const parts: string[] = [];
    let cursor = 0;
    for (const seg of segments) {
      if (seg.start < cursor) continue; // Skip overlapping segment
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

    // If there is Shiki-highlighted HTML (with <span style=...> tags), keep Shiki HTML;
    // Only when html !== escapeHtml(line) indicates syntax highlighting exists
    const plainHtml = escapeHtml(line);
    if (html !== plainHtml) {
      // Shiki HTML mode: use safe single-pass regex replacement on plain text segments
      // To avoid replacing inside HTML tags, use a mixed strategy:
      // For each highlight segment, precisely replace the first plain text match
      let result = html;
      for (const seg of segments) {
        const matchText = line.substring(seg.start, seg.end);
        const escapedMatch = escapeHtml(matchText);
        const escapedForRegex = escapedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Only replace the first match not inside HTML tags (without 'g' flag)
        const safeRegex = new RegExp(`(?<=>)([^<]*?)(${escapedForRegex})`, '');
        const replacement = `$1<span class="${seg.cls}">${escapedMatch}</span>`;
        const newResult = result.replace(safeRegex, replacement);
        // Safety check: skip if replaced string length grows abnormally
        if (newResult.length > result.length + 200) {
          // Single replacement should not grow more than ~100 chars; if it does, the match was at the wrong position
          continue;
        }
        result = newResult;
      }
      return result;
    }

    // Plain text mode (no Shiki highlight): use spliced result directly
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
    handleToolbarSearch,
    handleCommentSubmit,
    handleSendToAISubmit,
    getHighlightedLineHtml,

    // Inline blame
    inlineBlameLineRef,
    inlineBlameVersion,
  };
}
