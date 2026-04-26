import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { type CommitInfo } from '../components/project/CommitDetailPanel';
import type { FileNode, FileContent, BlameLine } from '../components/project/fileBrowser/types';
import { buildTreeFromPaths, collectAllDirPaths, computeMatchedPaths, computeMatchedPathsFromIndex, findNodeByPath } from '../components/project/fileBrowser/utils';
import type { RecentFileEntry } from '../app/api/files/recent/route';

interface UseFileTreeOptions {
  cwd: string;
}

export function useFileTree({ cwd }: UseFileTreeOptions) {
  // ========== File Browser State ==========
  const [files, setFiles] = useState<FileNode[]>([]);
  const [fileIndex, setFileIndex] = useState<string[] | null>(null);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchTreeExpandedPaths, setSearchTreeExpandedPaths] = useState<Set<string> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchExactMatch, setSearchDirExact] = useState(false);
  // New file creation state
  const [creatingItem, setCreatingItem] = useState<{ type: 'file'; parentPath: string } | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Whether to scroll to the selected file (true only when triggered externally; false when user clicks in the tree)
  const [shouldScrollToSelected, setShouldScrollToSelected] = useState(false);
  // Target line number to jump to (used when clicking a search result)
  const [targetLineNumber, setTargetLineNumber] = useState<number | null>(null);
  // Scroll alignment: 'start' = restore position (align to first line), 'center' = search/LSP jump (center highlight)
  const [targetScrollAlign, setTargetScrollAlign] = useState<'center' | 'start'>('center');
  // Restore cursor position (when switching back from recent files)
  const [initialCursorLine, setInitialCursorLine] = useState<number | null>(null);
  const [initialCursorCol, setInitialCursorCol] = useState<number | null>(null);

  // Blame state
  const [showBlame, setShowBlame] = useState(false);
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [isLoadingBlame, setIsLoadingBlame] = useState(false);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [blameSelectedCommit, setBlameSelectedCommit] = useState<CommitInfo | null>(null);

  // Markdown preview modal
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);

  // Edit modal
  const [showEditor, setShowEditor] = useState(false);

  // ========== Memoized Values ==========
  const recentFilePaths = useMemo(() => recentFiles.map(f => f.path).filter(Boolean), [recentFiles]);

  const recentFilesTree = useMemo(() => {
    return buildTreeFromPaths(recentFilePaths);
  }, [recentFilePaths]);

  const recentTreeDirPaths = useMemo(() => {
    return new Set(collectAllDirPaths(recentFilesTree));
  }, [recentFilesTree]);

  const matchedPaths = useMemo(() => {
    if (!searchQuery) return null;
    // Prefer fileIndex for search (covers all files including unloaded dirs)
    if (fileIndex) {
      return computeMatchedPathsFromIndex(fileIndex, searchQuery, searchExactMatch);
    }
    return computeMatchedPaths(files, searchQuery, searchExactMatch);
  }, [files, fileIndex, searchQuery, searchExactMatch]);

  // Search-mode expanded state: computed directly from matchedPaths, regenerated on every query change
  useEffect(() => {
    if (!matchedPaths || matchedPaths.size === 0) {
      setSearchTreeExpandedPaths(null);
      return;
    }
    const expanded = new Set<string>();
    if (fileIndex) {
      // With index: directories are paths in matchedPaths but not in fileIndex
      const fileSet = new Set(fileIndex);
      for (const p of matchedPaths) {
        if (!fileSet.has(p)) expanded.add(p);
      }
    } else {
      // Without index: traverse tree as before
      const collectDirs = (nodes: FileNode[]) => {
        for (const node of nodes) {
          if (node.isDirectory && node.children && matchedPaths.has(node.path)) {
            expanded.add(node.path);
            collectDirs(node.children);
          }
        }
      };
      collectDirs(files);
    }
    setSearchTreeExpandedPaths(expanded);
  }, [matchedPaths, files, fileIndex]);

  // Use separate expanded state in search mode; use user-managed state in non-search mode
  const effectiveExpandedPaths = searchTreeExpandedPaths ?? expandedPaths;

  // ========== File Browser Functions ==========
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
      const res = await fetch(`/api/files/init?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (data.error) {
        setFileError(data.error);
      } else {
        setFiles(data.files || []);
        // init returns expandedPaths from persisted state
        if (data.expandedPaths && Array.isArray(data.expandedPaths)) {
          setExpandedPaths(new Set(data.expandedPaths));
        }
      }
    } catch (err) {
      console.error('Error loading files:', err);
      setFileError('Failed to load files');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [cwd]);

  const loadFileIndex = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/index?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      if (data.paths) {
        setFileIndex(data.paths);
      }
    } catch (err) {
      console.error('Error loading file index:', err);
    }
  }, [cwd]);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoadingDirs(prev => new Set([...prev, dirPath]));
    try {
      const res = await fetch(`/api/files/readdir?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.children) {
        setFiles(prev => {
          if (!dirPath) {
            // Root directory: replace top-level nodes while preserving children of already-loaded subdirectories
            const prevMap = new Map(prev.map(n => [n.path, n]));
            return (data.children as FileNode[]).map(newNode => {
              const existing = prevMap.get(newNode.path);
              return existing?.children && newNode.isDirectory
                ? { ...newNode, children: existing.children }
                : newNode;
            });
          }
          const next = structuredClone(prev);
          const node = findNodeByPath(next, dirPath);
          if (node) {
            node.children = data.children;
          }
          return next;
        });
      }
    } catch (err) {
      console.error('Error loading directory:', err);
    } finally {
      setLoadingDirs(prev => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [cwd]);

  // Safety net: auto-load expanded dirs that don't have children yet
  // Covers both normal expandedPaths and search searchTreeExpandedPaths
  const loadingDirsRef = useRef(loadingDirs);
  loadingDirsRef.current = loadingDirs;
  useEffect(() => {
    const pathsToCheck = searchTreeExpandedPaths ?? expandedPaths;
    for (const p of pathsToCheck) {
      const node = findNodeByPath(files, p);
      if (node && node.isDirectory && !node.children && !loadingDirsRef.current.has(p)) {
        loadDirectory(p);
      }
    }
  }, [files, expandedPaths, searchTreeExpandedPaths, loadDirectory]);

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
      const filtered = prev.filter(f => f.path !== filePath);
      return [{ path: filePath }, ...filtered].slice(0, 15);
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

  /** Update the cursor/scroll position of a recent file entry (without changing order) */
  const updateRecentFilePosition = useCallback((filePath: string, scrollLine: number, cursorLine: number, cursorCol: number) => {
    // Optimistically update local state
    setRecentFiles(prev => prev.map(f =>
      f.path === filePath ? { ...f, scrollLine, cursorLine, cursorCol } : f
    ));

    // Persist to server (fire and forget)
    fetch('/api/files/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, file: filePath, scrollLine, cursorLine, cursorCol }),
    }).catch(() => {});
  }, [cwd]);

  /** Find a file's saved position in the recent files list */
  const getRecentFilePosition = useCallback((filePath: string) => {
    return recentFiles.find(f => f.path === filePath);
  }, [recentFiles]);

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
      // Two-step: cheap stat decides what to do; only text fetches bytes.
      // Image bytes are NEVER pulled into JS heap — the renderer uses <FileImagePreview/>
      // which talks to /api/files/read directly via <img src>.
      const statRes = await fetch(
        `/api/files/stat?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`,
        { cache: 'no-store' },
      );
      const stat = await statRes.json();

      if (!statRes.ok) {
        setFileContent({ type: 'error', message: stat?.error || 'Failed to stat file' });
        return;
      }
      if (!stat.exists) {
        setFileContent({ type: 'error', message: 'File not found' });
        return;
      }
      if (stat.kind === 'dir') {
        setFileContent({ type: 'error', message: 'Path is a directory' });
        return;
      }

      switch (stat.category) {
        case 'image': {
          // No fetch — the image renderer streams directly from /read.
          setFileContent({
            type: 'image',
            size: stat.size,
            mtime: stat.mtimeMs,
            ...(stat.isSymlink ? { isSymlink: true, symlinkTarget: stat.symlinkTarget } : {}),
          });
          break;
        }
        case 'binary': {
          setFileContent({
            type: 'binary',
            message: 'Cannot preview binary file',
            size: stat.size,
            mtime: stat.mtimeMs,
          });
          break;
        }
        case 'too-large': {
          setFileContent({
            type: 'error',
            message: 'File too large to preview',
            size: stat.size,
            mtime: stat.mtimeMs,
          });
          break;
        }
        case 'text':
        default: {
          const textRes = await fetch(
            `/api/files/text?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`,
            { cache: 'no-store' },
          );
          if (textRes.status === 409) {
            // File turned out to be binary on second sniff
            const body = await textRes.json().catch(() => ({}));
            setFileContent({
              type: 'binary',
              message: body?.error || 'Cannot preview binary file',
              size: stat.size,
              mtime: stat.mtimeMs,
            });
            break;
          }
          if (!textRes.ok) {
            const body = await textRes.json().catch(() => ({}));
            setFileContent({ type: 'error', message: body?.error || 'Failed to load file' });
            break;
          }
          const text = await textRes.json();
          setFileContent({
            type: 'text',
            content: text.content,
            size: text.size,
            mtime: text.mtimeMs,
            ...(text.isSymlink ? { isSymlink: true, symlinkTarget: text.symlinkTarget } : {}),
          });
          break;
        }
      }
      addToRecentFiles(filePath);
      // Auto-load blame (used for inline blame annotations, does not block file content rendering)
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
    if (!path) return;
    setSelectedPath(path);
    setTargetLineNumber(lineNumber ?? null);
    // If no line number is specified, try to restore position from recent files
    if (lineNumber == null) {
      const pos = recentFiles.find(f => f.path === path);
      if (pos?.scrollLine) {
        setTargetLineNumber(pos.scrollLine);
        setTargetScrollAlign('start');         // Restore position: align to first line
        setInitialCursorLine(pos.cursorLine ?? null);
        setInitialCursorCol(pos.cursorCol ?? null);
      } else {
        setTargetScrollAlign('center');
        setInitialCursorLine(null);
        setInitialCursorCol(null);
      }
    } else {
      setTargetScrollAlign('center');          // Search/LSP jump: center highlight
      setInitialCursorLine(null);
      setInitialCursorCol(null);
    }
    loadFileContent(path);

    // Auto-expand parent directories + lazy load handled by safety net useEffect
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
  }, [loadFileContent, saveExpandedPaths, recentFiles]);

  const handleToggle = useCallback((path: string) => {
    if (searchTreeExpandedPaths) {
      // Search mode: modify temporary expanded state, do not persist
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
      // Non-search mode: modify user expanded state and persist
      const isExpanding = !expandedPaths.has(path);
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
      // Lazy load: expanding a dir that hasn't loaded children yet
      if (isExpanding) {
        const node = findNodeByPath(files, path);
        if (node && node.isDirectory && !node.children) {
          loadDirectory(path);
        }
      }
    }
  }, [searchTreeExpandedPaths, saveExpandedPaths, expandedPaths, files, loadDirectory]);

  return {
    // File tree state
    files,
    setFiles,
    fileIndex,
    setFileIndex,
    loadingDirs,
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
    targetScrollAlign,
    setTargetScrollAlign,
    initialCursorLine,
    initialCursorCol,
    setInitialCursorLine,
    setInitialCursorCol,

    // Shared file viewing state
    selectedPath,
    setSelectedPath,
    fileContent,
    setFileContent,
    isLoadingContent,
    recentFiles,
    recentFilePaths,
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
    saveExpandedPaths,
    loadFiles,
    loadFileIndex,
    loadDirectory,
    loadRecentFiles,
    addToRecentFiles,
    updateRecentFilePosition,
    getRecentFilePosition,
    loadFileContent,
    loadBlame,
    handleToggleBlame,
    handleSelectFile,
    handleToggle,
  };
}
