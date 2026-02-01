'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { DiffView } from './DiffView';

// Types
export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  relativeDate?: string;
  time?: number; // Unix timestamp (for blame)
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

// Main component props
interface CommitDetailPanelProps {
  isOpen: boolean;
  onClose: () => void;
  commit: CommitInfo | null;
  cwd: string;
}

export function CommitDetailPanel({ isOpen, onClose, commit, cwd }: CommitDetailPanelProps) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileChange | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Load files when commit changes
  useEffect(() => {
    if (!isOpen || !commit) return;

    setFiles([]);
    setFileTree([]);
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
  }, [isOpen, commit, cwd]);

  // Load diff when file selected
  const handleSelectFile = useCallback((file: FileChange) => {
    if (!commit) return;
    setSelectedFile(file);
    setIsLoadingDiff(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingDiff(false));
  }, [cwd, commit]);

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

  // Format display date
  const displayDate = useMemo(() => {
    if (!commit) return '';
    if (commit.date) {
      return formatDateTime(commit.date);
    }
    if (commit.time) {
      return new Date(commit.time * 1000).toLocaleString();
    }
    return '';
  }, [commit]);

  if (!isOpen || !commit) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 w-full h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Commit 详情</h3>
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
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Commit info header */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex-shrink-0">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
              {commit.subject}
            </div>
            {commit.body && (
              <div className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap mb-3 max-h-32 overflow-y-auto border-l-2 border-gray-300 dark:border-gray-600 pl-3">
                {commit.body}
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-xs text-gray-500 dark:text-gray-400">
              <div className="flex items-center gap-1">
                <span className="text-gray-400">Hash:</span>
                <span className="font-mono bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                  {commit.hash}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-400">Author:</span>
                <span>{commit.author}</span>
                <span className="text-gray-400">&lt;{commit.authorEmail}&gt;</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-400">Date:</span>
                <span>{displayDate}</span>
                {commit.relativeDate && (
                  <span className="text-gray-400">({commit.relativeDate})</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-400">Files:</span>
                <span>{files.length} changed</span>
              </div>
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
                <DiffView
                  oldContent={fileDiff.oldContent}
                  newContent={fileDiff.newContent}
                  filePath={fileDiff.filePath}
                  isNew={fileDiff.isNew}
                  isDeleted={fileDiff.isDeleted}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm">
                  Select a file to view diff
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
