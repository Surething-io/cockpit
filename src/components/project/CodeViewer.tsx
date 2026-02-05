'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { useComments, type CodeComment } from '@/hooks/useComments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { useMenuContainer } from './FileContextMenu';
import { useChatContextOptional } from './ChatContext';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';

// ============================================
// Types
// ============================================

interface CodeViewerProps {
  content: string;
  filePath: string;
  showLineNumbers?: boolean;
  showSearch?: boolean;
  className?: string;
  // 评论功能需要 cwd
  cwd?: string;
  enableComments?: boolean;
  // 跳转到指定行号
  scrollToLine?: number | null;
  // 行号跳转完成后的回调
  onScrollToLineComplete?: () => void;
  // 高亮关键词（从外部搜索传入）
  highlightKeyword?: string | null;
}

interface SearchMatch {
  lineIndex: number;
  startCol: number;
  endCol: number;
}

// ============================================
// Shiki Highlighter Singleton
// ============================================

let highlighterPromise: Promise<Highlighter> | null = null;

const SUPPORTED_LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx',
  'html', 'css', 'scss', 'json', 'yaml',
  'python', 'go', 'rust', 'java', 'ruby', 'php',
  'bash', 'shell', 'markdown', 'sql', 'c', 'cpp',
  'swift', 'kotlin', 'dart', 'lua', 'graphql', 'xml',
] as const;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...SUPPORTED_LANGS],
    });
  }
  return highlighterPromise;
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    mjs: 'javascript', cjs: 'javascript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', rb: 'ruby', php: 'php',
    cs: 'cpp', cpp: 'cpp', c: 'c', h: 'c',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown', mdx: 'markdown', sql: 'sql',
    swift: 'swift', dart: 'dart', lua: 'lua',
    graphql: 'graphql', gql: 'graphql',
    dockerfile: 'bash',
    toml: 'yaml', sass: 'scss', less: 'css',
    scala: 'java', r: 'python', vim: 'bash',
    env: 'bash',
  };
  const lang = map[ext || ''] || 'text';
  if (SUPPORTED_LANGS.includes(lang as typeof SUPPORTED_LANGS[number])) {
    return lang;
  }
  return 'text';
}

// ============================================
// Helper Functions
// ============================================

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function findMatches(
  lines: string[],
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean
): SearchMatch[] {
  if (!query) return [];

  const matches: SearchMatch[] = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLowerCase();
    let startIndex = 0;

    while (true) {
      const foundIndex = line.indexOf(searchQuery, startIndex);
      if (foundIndex === -1) break;

      const endIndex = foundIndex + searchQuery.length;

      if (wholeWord) {
        const beforeChar = foundIndex > 0 ? line[foundIndex - 1] : ' ';
        const afterChar = endIndex < line.length ? line[endIndex] : ' ';
        const isWordBoundaryBefore = !/\w/.test(beforeChar);
        const isWordBoundaryAfter = !/\w/.test(afterChar);

        if (isWordBoundaryBefore && isWordBoundaryAfter) {
          matches.push({ lineIndex, startCol: foundIndex, endCol: endIndex });
        }
      } else {
        matches.push({ lineIndex, startCol: foundIndex, endCol: endIndex });
      }

      startIndex = foundIndex + 1;
    }
  }

  return matches;
}

// ============================================
// Floating Toolbar (portal version with container-relative positioning)
// ============================================

interface FloatingToolbarProps {
  x: number;
  y: number;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  isChatLoading?: boolean;
}

function FloatingToolbar({ x, y, container, onAddComment, onSendToAI, isChatLoading }: FloatingToolbarProps) {
  const containerRect = container.getBoundingClientRect();
  const relX = x - containerRect.left;
  const relY = y - containerRect.top;

  return (
    <div
      className="absolute z-[200] flex items-center gap-1 bg-card border border-border rounded-lg shadow-lg p-1"
      style={{ left: relX, top: relY }}
    >
      <button
        className="px-2 py-1 text-xs bg-amber-9/20 text-amber-11 rounded hover:bg-amber-9/30 transition-colors"
        onClick={onAddComment}
      >
        添加评论
      </button>
      <button
        className="px-2 py-1 text-xs bg-brand/20 text-brand rounded hover:bg-brand/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onSendToAI}
        disabled={isChatLoading}
        title={isChatLoading ? '正在生成中，请稍候' : '发送到 AI'}
      >
        发送 AI
      </button>
    </div>
  );
}

// ============================================
// View Comment Card (for viewing existing comments)
// ============================================

interface ViewCommentCardProps {
  x: number;
  y: number;
  comment: CodeComment;
  container?: HTMLElement | null;
  onClose: () => void;
  onUpdateComment: (id: string, content: string) => Promise<boolean>;
  onDeleteComment: (id: string) => Promise<boolean>;
}

function ViewCommentCard({
  x,
  y,
  comment,
  container,
  onClose,
  onUpdateComment,
  onDeleteComment,
}: ViewCommentCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Position adjustment relative to container
  useEffect(() => {
    if (cardRef.current && container) {
      const containerRect = container.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      // Calculate position relative to container
      let relX = x - containerRect.left;
      let relY = y - containerRect.top;
      // Avoid overflow
      if (relX + cardRect.width > containerRect.width - 16) relX = containerRect.width - cardRect.width - 16;
      if (relX < 16) relX = 16;
      if (relY + cardRect.height > containerRect.height - 16) relY = relY - cardRect.height - 8;
      if (relY < 16) relY = 16;
      setPosition({ x: relX, y: relY });
    }
  }, [x, y, container]);

  // Click outside to close
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
      className="absolute z-[200] w-96 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
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
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSave();
                }
                if (e.key === 'Escape') {
                  setIsEditing(false);
                  setEditContent(comment.content);
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setIsEditing(false); setEditContent(comment.content); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                className="px-2 py-1 text-xs bg-brand text-white rounded hover:bg-brand/90"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-foreground whitespace-pre-wrap">{comment.content}</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                行 {comment.startLine}-{comment.endLine}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setIsEditing(true)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground"
                  title="编辑"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={handleDelete}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-red-9"
                  title="删除"
                >
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

// ============================================
// Memoized Code Line Component - 避免 floatingToolbar 状态变化触发重渲染
// ============================================

interface CodeLineProps {
  virtualKey: React.Key;
  lineNum: number;
  highlightedHtml: string;
  hasComments: boolean;
  firstComment?: CodeComment;
  lineCommentsCount?: number;
  isInRange: boolean;
  showLineNumbers: boolean;
  lineNumberWidth: number;
  commentsEnabled: boolean;
  virtualItemSize: number;
  virtualItemStart: number;
  onCommentBubbleClick: (comment: CodeComment, e: React.MouseEvent) => void;
}

const CodeLine = memo(function CodeLine({
  virtualKey,
  lineNum,
  highlightedHtml,
  hasComments,
  firstComment,
  lineCommentsCount,
  isInRange,
  showLineNumbers,
  lineNumberWidth,
  commentsEnabled,
  virtualItemSize,
  virtualItemStart,
  onCommentBubbleClick,
}: CodeLineProps) {
  return (
    <div
      key={virtualKey}
      data-line={lineNum}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: `${virtualItemSize}px`,
        transform: `translateY(${virtualItemStart}px)`,
      }}
      className={`flex ${isInRange ? 'bg-blue-9/20' : hasComments ? 'bg-amber-9/10' : 'hover:bg-accent/50'}`}
    >
      {showLineNumbers && (
        <span
          className={`flex-shrink-0 flex items-center justify-end gap-0.5 pr-1 select-none border-r border-border ${
            isInRange ? 'bg-blue-9/30 text-blue-11' : 'bg-card/50 text-slate-9'
          }`}
          style={{ width: lineNumberWidth }}
        >
          {commentsEnabled && hasComments && firstComment && (
            <button
              onClick={(e) => onCommentBubbleClick(firstComment, e)}
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-accent text-amber-9"
              title={`${lineCommentsCount} 条评论`}
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {commentsEnabled && !hasComments && <span className="w-4" />}
          <span className="w-6 text-right">{lineNum}</span>
        </span>
      )}
      <span
        className="flex-1 px-3 whitespace-pre overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    </div>
  );
});

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
  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  // Floating toolbar - 使用 ref 存储数据，避免触发 CodeViewer 重渲染
  // toolbarVersion 仅用于触发 FloatingToolbarWrapper 组件更新
  const floatingToolbarRef = useRef<{
    x: number;
    y: number;
    range: { start: number; end: number };
    selectedText: string;
  } | null>(null);
  const [toolbarVersion, setToolbarVersion] = useState(0);

  const [addCommentInput, setAddCommentInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  // Send to AI input state
  const [sendToAIInput, setSendToAIInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  // Comments hook
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const lines = useMemo(() => content.split('\n'), [content]);

  // Group comments by their end line (for inline display)
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

  // Calculate row count including comment rows
  const rowData = useMemo(() => {
    const rows: Array<{ type: 'code'; lineIndex: number } | { type: 'comment'; lineNum: number; comments: CodeComment[] } | { type: 'add-comment'; startLine: number; endLine: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      rows.push({ type: 'code', lineIndex: i });
    }
    return rows;
  }, [lines.length]);

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: rowData.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 10,
  });

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
      // Find the row index for this line
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
    // 当 rowData 准备好且有目标行号时执行跳转
    if (scrollToLineRef.current !== null && scrollToLineRef.current > 0 && rowData.length > 0) {
      const targetLine = scrollToLineRef.current;
      // 行号从 1 开始，lineIndex 从 0 开始
      const targetLineIndex = targetLine - 1;
      const rowIndex = rowData.findIndex(r => r.type === 'code' && r.lineIndex === targetLineIndex);
      if (rowIndex >= 0) {
        // 延迟一点确保 virtualizer 已准备好
        setTimeout(() => {
          virtualizer.scrollToIndex(rowIndex, { align: 'center' });
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

  // Comment bubble click - view existing comment
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
  // Use document-level mouseup to catch selections even when mouse is released outside code area
  useEffect(() => {
    if (!commentsEnabled) return;

    const handleMouseUp = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        // 使用 ref，不触发 CodeViewer 重渲染
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          setToolbarVersion(v => v + 1);
        }
        return;
      }

      // 立即保存选中的文本内容（避免虚拟滚动重渲染后 selection 失效）
      const selectedText = selection.toString();
      if (!selectedText.trim()) {
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          setToolbarVersion(v => v + 1);
        }
        return;
      }

      // Get line range from selection
      const range = selection.getRangeAt(0);
      const container = parentRef.current;
      if (!container) return;

      // Check if selection is within our code area
      if (!container.contains(range.commonAncestorContainer)) {
        return;
      }

      // Find line numbers from DOM - 检查节点是否仍在 document 中
      const startNode = range.startContainer;
      const endNode = range.endContainer;

      const getLineFromNode = (node: Node): number | null => {
        // 检查节点是否仍在 document 中（虚拟滚动可能导致节点脱离）
        if (!document.contains(node)) return null;

        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
        if (!el) return null;

        // 直接使用 closest 查找，不需要循环
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

        // 直接更新 ref，不触发 CodeViewer 重渲染
        // 使用 requestAnimationFrame 确保在下一帧渲染 toolbar，此时选区已稳定
        requestAnimationFrame(() => {
          floatingToolbarRef.current = {
            x: e.clientX,
            y: e.clientY,
            range: { start: minLine, end: maxLine },
            selectedText,
          };
          // 只更新 toolbarVersion 触发 FloatingToolbar 显示
          // 这不会触发 virtualizer 重新计算
          setToolbarVersion(v => v + 1);
        });
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [commentsEnabled]);

  // Click "add comment" in toolbar - show input
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
    // 不清除文本选择，保留高亮显示选中的行
  }, []);

  // Click "send to AI" in toolbar - show input
  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    // 使用保存的选中文本（避免虚拟滚动导致的选区丢失问题）
    const codeContent = toolbar.selectedText;

    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent,
    });
    floatingToolbarRef.current = null;
    setToolbarVersion(v => v + 1);
    // 不清除文本选择，保留高亮显示选中的行
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
      // 1. 获取所有历史评论（带代码）
      const allComments = await fetchAllCommentsWithCode(cwd);

      // 2. 构建代码引用列表
      const references: CodeReference[] = [];

      // 添加历史评论作为引用
      for (const comment of allComments) {
        references.push({
          filePath: comment.filePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          codeContent: comment.codeContent,
          note: comment.content || undefined, // 如果有评论内容则添加备注
        });
      }

      // 添加当前选中的代码作为最后一个引用
      references.push({
        filePath,
        startLine: sendToAIInput.range.start,
        endLine: sendToAIInput.range.end,
        codeContent: sendToAIInput.codeContent,
      });

      // 3. 构建并发送消息
      const message = buildAIMessage(references, question);
      chatContext.sendMessage(message);

      // 4. 清空所有评论
      await clearAllComments(cwd);

      // 5. 刷新本地评论状态
      refreshComments();

      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, chatContext, filePath, cwd, refreshComments]);

  const lineNumberWidth = showLineNumbers ? Math.max(3, String(lines.length).length) * 10 + 24 : 0;

  // Highlight match in line (supports both internal search and external keyword)
  const getHighlightedLineHtml = useCallback((lineIndex: number, html: string): string => {
    let result = html;
    const line = lines[lineIndex];

    // 1. 内部搜索高亮
    if (searchQuery && matches.length > 0) {
      const lineMatches = matches.filter(m => m.lineIndex === lineIndex);
      for (const match of lineMatches.reverse()) {
        const isCurrentMatch = matches[currentMatchIndex]?.lineIndex === lineIndex &&
          matches[currentMatchIndex]?.startCol === match.startCol;

        const matchText = line.substring(match.startCol, match.endCol);
        const escapedMatch = escapeHtml(matchText);
        const highlightClass = isCurrentMatch ? 'bg-amber-9/50' : 'bg-amber-9/30';

        const regex = new RegExp(escapedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        result = result.replace(regex, `<span class="${highlightClass}">${escapedMatch}</span>`);
      }
    }

    // 2. 外部关键词高亮（来自搜索 tab）
    if (highlightKeyword && !searchQuery) {
      const escapedKeyword = escapeHtml(highlightKeyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedKeyword})`, 'gi');
      result = result.replace(regex, '<span class="bg-amber-9/40 rounded px-0.5">$1</span>');
    }

    return result;
  }, [searchQuery, matches, currentMatchIndex, lines, highlightKeyword]);

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
            const highlightedHtml = getHighlightedLineHtml(lineIndex, html);

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
          {/* Floating Toolbar - 使用 ref 获取数据，toolbarVersion 仅用于触发更新 */}
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
