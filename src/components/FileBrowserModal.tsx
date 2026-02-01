'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

// Types
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

// Build tree from file paths
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

  // Sort: directories first, then alphabetically
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

// Collect all directory paths from tree
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

// File icon mapping (defined outside component for performance)
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

// Compute matched paths for search (memoizable)
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
      // Also add all ancestors
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

// Flattened tree item for virtual scrolling
interface FlatTreeItem {
  node: FileNode;
  level: number;
}

// Flatten tree for virtual scrolling (only visible nodes)
function flattenTree(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  matchedPaths: Set<string> | null,
  level: number = 0
): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];

  for (const node of nodes) {
    // Skip if searching and this node doesn't match
    if (matchedPaths !== null && !matchedPaths.has(node.path)) {
      continue;
    }

    result.push({ node, level });

    // If directory is expanded, add children
    if (node.isDirectory && node.children && expandedPaths.has(node.path)) {
      result.push(...flattenTree(node.children, expandedPaths, matchedPaths, level + 1));
    }
  }

  return result;
}

// No-op function constant (avoids creating new function on each render)
const NOOP = () => {};

// Row height for virtual scrolling
const ROW_HEIGHT = 24;

// Virtual Tree Row - single row component for virtual scrolling (no recursion)
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

// Props interface for FileTreeItem (used for Recent files - non-virtual)
interface FileTreeItemProps {
  node: FileNode;
  level: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  matchedPaths: Set<string> | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

// File Tree Item Component - recursive, for Recent files (small list)
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

  // If searching, check if this node matches
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
})

// Virtual File Tree Component - uses virtualization for large file lists
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

  // Flatten tree based on current expansion state
  const flatItems = useMemo(() => {
    return flattenTree(files, expandedPaths, matchedPaths);
  }, [files, expandedPaths, matchedPaths]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10, // Render 10 extra items above/below viewport
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

// Code Preview Component with Syntax Highlighting
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Main Modal Component
interface FileBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
}

export function FileBrowserModal({ isOpen, onClose, cwd }: FileBrowserModalProps) {
  const [activeTab, setActiveTab] = useState<'tree' | 'recent'>('tree');
  const [files, setFiles] = useState<FileNode[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Build tree from recent files
  const recentFilesTree = useMemo(() => {
    return buildTreeFromPaths(recentFiles);
  }, [recentFiles]);

  // All directories in recent files tree (for full expansion)
  const recentTreeDirPaths = useMemo(() => {
    return new Set(collectAllDirPaths(recentFilesTree));
  }, [recentFilesTree]);

  // Memoized search matched paths
  const matchedPaths = useMemo(() => {
    if (!searchQuery) return null;
    return computeMatchedPaths(files, searchQuery);
  }, [files, searchQuery]);

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

  // Load saved expanded paths
  const loadExpandedPaths = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/expanded?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (data.paths && Array.isArray(data.paths) && data.paths.length > 0) {
        setExpandedPaths(new Set(data.paths));
      }
      // If no saved paths, keep the default empty Set (all collapsed)
    } catch (err) {
      console.error('Error loading expanded paths:', err);
    }
  }, [cwd]);

  // Save expanded paths
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

  // Load file tree (no longer handles expanded paths - that's done by loadExpandedPaths)
  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/list?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setFiles(data.files || []);
      }
    } catch (err) {
      console.error('Error loading files:', err);
      setError('Failed to load files');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [cwd]);

  // Load recent files
  const loadRecentFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/recent?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      setRecentFiles(data.files || []);
    } catch (err) {
      console.error('Error loading recent files:', err);
    }
  }, [cwd]);

  // Add to recent files
  const addToRecentFiles = useCallback(async (filePath: string) => {
    try {
      await fetch('/api/files/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, file: filePath }),
      });
      // Refresh recent files list
      loadRecentFiles();
    } catch (err) {
      console.error('Error adding to recent files:', err);
    }
  }, [cwd, loadRecentFiles]);

  // Load file content
  const loadFileContent = useCallback(async (filePath: string) => {
    setIsLoadingContent(true);
    setFileContent(null);
    try {
      const res = await fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      setFileContent(data);
      // Add to recent files
      addToRecentFiles(filePath);
    } catch (err) {
      console.error('Error loading file content:', err);
      setFileContent({ type: 'error', message: 'Failed to load file' });
    } finally {
      setIsLoadingContent(false);
    }
  }, [cwd, addToRecentFiles]);

  // Initialize on open
  useEffect(() => {
    if (isOpen) {
      loadExpandedPaths();
      loadFiles();
      loadRecentFiles();
      // Focus search input
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen, loadExpandedPaths, loadFiles, loadRecentFiles]);

  // Handle file selection
  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
    loadFileContent(path);
  }, [loadFileContent]);

  // Handle directory toggle (only for main tree, saves state)
  const handleToggle = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      // Save to storage
      saveExpandedPaths(next);
      return next;
    });
  }, [saveExpandedPaths]);

  // Handle refresh
  const handleRefresh = useCallback(() => {
    loadFiles();
    loadRecentFiles();
  }, [loadFiles, loadRecentFiles]);

  // Filter files based on search - expand matching directories
  useEffect(() => {
    if (searchQuery) {
      // Auto-expand directories that contain matching files
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

  if (!isOpen) return null;

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
              disabled={isLoadingFiles}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
              title="刷新"
            >
              <svg className={`w-5 h-5 ${isLoadingFiles ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'tree'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                目录树
              </button>
              <button
                onClick={() => setActiveTab('recent')}
                className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                最近浏览
              </button>
            </div>

            {/* Search (only for tree tab) */}
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

            {/* File List / Recent List */}
            <div className="flex-1 overflow-hidden">
              {activeTab === 'tree' ? (
                isLoadingFiles ? (
                  <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">Loading...</div>
                ) : error ? (
                  <div className="p-4 text-center text-red-500 text-sm">{error}</div>
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
              ) : (
                // Recent files tab - tree view
                recentFiles.length === 0 ? (
                  <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                    暂无最近浏览的文件
                  </div>
                ) : (
                  <div className="py-1">
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
            </div>
          </div>

          {/* Right Panel - Preview */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedPath ? (
              <>
                {/* File path header */}
                <div className="px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                  <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
                    {selectedPath}
                  </span>
                </div>

                {/* Preview content */}
                <div className="flex-1 overflow-hidden">
                  {isLoadingContent ? (
                    <div className="h-full flex items-center justify-center">
                      <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : fileContent ? (
                    fileContent.type === 'text' && fileContent.content ? (
                      <CodePreview content={fileContent.content} filePath={selectedPath} />
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
