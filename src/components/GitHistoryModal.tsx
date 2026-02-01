'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

// Types
interface Branch {
  current: string;
  local: string[];
  remote: string[];
}

interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  relativeDate: string;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
  file?: FileChange;
  expanded?: boolean;
}

interface FileDiff {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
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
    rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash',
    md: 'markdown', sql: 'sql', c: 'c', cpp: 'cpp', h: 'c',
    swift: 'swift', kt: 'kotlin', dart: 'dart', lua: 'lua',
  };
  const lang = map[ext || ''] || 'text';
  if (SUPPORTED_LANGS.includes(lang as typeof SUPPORTED_LANGS[number])) {
    return lang;
  }
  return 'text';
}

// Diff computation
interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  content: string;
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
      diffStack.push({ type: 'unchanged', content: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffStack.push({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      diffStack.push({ type: 'removed', content: oldLines[i - 1] });
      i--;
    }
  }

  while (diffStack.length > 0) {
    result.push(diffStack.pop()!);
  }

  return result;
}

// Line highlight hook
interface HighlightedLine {
  tokens: Array<{ content: string; style?: string }>;
}

function useLineHighlight(lines: string[], filePath: string): Map<number, HighlightedLine> {
  const [highlightedLines, setHighlightedLines] = useState<Map<number, HighlightedLine>>(new Map());
  const [isDark, setIsDark] = useState(false);
  const prevLinesKeyRef = useRef<string>('');

  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const linesKey = lines.join('\n');

  useEffect(() => {
    if (lines.length === 0) return;

    const currentKey = `${linesKey}:${filePath}:${isDark}`;
    if (currentKey === prevLinesKeyRef.current) return;
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
  }, [linesKey, filePath, isDark, lines]);

  return highlightedLines;
}

// Highlighted content component
function HighlightedContent({ content, highlightedLine, className }: {
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

// Minimap component
function DiffMinimap({ lines, containerRef, totalLines }: {
  lines: Array<{ type: 'unchanged' | 'removed' | 'added' }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  totalLines: number;
}) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewportInfo, setViewportInfo] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewport = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const minimapHeight = minimapRef.current?.clientHeight || 0;

      if (scrollHeight <= clientHeight) {
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
      <div className="absolute inset-0 flex flex-col">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`flex-1 ${
              line.type === 'removed' ? 'bg-red-400 dark:bg-red-500' :
              line.type === 'added' ? 'bg-green-400 dark:bg-green-500' : ''
            }`}
            style={{ minHeight: '1px' }}
          />
        ))}
      </div>
      <div
        className="absolute left-0 right-0 bg-gray-400/30 dark:bg-gray-500/30 border-y border-gray-400 dark:border-gray-500"
        style={{ top: `${viewportInfo.top}px`, height: `${Math.max(viewportInfo.height, 10)}px` }}
      />
    </div>
  );
}

// Diff Split View component
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
  const isSyncingRef = useRef(false);

  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    const sourceEl = source === 'left' ? leftRef.current : rightRef.current;
    const targetEl = source === 'left' ? rightRef.current : leftRef.current;
    if (sourceEl && targetEl) {
      targetEl.scrollTop = sourceEl.scrollTop;
      targetEl.scrollLeft = sourceEl.scrollLeft;
    }
    requestAnimationFrame(() => { isSyncingRef.current = false; });
  }, []);

  const leftLines: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
  const rightLines: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

  let leftIdx = 0, rightIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type === 'unchanged') {
      while (leftLines.length < rightLines.length) leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      while (rightLines.length < leftLines.length) rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      leftIdx++; rightIdx++;
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

  while (leftLines.length < rightLines.length) leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  while (rightLines.length < leftLines.length) rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });

  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  const minimapLines = leftLines.map((leftLine, idx) => {
    const rightLine = rightLines[idx];
    if (leftLine.type === 'removed') return { type: 'removed' as const };
    if (rightLine?.type === 'added') return { type: 'added' as const };
    return { type: 'unchanged' as const };
  });

  return (
    <div className="font-mono flex h-full" style={{ fontSize: '0.8125rem' }}>
      <div
        ref={leftRef}
        onScroll={() => handleScroll('left')}
        className={`${leftWidth} min-w-0 overflow-auto border-r border-gray-300 dark:border-gray-600`}
      >
        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center text-xs font-medium border-b border-gray-300 dark:border-gray-600 sticky top-0 z-10">
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        {leftLines.map((line, idx) => (
          <div key={idx} className={`flex ${line.type === 'removed' ? 'bg-red-100 dark:bg-red-900/30' : ''}`}>
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
      <div
        ref={rightRef}
        onScroll={() => handleScroll('right')}
        className={`${rightWidth} min-w-0 overflow-auto`}
      >
        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center text-xs font-medium border-b border-gray-300 dark:border-gray-600 sticky top-0 z-10">
          {isDeleted ? '(Deleted)' : 'New'}
        </div>
        {rightLines.map((line, idx) => (
          <div key={idx} className={`flex ${line.type === 'added' ? 'bg-green-100 dark:bg-green-900/30' : ''}`}>
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
      <DiffMinimap lines={minimapLines} containerRef={rightRef} totalLines={leftLines.length} />
    </div>
  );
}

// File status icon
function FileStatusIcon({ status }: { status: FileChange['status'] }) {
  const colors = {
    added: 'text-green-600 dark:text-green-400',
    modified: 'text-yellow-600 dark:text-yellow-400',
    deleted: 'text-red-600 dark:text-red-400',
    renamed: 'text-blue-600 dark:text-blue-400',
  };
  const labels = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
  return (
    <span className={`font-mono text-xs font-bold ${colors[status]}`}>
      {labels[status]}
    </span>
  );
}

// Branch selector component with search
function BranchSelector({
  branches,
  selectedBranch,
  onSelect,
  isLoading,
}: {
  branches: Branch | null;
  selectedBranch: string;
  onSelect: (branch: string) => void;
  isLoading: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const filteredLocal = branches?.local.filter(b =>
    b.toLowerCase().includes(search.toLowerCase())
  ) || [];
  const filteredRemote = branches?.remote.filter(b =>
    b.toLowerCase().includes(search.toLowerCase())
  ) || [];

  const handleSelect = (branch: string) => {
    onSelect(branch);
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-left flex items-center justify-between hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
      >
        <span className="truncate flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {selectedBranch || 'Select branch...'}
          {branches?.current === selectedBranch && (
            <span className="text-xs text-green-600 dark:text-green-400">(current)</span>
          )}
        </span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg max-h-80 flex flex-col">
          {/* Search input */}
          <div className="p-2 border-b border-gray-200 dark:border-gray-700">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search branches..."
              className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
          </div>

          {/* Branch list */}
          <div className="overflow-y-auto flex-1">
            {filteredLocal.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 sticky top-0">
                  Local
                </div>
                {filteredLocal.map(branch => (
                  <div
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2 ${
                      branch === selectedBranch
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <span className="truncate flex-1">{branch}</span>
                    {branch === branches?.current && (
                      <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">current</span>
                    )}
                    {branch === selectedBranch && (
                      <svg className="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}

            {filteredRemote.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 sticky top-0">
                  Remote
                </div>
                {filteredRemote.map(branch => (
                  <div
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2 ${
                      branch === selectedBranch
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <span className="truncate flex-1">{branch}</span>
                    {branch === selectedBranch && (
                      <svg className="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}

            {filteredLocal.length === 0 && filteredRemote.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400 text-center">
                No branches found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Build directory tree from file list
function buildFileTree(files: FileChange[]): TreeNode[] {
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

// File tree item component
function FileTreeItem({
  node,
  level,
  selectedPath,
  onSelect,
  expandedPaths,
  onToggle,
}: {
  node: TreeNode;
  level: number;
  selectedPath: string | null;
  onSelect: (file: FileChange) => void;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isSelected = selectedPath === node.path;
  const isExpanded = expandedPaths.has(node.path);

  if (node.isDirectory) {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-0.5 px-2 pr-3 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer whitespace-nowrap"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => onToggle(node.path)}
        >
          <span className="text-gray-400 text-xs">
            {isExpanded ? '▼' : '▶'}
          </span>
          <span className="text-yellow-500">📁</span>
          <span className="text-sm text-gray-700 dark:text-gray-300">{node.name}</span>
        </div>
        {isExpanded && node.children.map(child => (
          <FileTreeItem
            key={child.path}
            node={child}
            level={level + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 py-0.5 px-2 pr-3 cursor-pointer whitespace-nowrap ${
        isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : 'hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onClick={() => node.file && onSelect(node.file)}
    >
      <span className="text-gray-400">📄</span>
      <span className={`text-sm ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>
        {node.name}
      </span>
      {node.file && <FileStatusIcon status={node.file.status} />}
      {node.file && (
        <>
          <span className="text-xs text-green-600 dark:text-green-400">+{node.file.additions}</span>
          <span className="text-xs text-red-600 dark:text-red-400">-{node.file.deletions}</span>
        </>
      )}
    </div>
  );
}

// Main component
interface GitHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
}

export function GitHistoryModal({ isOpen, onClose, cwd }: GitHistoryModalProps) {
  const [branches, setBranches] = useState<Branch | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileChange | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Load branches
  useEffect(() => {
    if (!isOpen) return;
    setIsLoadingBranches(true);
    setError(null);
    fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setError(data.error === 'Failed to get branches' ? '当前目录不是 Git 仓库' : data.error);
          setBranches(null);
        } else if (data.local && data.current) {
          setBranches(data);
          setSelectedBranch(data.current);
        } else {
          setError('无法获取分支信息');
          setBranches(null);
        }
      })
      .catch(err => {
        console.error(err);
        setError('获取分支信息失败');
        setBranches(null);
      })
      .finally(() => setIsLoadingBranches(false));
  }, [isOpen, cwd]);

  // Load commits when branch changes
  useEffect(() => {
    if (!selectedBranch) return;
    setIsLoadingCommits(true);
    setSelectedCommit(null);
    setFiles([]);
    setSelectedFile(null);
    setFileDiff(null);
    fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(selectedBranch)}&limit=50`)
      .then(res => res.json())
      .then(data => setCommits(data.commits || []))
      .catch(console.error)
      .finally(() => setIsLoadingCommits(false));
  }, [selectedBranch, cwd]);

  // Load files when commit selected
  const handleSelectCommit = useCallback((commit: Commit) => {
    setSelectedCommit(commit);
    setSelectedFile(null);
    setFileDiff(null);
    setIsLoadingFiles(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}`)
      .then(res => res.json())
      .then(data => {
        const fileList = data.files || [];
        setFiles(fileList);
        // Build file tree
        const tree = buildFileTree(fileList);
        setFileTree(tree);
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
        collectPaths(tree);
        setExpandedPaths(allPaths);
      })
      .catch(console.error)
      .finally(() => setIsLoadingFiles(false));
  }, [cwd]);

  // Load diff when file selected
  const handleSelectFile = useCallback((file: FileChange) => {
    if (!selectedCommit) return;
    setSelectedFile(file);
    setIsLoadingDiff(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${selectedCommit.hash}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingDiff(false));
  }, [cwd, selectedCommit]);

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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 w-full h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Git History</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Error state */}
          {error && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <svg className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-gray-500 dark:text-gray-400">{error}</p>
              </div>
            </div>
          )}

          {/* Left panel - Branch selector + Commit list */}
          {!error && (
          <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
            {/* Branch selector */}
            <div className="p-3 border-b border-gray-200 dark:border-gray-700">
              <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">查看分支</label>
              <BranchSelector
                branches={branches}
                selectedBranch={selectedBranch}
                onSelect={setSelectedBranch}
                isLoading={isLoadingBranches}
              />
            </div>

            {/* Commit list */}
            <div className="flex-1 overflow-y-auto">
              {isLoadingCommits ? (
                <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">Loading commits...</div>
              ) : commits.length === 0 ? (
                <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">No commits</div>
              ) : (
                commits.map(commit => (
                  <div
                    key={commit.hash}
                    onClick={() => handleSelectCommit(commit)}
                    className={`px-3 py-2 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 ${
                      selectedCommit?.hash === commit.hash ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{commit.shortHash}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">{commit.relativeDate}</span>
                    </div>
                    <div className="text-sm text-gray-900 dark:text-gray-100 truncate mt-0.5">{commit.subject}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{commit.author}</div>
                  </div>
                ))
              )}
            </div>
          </div>
          )}

          {/* Right panel - Commit info + File tree + Diff */}
          {!error && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedCommit ? (
              <>
                {/* Commit info */}
                <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex-shrink-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{selectedCommit.subject}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    <span className="font-mono">{selectedCommit.shortHash}</span>
                    <span className="mx-2">·</span>
                    <span>{selectedCommit.author}</span>
                    <span className="mx-2">·</span>
                    <span>{selectedCommit.relativeDate}</span>
                    <span className="mx-2">·</span>
                    <span>{files.length} files changed</span>
                  </div>
                </div>

                {/* File tree + Diff container */}
                <div className="flex-1 flex overflow-hidden">
                  {/* File tree */}
                  <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 overflow-auto">
                    {isLoadingFiles ? (
                      <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">Loading files...</div>
                    ) : files.length === 0 ? (
                      <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">No files changed</div>
                    ) : (
                      <div className="py-1 min-w-max">
                        {fileTree.map(node => (
                          <FileTreeItem
                            key={node.path}
                            node={node}
                            level={0}
                            selectedPath={selectedFile?.path || null}
                            onSelect={handleSelectFile}
                            expandedPaths={expandedPaths}
                            onToggle={handleToggle}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Diff view */}
                  <div className="flex-1 overflow-hidden">
                    {isLoadingDiff ? (
                      <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">Loading diff...</div>
                    ) : fileDiff ? (
                      <DiffSplitView
                        oldStr={fileDiff.oldContent}
                        newStr={fileDiff.newContent}
                        filePath={fileDiff.filePath}
                        isNew={fileDiff.isNew}
                        isDeleted={fileDiff.isDeleted}
                      />
                    ) : selectedFile ? (
                      <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">Select a file to view diff</div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">Select a file to view diff</div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
                Select a commit to view changes
              </div>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
