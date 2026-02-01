'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DiffView } from './DiffView';

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

// Format date time for display (e.g., "01-15 14:30" or "2024-01-15 14:30")
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

const COMMITS_PER_PAGE = 50;

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
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreCommits, setHasMoreCommits] = useState(true);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commitListRef = useRef<HTMLDivElement>(null);

  // Tooltip state for commit info
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Handle mouse move on commit info area
  const handleCommitInfoMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCommitInfoMouseLeave = useCallback(() => {
    setTooltipPos(null);
  }, []);

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
  const loadBranches = useCallback(() => {
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
  }, [cwd]);

  useEffect(() => {
    if (!isOpen) return;
    loadBranches();
  }, [isOpen, loadBranches]);

  // Load commits function (initial load)
  const loadCommits = useCallback((branch: string) => {
    setIsLoadingCommits(true);
    setSelectedCommit(null);
    setFiles([]);
    setFileTree([]);
    setSelectedFile(null);
    setFileDiff(null);
    setHasMoreCommits(true);
    fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}&limit=${COMMITS_PER_PAGE}`)
      .then(res => res.json())
      .then(data => {
        const newCommits = data.commits || [];
        setCommits(newCommits);
        // 如果返回的数量少于请求的数量，说明没有更多了
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      })
      .catch(console.error)
      .finally(() => setIsLoadingCommits(false));
  }, [cwd]);

  // Load more commits (incremental load)
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
        // 如果返回的数量少于请求的数量，说明没有更多了
        setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
      })
      .catch(console.error)
      .finally(() => setIsLoadingMore(false));
  }, [cwd, selectedBranch, commits.length, isLoadingMore, hasMoreCommits]);

  // Handle scroll to load more
  const handleCommitListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const { scrollTop, scrollHeight, clientHeight } = target;

    // 当滚动到距离底部 100px 时加载更多
    if (scrollHeight - scrollTop - clientHeight < 100) {
      loadMoreCommits();
    }
  }, [loadMoreCommits]);

  // Refresh - reload branches and commits
  const handleRefresh = useCallback(() => {
    loadBranches();
    if (selectedBranch) {
      loadCommits(selectedBranch);
    }
  }, [loadBranches, loadCommits, selectedBranch]);

  // Load commits when branch changes
  useEffect(() => {
    if (!selectedBranch) return;
    loadCommits(selectedBranch);
  }, [selectedBranch, loadCommits]);

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
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={isLoadingBranches || isLoadingCommits}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
              title="刷新"
            >
              <svg className={`w-5 h-5 ${isLoadingBranches || isLoadingCommits ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                  {/* Loading more indicator */}
                  {isLoadingMore && (
                    <div className="p-3 text-center">
                      <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {/* End of list indicator */}
                  {!hasMoreCommits && commits.length > 0 && (
                    <div className="p-3 text-center text-xs text-gray-400 dark:text-gray-500">
                      已加载全部 {commits.length} 条记录
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          )}

          {/* Right panel - Commit info + File tree + Diff */}
          {!error && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedCommit ? (
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
                    <span>{files.length} files changed</span>
                  </div>
                </div>
                {/* Floating tooltip following mouse */}
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
                      <DiffView
                        oldContent={fileDiff.oldContent}
                        newContent={fileDiff.newContent}
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
