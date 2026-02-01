'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

// Types
interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  oldPath?: string;
}

interface GitStatusResponse {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  cwd: string;
}

interface GitDiffResponse {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
  file?: GitFileStatus;
  expanded?: boolean;
}

// Shiki highlighter singleton
let highlighterPromise: Promise<Highlighter> | null = null;

const SUPPORTED_LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx',
  'html', 'css', 'scss', 'json', 'yaml',
  'python', 'go', 'rust', 'java', 'ruby', 'php',
  'bash', 'shell', 'markdown', 'sql', 'c', 'cpp',
  'swift', 'kotlin', 'dart', 'lua', 'graphql', 'xml',
] as const;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...SUPPORTED_LANGS],
    });
  }
  return highlighterPromise;
}

function getLanguageFromPath(filePath: string): string {
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
  };
  const lang = map[ext || ''] || 'text';
  if (SUPPORTED_LANGS.includes(lang as typeof SUPPORTED_LANGS[number])) {
    return lang;
  }
  return 'text';
}

// Build directory tree from file list
function buildFileTree(files: GitFileStatus[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find(n => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: [],
          file: isLast ? file : undefined,
          expanded: true,
        };
        currentLevel.push(existing);
      }

      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort: directories first, then files
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => sortNodes(n.children));
  };

  sortNodes(root);
  return root;
}

// Compute line diff using LCS algorithm
interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];

  const m = oldLines.length;
  const n = newLines.length;

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

  while (diffStack.length > 0) {
    result.push(diffStack.pop()!);
  }

  return result;
}

// Hook for line highlighting
interface HighlightedLine {
  tokens: Array<{ content: string; style?: string }>;
}

function useLineHighlight(lines: string[], filePath: string): Map<number, HighlightedLine> {
  const [highlightedLines, setHighlightedLines] = useState<Map<number, HighlightedLine>>(new Map());
  const [isDark, setIsDark] = useState(false);

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

// Highlighted content component
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

// Split Diff View Component
// 迷你地图组件
function DiffMinimap({
  lines,
  containerRef,
  totalLines,
}: {
  lines: Array<{ type: 'unchanged' | 'removed' | 'added' }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  totalLines: number;
}) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewportInfo, setViewportInfo] = useState({ top: 0, height: 0 });

  // 更新视口指示器位置
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewport = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const minimapHeight = minimapRef.current?.clientHeight || 0;

      if (scrollHeight <= clientHeight) {
        // 内容没有超出容器，视口覆盖整个迷你地图
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
  }, [containerRef, totalLines]);

  // 点击跳转
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

  if (totalLines === 0) return null;

  return (
    <div
      ref={minimapRef}
      className="w-4 flex-shrink-0 bg-gray-100 dark:bg-gray-800 border-l border-gray-300 dark:border-gray-600 relative cursor-pointer"
      onClick={handleClick}
    >
      {/* 变更指示条 */}
      <div className="absolute inset-0 flex flex-col">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`flex-1 ${
              line.type === 'removed'
                ? 'bg-red-400 dark:bg-red-500'
                : line.type === 'added'
                ? 'bg-green-400 dark:bg-green-500'
                : ''
            }`}
            style={{ minHeight: '1px' }}
          />
        ))}
      </div>
      {/* 视口指示器 */}
      <div
        className="absolute left-0 right-0 bg-gray-400/30 dark:bg-gray-500/30 border-y border-gray-400 dark:border-gray-500"
        style={{
          top: `${viewportInfo.top}px`,
          height: `${Math.max(viewportInfo.height, 10)}px`,
        }}
      />
    </div>
  );
}

function DiffSplitView({ oldStr, newStr, filePath, isNew, isDeleted }: {
  oldStr: string;
  newStr: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}) {
  const diffLines = computeLineDiff(oldStr, newStr);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);

  // Sync scroll between left and right panels
  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;

    const sourceEl = source === 'left' ? leftRef.current : rightRef.current;
    const targetEl = source === 'left' ? rightRef.current : leftRef.current;

    if (sourceEl && targetEl) {
      targetEl.scrollTop = sourceEl.scrollTop;
      targetEl.scrollLeft = sourceEl.scrollLeft;
    }

    requestAnimationFrame(() => {
      isSyncingRef.current = false;
    });
  }, []);

  // Split into left and right columns
  const leftLines: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
  const rightLines: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

  let leftIdx = 0;
  let rightIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type === 'unchanged') {
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

  while (leftLines.length < rightLines.length) {
    leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }

  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // 根据文件状态调整左右比例：新增文件左25%右75%，删除文件左75%右25%，其他50%50%
  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  // 为迷你地图准备行类型数据（使用对齐后的行数）
  const minimapLines = leftLines.map((leftLine, idx) => {
    const rightLine = rightLines[idx];
    if (leftLine.type === 'removed') return { type: 'removed' as const };
    if (rightLine?.type === 'added') return { type: 'added' as const };
    return { type: 'unchanged' as const };
  });

  return (
    <div className="font-mono flex h-full" style={{ fontSize: '0.8125rem' }}>
      {/* Left - Old */}
      <div
        ref={leftRef}
        onScroll={() => handleScroll('left')}
        className={`${leftWidth} min-w-0 overflow-auto border-r border-gray-300 dark:border-gray-600`}
      >
        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center text-xs font-medium border-b border-gray-300 dark:border-gray-600 sticky top-0 z-10">
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        {leftLines.map((line, idx) => (
          <div
            key={idx}
            className={`flex ${line.type === 'removed' ? 'bg-red-100 dark:bg-red-900/30' : ''}`}
          >
            <span className="w-10 flex-shrink-0 text-right pr-2 text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
              {line.lineNum || ''}
            </span>
            <HighlightedContent
              content={line.content}
              highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
              className="flex-1 whitespace-pre pl-2"
            />
          </div>
        ))}
      </div>
      {/* Right - New */}
      <div
        ref={(el) => {
          (rightRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        onScroll={() => handleScroll('right')}
        className={`${rightWidth} min-w-0 overflow-auto`}
      >
        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center text-xs font-medium border-b border-gray-300 dark:border-gray-600 sticky top-0 z-10">
          {isDeleted ? '(Deleted)' : isNew ? 'New' : 'New'}
        </div>
        {rightLines.map((line, idx) => (
          <div
            key={idx}
            className={`flex ${line.type === 'added' ? 'bg-green-100 dark:bg-green-900/30' : ''}`}
          >
            <span className="w-10 flex-shrink-0 text-right pr-2 text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
              {line.lineNum || ''}
            </span>
            <HighlightedContent
              content={line.content}
              highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
              className="flex-1 whitespace-pre pl-2"
            />
          </div>
        ))}
      </div>
      {/* Minimap */}
      <DiffMinimap
        lines={minimapLines}
        containerRef={rightRef}
        totalLines={leftLines.length}
      />
    </div>
  );
}

// File Tree Item Component
function FileTreeItem({
  node,
  level,
  selectedPath,
  onSelect,
  onStage,
  onUnstage,
  type,
  onToggle,
}: {
  node: TreeNode;
  level: number;
  selectedPath: string | null;
  onSelect: (file: GitFileStatus, type: 'staged' | 'unstaged') => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  type: 'staged' | 'unstaged';
  onToggle: (path: string) => void;
}) {
  const isSelected = selectedPath === node.path;

  const getStatusIcon = (status: GitFileStatus['status']) => {
    switch (status) {
      case 'added':
      case 'untracked':
        return <span className="text-green-500 text-xs font-bold">A</span>;
      case 'modified':
        return <span className="text-yellow-500 text-xs font-bold">M</span>;
      case 'deleted':
        return <span className="text-red-500 text-xs font-bold">D</span>;
      case 'renamed':
        return <span className="text-blue-500 text-xs font-bold">R</span>;
      default:
        return null;
    }
  };

  if (node.isDirectory) {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-0.5 px-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => onToggle(node.path)}
        >
          <span className="text-gray-400 text-xs">
            {node.expanded ? '▼' : '▶'}
          </span>
          <span className="text-yellow-500">📁</span>
          <span className="text-sm text-gray-700 dark:text-gray-300">{node.name}</span>
        </div>
        {node.expanded && node.children.map(child => (
          <FileTreeItem
            key={child.path}
            node={child}
            level={level + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            type={type}
            onToggle={onToggle}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 py-0.5 px-2 cursor-pointer group ${
        isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : 'hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onClick={() => node.file && onSelect(node.file, type)}
    >
      <span className="text-gray-400">📄</span>
      <span className={`text-sm flex-1 truncate ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>
        {node.name}
      </span>
      {node.file && getStatusIcon(node.file.status)}
      {/* Stage/Unstage button */}
      {type === 'unstaged' && onStage && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStage(node.path);
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 hover:bg-green-100 dark:hover:bg-green-900/30 rounded transition-all"
          title="暂存文件"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      )}
      {type === 'staged' && onUnstage && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUnstage(node.path);
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-900/30 rounded transition-all"
          title="取消暂存"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
      )}
    </div>
  );
}

// Main Modal Component
interface GitStatusModalProps {
  cwd?: string;
  onClose: () => void;
}

export function GitStatusModal({ cwd, onClose }: GitStatusModalProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ file: GitFileStatus; type: 'staged' | 'unstaged' } | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [stagedTree, setStagedTree] = useState<TreeNode[]>([]);
  const [unstagedTree, setUnstagedTree] = useState<TreeNode[]>([]);

  // Fetch git status
  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = cwd ? `/api/git/status?cwd=${encodeURIComponent(cwd)}` : '/api/git/status';
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch git status');
      }
      const data: GitStatusResponse = await response.json();
      setStatus(data);

      // Build trees
      const staged = buildFileTree(data.staged);
      const unstaged = buildFileTree(data.unstaged);
      setStagedTree(staged);
      setUnstagedTree(unstaged);

      // Initialize expanded paths
      const allPaths = new Set<string>();
      const collectPaths = (nodes: TreeNode[]) => {
        nodes.forEach(n => {
          if (n.isDirectory) {
            allPaths.add(n.path);
            collectPaths(n.children);
          }
        });
      };
      collectPaths(staged);
      collectPaths(unstaged);
      setExpandedPaths(allPaths);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Fetch diff when file is selected
  useEffect(() => {
    if (!selectedFile) {
      setDiff(null);
      return;
    }

    const fetchDiff = async () => {
      setDiffLoading(true);
      try {
        const params = new URLSearchParams({
          file: selectedFile.file.path,
          type: selectedFile.type,
        });
        if (cwd) params.set('cwd', cwd);

        const response = await fetch(`/api/git/diff?${params}`);
        if (!response.ok) {
          throw new Error('Failed to fetch diff');
        }
        const data: GitDiffResponse = await response.json();
        setDiff(data);
      } catch (err) {
        console.error('Error fetching diff:', err);
      } finally {
        setDiffLoading(false);
      }
    };

    fetchDiff();
  }, [selectedFile, cwd]);

  // Toggle directory expand/collapse
  const handleToggle = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Update tree with expanded state - use useMemo to avoid recalculation on every render
  const updateTreeExpanded = useCallback((nodes: TreeNode[], paths: Set<string>): TreeNode[] => {
    return nodes.map(n => ({
      ...n,
      expanded: paths.has(n.path),
      children: updateTreeExpanded(n.children, paths),
    }));
  }, []);

  // Memoize the display trees to prevent unnecessary re-renders
  const displayStagedTree = useMemo(
    () => updateTreeExpanded(stagedTree, expandedPaths),
    [stagedTree, expandedPaths, updateTreeExpanded]
  );

  const displayUnstagedTree = useMemo(
    () => updateTreeExpanded(unstagedTree, expandedPaths),
    [unstagedTree, expandedPaths, updateTreeExpanded]
  );

  // Stage file
  const handleStage = useCallback(async (path: string) => {
    try {
      const response = await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: [path] }),
      });
      if (!response.ok) {
        throw new Error('Failed to stage file');
      }
      await fetchStatus();
    } catch (err) {
      console.error('Error staging file:', err);
    }
  }, [cwd, fetchStatus]);

  // Unstage file
  const handleUnstage = useCallback(async (path: string) => {
    try {
      const response = await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: [path] }),
      });
      if (!response.ok) {
        throw new Error('Failed to unstage file');
      }
      await fetchStatus();
    } catch (err) {
      console.error('Error unstaging file:', err);
    }
  }, [cwd, fetchStatus]);

  // Stage all files
  const handleStageAll = useCallback(async () => {
    if (!status?.unstaged.length) return;
    try {
      const response = await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: status.unstaged.map(f => f.path) }),
      });
      if (!response.ok) {
        throw new Error('Failed to stage all files');
      }
      await fetchStatus();
    } catch (err) {
      console.error('Error staging all files:', err);
    }
  }, [cwd, status, fetchStatus]);

  // Unstage all files
  const handleUnstageAll = useCallback(async () => {
    if (!status?.staged.length) return;
    try {
      const response = await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: status.staged.map(f => f.path) }),
      });
      if (!response.ok) {
        throw new Error('Failed to unstage all files');
      }
      await fetchStatus();
    } catch (err) {
      console.error('Error unstaging all files:', err);
    }
  }, [cwd, status, fetchStatus]);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 shadow-xl w-screen h-screen flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <span>📊</span>
            Git 变更
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchStatus}
              className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
              title="刷新"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel - File Tree */}
          <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : error ? (
              <div className="flex-1 flex items-center justify-center p-4">
                <span className="text-red-500 text-sm">{error}</span>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                {/* Staged Section */}
                <div className="border-b border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-900">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      暂存区 ({status?.staged.length || 0})
                    </span>
                    {(status?.staged.length || 0) > 0 && (
                      <button
                        onClick={handleUnstageAll}
                        className="text-xs text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300 hover:underline"
                      >
                        全部取消
                      </button>
                    )}
                  </div>
                  {displayStagedTree.length > 0 ? (
                    <div className="py-1">
                      {displayStagedTree.map(node => (
                        <FileTreeItem
                          key={node.path}
                          node={node}
                          level={0}
                          selectedPath={selectedFile?.type === 'staged' ? selectedFile.file.path : null}
                          onSelect={(file, type) => setSelectedFile({ file, type })}
                          onUnstage={handleUnstage}
                          type="staged"
                          onToggle={handleToggle}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
                      无暂存的文件
                    </div>
                  )}
                </div>

                {/* Unstaged Section */}
                <div>
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-900">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      工作区 ({status?.unstaged.length || 0})
                    </span>
                    {(status?.unstaged.length || 0) > 0 && (
                      <button
                        onClick={handleStageAll}
                        className="text-xs text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 hover:underline"
                      >
                        全部暂存
                      </button>
                    )}
                  </div>
                  {displayUnstagedTree.length > 0 ? (
                    <div className="py-1">
                      {displayUnstagedTree.map(node => (
                        <FileTreeItem
                          key={node.path}
                          node={node}
                          level={0}
                          selectedPath={selectedFile?.type === 'unstaged' ? selectedFile.file.path : null}
                          onSelect={(file, type) => setSelectedFile({ file, type })}
                          onStage={handleStage}
                          type="unstaged"
                          onToggle={handleToggle}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
                      无未暂存的变更
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right Panel - Diff View */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!selectedFile ? (
              <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
                <span>选择文件查看差异</span>
              </div>
            ) : diffLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : diff ? (
              <div className="flex-1 overflow-hidden">
                {/* File path header */}
                <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                    {selectedFile.file.path}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    selectedFile.type === 'staged'
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                      : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
                  }`}>
                    {selectedFile.type === 'staged' ? '已暂存' : '未暂存'}
                  </span>
                </div>
                <div className="flex-1 overflow-auto" style={{ height: 'calc(100% - 40px)' }}>
                  <DiffSplitView
                    oldStr={diff.oldContent}
                    newStr={diff.newContent}
                    filePath={diff.filePath}
                    isNew={diff.isNew}
                    isDeleted={diff.isDeleted}
                  />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
                <span>加载差异失败</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
