'use client';

import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useImperativeHandle, forwardRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { useMenuContainer } from './FileContextMenu';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { useLineHighlight } from '@/hooks/useLineHighlight';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, escapeHtml, tokensToHtml } from '@/lib/codeHighlighter';
import { FloatingToolbar } from './FloatingToolbar';
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

// contentEditable 行 div 的内联样式（用于 innerHTML 字符串拼接）
const EDITOR_LINE_STYLE = 'white-space:pre;padding:0 12px;min-height:20px;line-height:20px';

// ========== contentEditable 光标工具 ==========
function saveCursorPosition(container: HTMLElement): { line: number; offset: number } | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);

  // 找到光标所在的行 div
  let node: Node | null = range.startContainer;
  while (node && node.parentElement !== container) {
    node = node.parentElement;
  }
  if (!node) return null;

  const lineIndex = Array.from(container.children).indexOf(node as Element);
  if (lineIndex < 0) return null;

  // 计算行内字符偏移
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

  // fallback: 放到行末
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
// ToolbarRenderer - 独立状态，避免 CodeViewer 重渲染
// 只有 toolbar 自身的显示/隐藏触发此组件 re-render，
// CodeViewer 的虚拟列表完全不受影响 → 选区得以保留。
// ============================================
interface ToolbarRendererProps {
  floatingToolbarRef: React.RefObject<{ x: number; y: number; range: { start: number; end: number }; selectedText: string } | null>;
  bumpRef: React.MutableRefObject<() => void>;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  isChatLoading?: boolean;
}

function ToolbarRendererInner({ floatingToolbarRef, bumpRef, container, onAddComment, onSendToAI, isChatLoading }: ToolbarRendererProps) {
  const [version, forceRender] = useState(0);

  // 让父组件通过 bumpRef 触发本组件 re-render
  useEffect(() => {
    bumpRef.current = () => forceRender(v => v + 1);
  }, [bumpRef]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version 仅用于触发 re-read ref
  const toolbar = useMemo(() => floatingToolbarRef.current, [version]);

  return (
    <FloatingToolbar
      x={toolbar?.x ?? 0}
      y={toolbar?.y ?? 0}
      visible={!!toolbar}
      container={container}
      onAddComment={onAddComment}
      onSendToAI={onSendToAI}
      isChatLoading={isChatLoading}
    />
  );
}
const ToolbarRenderer = memo(ToolbarRendererInner);

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
}, ref) {
  // ========== 编辑模式状态 ==========
  const editContentRef = useRef(content); // ref：不触发 re-render，仅在 save/highlight 时读取
  const isDirtyRef = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editLineCount, setEditLineCount] = useState(() => content.split('\n').length);
  const editLineCountRef = useRef(content.split('\n').length);
  const [conflictState, setConflictState] = useState<{ show: boolean; diskContent?: string }>({ show: false });
  const editableRef = useRef<HTMLDivElement>(null);
  const editScrollRef = useRef<HTMLDivElement>(null);
  const mtimeRef = useRef<number | undefined>(initialMtime);

  // 编辑模式的 debounce 高亮
  const editDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHighlightingRef = useRef(false); // 防止 re-highlight 触发 onInput
  const isComposingRef = useRef(false); // IME 输入中标记，防止拼音写入文件

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
    handleCommentSubmit,
    handleSendToAISubmit,
    getHighlightedLineHtml,

    // Search scroll suppression
    suppressMatchScrollRef,

    // Inline blame
    inlineBlameLineRef,
    inlineBlameVersion,
  } = useCodeViewerLogic({
    content,  // 编辑模式下也传原始 content，避免每次按键触发 useLineHighlight 全文 re-tokenize
    filePath,
    showSearch,
    cwd,
    enableComments: editable ? false : enableComments, // 编辑模式下禁用 comments
    scrollToLine: editable ? null : scrollToLine,
    scrollToLineAlign: editable ? 'center' : scrollToLineAlign,
    onScrollToLineComplete: editable ? undefined : onScrollToLineComplete,
    visibleLineRef: editable ? undefined : visibleLineRef,
  });

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  // ========== Vi Mode ==========
  const LINE_HEIGHT = 20;
  const viCommandInputRef = useRef<HTMLInputElement>(null);
  const viSearchInputRef = useRef<HTMLInputElement>(null);
  // 记录进入 Insert 模式时的光标目标位置（行 + 列），供编辑模式初始化 effect 使用
  const viInsertPosRef = useRef({ line: 0, col: 0 });

  const vi = useViMode({
    lines,
    enabled: viModeEnabled && !editable,
    onContentChange: (newContent) => {
      onContentMutate?.(newContent);
    },
    onEnterInsert: (line, col, variant) => {
      // 根据 variant 计算编辑器中的实际光标列
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

  // Vi Normal mode keyboard listener (on container element)
  useEffect(() => {
    if (!viModeEnabled || editable) return;
    const container = containerRef.current;
    if (!container) return;

    const handler = (e: KeyboardEvent) => {
      // When command/search input is focused, don't intercept at container level
      // — let the input's own onKeyDown handle Enter/Escape
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' && target.closest('.vi-status-bar')) return;

      const consumed = vi.handleKeyDown(e);
      if (consumed) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Use capture phase to intercept before other handlers
    container.addEventListener('keydown', handler, true);
    return () => container.removeEventListener('keydown', handler, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viModeEnabled, editable, vi.handleKeyDown]);

  // Auto-focus container for vi-mode key capture (when not in insert/command/search mode)
  useEffect(() => {
    if (!viModeEnabled || editable) return;
    const container = containerRef.current;
    if (container && vi.state.mode === 'normal') {
      // Focus container so keyboard events reach vi handler
      // Use rAF to ensure this runs after any focus changes from mode transitions
      requestAnimationFrame(() => container.focus());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Re-focus container for keyboard events
    const container = containerRef.current;
    if (container) container.focus();
  }, [viModeEnabled, editable, vi.setCursorLine, vi.setCursorCol, lines]);

  // Double-click on code area → select word + highlight matches (no scroll)
  const viDblClickHandler = useCallback((e: React.MouseEvent) => {
    if (!viModeEnabled || editable) return;
    // 浏览器双击自动选中单词，直接取 selection 文本
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

  // ========== mousedown 时立即清除 hover 卡片 ==========
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleMouseDown = () => {
      // 立即版：mousedown 意味着用户要操作代码，不需要 150ms 延迟
      (onTokenHoverCancel ?? onTokenHoverLeave)?.();
    };
    el.addEventListener('mousedown', handleMouseDown);
    return () => el.removeEventListener('mousedown', handleMouseDown);
  }, [onTokenHoverCancel, onTokenHoverLeave]);

  // ========== 交互状态矩阵：浮层活跃时抑制 hover / cmd+click ==========
  // toolbar 的 suppressHoverRef 已在 useCodeViewerLogic 的事件处理中直接管理；
  // 此处仅处理 addCommentInput / sendToAIInput 等 state 变化的情况。
  useEffect(() => {
    if (addCommentInput || sendToAIInput) {
      suppressHoverRef.current = true;
      onTokenHoverLeave?.();
    } else if (!floatingToolbarRef.current) {
      // 只在 toolbar 也不存在时才解除抑制
      suppressHoverRef.current = false;
    }
  }, [addCommentInput, sendToAIInput, onTokenHoverLeave]);

  // ========== 选区恢复：re-render 后 DOM 被替换时从逻辑坐标恢复浏览器选区 ==========
  useLayoutEffect(() => {
    const saved = savedSelectionRef.current;
    if (!saved) return; // 没有保存的选区，跳过
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 选区仍然存在，无需恢复
    // 选区丢失 → 从逻辑坐标恢复
    const container = parentRef.current;
    if (!container) return;
    const startLineEl = container.querySelector(`[data-line="${saved.startLine}"]`);
    const endLineEl = container.querySelector(`[data-line="${saved.endLine}"]`);
    if (!startLineEl || !endLineEl) return; // 行不在视口内（虚拟滚动回收了）
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
      // offset 越界等异常静默忽略
    }
  });

  // 包装 hover / cmd+click 回调，读 ref 判断是否抑制（ref 不影响 memo 稳定性）
  const guardedTokenHover = useCallback((line: number, column: number, rect: { x: number; y: number }) => {
    if (suppressHoverRef.current) return;
    onTokenHover?.(line, column, rect);
  }, [onTokenHover]);

  const guardedCmdClick = useCallback((line: number, column: number) => {
    if (suppressHoverRef.current) return;
    onCmdClick?.(line, column);
  }, [onCmdClick]);

  // 行号列：最少4位数字宽度
  const lineNumChars = Math.max(4, String(editable ? editLineCount : lines.length).length);

  // ========== 编辑模式：进入/退出同步 ==========
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

  // 进入编辑模式时：设置 innerHTML、focus、滚动到当前位置
  useEffect(() => {
    if (!editable) return;
    const container = editableRef.current;
    if (!container) return;

    // 用只读模式已有的高亮 HTML 初始化 contentEditable
    const editLineArr = content.split('\n');
    const lineHtmls = editLineArr.map((line, i) => {
      return highlightedLines[i] || escapeHtml(line || ' ');
    });
    container.innerHTML = buildEditorHTML(lineHtmls);

    requestAnimationFrame(() => {
      // Vi 模式：光标定位到 vi 光标位置；非 vi：定位到视口首行
      let cursorLineIdx: number;
      let cursorOffset: number;
      if (viModeEnabled) {
        cursorLineIdx = Math.max(0, Math.min(viInsertPosRef.current.line, editLineArr.length - 1));
        cursorOffset = viInsertPosRef.current.col;
      } else {
        cursorLineIdx = Math.max(0, Math.min((visibleLineRef?.current ?? 1) - 1, editLineArr.length - 1));
        cursorOffset = 0;
      }

      // 1. focus + 光标定位（可能触发浏览器自动滚动到光标/顶部）
      container.focus();
      restoreCursorPosition(container, { line: cursorLineIdx, offset: cursorOffset });

      // 2. 滚动：保持与只读模式相同的视口位置
      const scrollLine = visibleLineRef?.current ?? 1;
      const scrollTop = (scrollLine - 1) * 20; // LINE_HEIGHT = 20
      if (editScrollRef.current) editScrollRef.current.scrollTop = scrollTop;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  // 通知父组件 dirty/saving 状态
  useEffect(() => {
    if (editable) {
      onEditorStateChange?.({ isDirty, isSaving });
    }
  }, [editable, isDirty, isSaving, onEditorStateChange]);

  // ========== 编辑模式：contentEditable handlers ==========
  const extractTextFromEditable = useCallback((): string => {
    const container = editableRef.current;
    if (!container) return editContentRef.current;
    const lines: string[] = [];
    for (const child of container.childNodes) {
      lines.push((child as HTMLElement).textContent || '');
    }
    return lines.join('\n');
  }, []);

  // 命令式 debounce 高亮（不依赖 React state，不触发 re-render）
  const triggerHighlightDebounce = useCallback(() => {
    if (editDebounceRef.current) clearTimeout(editDebounceRef.current);
    editDebounceRef.current = setTimeout(async () => {
      const container = editableRef.current;
      if (!container) return;
      if (isComposingRef.current) return; // IME 输入中不重建 DOM，否则会打断候选窗口

      // 从 DOM 提取最新内容写入 ref
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

        // 保存光标 → 替换 innerHTML → 恢复光标
        const cursorPos = saveCursorPosition(container);
        isHighlightingRef.current = true;
        container.innerHTML = buildEditorHTML(highlighted);
        isHighlightingRef.current = false;
        if (cursorPos) restoreCursorPosition(container, cursorPos);
      } catch {
        // 高亮失败，不更新 DOM
      }
    }, 300);
  }, [filePath, extractTextFromEditable]);

  // 清理 debounce timer
  useEffect(() => {
    if (!editable) return;
    return () => { if (editDebounceRef.current) clearTimeout(editDebounceRef.current); };
  }, [editable]);

  // 同步行数 & dirty 标记（仅在真正变化时 setState，普通按键零 re-render）
  const syncEditMeta = useCallback(() => {
    const container = editableRef.current;
    if (!container) return;

    // dirty：首次变脏后不再重复 setState
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      setIsDirty(true);
    }

    // 行数：从 DOM children 数量直接取，O(1)
    const newLineCount = container.children.length;
    if (newLineCount !== editLineCountRef.current) {
      editLineCountRef.current = newLineCount;
      setEditLineCount(newLineCount);
    }
  }, []);

  const handleContentInput = useCallback(() => {
    if (isHighlightingRef.current) return;
    if (isComposingRef.current) return; // IME 输入中不同步，等 compositionend
    syncEditMeta();
    triggerHighlightDebounce();
  }, [syncEditMeta, triggerHighlightDebounce]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME 输入中（如中文候选词确认）不拦截
    if (e.nativeEvent.isComposing) return;

    // Tab → 插入 2 空格
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
    // Enter → 确保插入纯文本换行，而不是浏览器默认的 <div>
    if (e.key === 'Enter') {
      e.preventDefault();
      // 插入换行：在当前位置分割 div
      const container = editableRef.current;
      if (!container) return;
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();

      // 找到当前行 div
      let lineEl: Node | null = range.startContainer;
      while (lineEl && lineEl.parentElement !== container) {
        lineEl = lineEl.parentElement;
      }
      if (!lineEl || !(lineEl instanceof HTMLElement)) return;

      // 分割当前行：光标后的内容移到新行
      const cursorPos = saveCursorPosition(container);
      const lineIdx = Array.from(container.children).indexOf(lineEl);
      const fullText = lineEl.textContent || '';
      const splitAt = cursorPos?.offset ?? fullText.length;
      const beforeText = fullText.substring(0, splitAt);
      const afterText = fullText.substring(splitAt);

      // 更新当前行
      lineEl.innerHTML = escapeHtml(beforeText || ' ');

      // 创建新行 div
      const newLineEl = document.createElement('div');
      newLineEl.setAttribute('style', EDITOR_LINE_STYLE);
      newLineEl.innerHTML = escapeHtml(afterText || ' ');
      lineEl.after(newLineEl);

      // 光标移到新行开头
      restoreCursorPosition(container, { line: lineIdx + 1, offset: 0 });

      // 同步 meta + 触发高亮
      syncEditMeta();
      triggerHighlightDebounce();
    }
  }, [syncEditMeta, triggerHighlightDebounce]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // ========== 编辑模式：保存逻辑 ==========
  const doSave = useCallback(async (skipConflictCheck = false) => {
    if (!cwd) return;
    // 保存前从 DOM 提取最新内容（确保 ref 是最新的）
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
      toast('已保存', 'success');
      onSaved?.();
    } catch (error) {
      console.error('Error saving file:', error);
      toast('保存失败', 'error');
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
      // 将磁盘内容写入 ref 并重建 contentEditable DOM
      editContentRef.current = conflictState.diskContent;
      const lc = conflictState.diskContent.split('\n').length;
      editLineCountRef.current = lc;
      setEditLineCount(lc);
      const newDirty = conflictState.diskContent !== content;
      isDirtyRef.current = newDirty;
      setIsDirty(newDirty);
      // 重建编辑器内容
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
    // 返回可视区域首行（而非光标行），确保退出编辑模式后视图位置一致
    const scrollEl = editScrollRef.current;
    if (scrollEl) return Math.floor(scrollEl.scrollTop / 20) + 1;
    return visibleLineRef?.current ?? 1;
  }, [visibleLineRef]);

  const handleEditorClose = useCallback(async () => {
    if (isDirty) {
      const ok = await confirm('有未保存的修改，确定关闭？', { danger: true, confirmText: '放弃修改', cancelText: '继续编辑' });
      if (!ok) return;
    }
    onEditorClose?.(getCurrentLine());
  }, [isDirty, onEditorClose, getCurrentLine]);

  // Cmd+S 保存（编辑模式）
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

  // Vi Insert → Normal 的退出逻辑（提取光标位置 + 通知父组件）
  const viExitInsert = useCallback(() => {
    const currentContent = extractTextFromEditable();
    onContentMutate?.(currentContent);

    // 从 contentEditable 获取真实光标位置（行 + 列）
    const container = editableRef.current;
    const cursorPos = container ? saveCursorPosition(container) : null;
    const scrollLine = getCurrentLine(); // 仅用于滚动恢复

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

  // ESC / Ctrl+C: vi 模式下回到 Normal，非 vi 模式下关闭编辑器
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
            // 有未保存修改，弹确认对话框
            confirm('有未保存的修改，确定退出编辑模式？', { danger: true, confirmText: '放弃修改', cancelText: '继续编辑' })
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

  // ========== Blame 状态 ==========
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

  // ========== 行号列宽度 ==========
  const lineNumberWidth = `${lineNumChars + 2}ch`;

  return (
    <div ref={containerRef} className={`h-full flex flex-col outline-none ${className}`} tabIndex={0} onClick={viClickHandler} onDoubleClick={viDblClickHandler}>
      {/* 冲突提示条（编辑模式） */}
      {editable && conflictState.show && (
        <div className="px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 flex items-center gap-3 flex-shrink-0">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-sm text-foreground flex-1">文件已被外部修改，保存将覆盖外部更改</span>
          <div className="flex items-center gap-2">
            <button onClick={handleRevertToDisk} className="px-3 py-1 text-sm rounded border border-border hover:bg-accent transition-colors">
              使用磁盘版本
            </button>
            <button onClick={handleForceOverwrite} className="px-3 py-1 text-sm rounded bg-amber-500 text-white hover:bg-amber-600 transition-colors">
              强制覆盖
            </button>
          </div>
        </div>
      )}

      {/* Search Bar（非编辑模式） */}
      {!editable && showSearch && isSearchVisible && (
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

      {/* ========== 编辑模式：contentEditable ========== */}
      {editable ? (
        <div ref={editScrollRef} className="flex-1 overflow-auto bg-secondary">
          <div className="flex" style={{ minHeight: '100%' }}>
            {/* 行号列 */}
            <div
              className="flex-shrink-0 font-mono text-sm select-none"
              style={{ width: lineNumberWidth }}
            >
              {Array.from({ length: editLineCount }, (_, i) => (
                <div key={i} className="text-right text-muted-foreground/50 pr-3" style={{ height: 20, lineHeight: '20px' }}>
                  {i + 1}
                </div>
              ))}
            </div>

            {/* contentEditable 代码区 - 单层，光标/选区/文字天然对齐 */}
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
        /* ========== 只读模式：虚拟滚动 ========== */
        <div
          ref={parentRef}
          className={`flex-1 overflow-auto font-mono text-sm bg-secondary${cmdHeld ? ' cmd-held-container' : ''}`}
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

              // Inline blame annotation: 只有 mouseup 所在行显示
              // Inline blame annotation: 只有 mouseup 所在行显示
              // inlineBlameVersion 在此读取以订阅 ref 变化触发的 re-render
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

      {/* ========== Vi Mode 状态栏 ========== */}
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
                  // IME 输入中不拦截（中文候选词确认的 Enter）
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
          {/* Floating Toolbar — 独立 ToolbarRenderer 组件管理自身状态，
              CodeViewer 不会因 toolbar 显隐而重渲染 → 选区得以保留 */}
          {!editable && (
            <ToolbarRenderer
              floatingToolbarRef={floatingToolbarRef}
              bumpRef={bumpToolbarRef}
              container={menuContainer}
              onAddComment={handleToolbarAddComment}
              onSendToAI={handleToolbarSendToAI}
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
                <span className="ml-2 text-brand">点击查看详情</span>
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
