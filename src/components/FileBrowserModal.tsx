'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { CommitDetailPanel, type CommitInfo } from './CommitDetailPanel';
import { DiffView } from './DiffView';
import { toast } from './Toast';

// ============================================================================
// Types
// ============================================================================

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface FileContent {
  type: 'text' | 'image' | 'binary' | 'error';
  content?: string;
  message?: string;
  size?: number;
}

interface BlameLine {
  hash: string;
  hashFull: string;
  author: string;
  authorEmail: string;
  time: number;
  message: string;
  line: number;
  content: string;
}

// Git Status Types
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

interface StatusTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: StatusTreeNode[];
  file?: GitFileStatus;
  expanded?: boolean;
}

// Git History Types
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
  body: string;
  relativeDate: string;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
}

interface HistoryTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: HistoryTreeNode[];
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

// Tab type
type TabType = 'tree' | 'recent' | 'status' | 'history';

// ============================================================================
// Shiki Highlighter
// ============================================================================

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

// ============================================================================
// Utility Functions
// ============================================================================

function buildTreeFromPaths(filePaths: string[]): FileNode[] {
  const root: FileNode[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
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
          children: isLast ? undefined : [],
        };
        currentLevel.push(existing);
      }

      if (!isLast && existing.children) {
        currentLevel = existing.children;
      }
    }
  }

  const sortNodes = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => {
      if (n.children) sortNodes(n.children);
    });
  };

  sortNodes(root);
  return root;
}

function collectAllDirPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  const traverse = (nodeList: FileNode[]) => {
    for (const node of nodeList) {
      if (node.isDirectory) {
        paths.push(node.path);
        if (node.children) traverse(node.children);
      }
    }
  };
  traverse(nodes);
  return paths;
}

const FILE_ICONS: Record<string, string> = {
  ts: '📘', tsx: '⚛️', js: '📒', jsx: '⚛️',
  json: '📋', md: '📝', css: '🎨', scss: '🎨',
  html: '🌐', py: '🐍', go: '🔵', rs: '🦀',
  java: '☕', rb: '💎', php: '🐘',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
  sh: '⚙️', bash: '⚙️', yml: '⚙️', yaml: '⚙️',
};

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return FILE_ICONS[ext || ''] || '📄';
}

function computeMatchedPaths(nodes: FileNode[], searchQuery: string): Set<string> {
  const matched = new Set<string>();
  if (!searchQuery) return matched;

  const query = searchQuery.toLowerCase();

  const traverse = (node: FileNode, ancestors: string[]): boolean => {
    const nameMatches = node.name.toLowerCase().includes(query);
    let childMatches = false;

    if (node.children) {
      for (const child of node.children) {
        if (traverse(child, [...ancestors, node.path])) {
          childMatches = true;
        }
      }
    }

    if (nameMatches || childMatches) {
      matched.add(node.path);
      ancestors.forEach(p => matched.add(p));
      return true;
    }
    return false;
  };

  for (const node of nodes) {
    traverse(node, []);
  }

  return matched;
}

interface FlatTreeItem {
  node: FileNode;
  level: number;
}

function flattenTree(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  matchedPaths: Set<string> | null,
  level: number = 0
): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];

  for (const node of nodes) {
    if (matchedPaths !== null && !matchedPaths.has(node.path)) {
      continue;
    }

    result.push({ node, level });

    if (node.isDirectory && node.children && expandedPaths.has(node.path)) {
      result.push(...flattenTree(node.children, expandedPaths, matchedPaths, level + 1));
    }
  }

  return result;
}

const NOOP = () => {};
const ROW_HEIGHT = 24;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years}y ago`;
  if (months > 0) return `${months}mo ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  if (isThisYear) {
    return `${month}-${day} ${hours}:${minutes}`;
  }
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

// Build status file tree
function buildStatusFileTree(files: GitFileStatus[]): StatusTreeNode[] {
  const root: StatusTreeNode[] = [];

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

  const sortNodes = (nodes: StatusTreeNode[]) => {
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

// Build history file tree
function buildHistoryFileTree(files: FileChange[]): HistoryTreeNode[] {
  const root: HistoryTreeNode[] = [];

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

  const sortNodes = (nodes: HistoryTreeNode[]) => {
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

// ============================================================================
// Shared Components
// ============================================================================

const AUTHOR_COLORS = [
  { bg: 'rgba(59, 130, 246, 0.15)', border: 'rgb(59, 130, 246)' },
  { bg: 'rgba(16, 185, 129, 0.15)', border: 'rgb(16, 185, 129)' },
  { bg: 'rgba(245, 158, 11, 0.15)', border: 'rgb(245, 158, 11)' },
  { bg: 'rgba(239, 68, 68, 0.15)', border: 'rgb(239, 68, 68)' },
  { bg: 'rgba(168, 85, 247, 0.15)', border: 'rgb(168, 85, 247)' },
  { bg: 'rgba(236, 72, 153, 0.15)', border: 'rgb(236, 72, 153)' },
  { bg: 'rgba(20, 184, 166, 0.15)', border: 'rgb(20, 184, 166)' },
  { bg: 'rgba(249, 115, 22, 0.15)', border: 'rgb(249, 115, 22)' },
];

// Virtual Tree Row
interface VirtualTreeRowProps {
  node: FileNode;
  level: number;
  isSelected: boolean;
  isExpanded: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

const VirtualTreeRow = React.memo(function VirtualTreeRow({
  node,
  level,
  isSelected,
  isExpanded,
  onSelect,
  onToggle,
}: VirtualTreeRowProps) {
  if (node.isDirectory) {
    return (
      <div
        className={`flex items-center gap-1 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
          isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : ''
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px`, height: ROW_HEIGHT }}
        onClick={() => onToggle(node.path)}
      >
        <span className="text-gray-400 text-xs w-3">
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{node.name}</span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
        isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : ''
      }`}
      style={{ paddingLeft: `${level * 12 + 20}px`, height: ROW_HEIGHT }}
      onClick={() => onSelect(node.path)}
    >
      <span>{getFileIcon(node.name)}</span>
      <span className={`text-sm truncate ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>
        {node.name}
      </span>
    </div>
  );
});

// File Tree Item (recursive, for small lists)
interface FileTreeItemProps {
  node: FileNode;
  level: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  matchedPaths: Set<string> | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

const FileTreeItem = React.memo(function FileTreeItem({
  node,
  level,
  selectedPath,
  expandedPaths,
  matchedPaths,
  onSelect,
  onToggle,
}: FileTreeItemProps) {
  const isSelected = selectedPath === node.path;
  const isExpanded = expandedPaths.has(node.path);

  if (matchedPaths !== null && !matchedPaths.has(node.path)) {
    return null;
  }

  if (node.isDirectory) {
    return (
      <div>
        <div
          className={`flex items-center gap-1 py-0.5 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
            isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : ''
          }`}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => onToggle(node.path)}
        >
          <span className="text-gray-400 text-xs w-3">
            {isExpanded ? '▼' : '▶'}
          </span>
          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{node.name}</span>
        </div>
        {isExpanded && node.children && (
          <div>
            {node.children.map(child => (
              <FileTreeItem
                key={child.path}
                node={child}
                level={level + 1}
                selectedPath={selectedPath}
                expandedPaths={expandedPaths}
                matchedPaths={matchedPaths}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 py-0.5 px-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 ${
        isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : ''
      }`}
      style={{ paddingLeft: `${level * 12 + 20}px` }}
      onClick={() => onSelect(node.path)}
    >
      <span>{getFileIcon(node.name)}</span>
      <span className={`text-sm truncate ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'}`}>
        {node.name}
      </span>
    </div>
  );
});

// Virtual File Tree
interface VirtualFileTreeProps {
  files: FileNode[];
  selectedPath: string | null;
  expandedPaths: Set<string>;
  matchedPaths: Set<string> | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function VirtualFileTree({
  files,
  selectedPath,
  expandedPaths,
  matchedPaths,
  onSelect,
  onToggle,
}: VirtualFileTreeProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const flatItems = useMemo(() => {
    return flattenTree(files, expandedPaths, matchedPaths);
  }, [files, expandedPaths, matchedPaths]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  if (flatItems.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
        No files
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      style={{ willChange: 'transform' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = flatItems[virtualItem.index];
          return (
            <div
              key={item.node.path}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <VirtualTreeRow
                node={item.node}
                level={item.level}
                isSelected={selectedPath === item.node.path}
                isExpanded={expandedPaths.has(item.node.path)}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Code Preview
function CodePreview({ content, filePath }: { content: string; filePath: string }) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');
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

        const html = highlighter.codeToHtml(content, {
          lang: language as BundledLanguage,
          theme,
        });

        setHighlightedHtml(html);
      } catch (err) {
        console.error('Highlight error:', err);
        setHighlightedHtml(`<pre>${escapeHtml(content)}</pre>`);
      }
    };

    highlight();
  }, [content, filePath, isDark]);

  return (
    <div
      className="text-sm font-mono overflow-auto h-full p-4"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}

// Blame View
interface BlameViewProps {
  blameLines: BlameLine[];
  cwd: string;
}

function BlameView({ blameLines, cwd }: BlameViewProps) {
  const [hoveredAuthor, setHoveredAuthor] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ line: BlameLine; x: number; y: number } | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<CommitInfo | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const authorColorMap = useMemo(() => {
    const authors = [...new Set(blameLines.map(l => l.author))];
    const map = new Map<string, typeof AUTHOR_COLORS[0]>();
    authors.forEach((author, index) => {
      map.set(author, AUTHOR_COLORS[index % AUTHOR_COLORS.length]);
    });
    return map;
  }, [blameLines]);

  const virtualizer = useVirtualizer({
    count: blameLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  const handleMouseEnter = useCallback((line: BlameLine, e: React.MouseEvent) => {
    setHoveredAuthor(line.author);
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ line, x: rect.right + 8, y: rect.top });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredAuthor(null);
    setTooltip(null);
  }, []);

  const handleClick = useCallback((line: BlameLine) => {
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
    setSelectedCommit(commitInfo);
    setTooltip(null);
  }, []);

  return (
    <div ref={parentRef} className="h-full overflow-auto font-mono text-xs relative">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const line = blameLines[virtualItem.index];
          const prevLine = virtualItem.index > 0 ? blameLines[virtualItem.index - 1] : null;
          const showBlameInfo = !prevLine || prevLine.hash !== line.hash;
          const authorColor = authorColorMap.get(line.author) || AUTHOR_COLORS[0];
          const isHovered = hoveredAuthor === line.author;

          return (
            <div
              key={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
                backgroundColor: isHovered ? authorColor.bg : undefined,
              }}
              className="flex hover:bg-gray-100 dark:hover:bg-gray-700/50"
            >
              <div
                className="w-1 flex-shrink-0"
                style={{ backgroundColor: authorColor.border }}
              />
              <div
                className="w-48 flex-shrink-0 px-2 flex items-center gap-2 border-r border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600/50"
                onMouseEnter={(e) => handleMouseEnter(line, e)}
                onMouseLeave={handleMouseLeave}
                onClick={() => handleClick(line)}
                title="点击查看 commit 详情"
              >
                {showBlameInfo ? (
                  <>
                    <span className="font-medium" style={{ color: authorColor.border }}>{line.hash}</span>
                    <span className="truncate flex-1">{line.author.split(' ')[0]}</span>
                    <span className="text-gray-400 dark:text-gray-500">{formatRelativeTime(line.time)}</span>
                  </>
                ) : null}
              </div>
              <div className="w-10 flex-shrink-0 px-2 text-right text-gray-400 dark:text-gray-500 select-none">
                {line.line}
              </div>
              <pre className="flex-1 px-2 overflow-hidden whitespace-pre">
                <code className="text-gray-800 dark:text-gray-200">{line.content}</code>
              </pre>
            </div>
          );
        })}
      </div>

      {tooltip && (
        <div
          className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-w-lg"
          style={{
            left: Math.min(tooltip.x, window.innerWidth - 450),
            top: Math.max(8, Math.min(tooltip.y, window.innerHeight - 200)),
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="px-2 py-0.5 rounded text-xs font-mono font-medium text-white flex-shrink-0"
              style={{ backgroundColor: authorColorMap.get(tooltip.line.author)?.border || '#666' }}
            >
              {tooltip.line.hash}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {tooltip.line.author}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {tooltip.line.authorEmail}
              </div>
            </div>
          </div>
          <div className="mt-2 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
            {tooltip.line.message}
          </div>
          <div className="mt-2 text-xs text-gray-400 dark:text-gray-500 border-t border-gray-200 dark:border-gray-700 pt-2">
            {new Date(tooltip.line.time * 1000).toLocaleString()}
            <span className="ml-2 text-blue-500">点击查看详情</span>
          </div>
        </div>
      )}

      <CommitDetailPanel
        isOpen={selectedCommit !== null}
        onClose={() => setSelectedCommit(null)}
        commit={selectedCommit}
        cwd={cwd}
      />
    </div>
  );
}

// ============================================================================
// Git Status Components
// ============================================================================

function StatusFileTreeItem({
  node,
  level,
  selectedPath,
  onSelect,
  onStage,
  onUnstage,
  type,
  onToggle,
}: {
  node: StatusTreeNode;
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
          <span className="text-sm text-gray-700 dark:text-gray-300">{node.name}</span>
        </div>
        {node.expanded && node.children.map(child => (
          <StatusFileTreeItem
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

// ============================================================================
// Git History Components
// ============================================================================

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

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

function HistoryFileTreeItem({
  node,
  level,
  selectedPath,
  onSelect,
  expandedPaths,
  onToggle,
}: {
  node: HistoryTreeNode;
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
          <span className="text-sm text-gray-700 dark:text-gray-300">{node.name}</span>
        </div>
        {isExpanded && node.children.map(child => (
          <HistoryFileTreeItem
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

// ============================================================================
// Main Modal Component
// ============================================================================

interface FileBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
  initialTab?: TabType;
}

const COMMITS_PER_PAGE = 50;

export function FileBrowserModal({ isOpen, onClose, cwd, initialTab = 'tree' }: FileBrowserModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);

  // ========== File Browser State ==========
  const [files, setFiles] = useState<FileNode[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Blame state
  const [showBlame, setShowBlame] = useState(false);
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [isLoadingBlame, setIsLoadingBlame] = useState(false);
  const [blameError, setBlameError] = useState<string | null>(null);

  // ========== Git Status State ==========
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSelectedFile, setStatusSelectedFile] = useState<{ file: GitFileStatus; type: 'staged' | 'unstaged' } | null>(null);
  const [statusDiff, setStatusDiff] = useState<GitDiffResponse | null>(null);
  const [statusDiffLoading, setStatusDiffLoading] = useState(false);
  const [statusExpandedPaths, setStatusExpandedPaths] = useState<Set<string>>(new Set());
  const [stagedTree, setStagedTree] = useState<StatusTreeNode[]>([]);
  const [unstagedTree, setUnstagedTree] = useState<StatusTreeNode[]>([]);

  // ========== Git History State ==========
  const [branches, setBranches] = useState<Branch | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
  const [historyFiles, setHistoryFiles] = useState<FileChange[]>([]);
  const [historyFileTree, setHistoryFileTree] = useState<HistoryTreeNode[]>([]);
  const [historyExpandedPaths, setHistoryExpandedPaths] = useState<Set<string>>(new Set());
  const [historySelectedFile, setHistorySelectedFile] = useState<FileChange | null>(null);
  const [historyFileDiff, setHistoryFileDiff] = useState<FileDiff | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreCommits, setHasMoreCommits] = useState(true);
  const [isLoadingHistoryFiles, setIsLoadingHistoryFiles] = useState(false);
  const [isLoadingHistoryDiff, setIsLoadingHistoryDiff] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const commitListRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // ========== Memoized Values ==========
  const recentFilesTree = useMemo(() => {
    return buildTreeFromPaths(recentFiles);
  }, [recentFiles]);

  const recentTreeDirPaths = useMemo(() => {
    return new Set(collectAllDirPaths(recentFilesTree));
  }, [recentFilesTree]);

  const matchedPaths = useMemo(() => {
    if (!searchQuery) return null;
    return computeMatchedPaths(files, searchQuery);
  }, [files, searchQuery]);

  const displayStagedTree = useMemo(() => {
    const updateTreeExpanded = (nodes: StatusTreeNode[], paths: Set<string>): StatusTreeNode[] => {
      return nodes.map(n => ({
        ...n,
        expanded: paths.has(n.path),
        children: updateTreeExpanded(n.children, paths),
      }));
    };
    return updateTreeExpanded(stagedTree, statusExpandedPaths);
  }, [stagedTree, statusExpandedPaths]);

  const displayUnstagedTree = useMemo(() => {
    const updateTreeExpanded = (nodes: StatusTreeNode[], paths: Set<string>): StatusTreeNode[] => {
      return nodes.map(n => ({
        ...n,
        expanded: paths.has(n.path),
        children: updateTreeExpanded(n.children, paths),
      }));
    };
    return updateTreeExpanded(unstagedTree, statusExpandedPaths);
  }, [unstagedTree, statusExpandedPaths]);

  // ========== Update activeTab when initialTab changes ==========
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  // ========== ESC Handler ==========
  const lastEscTimeRef = useRef<number>(0);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const now = Date.now();
        if (now - lastEscTimeRef.current < 3000) {
          return;
        }
        lastEscTimeRef.current = now;

        if (showBlame) {
          setShowBlame(false);
        } else {
          onClose();
        }
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose, showBlame]);

  // ========== File Browser Functions ==========
  const loadExpandedPaths = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/expanded?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (data.paths && Array.isArray(data.paths) && data.paths.length > 0) {
        setExpandedPaths(new Set(data.paths));
      }
    } catch (err) {
      console.error('Error loading expanded paths:', err);
    }
  }, [cwd]);

  const saveExpandedPaths = useCallback(async (paths: Set<string>) => {
    try {
      await fetch('/api/files/expanded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, paths: Array.from(paths) }),
      });
    } catch (err) {
      console.error('Error saving expanded paths:', err);
    }
  }, [cwd]);

  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true);
    setFileError(null);
    try {
      const res = await fetch(`/api/files/list?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (data.error) {
        setFileError(data.error);
      } else {
        setFiles(data.files || []);
      }
    } catch (err) {
      console.error('Error loading files:', err);
      setFileError('Failed to load files');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [cwd]);

  const loadRecentFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/recent?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      setRecentFiles(data.files || []);
    } catch (err) {
      console.error('Error loading recent files:', err);
    }
  }, [cwd]);

  const addToRecentFiles = useCallback(async (filePath: string) => {
    try {
      await fetch('/api/files/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, file: filePath }),
      });
      loadRecentFiles();
    } catch (err) {
      console.error('Error adding to recent files:', err);
    }
  }, [cwd, loadRecentFiles]);

  const loadFileContent = useCallback(async (filePath: string) => {
    setIsLoadingContent(true);
    setFileContent(null);
    setShowBlame(false);
    setBlameLines([]);
    setBlameError(null);
    try {
      const res = await fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      setFileContent(data);
      addToRecentFiles(filePath);
    } catch (err) {
      console.error('Error loading file content:', err);
      setFileContent({ type: 'error', message: 'Failed to load file' });
    } finally {
      setIsLoadingContent(false);
    }
  }, [cwd, addToRecentFiles]);

  const loadBlame = useCallback(async () => {
    if (!selectedPath) return;
    setIsLoadingBlame(true);
    setBlameError(null);
    try {
      const res = await fetch(`/api/files/blame?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selectedPath)}`);
      const data = await res.json();
      if (data.error) {
        setBlameError(data.error);
      } else {
        setBlameLines(data.blame || []);
      }
    } catch (err) {
      console.error('Error loading blame:', err);
      setBlameError('Failed to load blame info');
    } finally {
      setIsLoadingBlame(false);
    }
  }, [cwd, selectedPath]);

  const handleToggleBlame = useCallback(() => {
    if (showBlame) {
      setShowBlame(false);
    } else {
      setShowBlame(true);
      if (blameLines.length === 0) {
        loadBlame();
      }
    }
  }, [showBlame, blameLines.length, loadBlame]);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
    loadFileContent(path);
  }, [loadFileContent]);

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      saveExpandedPaths(next);
      return next;
    });
  }, [saveExpandedPaths]);

  // ========== Git Status Functions ==========
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const url = `/api/git/status?cwd=${encodeURIComponent(cwd)}`;
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch git status');
      }
      const data: GitStatusResponse = await response.json();
      setStatus(data);

      const staged = buildStatusFileTree(data.staged);
      const unstaged = buildStatusFileTree(data.unstaged);
      setStagedTree(staged);
      setUnstagedTree(unstaged);

      const allPaths = new Set<string>();
      const collectPaths = (nodes: StatusTreeNode[]) => {
        nodes.forEach(n => {
          if (n.isDirectory) {
            allPaths.add(n.path);
            collectPaths(n.children);
          }
        });
      };
      collectPaths(staged);
      collectPaths(unstaged);
      setStatusExpandedPaths(allPaths);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStatusLoading(false);
    }
  }, [cwd]);

  const handleStatusToggle = useCallback((path: string) => {
    setStatusExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

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
      toast('已暂存', 'success');
    } catch (err) {
      console.error('Error staging file:', err);
      toast('暂存失败', 'error');
    }
  }, [cwd, fetchStatus]);

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
      toast('已取消暂存', 'success');
    } catch (err) {
      console.error('Error unstaging file:', err);
      toast('取消暂存失败', 'error');
    }
  }, [cwd, fetchStatus]);

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
      toast(`已暂存 ${status.unstaged.length} 个文件`, 'success');
    } catch (err) {
      console.error('Error staging all files:', err);
      toast('暂存失败', 'error');
    }
  }, [cwd, status, fetchStatus]);

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
      toast(`已取消暂存 ${status.staged.length} 个文件`, 'success');
    } catch (err) {
      console.error('Error unstaging all files:', err);
      toast('取消暂存失败', 'error');
    }
  }, [cwd, status, fetchStatus]);

  // Fetch status diff
  useEffect(() => {
    if (!statusSelectedFile) {
      setStatusDiff(null);
      return;
    }

    const fetchDiff = async () => {
      setStatusDiffLoading(true);
      try {
        const params = new URLSearchParams({
          file: statusSelectedFile.file.path,
          type: statusSelectedFile.type,
        });
        params.set('cwd', cwd);

        const response = await fetch(`/api/git/diff?${params}`);
        if (!response.ok) {
          throw new Error('Failed to fetch diff');
        }
        const data: GitDiffResponse = await response.json();
        setStatusDiff(data);
      } catch (err) {
        console.error('Error fetching diff:', err);
      } finally {
        setStatusDiffLoading(false);
      }
    };

    fetchDiff();
  }, [statusSelectedFile, cwd]);

  // ========== Git History Functions ==========
  const loadBranches = useCallback(() => {
    setIsLoadingBranches(true);
    setHistoryError(null);
    fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setHistoryError(data.error === 'Failed to get branches' ? '当前目录不是 Git 仓库' : data.error);
          setBranches(null);
        } else if (data.local && data.current) {
          setBranches(data);
          setSelectedBranch(data.current);
        } else {
          setHistoryError('无法获取分支信息');
          setBranches(null);
        }
      })
      .catch(err => {
        console.error(err);
        setHistoryError('获取分支信息失败');
        setBranches(null);
      })
      .finally(() => setIsLoadingBranches(false));
  }, [cwd]);

  const loadCommits = useCallback((branch: string) => {
    setIsLoadingCommits(true);
    setSelectedCommit(null);
    setHistoryFiles([]);
    setHistoryFileTree([]);
    setHistorySelectedFile(null);
    setHistoryFileDiff(null);
    setHasMoreCommits(true);
    fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}&limit=${COMMITS_PER_PAGE}`)
      .then(res => res.json())
      .then(data => {
        const newCommits = data.commits || [];
        setCommits(newCommits);
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      })
      .catch(console.error)
      .finally(() => setIsLoadingCommits(false));
  }, [cwd]);

  const loadMoreCommits = useCallback(() => {
    if (isLoadingMore || !hasMoreCommits || !selectedBranch) return;

    setIsLoadingMore(true);
    const offset = commits.length;

    fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(selectedBranch)}&limit=${COMMITS_PER_PAGE}&offset=${offset}`)
      .then(res => res.json())
      .then(data => {
        const newCommits = data.commits || [];
        if (newCommits.length > 0) {
          setCommits(prev => [...prev, ...newCommits]);
        }
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      })
      .catch(console.error)
      .finally(() => setIsLoadingMore(false));
  }, [cwd, selectedBranch, commits.length, isLoadingMore, hasMoreCommits]);

  const handleCommitListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const { scrollTop, scrollHeight, clientHeight } = target;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      loadMoreCommits();
    }
  }, [loadMoreCommits]);

  const handleSelectCommit = useCallback((commit: Commit) => {
    setSelectedCommit(commit);
    setHistorySelectedFile(null);
    setHistoryFileDiff(null);
    setIsLoadingHistoryFiles(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}`)
      .then(res => res.json())
      .then(data => {
        const fileList = data.files || [];
        setHistoryFiles(fileList);
        const tree = buildHistoryFileTree(fileList);
        setHistoryFileTree(tree);
        const allPaths = new Set<string>();
        const collectPaths = (nodes: HistoryTreeNode[]) => {
          nodes.forEach(n => {
            if (n.isDirectory) {
              allPaths.add(n.path);
              collectPaths(n.children);
            }
          });
        };
        collectPaths(tree);
        setHistoryExpandedPaths(allPaths);
      })
      .catch(console.error)
      .finally(() => setIsLoadingHistoryFiles(false));
  }, [cwd]);

  const handleSelectHistoryFile = useCallback((file: FileChange) => {
    if (!selectedCommit) return;
    setHistorySelectedFile(file);
    setIsLoadingHistoryDiff(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${selectedCommit.hash}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setHistoryFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingHistoryDiff(false));
  }, [cwd, selectedCommit]);

  const handleHistoryToggle = useCallback((path: string) => {
    setHistoryExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleCommitInfoMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCommitInfoMouseLeave = useCallback(() => {
    setTooltipPos(null);
  }, []);

  // ========== Load Data on Tab Change ==========
  useEffect(() => {
    if (!isOpen) return;

    if (activeTab === 'tree' || activeTab === 'recent') {
      loadExpandedPaths();
      loadFiles();
      loadRecentFiles();
      if (activeTab === 'tree') {
        setTimeout(() => searchInputRef.current?.focus(), 100);
      }
    } else if (activeTab === 'status') {
      fetchStatus();
    } else if (activeTab === 'history') {
      loadBranches();
    }
  }, [isOpen, activeTab, loadExpandedPaths, loadFiles, loadRecentFiles, fetchStatus, loadBranches]);

  // Load commits when branch changes
  useEffect(() => {
    if (activeTab === 'history' && selectedBranch) {
      loadCommits(selectedBranch);
    }
  }, [activeTab, selectedBranch, loadCommits]);

  // Search auto-expand
  useEffect(() => {
    if (searchQuery) {
      const expandMatching = (nodes: FileNode[], toExpand: Set<string>) => {
        for (const node of nodes) {
          if (node.isDirectory && node.children) {
            const hasMatch = node.children.some(child => {
              if (child.name.toLowerCase().includes(searchQuery.toLowerCase())) {
                return true;
              }
              if (child.isDirectory && child.children) {
                expandMatching([child], toExpand);
                return toExpand.has(child.path);
              }
              return false;
            });
            if (hasMatch) {
              toExpand.add(node.path);
            }
          }
        }
      };

      const toExpand = new Set<string>();
      expandMatching(files, toExpand);
      if (toExpand.size > 0) {
        setExpandedPaths(prev => new Set([...prev, ...toExpand]));
      }
    }
  }, [searchQuery, files]);

  // ========== Refresh Handler ==========
  const handleRefresh = useCallback(() => {
    if (activeTab === 'tree' || activeTab === 'recent') {
      loadFiles();
      loadRecentFiles();
    } else if (activeTab === 'status') {
      fetchStatus();
    } else if (activeTab === 'history') {
      loadBranches();
      if (selectedBranch) {
        loadCommits(selectedBranch);
      }
    }
  }, [activeTab, loadFiles, loadRecentFiles, fetchStatus, loadBranches, loadCommits, selectedBranch]);

  if (!isOpen) return null;

  // Determine loading state for refresh button
  const isRefreshLoading = isLoadingFiles || statusLoading || isLoadingBranches || isLoadingCommits;

  return (
    <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 w-full h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            文件浏览
          </h3>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={isRefreshLoading}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
              title="刷新"
            >
              <svg className={`w-5 h-5 ${isRefreshLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          {/* Left Panel */}
          <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setActiveTab('tree')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'tree'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                目录树
              </button>
              <button
                onClick={() => setActiveTab('recent')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                最近浏览
              </button>
              <button
                onClick={() => setActiveTab('status')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'status'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Git 变更
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'history'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Git 历史
              </button>
            </div>

            {/* Tab-specific content above list */}
            {activeTab === 'tree' && (
              <div className="p-2 border-b border-gray-200 dark:border-gray-700">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索文件..."
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {activeTab === 'history' && (
              <div className="p-3 border-b border-gray-200 dark:border-gray-700">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">查看分支</label>
                <BranchSelector
                  branches={branches}
                  selectedBranch={selectedBranch}
                  onSelect={setSelectedBranch}
                  isLoading={isLoadingBranches}
                />
              </div>
            )}

            {/* List Content */}
            <div className="flex-1 overflow-hidden">
              {/* Tree Tab */}
              {activeTab === 'tree' && (
                isLoadingFiles ? (
                  <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">Loading...</div>
                ) : fileError ? (
                  <div className="p-4 text-center text-red-500 text-sm">{fileError}</div>
                ) : (
                  <VirtualFileTree
                    files={files}
                    selectedPath={selectedPath}
                    expandedPaths={expandedPaths}
                    matchedPaths={matchedPaths}
                    onSelect={handleSelectFile}
                    onToggle={handleToggle}
                  />
                )
              )}

              {/* Recent Tab */}
              {activeTab === 'recent' && (
                recentFiles.length === 0 ? (
                  <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                    暂无最近浏览的文件
                  </div>
                ) : (
                  <div className="py-1 overflow-y-auto h-full">
                    {recentFilesTree.map(node => (
                      <FileTreeItem
                        key={node.path}
                        node={node}
                        level={0}
                        selectedPath={selectedPath}
                        expandedPaths={recentTreeDirPaths}
                        matchedPaths={null}
                        onSelect={handleSelectFile}
                        onToggle={NOOP}
                      />
                    ))}
                  </div>
                )
              )}

              {/* Status Tab */}
              {activeTab === 'status' && (
                statusLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : statusError ? (
                  <div className="flex-1 flex items-center justify-center p-4">
                    <span className="text-red-500 text-sm">{statusError}</span>
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
                            <StatusFileTreeItem
                              key={node.path}
                              node={node}
                              level={0}
                              selectedPath={statusSelectedFile?.type === 'staged' ? statusSelectedFile.file.path : null}
                              onSelect={(file, type) => setStatusSelectedFile({ file, type })}
                              onUnstage={handleUnstage}
                              type="staged"
                              onToggle={handleStatusToggle}
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
                            <StatusFileTreeItem
                              key={node.path}
                              node={node}
                              level={0}
                              selectedPath={statusSelectedFile?.type === 'unstaged' ? statusSelectedFile.file.path : null}
                              onSelect={(file, type) => setStatusSelectedFile({ file, type })}
                              onStage={handleStage}
                              type="unstaged"
                              onToggle={handleStatusToggle}
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
                )
              )}

              {/* History Tab */}
              {activeTab === 'history' && (
                historyError ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <p className="text-gray-500 dark:text-gray-400">{historyError}</p>
                    </div>
                  </div>
                ) : (
                  <div
                    ref={commitListRef}
                    className="flex-1 overflow-y-auto"
                    onScroll={handleCommitListScroll}
                  >
                    {isLoadingCommits ? (
                      <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">Loading commits...</div>
                    ) : commits.length === 0 ? (
                      <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">No commits</div>
                    ) : (
                      <>
                        {commits.map(commit => (
                          <div
                            key={commit.hash}
                            onClick={() => handleSelectCommit(commit)}
                            className={`px-3 py-2 border-b border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 ${
                              selectedCommit?.hash === commit.hash ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{commit.shortHash}</span>
                              <span className="text-xs text-gray-400 dark:text-gray-500" title={commit.date}>
                                {commit.relativeDate} · {formatDateTime(commit.date)}
                              </span>
                            </div>
                            <div className="text-sm text-gray-900 dark:text-gray-100 truncate mt-0.5">{commit.subject}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{commit.author}</div>
                          </div>
                        ))}
                        {isLoadingMore && (
                          <div className="p-3 text-center">
                            <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        {!hasMoreCommits && commits.length > 0 && (
                          <div className="p-3 text-center text-xs text-gray-400 dark:text-gray-500">
                            已加载全部 {commits.length} 条记录
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              )}
            </div>
          </div>

          {/* Right Panel */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* File Browser / Recent - Right Panel */}
            {(activeTab === 'tree' || activeTab === 'recent') && (
              selectedPath ? (
                <>
                  <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 flex items-center justify-between">
                    <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                      {selectedPath}
                    </span>
                    {fileContent?.type === 'text' && (
                      <button
                        onClick={handleToggleBlame}
                        disabled={isLoadingBlame}
                        className={`px-2 py-1 text-xs rounded transition-colors ${
                          showBlame
                            ? 'bg-blue-500 text-white'
                            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                        } disabled:opacity-50`}
                        title="查看每行代码的修改记录"
                      >
                        {isLoadingBlame ? (
                          <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                          'Blame'
                        )}
                      </button>
                    )}
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {isLoadingContent ? (
                      <div className="h-full flex items-center justify-center">
                        <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : fileContent ? (
                      fileContent.type === 'text' && fileContent.content ? (
                        showBlame ? (
                          blameError ? (
                            <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                              <div className="text-center">
                                <p className="text-red-500">{blameError}</p>
                                <button
                                  onClick={() => setShowBlame(false)}
                                  className="mt-2 text-blue-500 hover:underline text-sm"
                                >
                                  返回预览
                                </button>
                              </div>
                            </div>
                          ) : blameLines.length > 0 ? (
                            <BlameView blameLines={blameLines} cwd={cwd} />
                          ) : (
                            <div className="h-full flex items-center justify-center">
                              <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                            </div>
                          )
                        ) : (
                          <CodePreview content={fileContent.content} filePath={selectedPath} />
                        )
                      ) : fileContent.type === 'image' && fileContent.content ? (
                        <div className="h-full flex items-center justify-center p-4 bg-gray-100 dark:bg-gray-900">
                          <img
                            src={fileContent.content}
                            alt={selectedPath}
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                      ) : (
                        <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                          <div className="text-center">
                            <svg className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p>{fileContent.message || '无法预览此文件'}</p>
                          </div>
                        </div>
                      )
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                        <span>加载失败</span>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                  <span>选择文件查看内容</span>
                </div>
              )
            )}

            {/* Status - Right Panel */}
            {activeTab === 'status' && (
              !statusSelectedFile ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
                  <span>选择文件查看差异</span>
                </div>
              ) : statusDiffLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : statusDiff ? (
                <div className="flex-1 overflow-hidden flex flex-col">
                  <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                      {statusSelectedFile.file.path}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      statusSelectedFile.type === 'staged'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300'
                        : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300'
                    }`}>
                      {statusSelectedFile.type === 'staged' ? '已暂存' : '未暂存'}
                    </span>
                  </div>
                  <div className="flex-1 overflow-auto">
                    <DiffView
                      oldContent={statusDiff.oldContent}
                      newContent={statusDiff.newContent}
                      filePath={statusDiff.filePath}
                      isNew={statusDiff.isNew}
                      isDeleted={statusDiff.isDeleted}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
                  <span>加载差异失败</span>
                </div>
              )
            )}

            {/* History - Right Panel */}
            {activeTab === 'history' && !historyError && (
              selectedCommit ? (
                <>
                  {/* Commit info with tooltip */}
                  <div
                    className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex-shrink-0 cursor-help"
                    onMouseMove={handleCommitInfoMouseMove}
                    onMouseLeave={handleCommitInfoMouseLeave}
                  >
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{selectedCommit.subject}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      <span className="font-mono">{selectedCommit.shortHash}</span>
                      <span className="mx-2">·</span>
                      <span>{selectedCommit.author}</span>
                      <span className="mx-2">·</span>
                      <span>{selectedCommit.relativeDate} ({formatDateTime(selectedCommit.date)})</span>
                      <span className="mx-2">·</span>
                      <span>{historyFiles.length} files changed</span>
                    </div>
                  </div>
                  {tooltipPos && (
                    <div
                      className="fixed z-[100] pointer-events-none"
                      style={{
                        left: tooltipPos.x + 12,
                        top: tooltipPos.y + 12,
                      }}
                    >
                      <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl border border-gray-200 dark:border-gray-600 p-3 max-w-lg min-w-[300px]">
                        <div className="text-sm font-medium mb-2">{selectedCommit.subject}</div>
                        {selectedCommit.body && (
                          <div className="text-xs text-gray-600 dark:text-gray-300 mb-2 whitespace-pre-wrap border-t border-gray-200 dark:border-gray-600 pt-2 max-h-48 overflow-y-auto">
                            {selectedCommit.body}
                          </div>
                        )}
                        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1 border-t border-gray-200 dark:border-gray-600 pt-2">
                          <div><span className="text-gray-400 dark:text-gray-500">Hash:</span> <span className="font-mono">{selectedCommit.hash}</span></div>
                          <div><span className="text-gray-400 dark:text-gray-500">Author:</span> {selectedCommit.author} &lt;{selectedCommit.authorEmail}&gt;</div>
                          <div><span className="text-gray-400 dark:text-gray-500">Date:</span> {selectedCommit.date}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* File tree + Diff container */}
                  <div className="flex-1 flex overflow-hidden">
                    {/* File tree */}
                    <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 overflow-auto">
                      {isLoadingHistoryFiles ? (
                        <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">Loading files...</div>
                      ) : historyFiles.length === 0 ? (
                        <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">No files changed</div>
                      ) : (
                        <div className="py-1 min-w-max">
                          {historyFileTree.map(node => (
                            <HistoryFileTreeItem
                              key={node.path}
                              node={node}
                              level={0}
                              selectedPath={historySelectedFile?.path || null}
                              onSelect={handleSelectHistoryFile}
                              expandedPaths={historyExpandedPaths}
                              onToggle={handleHistoryToggle}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Diff view */}
                    <div className="flex-1 overflow-hidden">
                      {isLoadingHistoryDiff ? (
                        <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">Loading diff...</div>
                      ) : historyFileDiff ? (
                        <DiffView
                          oldContent={historyFileDiff.oldContent}
                          newContent={historyFileDiff.newContent}
                          filePath={historyFileDiff.filePath}
                          isNew={historyFileDiff.isNew}
                          isDeleted={historyFileDiff.isDeleted}
                        />
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
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
