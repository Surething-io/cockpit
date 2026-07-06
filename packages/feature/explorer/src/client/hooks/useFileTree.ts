import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { type CommitInfo } from '../CommitDetailPanel';
import type { FileNode, FileContent, BlameLine } from '../fileBrowser/types';
import { buildTreeFromPaths, collectAllDirPaths, computeMatchedPaths, computeMatchedPathsFromIndex, findNodeByPath } from '../fileBrowser/utils';
import type { RecentFileEntry } from '@/app/api/files/recent/route';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadFilesInit,
  loadFileIndex as loadFileIndexEff,
  readDirectory,
  loadRecentFiles as loadRecentFilesEff,
  persistRecentFile,
  saveExpandedPaths as saveExpandedPathsEff,
  loadBlame as loadBlameEff,
  fetchFileStat,
  fetchFileText,
  type StatLike,
} from '../effect/filesClient';

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

  // Markdown in-place preview — global toggle (session-level, persists across file switches)
  // Markdown files default to preview mode (rendered view) when opened.
  const [previewMarkdown, setPreviewMarkdown] = useState(true);

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
    saveExpandedPathsTimeoutRef.current = setTimeout(() => {
      BrowserRuntime.runFork(
        saveExpandedPathsEff(cwd, Array.from(paths)).pipe(
          Effect.tapError((err) =>
            Effect.sync(() => console.error('Error saving expanded paths:', err))
          ),
          Effect.orElse(() => Effect.void)
        )
      );
    }, 500);
  }, [cwd]);

  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true);
    setFileError(null);
    await BrowserRuntime.runPromise(
      loadFilesInit<FileNode>(cwd).pipe(
        Effect.match({
          onSuccess: (data) => {
            if (data.error) {
              setFileError(data.error);
            } else {
              setFiles((data.files ?? []) as FileNode[]);
              // init returns expandedPaths from persisted state
              if (data.expandedPaths && Array.isArray(data.expandedPaths)) {
                setExpandedPaths(new Set(data.expandedPaths));
              }
            }
          },
          onFailure: (err) => {
            console.error('Error loading files:', err);
            setFileError('Failed to load files');
          },
        })
      )
    );
    setIsLoadingFiles(false);
  }, [cwd]);

  const loadFileIndex = useCallback(() => {
    BrowserRuntime.runPromise(
      loadFileIndexEff(cwd).pipe(
        Effect.match({
          onSuccess: (data) => {
            if (data.paths) {
              setFileIndex(data.paths as string[]);
            }
          },
          onFailure: (err) => {
            console.error('Error loading file index:', err);
          },
        })
      )
    );
  }, [cwd]);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoadingDirs(prev => new Set([...prev, dirPath]));
    await BrowserRuntime.runPromise(
      readDirectory<FileNode>(cwd, dirPath).pipe(
        Effect.match({
          onSuccess: (data) => {
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
                  node.children = data.children as FileNode[];
                }
                return next;
              });
            }
          },
          onFailure: (err) => {
            console.error('Error loading directory:', err);
          },
        })
      )
    );
    setLoadingDirs(prev => {
      const next = new Set(prev);
      next.delete(dirPath);
      return next;
    });
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
    await BrowserRuntime.runPromise(
      loadRecentFilesEff<RecentFileEntry>(cwd).pipe(
        Effect.match({
          onSuccess: (data) => setRecentFiles((data.files ?? []) as RecentFileEntry[]),
          onFailure: (err) => console.error('Error loading recent files:', err),
        })
      )
    );
  }, [cwd]);

  const addToRecentFiles = useCallback(async (filePath: string) => {
    // Optimistically update local state (move to front, avoid duplicates)
    setRecentFiles(prev => {
      const filtered = prev.filter(f => f.path !== filePath);
      return [{ path: filePath }, ...filtered].slice(0, 15);
    });

    // Persist to server (fire and forget)
    await BrowserRuntime.runPromise(
      persistRecentFile(cwd, filePath).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => console.error('Error adding to recent files:', err))
        ),
        Effect.orElse(() => Effect.void)
      )
    );
  }, [cwd]);

  /** Update the cursor/scroll position of a recent file entry (without changing order) */
  const updateRecentFilePosition = useCallback((filePath: string, scrollLine: number, cursorLine: number, cursorCol: number) => {
    // Optimistically update local state
    setRecentFiles(prev => prev.map(f =>
      f.path === filePath ? { ...f, scrollLine, cursorLine, cursorCol } : f
    ));

    // Persist to server (fire and forget)
    BrowserRuntime.runFork(
      persistRecentFile(cwd, filePath, { scrollLine, cursorLine, cursorCol }).pipe(
        Effect.orElse(() => Effect.void)
      )
    );
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
    await BrowserRuntime.runPromise(
      loadBlameEff<BlameLine>(cwd, path).pipe(
        Effect.match({
          onSuccess: (data) => {
            if (data.error) {
              setBlameError(data.error);
            } else {
              setBlameLines((data.blame ?? []) as BlameLine[]);
            }
          },
          onFailure: (err) => {
            console.error('Error loading blame:', err);
            setBlameError('Failed to load blame info');
          },
        })
      )
    );
    setIsLoadingBlame(false);
  }, [cwd, selectedPath]);

  const loadFileContent = useCallback(async (filePath: string) => {
    setIsLoadingContent(true);
    setFileContent(null);
    setShowBlame(false);
    setBlameLines([]);
    setBlameError(null);
    setBlameSelectedCommit(null);

    // Two-step Effect pipeline: cheap stat → (image/binary/too-large yields FileContent directly; text chains through fetchFileText)
    // Image bytes are NEVER pulled into JS heap — <FileImagePreview/> goes through /api/files/read via <img src>.
    const flow = Effect.gen(function* () {
      const stat = yield* fetchFileStat(cwd, filePath);
      if (!stat.ok) {
        return { type: 'error', message: stat.data?.error || 'Failed to stat file' } as FileContent;
      }
      const s: StatLike = stat.data ?? {};
      if (!s.exists) {
        return { type: 'error', message: 'File not found' } as FileContent;
      }
      if (s.kind === 'dir') {
        return { type: 'error', message: 'Path is a directory' } as FileContent;
      }
      switch (s.category) {
        case 'image':
          return {
            type: 'image',
            size: s.size,
            mtime: s.mtimeMs,
            ...(s.isSymlink ? { isSymlink: true, symlinkTarget: s.symlinkTarget } : {}),
          } as FileContent;
        case 'pdf':
          // PDF bytes are NEVER pulled into JS heap — the preview renders an
          // <iframe> that streams /api/files/read via the browser's native viewer.
          return {
            type: 'pdf',
            size: s.size,
            mtime: s.mtimeMs,
            ...(s.isSymlink ? { isSymlink: true, symlinkTarget: s.symlinkTarget } : {}),
          } as FileContent;
        case 'binary':
          return {
            type: 'binary',
            message: 'Cannot preview binary file',
            size: s.size,
            mtime: s.mtimeMs,
          } as FileContent;
        case 'too-large':
          return {
            type: 'error',
            message: 'File too large to preview',
            size: s.size,
            mtime: s.mtimeMs,
          } as FileContent;
        case 'text':
        default: {
          const text = yield* fetchFileText(cwd, filePath);
          if (text.status === 409) {
            return {
              type: 'binary',
              message: text.data?.error || 'Cannot preview binary file',
              size: s.size,
              mtime: s.mtimeMs,
            } as FileContent;
          }
          if (!text.ok) {
            return { type: 'error', message: text.data?.error || 'Failed to load file' } as FileContent;
          }
          const t = text.data ?? {};
          return {
            type: 'text',
            content: t.content,
            size: t.size,
            mtime: t.mtimeMs,
            ...(t.isSymlink ? { isSymlink: true, symlinkTarget: t.symlinkTarget } : {}),
          } as FileContent;
        }
      }
    });

    await BrowserRuntime.runPromise(
      flow.pipe(
        Effect.match({
          onSuccess: (content) => setFileContent(content),
          onFailure: (err) => {
            console.error('Error loading file content:', err);
            setFileContent({ type: 'error', message: 'Failed to load file' });
          },
        })
      )
    );
    addToRecentFiles(filePath);
    // Auto-load blame (used for inline blame annotations, does not block file content rendering)
    loadBlame(filePath);
    setIsLoadingContent(false);
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
    previewMarkdown,
    setPreviewMarkdown,
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
