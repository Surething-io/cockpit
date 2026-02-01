'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from './Toast';
import { DiffView } from './DiffView';

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
      toast('已暂存', 'success');
    } catch (err) {
      console.error('Error staging file:', err);
      toast('暂存失败', 'error');
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
      toast('已取消暂存', 'success');
    } catch (err) {
      console.error('Error unstaging file:', err);
      toast('取消暂存失败', 'error');
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
      toast(`已暂存 ${status.unstaged.length} 个文件`, 'success');
    } catch (err) {
      console.error('Error staging all files:', err);
      toast('暂存失败', 'error');
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
      toast(`已取消暂存 ${status.staged.length} 个文件`, 'success');
    } catch (err) {
      console.error('Error unstaging all files:', err);
      toast('取消暂存失败', 'error');
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
                  <DiffView
                    oldContent={diff.oldContent}
                    newContent={diff.newContent}
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
