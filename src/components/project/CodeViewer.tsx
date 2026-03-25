'use client';

import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useMenuContainer } from './FileContextMenu';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { useLineHighlight } from '@/hooks/useLineHighlight';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, escapeHtml, tokensToHtml } from '@/lib/codeHighlighter';
import { ToolbarRenderer } from './FloatingToolbar';
import { ViewCommentCard } from './ViewCommentCard';
import { CodeLine, AUTHOR_COLORS } from './CodeLine';
import { useCodeViewerLogic, resolveCharOffset, type CodeViewerProps } from './useCodeViewerLogic';
import type { BlameLine } from './fileBrowser/types';
import type { CommitInfo } from './CommitDetailPanel';
import { formatRelativeTime } from './fileBrowser/utils';
import { toast, confirm } from '../shared/Toast';
import type { FileEditorHandle } from './FileEditorModal';
import { useViMode } from '@/hooks/useViMode';

// Re-export utilities used by other modules
export { getHighlighter, getLanguageFromPath } from '@/lib/codeHighlighter';

// Inline style for contentEditable line divs (used in innerHTML string concatenation)
const EDITOR_LINE_STYLE = 'white-space:pre;padding:0 12px;min-height:20px;line-height:20px';

// ========== contentEditable cursor utilities ==========
function saveCursorPosition(container: HTMLElement): { line: number; offset: number } | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);

  // Find the line div where the cursor resides
  let node: Node | null = range.startContainer;
  while (node && node.parentElement !== container) {
    node = node.parentElement;
  }
  if (!node) return null;

  const lineIndex = Array.from(container.children).indexOf(node as Element);
  if (lineIndex < 0) return null;

  // Calculate character offset within the line
  const preRange = document.createRange();
  preRange.selectNodeContents(node);
  preRange.setEnd(range.startContainer, range.startOffset);
  const offset = preRange.toString().length;

  return { line: lineIndex, offset };
}

function restoreCursorPosition(container: HTMLElement, pos: { line: number; offset: number }) {
  const lineEl = container.children[pos.line];
  if (!lineEl) return;

  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let remaining = pos.offset;
  let textNode: Node | null;

  while ((textNode = walker.nextNode())) {
    const len = textNode.textContent?.length || 0;
    if (remaining <= len) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode, remaining);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    remaining -= len;
  }

  // fallback: place at end of line
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(lineEl);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function buildEditorHTML(lineHtmls: string[]): string {
  return lineHtmls.map(h => `<div style="${EDITOR_LINE_STYLE}">${h}</div>`).join('');
}

// ============================================
// ToolbarRenderer — extracted to FloatingToolbar.tsx, imported from there

// ============================================
// CodeViewer Component
// ============================================

export const CodeViewer = forwardRef<FileEditorHandle, CodeViewerProps>(function CodeViewer({
  content,
  filePath,
  showLineNumbers = true,
  showSearch = true,
  className = '',
  cwd,
  enableComments = false,
  scrollToLine = null,
  scrollToLineAlign = 'center',
  onScrollToLineComplete,
  highlightKeyword = null,
  visibleLineRef,
  onCmdClick,
  onTokenHover,
  onTokenHoverLeave,
  onTokenHoverCancel,
  blameLines,
  inlineBlameLines,
  onSelectCommit,
  editable = false,
  initialMtime,
  onEditorClose,
  onSaved,
  onEditorStateChange,
  viMode: viModeEnabled = false,
  onContentMutate,
  onEnterInsertMode,
  onViSave,
  viStateRef,
  initialCursorLine,
  initialCursorCol,
  onInitialCursorSet,
  onContentSearch,
}, ref) {
  const { t } = useTranslation();

  // ========== Edit mode state ==========
  const editContentRef = useRef(content); // ref: no re-render, only read during save/highlight
  const isDirtyRef = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editLineCount, setEditLineCount] = useState(() => content.split('\n').length);
  const editLineCountRef = useRef(content.split('\n').length);
  const [conflictState, setConflictState] = useState<{ show: boolean; diskContent?: string }>({ show: false });
  const editableRef = useRef<HTMLDivElement>(null);
  const editScrollRef = useRef<HTMLDivElement>(null);
  const mtimeRef = useRef<number | undefined>(initialMtime);

  // Debounced highlight for edit mode
  const editDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHighlightingRef = useRef(false); // Prevent re-highlight from triggering onInput
  const isComposingRef = useRef(false); // IME composition flag, prevents pinyin from being written to file

  const {
    // Refs
    parentRef,
    containerRef,
    searchInputRef,
    floatingToolbarRef,
    suppressHoverRef,
    bumpToolbarRef,
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
    handleToolbarSearch,
    handleCommentSubmit,
    handleSendToAISubmit,
    getHighlightedLineHtml,

    // Search scroll suppression
    suppressMatchScrollRef,

    // Inline blame
    inlineBlameLineRef,
    inlineBlameVersion,
  } = useCodeViewerLogic({
    content,  // Pass original content even in edit mode, to avoid useLineHighlight re-tokenizing the entire file on every keystroke
    filePath,
    showSearch,
    cwd,
    enableComments: editable ? false : enableComments, // Disable comments in edit mode
    scrollToLine: editable ? null : scrollToLine,
    scrollToLineAlign: editable ? 'center' : scrollToLineAlign,
    onScrollToLineComplete: editable ? undefined : onScrollToLineComplete,
    visibleLineRef: editable ? undefined : visibleLineRef,
    onContentSearch,
  });

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  // ========== Vi Mode ==========
  const LINE_HEIGHT = 20;
  const viCommandInputRef = useRef<HTMLInputElement>(null);
  const viSearchInputRef = useRef<HTMLInputElement>(null);
  // Record cursor target position (line + col) when entering Insert mode, used by edit mode init effect
  const viInsertPosRef = useRef({ line: 0, col: 0 });

  const vi = useViMode({
    lines,
    enabled: viModeEnabled && !editable,
    onContentChange: (newContent) => {
      onContentMutate?.(newContent);
    },
    onEnterInsert: (line, col, variant) => {
      // Calculate the actual cursor column in the editor based on variant
      let targetCol = col;
      if (variant === 'a') targetCol = col + 1;
      else if (variant === 'A') targetCol = (lines[line] ?? '').length;
      else if (variant === 'I') {
        const first = (lines[line] ?? '').search(/\S/);
        targetCol = first >= 0 ? first : 0;
      } else if (variant === 'o' || variant === 'O') targetCol = 0;
      viInsertPosRef.current = { line, col: targetCol };
      onEnterInsertMode?.(line);
    },
    onSave: onViSave,
    getVisibleLineCount: () => {
      const el = parentRef.current;
      if (!el) return 20;
      return Math.floor(el.clientHeight / LINE_HEIGHT);
    },
    scrollToLine: (lineIndex, align) => {
      const rowIndex = rowData.findIndex(r => r.type === 'code' && r.lineIndex === lineIndex);
      if (rowIndex >= 0) {
        virtualizer.scrollToIndex(rowIndex, { align: align || 'auto' });
      }
    },
    onSearchExecute: (query) => {
      setSearchQuery(query);
      setIsSearchVisible(false); // vi handles its own search display
    },
    onSearchNext: goToNextMatch,
    onSearchPrev: goToPrevMatch,
    onSearchClear: () => { setSearchQuery(''); },
  });

  // Continuously sync vi cursor position to external ref (read by FileBrowserModal, saved to recent visits)
  useEffect(() => {
    if (viStateRef) {
      viStateRef.current = { cursorLine: vi.state.cursorLine, cursorCol: vi.state.cursorCol };
    }
  }, [viStateRef, vi.state.cursorLine, vi.state.cursorCol]);

  // Restore cursor position when switching back to this file
  const initialCursorAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!viModeEnabled || editable) return;
    if (initialCursorLine == null || !filePath) return;
    // Restore only once per file
    if (initialCursorAppliedRef.current === filePath) return;
    initialCursorAppliedRef.current = filePath;
    vi.setCursorLine(initialCursorLine - 1); // convert 1-based → 0-based
    if (initialCursorCol != null) {
      vi.setCursorCol(initialCursorCol - 1);
    }
    onInitialCursorSet?.();
   
  }, [viModeEnabled, editable, initialCursorLine, initialCursorCol, filePath]);

  // Vi Normal mode keyboard listener (on container element)
  useEffect(() => {
    if (!viModeEnabled || editable) return;
    const container = containerRef.current;
    if (!container) return;

    const handler = (e: KeyboardEvent) => {
      // Don't intercept keyboard events targeting editable elements
      // (textarea in comment/AI cards, input in vi-status-bar, contentEditable, etc.)
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable) return;

      const consumed = vi.handleKeyDown(e);
      if (consumed) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Use capture phase to intercept before other handlers
    container.addEventListener('keydown', handler, true);
    return () => container.removeEventListener('keydown', handler, true);
   
  }, [viModeEnabled, editable, vi.handleKeyDown]);

  // Auto-focus container for vi-mode key capture (when not in insert/command/search mode)
  useEffect(() => {
    if (!viModeEnabled || editable) return;
    const container = containerRef.current;
    if (container && vi.state.mode === 'normal') {
      // Focus container so keyboard events reach vi handler
      // Use rAF to ensure this runs after any focus changes from mode transitions
      requestAnimationFrame(() => {
        // Don't steal focus from editable elements (textarea in comment/AI cards, etc.)
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || (active as HTMLElement).isContentEditable)) return;
        container.focus();
      });
    }
   
  }, [viModeEnabled, editable, vi.state.mode, content]);

  // Click on code area → set cursorLine + cursorCol + re-focus container for vi key capture
  const viClickHandler = useCallback((e: React.MouseEvent) => {
    if (!viModeEnabled || editable) return;
    // Find clicked line via data-line attribute
    const target = e.target as HTMLElement;
    const lineEl = target.closest('[data-line]') as HTMLElement | null;
    if (lineEl) {
      const lineNum = parseInt(lineEl.getAttribute('data-line')!, 10);
      if (!isNaN(lineNum)) {
        vi.setCursorLine(lineNum - 1); // data-line is 1-based → 0-based

        // Detect clicked column via caretRangeFromPoint
        const codeSpan = lineEl.querySelector('[data-code-content]') as HTMLElement | null;
        if (codeSpan) {
          const range = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (range && codeSpan.contains(range.startContainer)) {
            // Walk text nodes to compute total offset
            const walker = document.createTreeWalker(codeSpan, NodeFilter.SHOW_TEXT);
            let col = 0;
            let node: Text | null;
            while ((node = walker.nextNode() as Text | null)) {
              if (node === range.startContainer) {
                col += range.startOffset;
                break;
              }
              col += node.textContent?.length || 0;
            }
            // Clamp to line length (vi normal mode: max = len-1)
            const lineText = lines[lineNum - 1] ?? '';
            vi.setCursorCol(Math.max(0, Math.min(col, Math.max(0, lineText.length - 1))));
          }
        }
      }
    }
    // Re-focus container for keyboard events (but not if clicking on an editable element)
    const clickTarget = e.target as HTMLElement;
    if (clickTarget.tagName === 'TEXTAREA' || clickTarget.tagName === 'INPUT' || clickTarget.isContentEditable) return;
    const container = containerRef.current;
    if (container) container.focus();
  }, [viModeEnabled, editable, vi.setCursorLine, vi.setCursorCol, lines]);

  // Double-click on code area → select word + highlight matches (no scroll)
  const viDblClickHandler = useCallback((_e: React.MouseEvent) => {
    if (!viModeEnabled || editable) return;
    // Browser double-click auto-selects the word; read selection text directly
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const word = sel?.toString().trim();
      if (word && /^\S+$/.test(word)) {
        suppressMatchScrollRef.current = true;
        setSearchQuery(word);
      }
    });
  }, [viModeEnabled, editable, setSearchQuery, suppressMatchScrollRef]);

  // Focus command/search input when entering those modes
  useEffect(() => {
    if (vi.state.mode === 'command') {
      setTimeout(() => viCommandInputRef.current?.focus(), 0);
    } else if (vi.state.mode === 'search') {
      setTimeout(() => viSearchInputRef.current?.focus(), 0);
    }
  }, [vi.state.mode]);

  // ========== Clear hover card immediately on mousedown ==========
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleMouseDown = () => {
      // Immediate: mousedown means user is about to interact with code, no 150ms delay needed
      (onTokenHoverCancel ?? onTokenHoverLeave)?.();
    };
    el.addEventListener('mousedown', handleMouseDown);
    return () => el.removeEventListener('mousedown', handleMouseDown);
  }, [onTokenHoverCancel, onTokenHoverLeave]);

  // ========== Interaction state matrix: suppress hover / cmd+click when overlay is active ==========
  // suppressHoverRef for toolbar is managed directly in useCodeViewerLogic's event handlers;
  // here we only handle state changes from addCommentInput / sendToAIInput etc.
  useEffect(() => {
    if (addCommentInput || sendToAIInput) {
      suppressHoverRef.current = true;
      onTokenHoverLeave?.();
    } else if (!floatingToolbarRef.current) {
      // Only release suppression when toolbar also does not exist
      suppressHoverRef.current = false;
    }
  }, [addCommentInput, sendToAIInput, onTokenHoverLeave]);

  // ========== Selection restore: recover browser selection from logical coordinates when DOM is replaced after re-render ==========
  useLayoutEffect(() => {
    const saved = savedSelectionRef.current;
    if (!saved) return; // No saved selection, skip
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // Selection still exists, no need to restore
    // Selection lost → restore from logical coordinates
    const container = parentRef.current;
    if (!container) return;
    const startLineEl = container.querySelector(`[data-line="${saved.startLine}"]`);
    const endLineEl = container.querySelector(`[data-line="${saved.endLine}"]`);
    if (!startLineEl || !endLineEl) return; // Lines not in viewport (recycled by virtual scroll)
    const start = resolveCharOffset(startLineEl, saved.startOffset);
    const end = resolveCharOffset(endLineEl, saved.endOffset);
    if (!start || !end) return;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      // Silently ignore offset overflow and similar exceptions
    }
  });

  // Wrap hover / cmd+click callbacks, read ref to check suppression (ref does not affect memo stability)
  const guardedTokenHover = useCallback((line: number, column: number, rect: { x: number; y: number }) => {
    if (suppressHoverRef.current) return;
    onTokenHover?.(line, column, rect);
  }, [onTokenHover]);

  const guardedCmdClick = useCallback((line: number, column: number) => {
    if (suppressHoverRef.current) return;
    onCmdClick?.(line, column);
  }, [onCmdClick]);

  // Line number column: minimum 4 digits wide
  const lineNumChars = Math.max(4, String(editable ? editLineCount : lines.length).length);

  // Visual width of the longest line (in ch units), for consistent horizontal scrolling
  const maxLineVisualWidth = useMemo(() => {
    let max = 0;
    for (const line of lines) {
      let w = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\t') {
          w += 2 - (w % 2); // tab-size: 2, align to multiple of 2
        } else {
          w += 1;
        }
      }
      if (w > max) max = w;
    }
    return max;
  }, [lines]);

  // ========== Edit mode: enter/exit sync ==========
  useEffect(() => {
    if (editable) {
      editContentRef.current = content;
      const lc = content.split('\n').length;
      editLineCountRef.current = lc;
      setEditLineCount(lc);
      isDirtyRef.current = false;
      setIsDirty(false);
      setConflictState({ show: false });
      mtimeRef.current = initialMtime;
    }
  }, [editable, content, initialMtime]);

  // When entering edit mode: set innerHTML, focus, scroll to current position
  useEffect(() => {
    if (!editable) return;
    const container = editableRef.current;
    if (!container) return;

    // Initialize contentEditable with highlighted HTML already available from read-only mode
    const editLineArr = content.split('\n');
    const lineHtmls = editLineArr.map((line, i) => {
      return highlightedLines[i] || escapeHtml(line || ' ');
    });
    container.innerHTML = buildEditorHTML(lineHtmls);

    requestAnimationFrame(() => {
      // Vi mode: position cursor at vi cursor position; non-vi: position at first visible line
      let cursorLineIdx: number;
      let cursorOffset: number;
      if (viModeEnabled) {
        cursorLineIdx = Math.max(0, Math.min(viInsertPosRef.current.line, editLineArr.length - 1));
        cursorOffset = viInsertPosRef.current.col;
      } else {
        cursorLineIdx = Math.max(0, Math.min((visibleLineRef?.current ?? 1) - 1, editLineArr.length - 1));
        cursorOffset = 0;
      }

      // 1. focus + cursor positioning (may trigger browser auto-scroll to cursor/top)
      container.focus();
      restoreCursorPosition(container, { line: cursorLineIdx, offset: cursorOffset });

      // 2. Scroll: maintain the same viewport position as read-only mode
      const scrollLine = visibleLineRef?.current ?? 1;
      const scrollTop = (scrollLine - 1) * 20; // LINE_HEIGHT = 20px
      if (editScrollRef.current) editScrollRef.current.scrollTop = scrollTop;
    });
   
  }, [editable]);

  // Notify parent of dirty/saving state
  useEffect(() => {
    if (editable) {
      onEditorStateChange?.({ isDirty, isSaving });
    }
  }, [editable, isDirty, isSaving, onEditorStateChange]);

  // ========== Edit mode: contentEditable handlers ==========
  const extractTextFromEditable = useCallback((): string => {
    const container = editableRef.current;
    if (!container) return editContentRef.current;
    const lines: string[] = [];
    for (const child of container.childNodes) {
      const text = (child as HTMLElement).textContent || '';
      // Empty lines use ' ' as placeholder in DOM to prevent div collapse, restore to empty string on extract
      lines.push(text === ' ' ? '' : text);
    }
    return lines.join('\n');
  }, []);

  // Imperative debounced highlight (does not depend on React state, no re-render)
  const triggerHighlightDebounce = useCallback(() => {
    if (editDebounceRef.current) clearTimeout(editDebounceRef.current);
    editDebounceRef.current = setTimeout(async () => {
      const container = editableRef.current;
      if (!container) return;
      if (isComposingRef.current) return; // Don't rebuild DOM during IME composition, would break candidate window

      // Extract latest content from DOM and write to ref
      editContentRef.current = extractTextFromEditable();

      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const isDarkMode = document.documentElement.classList.contains('dark');
        const theme = isDarkMode ? 'github-dark' : 'github-light';
        const editLineArr = editContentRef.current.split('\n');
        const result = highlighter.codeToTokens(editLineArr.join('\n'), {
          lang: language as BundledLanguage,
          theme,
        });
        const highlighted = result.tokens.map(lineTokens => tokensToHtml(lineTokens));

        // Save cursor → replace innerHTML → restore cursor
        const cursorPos = saveCursorPosition(container);
        isHighlightingRef.current = true;
        container.innerHTML = buildEditorHTML(highlighted);
        isHighlightingRef.current = false;
        if (cursorPos) restoreCursorPosition(container, cursorPos);
      } catch {
        // Highlight failed, don't update DOM
      }
    }, 300);
  }, [filePath, extractTextFromEditable]);

  // Clean up debounce timer
  useEffect(() => {
    if (!editable) return;
    return () => { if (editDebounceRef.current) clearTimeout(editDebounceRef.current); };
  }, [editable]);

  // Sync line count & dirty flag (only setState on actual change, zero re-render for normal keystrokes)
  const syncEditMeta = useCallback(() => {
    const container = editableRef.current;
    if (!container) return;

    // dirty: don't repeat setState after first becoming dirty
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      setIsDirty(true);
    }

    // Line count: read directly from DOM children count, O(1)
    const newLineCount = container.children.length;
    if (newLineCount !== editLineCountRef.current) {
      editLineCountRef.current = newLineCount;
      setEditLineCount(newLineCount);
    }
  }, []);

  const handleContentInput = useCallback(() => {
    if (isHighlightingRef.current) return;
    if (isComposingRef.current) return; // Don't sync during IME composition, wait for compositionend
    syncEditMeta();
    triggerHighlightDebounce();
  }, [syncEditMeta, triggerHighlightDebounce]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't intercept during IME composition (e.g., confirming Chinese candidates)
    if (e.nativeEvent.isComposing) return;

    // Tab → insert 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
    // Enter → ensure plain text newline is inserted, not browser's default <div>
    if (e.key === 'Enter') {
      e.preventDefault();
      // Insert newline: split div at current position
      const container = editableRef.current;
      if (!container) return;
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();

      // Find the current line div
      let lineEl: Node | null = range.startContainer;
      while (lineEl && lineEl.parentElement !== container) {
        lineEl = lineEl.parentElement;
      }
      if (!lineEl || !(lineEl instanceof HTMLElement)) return;

      // Split current line: content after cursor moves to new line
      const cursorPos = saveCursorPosition(container);
      const lineIdx = Array.from(container.children).indexOf(lineEl);
      const fullText = lineEl.textContent || '';
      const splitAt = cursorPos?.offset ?? fullText.length;
      const beforeText = fullText.substring(0, splitAt);
      const afterText = fullText.substring(splitAt);

      // Update current line
      lineEl.innerHTML = escapeHtml(beforeText || ' ');

      // Create new line div
      const newLineEl = document.createElement('div');
      newLineEl.setAttribute('style', EDITOR_LINE_STYLE);
      newLineEl.innerHTML = escapeHtml(afterText || ' ');
      lineEl.after(newLineEl);

      // Move cursor to start of new line
      restoreCursorPosition(container, { line: lineIdx + 1, offset: 0 });

      // Sync meta + trigger highlight
      syncEditMeta();
      triggerHighlightDebounce();
    }
  }, [syncEditMeta, triggerHighlightDebounce]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // ========== Edit mode: save logic ==========
  const doSave = useCallback(async (skipConflictCheck = false) => {
    if (!cwd) return;
    // Extract latest content from DOM before saving (ensure ref is up-to-date)
    editContentRef.current = extractTextFromEditable();
    setIsSaving(true);
    try {
      const response = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          path: filePath,
          content: editContentRef.current,
          expectedMtime: skipConflictCheck ? undefined : mtimeRef.current,
        }),
      });
      const data = await response.json();

      if (response.status === 409 && data.conflict) {
        try {
          const readRes = await fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`);
          const readData = await readRes.json();
          setConflictState({ show: true, diskContent: readData.type === 'text' ? readData.content : undefined });
        } catch {
          setConflictState({ show: true });
        }
        return;
      }
      if (!response.ok) throw new Error('Failed to save file');

      if (data.mtime) mtimeRef.current = data.mtime;
      isDirtyRef.current = false;
      setIsDirty(false);
      setConflictState({ show: false });
      toast(t('toast.savedSuccess'), 'success');
      onSaved?.();
    } catch (error) {
      console.error('Error saving file:', error);
      toast(t('toast.saveFailed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [cwd, filePath, extractTextFromEditable, onSaved]);

  const handleSave = useCallback(async () => {
    if (!isDirty || isSaving) return;
    await doSave(false);
  }, [isDirty, isSaving, doSave]);

  const handleForceOverwrite = useCallback(async () => {
    setConflictState({ show: false });
    await doSave(true);
  }, [doSave]);

  const handleRevertToDisk = useCallback(() => {
    if (conflictState.diskContent !== undefined) {
      // Write disk content to ref and rebuild contentEditable DOM
      editContentRef.current = conflictState.diskContent;
      const lc = conflictState.diskContent.split('\n').length;
      editLineCountRef.current = lc;
      setEditLineCount(lc);
      const newDirty = conflictState.diskContent !== content;
      isDirtyRef.current = newDirty;
      setIsDirty(newDirty);
      // Rebuild editor content
      const container = editableRef.current;
      if (container) {
        const editLineArr = conflictState.diskContent.split('\n');
        container.innerHTML = buildEditorHTML(editLineArr.map(l => escapeHtml(l || ' ')));
        triggerHighlightDebounce();
      }
    }
    setConflictState({ show: false });
    onSaved?.();
  }, [conflictState.diskContent, content, onSaved, triggerHighlightDebounce]);

  const getCurrentLine = useCallback((): number => {
    // Return first visible line (not cursor line), to maintain consistent view position when exiting edit mode
    const scrollEl = editScrollRef.current;
    if (scrollEl) return Math.floor(scrollEl.scrollTop / 20) + 1;
    return visibleLineRef?.current ?? 1;
  }, [visibleLineRef]);

  const handleEditorClose = useCallback(async () => {
    if (isDirty) {
      const ok = await confirm(t('codeViewer.unsavedConfirm'), { danger: true, confirmText: t('codeViewer.discardChanges'), cancelText: t('codeViewer.continueEditing') });
      if (!ok) return;
    }
    onEditorClose?.(getCurrentLine());
  }, [isDirty, onEditorClose, getCurrentLine]);

  // Cmd+S to save (edit mode)
  useEffect(() => {
    if (!editable) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editable, handleSave]);

  // Vi Insert → Normal exit logic (extract cursor position + notify parent)
  const viExitInsert = useCallback(() => {
    const currentContent = extractTextFromEditable();
    onContentMutate?.(currentContent);

    // Get actual cursor position (line + col) from contentEditable
    const container = editableRef.current;
    const cursorPos = container ? saveCursorPosition(container) : null;
    const scrollLine = getCurrentLine(); // Used only for scroll restoration

    vi.enterNormal();
    if (cursorPos) {
      vi.setCursorLine(cursorPos.line);
      const lineText = currentContent.split('\n')[cursorPos.line] ?? '';
      vi.setCursorCol(Math.max(0, Math.min(cursorPos.offset, Math.max(0, lineText.length - 1))));
    } else {
      vi.setCursorLine(Math.max(0, scrollLine - 1));
    }
    onEditorClose?.(scrollLine);
  }, [extractTextFromEditable, onContentMutate, getCurrentLine, onEditorClose, vi]);

  // ESC / Ctrl+C: in vi mode return to Normal, in non-vi mode close editor
  useEffect(() => {
    if (!editable) return;
    const handler = (e: KeyboardEvent) => {
      const isEsc = e.key === 'Escape';
      const isCtrlC = e.ctrlKey && e.key === 'c' && !e.metaKey && !e.shiftKey;
      if (isEsc || (viModeEnabled && isCtrlC)) {
        e.preventDefault();
        e.stopPropagation();
        if (viModeEnabled) {
          if (isDirtyRef.current) {
            // Unsaved changes, show confirmation dialog
            confirm(t('codeViewer.unsavedExitConfirm'), { danger: true, confirmText: t('codeViewer.discardChanges'), cancelText: t('codeViewer.continueEditing') })
              .then(ok => { if (ok) viExitInsert(); });
          } else {
            viExitInsert();
          }
        } else {
          handleEditorClose();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [editable, viModeEnabled, handleEditorClose, viExitInsert]);

  // Expose imperative handle
  useImperativeHandle(ref, () => ({
    save: handleSave,
    close: handleEditorClose,
    get isDirty() { return isDirty; },
    get isSaving() { return isSaving; },
  }), [handleSave, handleEditorClose, isDirty, isSaving]);

  // ========== Blame state ==========
  const hasBlame = !!(blameLines && blameLines.length > 0);

  const authorColorMap = useMemo(() => {
    if (!blameLines) return new Map<string, typeof AUTHOR_COLORS[0]>();
    const authors = [...new Set(blameLines.map(l => l.author))];
    const map = new Map<string, typeof AUTHOR_COLORS[0]>();
    authors.forEach((author, index) => {
      map.set(author, AUTHOR_COLORS[index % AUTHOR_COLORS.length]);
    });
    return map;
  }, [blameLines]);

  const [hoveredAuthor, setHoveredAuthor] = useState<string | null>(null);
  const [blameTooltip, setBlameTooltip] = useState<{ line: BlameLine; x: number; y: number } | null>(null);

  useEffect(() => {
    setHoveredAuthor(null);
    setBlameTooltip(null);
  }, [blameLines]);

  const handleBlameMouseEnter = useCallback((line: BlameLine, e: React.MouseEvent) => {
    setHoveredAuthor(line.author);
    const rect = e.currentTarget.getBoundingClientRect();
    setBlameTooltip({ line, x: rect.right + 8, y: rect.top });
  }, []);

  const handleBlameMouseLeave = useCallback(() => {
    setHoveredAuthor(null);
    setBlameTooltip(null);
  }, []);

  const handleBlameClick = useCallback((line: BlameLine) => {
    if (!onSelectCommit) return;
    const commitInfo: CommitInfo = {
      hash: line.hashFull,
      shortHash: line.hash,
      author: line.author,
      authorEmail: line.authorEmail,
      date: new Date(line.time * 1000).toISOString(),
      subject: line.message.split('\n')[0] || '',
      body: line.message.split('\n').slice(1).join('\n').trim(),
      time: line.time,
    };
    onSelectCommit(commitInfo);
    setBlameTooltip(null);
  }, [onSelectCommit]);

  // ========== Line number column width ==========
  const lineNumberWidth = `${lineNumChars + 2}ch`;

  return (
    <div ref={containerRef} className={`h-full flex flex-col outline-none ${className}`} tabIndex={0} onClick={viClickHandler} onDoubleClick={viDblClickHandler}>
      {/* Conflict warning bar (edit mode) */}
      {editable && conflictState.show && (
        <div className="px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 flex items-center gap-3 flex-shrink-0">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-sm text-foreground flex-1">{t('codeViewer.fileModifiedExternally')}</span>
          <div className="flex items-center gap-2">
            <button onClick={handleRevertToDisk} className="px-3 py-1 text-sm rounded border border-border hover:bg-accent transition-colors">
              {t('codeViewer.useDiskVersion')}
            </button>
            <button onClick={handleForceOverwrite} className="px-3 py-1 text-sm rounded bg-amber-500 text-white hover:bg-amber-600 transition-colors">
              {t('codeViewer.forceOverwrite')}
            </button>
          </div>
        </div>
      )}

      {/* Search bar (read-only mode) */}
      {!editable && showSearch && isSearchVisible && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-secondary border-b border-border">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('codeViewer.searchPlaceholder')}
            className="flex-1 max-w-xs px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              caseSensitive
                ? 'bg-brand text-white border-brand'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
            title={t('codeViewer.caseSensitive')}
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
            title={t('codeViewer.wholeWordMatch')}
          >
            [ab]
          </button>
          <span className="text-xs text-muted-foreground">
            {matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : t('common.noMatch')}
          </span>
          <button onClick={goToPrevMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title={t('common.previous')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button onClick={goToNextMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title={t('common.next')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button onClick={() => { setIsSearchVisible(false); setSearchQuery(''); }} className="p-1 rounded hover:bg-accent" title={t('common.close')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ========== Edit mode: contentEditable ========== */}
      {editable ? (
        <div ref={editScrollRef} className="flex-1 overflow-auto bg-secondary">
          <div className="flex" style={{ minHeight: '100%' }}>
            {/* Line number column (sticky: pinned to left on horizontal scroll) */}
            <div
              className="flex-shrink-0 font-mono text-sm select-none sticky left-0 z-[2] bg-secondary"
              style={{ width: lineNumberWidth }}
            >
              {Array.from({ length: editLineCount }, (_, i) => (
                <div key={i} className="text-right text-muted-foreground/50 pr-3" style={{ height: 20, lineHeight: '20px' }}>
                  {i + 1}
                </div>
              ))}
            </div>

            {/* contentEditable code area - single layer, cursor/selection/text naturally aligned */}
            <div
              ref={editableRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleContentInput}
              onKeyDown={handleEditKeyDown}
              onPaste={handlePaste}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; handleContentInput(); }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="flex-1 font-mono text-sm outline-none"
              style={{
                caretColor: 'var(--foreground)',
                tabSize: 2,
              }}
            />
          </div>
        </div>
      ) : (
        /* ========== Read-only mode: virtual scroll ========== */
        <div
          ref={parentRef}
          className={`flex-1 overflow-auto font-mono text-sm bg-secondary${cmdHeld ? ' cmd-held-container' : ''}`}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              minWidth: '100%',
              // Consistent horizontal scroll: inner width = line number col + code content + buffer (blame col appended via CSS calc)
              width: hasBlame
                ? `calc(${lineNumChars + maxLineVisualWidth + 10}ch + 13rem)` // 13rem ≈ w-1 + w-48 blame column
                : `${lineNumChars + maxLineVisualWidth + 10}ch`,
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

              // Inline blame annotation: only show on the line where mouseup occurred
              // inlineBlameVersion is read here to subscribe to re-renders triggered by ref changes
              const inlineBlameLine = inlineBlameVersion >= 0 ? inlineBlameLineRef.current : null;
              const inlineBlameData = (!editable && inlineBlameLines && inlineBlameLine === lineNum)
                ? (inlineBlameLines[lineIndex] ?? null)
                : null;

              // Blame data for this line
              const blameLine = hasBlame ? blameLines![lineIndex] : undefined;
              const prevBlameLine = hasBlame && lineIndex > 0 ? blameLines![lineIndex - 1] : undefined;
              const showBlameInfo = blameLine ? (!prevBlameLine || prevBlameLine.hash !== blameLine.hash) : false;
              const blameAuthorColor = blameLine ? authorColorMap.get(blameLine.author) : undefined;

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
                  lineNumChars={lineNumChars}
                  commentsEnabled={commentsEnabled}
                  virtualItemSize={virtualItem.size}
                  virtualItemStart={virtualItem.start}
                  onCommentBubbleClick={handleCommentBubbleClick}
                  onCmdClick={guardedCmdClick}
                  onTokenHover={guardedTokenHover}
                  onTokenHoverLeave={onTokenHoverLeave}
                  flashLine={flashLine}
                  blameLine={blameLine}
                  showBlameInfo={showBlameInfo}
                  blameAuthorColor={blameAuthorColor}
                  isBlameHovered={!!(blameLine && hoveredAuthor === blameLine.author)}
                  onBlameClick={handleBlameClick}
                  onBlameMouseEnter={handleBlameMouseEnter}
                  onBlameMouseLeave={handleBlameMouseLeave}
                  inlineBlameData={inlineBlameData}
                  onInlineBlameClick={handleBlameClick}
                  isCursorLine={viModeEnabled && !editable && vi.state.cursorLine === lineIndex}
                  cursorCol={viModeEnabled && !editable && vi.state.cursorLine === lineIndex ? vi.state.cursorCol : undefined}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ========== Vi Mode status bar ========== */}
      {viModeEnabled && (
        <div className="vi-status-bar flex-shrink-0 h-6 bg-card border-t border-border flex items-center px-3 text-xs font-mono select-none">
          {vi.state.mode === 'normal' && (
            <span className="text-green-11 font-medium">NORMAL</span>
          )}
          {vi.state.mode === 'insert' && (
            <span className="text-blue-11 font-medium">INSERT</span>
          )}
          {vi.state.mode === 'command' && (
            <div className="flex items-center flex-1">
              <span className="text-foreground">:</span>
              <input
                ref={viCommandInputRef}
                value={vi.state.commandInput}
                onChange={e => vi.setCommandInput(e.target.value)}
                onKeyDown={e => {
                  // Don't intercept during IME composition (Enter from confirming Chinese candidates)
                  if (e.nativeEvent.isComposing) return;
                  const isCtrlC = e.ctrlKey && e.key === 'c' && !e.metaKey && !e.shiftKey;
                  if (e.key === 'Enter' || e.key === 'Escape' || isCtrlC) {
                    e.preventDefault();
                    e.stopPropagation();
                    vi.handleKeyDown(e.nativeEvent);
                  }
                }}
                className="flex-1 bg-transparent outline-none text-foreground ml-0.5"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {vi.state.mode === 'search' && (
            <div className="flex items-center flex-1">
              <span className="text-foreground">/</span>
              <input
                ref={viSearchInputRef}
                value={vi.state.searchInput}
                onChange={e => vi.setSearchInput(e.target.value)}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing) return;
                  const isCtrlC = e.ctrlKey && e.key === 'c' && !e.metaKey && !e.shiftKey;
                  if (e.key === 'Enter' || e.key === 'Escape' || isCtrlC) {
                    e.preventDefault();
                    e.stopPropagation();
                    vi.handleKeyDown(e.nativeEvent);
                  }
                }}
                className="flex-1 bg-transparent outline-none text-foreground ml-0.5"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {vi.state.keyBuffer && (vi.state.mode === 'normal') && (
            <span className="ml-2 text-muted-foreground">{vi.state.keyBuffer}</span>
          )}
          {vi.state.isDirty && (vi.state.mode === 'normal' || vi.state.mode === 'command') && (
            <span className="ml-2 text-amber-11">[+]</span>
          )}
          <span className="ml-auto text-muted-foreground">
            {vi.state.cursorLine + 1}:{vi.state.cursorCol + 1}
          </span>
        </div>
      )}

      {/* Floating elements via Portal to menu container (keeps within second screen) */}
      {isMounted && menuContainer && createPortal(
        <>
          {/* Floating Toolbar — separate ToolbarRenderer component manages its own state,
              CodeViewer does not re-render on toolbar show/hide → selection is preserved */}
          {!editable && (
            <ToolbarRenderer
              floatingToolbarRef={floatingToolbarRef}
              bumpRef={bumpToolbarRef}
              container={menuContainer}
              onAddComment={handleToolbarAddComment}
              onSendToAI={handleToolbarSendToAI}
              onSearch={onContentSearch ? handleToolbarSearch : undefined}
              isChatLoading={chatContext?.isLoading}
            />
          )}

          {/* Add Comment Input */}
          {!editable && addCommentInput && (
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
          {!editable && sendToAIInput && (
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
          {!editable && viewingComment && (
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

          {/* Blame Tooltip */}
          {blameTooltip && (
            <div
              className="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-3 max-w-lg"
              style={{
                left: Math.min(blameTooltip.x, window.innerWidth - 450),
                top: Math.max(8, Math.min(blameTooltip.y, window.innerHeight - 200)),
              }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="px-2 py-0.5 rounded text-xs font-mono font-medium text-white flex-shrink-0"
                  style={{ backgroundColor: authorColorMap.get(blameTooltip.line.author)?.border || '#666' }}
                >
                  {blameTooltip.line.hash}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {blameTooltip.line.author}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {blameTooltip.line.authorEmail}
                  </div>
                </div>
              </div>
              <div className="mt-2 text-sm text-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
                {blameTooltip.line.message}
              </div>
              <div className="mt-2 text-xs text-muted-foreground border-t border-border pt-2">
                {formatRelativeTime(blameTooltip.line.time)}
                {' · '}
                {new Date(blameTooltip.line.time * 1000).toLocaleString()}
                <span className="ml-2 text-brand">{t('codeViewer.clickToViewDetails')}</span>
              </div>
            </div>
          )}
        </>,
        menuContainer
      )}
    </div>
  );
});

// ============================================
// Simple Code Block (non-virtual, for small content)
// ============================================

interface SimpleCodeBlockProps {
  content: string;
  filePath: string;
  className?: string;
}

export function SimpleCodeBlock({ content, filePath, className = '' }: SimpleCodeBlockProps) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const highlightedLines = useLineHighlight(lines, filePath);
  const lnChars = Math.max(4, String(lines.length).length);

  return (
    <pre className={`overflow-auto text-sm font-mono bg-secondary p-2 ${className}`}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="text-slate-9 select-none pr-4 text-right" style={{ minWidth: `${lnChars + 2}ch` }}>
            {i + 1}
          </span>
          <span
            className="flex-1"
            dangerouslySetInnerHTML={{ __html: highlightedLines[i] || escapeHtml(line || ' ') }}
          />
        </div>
      ))}
    </pre>
  );
}
