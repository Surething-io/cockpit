'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CommitDetailPanel, type CommitInfo } from './CommitDetailPanel';
import { DiffView } from './DiffView';
import { toast } from './Toast';
import { FileTree, type FileNode as FileTreeNode } from './FileTree';
import { GitFileTree, buildGitFileTree, collectGitTreeDirPaths, type GitFileNode, type GitFileStatus as GitFileStatusType } from './GitFileTree';
import { MenuContainerProvider } from './FileContextMenu';
import { CodeViewer } from './CodeViewer';
import { MarkdownFileViewer, isMarkdownFile } from './MarkdownFileViewer';
import { FileIcon } from './FileIcon';

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

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.has(ext || '');
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
        className={`flex items-center gap-1 px-2 cursor-pointer hover:bg-accent ${
          isSelected ? 'bg-brand/10' : ''
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px`, height: ROW_HEIGHT }}
        onClick={() => onToggle(node.path)}
      >
        <span className="text-slate-9 text-xs w-3">
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className="text-sm text-foreground truncate">{node.name}</span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 px-2 cursor-pointer hover:bg-accent ${
        isSelected ? 'bg-brand/10' : ''
      }`}
      style={{ paddingLeft: `${level * 12 + 20}px`, height: ROW_HEIGHT }}
      onClick={() => onSelect(node.path)}
    >
      <FileIcon name={node.name} size={16} className="flex-shrink-0" />
      <span className={`text-sm truncate ${isSelected ? 'text-brand' : 'text-foreground'}`}>
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
          className={`flex items-center gap-1 py-0.5 px-2 cursor-pointer hover:bg-accent ${
            isSelected ? 'bg-brand/10' : ''
          }`}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => onToggle(node.path)}
        >
          <span className="text-slate-9 text-xs w-3">
            {isExpanded ? '▼' : '▶'}
          </span>
          <span className="text-sm text-foreground truncate">{node.name}</span>
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
      className={`flex items-center gap-1.5 py-0.5 px-2 cursor-pointer hover:bg-accent ${
        isSelected ? 'bg-brand/10' : ''
      }`}
      style={{ paddingLeft: `${level * 12 + 20}px` }}
      onClick={() => onSelect(node.path)}
    >
      <FileIcon name={node.name} size={16} className="flex-shrink-0" />
      <span className={`text-sm truncate ${isSelected ? 'text-brand' : 'text-foreground'}`}>
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
  shouldScrollToSelected?: boolean; // 是否滚动到选中文件（仅外部触发时为 true）
}

function VirtualFileTree({
  files,
  selectedPath,
  expandedPaths,
  matchedPaths,
  onSelect,
  onToggle,
  shouldScrollToSelected = false,
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

  // Scroll to selected file only when shouldScrollToSelected is true
  useEffect(() => {
    if (shouldScrollToSelected && selectedPath && flatItems.length > 0) {
      const index = flatItems.findIndex(item => item.node.path === selectedPath);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'center' });
      }
    }
  }, [shouldScrollToSelected, selectedPath, flatItems, virtualizer]);

  if (flatItems.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground text-sm">
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


// Blame View
interface BlameViewProps {
  blameLines: BlameLine[];
  cwd: string;
  onSelectCommit?: (commit: CommitInfo) => void;
}

function BlameView({ blameLines, cwd, onSelectCommit }: BlameViewProps) {
  const [hoveredAuthor, setHoveredAuthor] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ line: BlameLine; x: number; y: number } | null>(null);
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
    onSelectCommit?.(commitInfo);
    setTooltip(null);
  }, [onSelectCommit]);

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
              className="flex hover:bg-accent/50"
            >
              <div
                className="w-1 flex-shrink-0"
                style={{ backgroundColor: authorColor.border }}
              />
              <div
                className="w-48 flex-shrink-0 px-2 flex items-center gap-2 border-r border-border text-muted-foreground cursor-pointer hover:bg-accent"
                onMouseEnter={(e) => handleMouseEnter(line, e)}
                onMouseLeave={handleMouseLeave}
                onClick={() => handleClick(line)}
                title="点击查看 commit 详情"
              >
                {showBlameInfo ? (
                  <>
                    <span className="font-medium" style={{ color: authorColor.border }}>{line.hash}</span>
                    <span className="truncate flex-1">{line.author.split(' ')[0]}</span>
                    <span className="text-slate-9">{formatRelativeTime(line.time)}</span>
                  </>
                ) : null}
              </div>
              <div className="w-10 flex-shrink-0 px-2 text-right text-slate-9 select-none">
                {line.line}
              </div>
              <pre className="flex-1 px-2 overflow-hidden whitespace-pre">
                <code className="text-foreground">{line.content}</code>
              </pre>
            </div>
          );
        })}
      </div>

      {tooltip && (
        <div
          className="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-3 max-w-lg"
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
              <div className="text-sm font-medium text-foreground">
                {tooltip.line.author}
              </div>
              <div className="text-xs text-muted-foreground">
                {tooltip.line.authorEmail}
              </div>
            </div>
          </div>
          <div className="mt-2 text-sm text-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
            {tooltip.line.message}
          </div>
          <div className="mt-2 text-xs text-muted-foreground border-t border-border pt-2">
            {new Date(tooltip.line.time * 1000).toLocaleString()}
            <span className="ml-2 text-brand">点击查看详情</span>
          </div>
        </div>
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
        className="w-full px-3 py-1.5 text-sm border border-border rounded bg-card text-foreground text-left flex items-center justify-between hover:border-slate-6 dark:hover:border-slate-6 transition-colors"
      >
        <span className="truncate flex items-center gap-2">
          <svg className="w-4 h-4 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {selectedBranch || '选择分支...'}
          {branches?.current === selectedBranch && (
            <span className="text-xs text-green-11">(当前)</span>
          )}
        </span>
        <svg className={`w-4 h-4 text-slate-9 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-80 flex flex-col">
          <div className="p-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索分支..."
              className="w-full px-2 py-1 text-sm border border-border rounded bg-secondary text-foreground placeholder-slate-9"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {filteredLocal.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground bg-secondary sticky top-0">
                  本地分支
                </div>
                {filteredLocal.map(branch => (
                  <div
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2 ${
                      branch === selectedBranch
                        ? 'bg-brand/10 text-brand'
                        : 'hover:bg-accent text-foreground'
                    }`}
                  >
                    <span className="truncate flex-1">{branch}</span>
                    {branch === branches?.current && (
                      <span className="text-xs text-green-11 flex-shrink-0">当前</span>
                    )}
                    {branch === selectedBranch && (
                      <svg className="w-4 h-4 text-brand flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}
            {filteredRemote.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground bg-secondary sticky top-0">
                  远程分支
                </div>
                {filteredRemote.map(branch => (
                  <div
                    key={branch}
                    onClick={() => handleSelect(branch)}
                    className={`px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2 ${
                      branch === selectedBranch
                        ? 'bg-brand/10 text-brand'
                        : 'hover:bg-accent text-foreground'
                    }`}
                  >
                    <span className="truncate flex-1">{branch}</span>
                    {branch === selectedBranch && (
                      <svg className="w-4 h-4 text-brand flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            )}
            {filteredLocal.length === 0 && filteredRemote.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                未找到分支
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


// ============================================================================
// Main Modal Component
// ============================================================================

interface FileBrowserModalProps {
  onClose: () => void;
  cwd: string;
  initialTab?: TabType;
  tabSwitchTrigger?: number;
}

const COMMITS_PER_PAGE = 50;

export function FileBrowserModal({ onClose, cwd, initialTab = 'tree', tabSwitchTrigger }: FileBrowserModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);

  // Set menu container after mount
  useEffect(() => {
    setMenuContainer(menuContainerRef.current);
  }, []);

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
  // 是否需要滚动到选中文件（仅外部触发选择时为 true，用户在目录树中点击选择时为 false）
  const [shouldScrollToSelected, setShouldScrollToSelected] = useState(false);

  // Blame state
  const [showBlame, setShowBlame] = useState(false);
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [isLoadingBlame, setIsLoadingBlame] = useState(false);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [blameSelectedCommit, setBlameSelectedCommit] = useState<CommitInfo | null>(null);

  // ========== Git Status State ==========
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSelectedFile, setStatusSelectedFile] = useState<{ file: GitFileStatus; type: 'staged' | 'unstaged' } | null>(null);
  const [statusDiff, setStatusDiff] = useState<GitDiffResponse | null>(null);
  // Git Status 右键菜单
    const [statusDiffLoading, setStatusDiffLoading] = useState(false);
  const [statusExpandedPaths, setStatusExpandedPaths] = useState<Set<string>>(new Set());
  const [stagedTree, setStagedTree] = useState<GitFileNode<unknown>[]>([]);
  const [unstagedTree, setUnstagedTree] = useState<GitFileNode<unknown>[]>([]);

  // ========== Git History State ==========
  const [branches, setBranches] = useState<Branch | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
  const [historyFiles, setHistoryFiles] = useState<FileChange[]>([]);
  const [historyFileTree, setHistoryFileTree] = useState<GitFileNode<unknown>[]>([]);
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


  // ========== Update activeTab when initialTab changes ==========
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, tabSwitchTrigger]);

  // ========== Tab 切换处理 ==========
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    // 切换 tab 时关闭 blame 详情
    setBlameSelectedCommit(null);
  }, []);

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

        // 优先关闭 blame commit 详情
        if (blameSelectedCommit) {
          setBlameSelectedCommit(null);
        } else if (showBlame) {
          setShowBlame(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, showBlame, blameSelectedCommit]);

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

  const saveExpandedPathsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveExpandedPaths = useCallback((paths: Set<string>) => {
    // Debounce save to avoid too many requests
    if (saveExpandedPathsTimeoutRef.current) {
      clearTimeout(saveExpandedPathsTimeoutRef.current);
    }
    saveExpandedPathsTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch('/api/files/expanded', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, paths: Array.from(paths) }),
        });
      } catch (err) {
        console.error('Error saving expanded paths:', err);
      }
    }, 500);
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
    // Optimistically update local state (move to front, avoid duplicates)
    setRecentFiles(prev => {
      const filtered = prev.filter(f => f !== filePath);
      return [filePath, ...filtered].slice(0, 15); // Keep max 15 recent files (same as API)
    });

    // Persist to server (fire and forget)
    try {
      await fetch('/api/files/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, file: filePath }),
      });
    } catch (err) {
      console.error('Error adding to recent files:', err);
    }
  }, [cwd]);

  const loadFileContent = useCallback(async (filePath: string) => {
    setIsLoadingContent(true);
    setFileContent(null);
    setShowBlame(false);
    setBlameLines([]);
    setBlameError(null);
    setBlameSelectedCommit(null);
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

    // Auto-expand parent directories
    const parts = path.split('/');
    if (parts.length > 1) {
      const parentPaths: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        parentPaths.push(parts.slice(0, i).join('/'));
      }
      setExpandedPaths(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const p of parentPaths) {
          if (!next.has(p)) {
            next.add(p);
            changed = true;
          }
        }
        if (changed) {
          saveExpandedPaths(next);
        }
        return changed ? next : prev;
      });
    }
  }, [loadFileContent, saveExpandedPaths]);

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

      const staged = buildGitFileTree(data.staged);
      const unstaged = buildGitFileTree(data.unstaged);
      setStagedTree(staged);
      setUnstagedTree(unstaged);

      const allPaths = new Set<string>([
        ...collectGitTreeDirPaths(staged),
        ...collectGitTreeDirPaths(unstaged),
      ]);
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

  const handleStatusFileSelect = useCallback((file: GitFileStatus, type: 'staged' | 'unstaged') => {
    setStatusSelectedFile({ file, type });
    addToRecentFiles(file.path);
  }, [addToRecentFiles]);

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

  // 放弃单个文件的变更
  const handleDiscardFile = useCallback(async (file: GitFileStatus) => {
    try {
      const isUntracked = file.status === 'untracked';
      const response = await fetch('/api/git/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: [file.path], isUntracked }),
      });
      if (!response.ok) {
        throw new Error('Failed to discard file');
      }
      await fetchStatus();
      toast(isUntracked ? '已删除文件' : '已放弃变更', 'success');
    } catch (err) {
      console.error('Error discarding file:', err);
      toast('放弃变更失败', 'error');
    }
  }, [cwd, fetchStatus]);

  // 放弃工作区所有变更
  const handleDiscardAll = useCallback(async () => {
    if (!status?.unstaged.length) return;
    if (!confirm(`确定要放弃工作区的 ${status.unstaged.length} 个文件的变更吗？此操作不可恢复。`)) return;

    try {
      // 分离 untracked 和已跟踪文件
      const untrackedFiles = status.unstaged.filter(f => f.status === 'untracked').map(f => f.path);
      const trackedFiles = status.unstaged.filter(f => f.status !== 'untracked').map(f => f.path);

      // 放弃已跟踪文件的变更
      if (trackedFiles.length > 0) {
        await fetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, files: trackedFiles, isUntracked: false }),
        });
      }

      // 删除 untracked 文件
      if (untrackedFiles.length > 0) {
        await fetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, files: untrackedFiles, isUntracked: true }),
        });
      }

      await fetchStatus();
      toast(`已放弃 ${status.unstaged.length} 个文件的变更`, 'success');
    } catch (err) {
      console.error('Error discarding all:', err);
      toast('放弃变更失败', 'error');
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
        const tree = buildGitFileTree(fileList);
        setHistoryFileTree(tree);
        setHistoryExpandedPaths(new Set(collectGitTreeDirPaths(tree)));
      })
      .catch(console.error)
      .finally(() => setIsLoadingHistoryFiles(false));
  }, [cwd]);

  const handleSelectHistoryFile = useCallback((file: FileChange) => {
    if (!selectedCommit) return;
    setHistorySelectedFile(file);
    addToRecentFiles(file.path);
    setIsLoadingHistoryDiff(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${selectedCommit.hash}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setHistoryFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingHistoryDiff(false));
  }, [cwd, selectedCommit, addToRecentFiles]);

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

  // ========== Initial Data Load (once on mount) ==========
  useEffect(() => {
    loadExpandedPaths();
    loadFiles();
    loadRecentFiles();
    fetchStatus();
    loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load commits when branch changes (user selects a different branch)
  useEffect(() => {
    if (selectedBranch) {
      loadCommits(selectedBranch);
    }
  }, [selectedBranch, loadCommits]);

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

  // ========== Auto-select first recent file when switching to tree/recent tab ==========
  const prevTabRef = useRef<TabType>(activeTab);
  useEffect(() => {
    const prevTab = prevTabRef.current;
    prevTabRef.current = activeTab;

    // When switching from status/history to tree/recent, select the most recent file
    if ((activeTab === 'tree' || activeTab === 'recent') && recentFiles.length > 0) {
      const isFromOtherTab = prevTab === 'status' || prevTab === 'history';
      const needsUpdate = !selectedPath || (isFromOtherTab && selectedPath !== recentFiles[0]);

      if (needsUpdate) {
        // 外部触发选择，需要滚动居中
        setShouldScrollToSelected(true);
        handleSelectFile(recentFiles[0]);
      }
    }
  }, [activeTab, recentFiles, selectedPath, handleSelectFile]);

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

  // Determine loading state for refresh button
  const isRefreshLoading = isLoadingFiles || statusLoading || isLoadingBranches || isLoadingCommits;

  // ========== Auto-sync with fingerprint detection ==========
  const lastFingerprintRef = useRef<string>('');

  const silentRefresh = useCallback(async () => {
    try {
      // 1. Check if anything changed using fingerprint
      const checkRes = await fetch(`/api/sync?cwd=${encodeURIComponent(cwd)}&since=${encodeURIComponent(lastFingerprintRef.current)}`);
      const { changed, fingerprint } = await checkRes.json();

      if (!changed) {
        // No changes, skip refresh
        return;
      }

      // Update fingerprint
      lastFingerprintRef.current = fingerprint;

      // 2. Refresh all data since something changed
      const [filesRes, recentRes, statusRes, commitsRes] = await Promise.all([
        fetch(`/api/files/list?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/files/recent?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
        selectedBranch
          ? fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(selectedBranch)}&limit=${COMMITS_PER_PAGE}`)
          : Promise.resolve(null),
      ]);

      // Process files
      const filesData = await filesRes.json();
      if (!filesData.error) {
        setFiles(filesData.files || []);
      }

      // Process recent files
      const recentData = await recentRes.json();
      setRecentFiles(recentData.files || []);

      // Process Git status
      if (statusRes.ok) {
        const statusData: GitStatusResponse = await statusRes.json();
        setStatus(statusData);
        const staged = buildGitFileTree(statusData.staged);
        const unstaged = buildGitFileTree(statusData.unstaged);
        setStagedTree(staged);
        setUnstagedTree(unstaged);
        const newPaths = new Set<string>([
          ...collectGitTreeDirPaths(staged),
          ...collectGitTreeDirPaths(unstaged),
        ]);
        setStatusExpandedPaths(prev => new Set([...prev, ...newPaths]));
      }

      // Process Git commits
      if (commitsRes) {
        const commitsData = await commitsRes.json();
        const newCommits = commitsData.commits || [];
        setCommits(newCommits);
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      }

      // Refresh current preview file content (if selected)
      if (selectedPath && fileContent?.type === 'text') {
        const contentRes = await fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selectedPath)}`);
        const contentData = await contentRes.json();
        if (contentData.type === 'text') {
          setFileContent(contentData);
        }
      }
    } catch (err) {
      // Silent fail - don't show errors for auto-refresh
      console.error('Silent refresh error:', err);
    }
  }, [cwd, selectedBranch, selectedPath, fileContent?.type]);

  // ========== Auto-sync polling (every 5s) ==========
  useEffect(() => {
    const intervalId = setInterval(() => {
      silentRefresh();
    }, 5000);

    return () => clearInterval(intervalId);
  }, [silentRefresh]);

  return (
    <MenuContainerProvider container={menuContainer}>
      <div ref={menuContainerRef} className="bg-card w-full h-full flex flex-col relative">
        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel */}
          <div className="w-80 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-border">
              <button
                onClick={() => handleTabChange('tree')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'tree'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                目录树
              </button>
              <button
                onClick={() => handleTabChange('recent')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                最近浏览
              </button>
              <button
                onClick={() => handleTabChange('status')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'status'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                Git 变更
              </button>
              <button
                onClick={() => handleTabChange('history')}
                className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === 'history'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                Git 历史
              </button>
            </div>

            {/* Tab-specific content above list */}
            {activeTab === 'tree' && (
              <div className="p-2 border-b border-border">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索文件..."
                  className="w-full px-3 py-1.5 text-sm border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}

            {activeTab === 'history' && (
              <div className="p-3 border-b border-border">
                <BranchSelector
                  branches={branches}
                  selectedBranch={selectedBranch}
                  onSelect={setSelectedBranch}
                  isLoading={isLoadingBranches}
                />
              </div>
            )}

            {/* List Content - 使用 CSS 显示/隐藏避免组件重新挂载 */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Tree Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'tree' ? '' : 'hidden'}`}>
                {isLoadingFiles ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">加载中...</div>
                ) : fileError ? (
                  <div className="p-4 text-center text-red-11 text-sm">{fileError}</div>
                ) : (
                  <FileTree
                    files={files}
                    selectedPath={selectedPath}
                    expandedPaths={expandedPaths}
                    matchedPaths={matchedPaths}
                    onSelect={(path) => {
                      // 用户在目录树中点击选择，不需要滚动居中
                      setShouldScrollToSelected(false);
                      handleSelectFile(path);
                    }}
                    onToggle={handleToggle}
                    cwd={cwd}
                    shouldScrollToSelected={shouldScrollToSelected}
                  />
                )}
              </div>

              {/* Recent Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'recent' ? '' : 'hidden'}`}>
                {recentFiles.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    暂无最近浏览的文件
                  </div>
                ) : (
                  <FileTree
                    files={recentFilesTree}
                    selectedPath={selectedPath}
                    expandedPaths={recentTreeDirPaths}
                    onSelect={handleSelectFile}
                    onToggle={NOOP}
                    cwd={cwd}
                  />
                )}
              </div>

              {/* Status Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'status' ? '' : 'hidden'}`}>
                {statusLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : statusError ? (
                  <div className="flex-1 flex items-center justify-center p-4">
                    <span className="text-red-11 text-sm">{statusError}</span>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {/* Staged Section */}
                    <div className="border-b border-border">
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary">
                        <span className="text-xs font-medium text-muted-foreground">
                          暂存区 ({status?.staged.length || 0})
                        </span>
                        {(status?.staged.length || 0) > 0 && (
                          <button
                            onClick={handleUnstageAll}
                            className="text-xs text-amber-11 hover:text-amber-10 hover:underline"
                          >
                            全部取消
                          </button>
                        )}
                      </div>
                      <GitFileTree
                        files={stagedTree}
                        selectedPath={statusSelectedFile?.type === 'staged' ? statusSelectedFile.file.path : null}
                        expandedPaths={statusExpandedPaths}
                        onSelect={(node) => node.file && handleStatusFileSelect(node.file as GitFileStatus, 'staged')}
                        onToggle={handleStatusToggle}
                        cwd={cwd}
                        emptyMessage="无暂存的文件"
                        className="py-1"
                        renderActions={(node) => !node.isDirectory ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUnstage(node.path);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 dark:hover:bg-amber-9/20 rounded transition-all"
                            title="取消暂存"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                            </svg>
                          </button>
                        ) : null}
                      />
                    </div>

                    {/* Unstaged Section */}
                    <div>
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary">
                        <span className="text-xs font-medium text-muted-foreground">
                          工作区 ({status?.unstaged.length || 0})
                        </span>
                        {(status?.unstaged.length || 0) > 0 && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleDiscardAll}
                              className="text-xs text-red-11 hover:text-red-10 hover:underline"
                            >
                              放弃所有
                            </button>
                            <button
                              onClick={handleStageAll}
                              className="text-xs text-green-11 hover:text-green-10 hover:underline"
                            >
                              全部暂存
                            </button>
                          </div>
                        )}
                      </div>
                      <GitFileTree
                        files={unstagedTree}
                        selectedPath={statusSelectedFile?.type === 'unstaged' ? statusSelectedFile.file.path : null}
                        expandedPaths={statusExpandedPaths}
                        onSelect={(node) => node.file && handleStatusFileSelect(node.file as GitFileStatus, 'unstaged')}
                        onToggle={handleStatusToggle}
                        cwd={cwd}
                        emptyMessage="无未暂存的变更"
                        className="py-1"
                        renderActions={(node) => !node.isDirectory && node.file ? (
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDiscardFile(node.file as GitFileStatus);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-red-11 hover:text-red-10 hover:bg-red-9/10 dark:hover:bg-red-9/20 rounded transition-all"
                              title="放弃变更"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                              </svg>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStage(node.path);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-green-11 hover:text-green-10 hover:bg-green-9/10 dark:hover:bg-green-9/20 rounded transition-all"
                              title="暂存文件"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                            </button>
                          </div>
                        ) : null}
                      />
                    </div>

                  </div>
                )}
              </div>

              {/* History Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'history' ? '' : 'hidden'}`}>
                {historyError ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-16 h-16 mx-auto text-slate-7 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <p className="text-muted-foreground">{historyError}</p>
                    </div>
                  </div>
                ) : (
                  <div
                    ref={commitListRef}
                    className="flex-1 overflow-y-auto"
                    onScroll={handleCommitListScroll}
                  >
                    {isLoadingCommits ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">加载提交记录中...</div>
                    ) : commits.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">无提交记录</div>
                    ) : (
                      <>
                        {commits.map(commit => (
                          <div
                            key={commit.hash}
                            onClick={() => handleSelectCommit(commit)}
                            className={`px-3 py-2 border-b border-border cursor-pointer hover:bg-accent ${
                              selectedCommit?.hash === commit.hash ? 'bg-brand/10' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-brand">{commit.shortHash}</span>
                              <span className="text-xs text-slate-9" title={commit.date}>
                                {commit.relativeDate} · {formatDateTime(commit.date)}
                              </span>
                            </div>
                            <div className="text-sm text-foreground truncate mt-0.5">{commit.subject}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{commit.author}</div>
                          </div>
                        ))}
                        {isLoadingMore && (
                          <div className="p-3 text-center">
                            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        {!hasMoreCommits && commits.length > 0 && (
                          <div className="p-3 text-center text-xs text-slate-9">
                            已加载全部 {commits.length} 条记录
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Panel */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* File Browser / Recent - Right Panel */}
            {(activeTab === 'tree' || activeTab === 'recent') && (
              blameSelectedCommit ? (
                // 当选中 blame commit 时，显示 commit 详情
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => setBlameSelectedCommit(null)}
                  commit={blameSelectedCommit}
                  cwd={cwd}
                  embedded={true}
                  initialFilePath={selectedPath || undefined}
                />
              ) : selectedPath ? (
                <>
                  <div className="px-4 py-2 bg-secondary border-b border-border flex-shrink-0 flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">
                      {selectedPath}
                    </span>
                    {fileContent?.type === 'text' && (
                      <button
                        onClick={handleToggleBlame}
                        disabled={isLoadingBlame}
                        className={`px-2 py-1 text-xs rounded transition-colors ${
                          showBlame
                            ? 'bg-brand text-white'
                            : 'text-muted-foreground hover:bg-accent'
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
                        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : fileContent ? (
                      fileContent.type === 'text' && fileContent.content ? (
                        showBlame ? (
                          blameError ? (
                            <div className="h-full flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <p className="text-red-11">{blameError}</p>
                                <button
                                  onClick={() => setShowBlame(false)}
                                  className="mt-2 text-brand hover:underline text-sm"
                                >
                                  返回预览
                                </button>
                              </div>
                            </div>
                          ) : blameLines.length > 0 ? (
                            <BlameView blameLines={blameLines} cwd={cwd} onSelectCommit={setBlameSelectedCommit} />
                          ) : (
                            <div className="h-full flex items-center justify-center">
                              <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                            </div>
                          )
                        ) : isMarkdownFile(selectedPath) ? (
                          <MarkdownFileViewer content={fileContent.content} filePath={selectedPath} className="h-full" />
                        ) : (
                          <CodeViewer content={fileContent.content} filePath={selectedPath} cwd={cwd} enableComments={true} />
                        )
                      ) : fileContent.type === 'image' && fileContent.content ? (
                        <div className="h-full flex items-center justify-center p-4 bg-secondary">
                          <img
                            src={fileContent.content}
                            alt={selectedPath}
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                      ) : (
                        <div className="h-full flex items-center justify-center text-muted-foreground">
                          <div className="text-center">
                            <svg className="w-16 h-16 mx-auto text-slate-7 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p>{fileContent.message || '无法预览此文件'}</p>
                          </div>
                        </div>
                      )
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        选择文件以预览
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <svg className="w-16 h-16 mx-auto text-slate-7 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <p>选择文件以预览</p>
                  </div>
                </div>
              )
            )}

            {/* Status - Right Panel */}
            {activeTab === 'status' && (
              statusSelectedFile && statusDiff ? (
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="px-4 py-2 bg-secondary border-b border-border flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">
                      {statusSelectedFile.file.path}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      statusSelectedFile.type === 'staged'
                        ? 'bg-green-9/15 text-green-11 dark:bg-green-9/25'
                        : 'bg-amber-9/15 text-amber-11 dark:bg-amber-9/25'
                    }`}>
                      {statusSelectedFile.type === 'staged' ? '已暂存' : '未暂存'}
                    </span>
                  </div>
                  <div className="flex-1 overflow-auto">
                    {isImageFile(statusSelectedFile.file.path) ? (
                      <div className="p-4 flex items-center justify-center">
                        <img
                          src={`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(statusSelectedFile.file.path)}&raw=1`}
                          alt={statusSelectedFile.file.path}
                          className="max-w-full max-h-[60vh] object-contain"
                        />
                      </div>
                    ) : (
                      <DiffView
                        oldContent={statusDiff.oldContent}
                        newContent={statusDiff.newContent}
                        filePath={statusDiff.filePath}
                        isNew={statusDiff.isNew}
                        isDeleted={statusDiff.isDeleted}
                        cwd={cwd}
                        enableComments={true}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-9">
                  <span>选择文件查看差异</span>
                </div>
              )
            )}

            {/* History - Right Panel */}
            {activeTab === 'history' && !historyError && (
              selectedCommit ? (
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => setSelectedCommit(null)}
                  commit={selectedCommit}
                  cwd={cwd}
                  embedded={true}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-9">
                  <span>选择提交查看详情</span>
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </MenuContainerProvider>
  );
}
