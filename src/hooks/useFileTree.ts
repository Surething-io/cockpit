import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { type CommitInfo } from '../components/project/CommitDetailPanel';
import type { FileNode, FileContent, BlameLine } from '../components/project/fileBrowser/types';
import { buildTreeFromPaths, collectAllDirPaths, computeMatchedPaths } from '../components/project/fileBrowser/utils';

interface UseFileTreeOptions {
  cwd: string;
}

export function useFileTree({ cwd }: UseFileTreeOptions) {
  // ========== File Browser State ==========
  const [files, setFiles] = useState<FileNode[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchTreeExpandedPaths, setSearchTreeExpandedPaths] = useState<Set<string> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchExactMatch, setSearchDirExact] = useState(false);
  // 新建文件状态
  const [creatingItem, setCreatingItem] = useState<{ type: 'file'; parentPath: string } | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 是否需要滚动到选中文件（仅外部触发选择时为 true，用户在目录树中点击选择时为 false）
  const [shouldScrollToSelected, setShouldScrollToSelected] = useState(false);
  // 跳转到的目标行号（搜索结果点击时使用）
  const [targetLineNumber, setTargetLineNumber] = useState<number | null>(null);

  // Blame state
  const [showBlame, setShowBlame] = useState(false);
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [isLoadingBlame, setIsLoadingBlame] = useState(false);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [blameSelectedCommit, setBlameSelectedCommit] = useState<CommitInfo | null>(null);

  // Markdown 预览 Modal
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);

  // 编辑 Modal
  const [showEditor, setShowEditor] = useState(false);

  // ========== Memoized Values ==========
  const recentFilesTree = useMemo(() => {
    return buildTreeFromPaths(recentFiles);
  }, [recentFiles]);

  const recentTreeDirPaths = useMemo(() => {
    return new Set(collectAllDirPaths(recentFilesTree));
  }, [recentFilesTree]);

  const matchedPaths = useMemo(() => {
    if (!searchQuery) return null;
    return computeMatchedPaths(files, searchQuery, searchExactMatch);
  }, [files, searchQuery, searchExactMatch]);

  // 搜索态展开状态：从 matchedPaths 直接计算，每次搜索词变化都重新生成
  useEffect(() => {
    if (!matchedPaths || matchedPaths.size === 0) {
      setSearchTreeExpandedPaths(null);
      return;
    }
    const expanded = new Set<string>();
    const collectDirs = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.isDirectory && node.children && matchedPaths.has(node.path)) {
          expanded.add(node.path);
          collectDirs(node.children);
        }
      }
    };
    collectDirs(files);
    setSearchTreeExpandedPaths(expanded);
  }, [matchedPaths, files]);

  // 搜索态用独立的展开状态，非搜索态用用户手动管理的状态
  const effectiveExpandedPaths = searchTreeExpandedPaths ?? expandedPaths;

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

  const loadBlame = useCallback(async (pathOverride?: string) => {
    const path = pathOverride || selectedPath;
    if (!path) return;
    setIsLoadingBlame(true);
    setBlameError(null);
    try {
      const res = await fetch(`/api/files/blame?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
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
      // 自动加载 blame（用于 inline blame 注释，不阻塞文件内容展示）
      loadBlame(filePath);
    } catch (err) {
      console.error('Error loading file content:', err);
      setFileContent({ type: 'error', message: 'Failed to load file' });
    } finally {
      setIsLoadingContent(false);
    }
  }, [cwd, addToRecentFiles, loadBlame]);

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

  const handleSelectFile = useCallback((path: string, lineNumber?: number) => {
    setSelectedPath(path);
    setTargetLineNumber(lineNumber ?? null);
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
    if (searchTreeExpandedPaths) {
      // 搜索态：修改临时展开状态，不持久化
      setSearchTreeExpandedPaths(prev => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    } else {
      // 非搜索态：修改用户展开状态，持久化
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
    }
  }, [searchTreeExpandedPaths, saveExpandedPaths]);

  return {
    // File tree state
    files,
    setFiles,
    expandedPaths,
    setExpandedPaths,
    searchTreeExpandedPaths,
    setSearchTreeExpandedPaths,
    effectiveExpandedPaths,
    searchQuery,
    setSearchQuery,
    searchExactMatch,
    setSearchDirExact,
    matchedPaths,
    creatingItem,
    setCreatingItem,
    isLoadingFiles,
    fileError,
    searchInputRef,
    shouldScrollToSelected,
    setShouldScrollToSelected,
    targetLineNumber,
    setTargetLineNumber,

    // Shared file viewing state
    selectedPath,
    setSelectedPath,
    fileContent,
    setFileContent,
    isLoadingContent,
    recentFiles,
    setRecentFiles,
    recentFilesTree,
    recentTreeDirPaths,

    // Blame state
    showBlame,
    setShowBlame,
    blameLines,
    isLoadingBlame,
    blameError,
    blameSelectedCommit,
    setBlameSelectedCommit,

    // Modal state
    showMarkdownPreview,
    setShowMarkdownPreview,
    showEditor,
    setShowEditor,

    // Actions
    loadExpandedPaths,
    saveExpandedPaths,
    loadFiles,
    loadRecentFiles,
    addToRecentFiles,
    loadFileContent,
    loadBlame,
    handleToggleBlame,
    handleSelectFile,
    handleToggle,
  };
}
