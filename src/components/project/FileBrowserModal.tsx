'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CommitDetailPanel, type CommitInfo } from './CommitDetailPanel';
import { DiffView } from './DiffView';
import { toast } from '../shared/Toast';
import { FileTree, type GitStatusMap, type GitStatusCode } from './FileTree';
import { GitFileTree, buildGitFileTree, collectGitTreeDirPaths, collectFilesUnderNode } from './GitFileTree';
import { MenuContainerProvider } from './FileContextMenu';
import { CodeViewer } from './CodeViewer';
import { isMarkdownFile, formatAsHumanReadable } from './toolCallUtils';
import { buildTreeFromPaths, collectAllDirPaths } from './fileBrowser/utils';
import { InteractiveMarkdownPreview } from './InteractiveMarkdownPreview';
import { FileIcon } from '../shared/FileIcon';
import { type FileEditorHandle } from './FileEditorModal';
import { QuickFileOpen } from './QuickFileOpen';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePageVisible } from '@/hooks/usePageVisible';

import type { TabType, GitFileStatus, GitStatusResponse, FileBrowserModalProps, SearchResult } from './fileBrowser/types';
import { getTargetDirPath, isImageFile, formatDateTime, NOOP, COMMITS_PER_PAGE } from './fileBrowser/utils';

import { BranchSelector } from './fileBrowser/BranchSelector';

import { useFileTree } from '../../hooks/useFileTree';
import { useContentSearch } from '../../hooks/useContentSearch';
import { useGitStatus } from '../../hooks/useGitStatus';
import { useGitHistory } from '../../hooks/useGitHistory';
import { useLSPDefinition, useLSPHover, useLSPReferences, useLSPWarmup } from '../../hooks/useLSP';
import { useNavigationHistory } from '../../hooks/useNavigationHistory';
import { useTranslation } from 'react-i18next';
import { useJsonSearch, JsonSearchBar } from '../../hooks/useJsonSearch';
import { getLanguageForFile } from '@/lib/lsp/types';
import { HoverTooltip } from './HoverTooltip';
import { ReferencesPanel } from './ReferencesPanel';
import { SearchResultsPanel } from './SearchResultsPanel';
import type { Location } from '@/lib/lsp/types';
import { useSwipeContext } from './SwipeableViewContainer';

export function FileBrowserModal({ onClose, cwd, initialTab = 'tree', tabSwitchTrigger, initialSearchQuery, searchQueryTrigger }: FileBrowserModalProps) {
  const { t } = useTranslation();
  const { activeView } = useSwipeContext();
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; isDirectory: boolean; name: string } | null>(null);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  // CodeViewer currently visible line number (1-based), used to sync editor ↔ viewer position
  const visibleLineRef = useRef<number>(1);
  // Vi cursor position ref (0-based), continuously updated by CodeViewer
  const viStateRef = useRef<{ cursorLine: number; cursorCol: number } | null>(null);
  // Line number to jump to when returning from editor
  const [editorReturnLine, setEditorReturnLine] = useState<number | null>(null);
  // Editor ref and state (used to render save/close buttons in the top toolbar)
  const editorHandleRef = useRef<FileEditorHandle>(null);
  const [editorState, setEditorState] = useState({ isDirty: false, isSaving: false });
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [jsonReadable, setJsonReadable] = useState(false);
  const [jsonPreview, setJsonPreview] = useState<{ content: string; filePath: string } | null>(null);
  const jsonPreRef = useRef<HTMLPreElement>(null);
  const jsonSearch = useJsonSearch(jsonPreRef);
  const jsonPreviewPreRef = useRef<HTMLPreElement>(null);
  const jsonPreviewSearch = useJsonSearch(jsonPreviewPreRef);

  // ========== Hooks ==========
  const lspDefinition = useLSPDefinition(cwd);
  const lspHover = useLSPHover(cwd);
  const lspReferences = useLSPReferences(cwd);
  const navHistory = useNavigationHistory();

  const pageVisible = usePageVisible();
  const fileTree = useFileTree({ cwd });
  useLSPWarmup(cwd, fileTree.selectedPath);
  const contentSearch = useContentSearch({ cwd, onSearchComplete: () => setShowSearchPanel(true) });
  const gitStatus = useGitStatus({ cwd, addToRecentFiles: fileTree.addToRecentFiles });
  const gitHistory = useGitHistory({ cwd, addToRecentFiles: fileTree.addToRecentFiles });

  // ========== Vi Mode Callbacks ==========
  const handleViContentMutate = useCallback((newContent: string) => {
    fileTree.setFileContent(prev =>
      prev?.type === 'text' ? { ...prev, content: newContent } : prev
    );
  }, [fileTree]);

  const handleViEnterInsert = useCallback((_cursorLine: number) => {
    // Don't overwrite visibleLineRef — keep the current viewport scroll position.
    // visibleLineRef already tracks the first visible line in the virtual scroller,
    // which the editor init effect uses for both scroll and cursor placement.
    fileTree.setShowEditor(true);
  }, [fileTree]);

  const handleViSave = useCallback(async () => {
    if (!fileTree.fileContent || fileTree.fileContent.type !== 'text' || !fileTree.fileContent.content) return;
    try {
      const response = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          path: fileTree.selectedPath,
          content: fileTree.fileContent.content,
        }),
      });
      if (!response.ok) throw new Error('Failed to save file');
      const data = await response.json();
      if (data.mtime) {
        fileTree.setFileContent(prev =>
          prev?.type === 'text' ? { ...prev, mtime: data.mtime } : prev
        );
      }
      toast(t('toast.savedSuccess'), 'success');
    } catch {
      toast(t('toast.saveFailed'), 'error');
    }
  }, [cwd, fileTree]);

  // ========== Save current position to recent files before switching ==========
  const saveCurrentFilePosition = useCallback(() => {
    if (!fileTree.selectedPath) return;
    const scrollLine = visibleLineRef.current;
    const cursor = viStateRef.current;
    if (scrollLine > 0) {
      fileTree.updateRecentFilePosition(
        fileTree.selectedPath,
        scrollLine,
        cursor ? cursor.cursorLine + 1 : scrollLine,  // 0-based → 1-based (convert)
        cursor ? cursor.cursorCol + 1 : 1,
      );
    }
  }, [fileTree]);

  /** Wrap handleSelectFile: auto-save current file position before switching */
  const handleSelectFileWithSave = useCallback((path: string, lineNumber?: number) => {
    if (path !== fileTree.selectedPath) {
      saveCurrentFilePosition();
    }
    fileTree.handleSelectFile(path, lineNumber);
  }, [fileTree, saveCurrentFilePosition]);

  // ========== Search results: build an independent tree from search result paths (no lazy-loaded dir tree) ==========
  const searchData = useMemo(() => {
    const results = contentSearch.contentSearchResults;
    if (results.length === 0) return { files: [] as import('./fileBrowser/types').FileNode[], expandDirs: new Set<string>(), matchMap: new Map<string, SearchResult>() };

    const matchMap = new Map<string, SearchResult>();
    const filePaths: string[] = [];
    for (const r of results) {
      matchMap.set(r.path, r);
      filePaths.push(r.path);
    }

    // Build a full tree directly from search result file paths, similar to the recent files tab strategy
    const files = buildTreeFromPaths(filePaths);
    const expandDirs = new Set(collectAllDirPaths(files));

    return { files, expandDirs, matchMap };
  }, [contentSearch.contentSearchResults]);

  // Search tree expanded paths — fully expanded by default after search completes
  const [searchTreeExpanded, setSearchTreeExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSearchTreeExpanded(searchData.expandDirs);
  }, [searchData.expandDirs]);

  const handleSearchTreeToggle = useCallback((path: string) => {
    setSearchTreeExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderSearchActions = useCallback((node: { path: string; isDirectory: boolean }) => {
    if (node.isDirectory) return null;
    const result = searchData.matchMap.get(node.path);
    if (!result) return null;
    return <span className="text-xs text-muted-foreground">{result.matches.length}</span> as ReactNode;
  }, [searchData.matchMap]);

  const showSearchResults = showSearchPanel && contentSearch.contentSearchResults.length > 0;

  // ========== LSP handlers (depend on fileTree) ==========
  const isLSPSupported = fileTree.selectedPath ? getLanguageForFile(fileTree.selectedPath) !== null : false;

  const handleLSPCmdClick = useCallback(async (line: number, column: number) => {
    if (!fileTree.selectedPath || !isLSPSupported) return;

    const definitions = await lspDefinition.goToDefinition(fileTree.selectedPath, line, column);
    if (definitions.length === 0) return;

    const def = definitions[0];
    // tsserver returns absolute paths; convert to relative (relative to cwd)
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const relativePath = def.file.startsWith(cwdPrefix)
      ? def.file.slice(cwdPrefix.length)
      : def.file;

    // Push current position to navigation history before jumping
    navHistory.push({
      filePath: fileTree.selectedPath,
      lineNumber: visibleLineRef.current,
    });

    if (relativePath === fileTree.selectedPath) {
      // Same file: scroll to target line
      fileTree.setTargetLineNumber(def.line);
    } else {
      handleSelectFileWithSave(relativePath, def.line);
    }
  }, [fileTree, cwd, isLSPSupported, lspDefinition, navHistory]);

  const handleLSPTokenHover = useCallback((line: number, column: number, rect: { x: number; y: number }) => {
    if (!fileTree.selectedPath || !isLSPSupported) return;
    lspHover.onTokenMouseEnter(fileTree.selectedPath, line, column, rect);
  }, [fileTree.selectedPath, isLSPSupported, lspHover]);

  const handleLSPReferenceSelect = useCallback((ref: Location) => {
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const relativePath = ref.file.startsWith(cwdPrefix)
      ? ref.file.slice(cwdPrefix.length)
      : ref.file;

    // Push current position to navigation history before jumping
    if (fileTree.selectedPath) {
      navHistory.push({ filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current });
    }

    if (relativePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(ref.line);
    } else {
      handleSelectFileWithSave(relativePath, ref.line);
    }
  }, [fileTree, cwd, navHistory]);

  // ========== gitStatusMap (depends on both useFileTree and useGitStatus) ==========
  const gitStatusMap = useMemo<GitStatusMap | null>(() => {
    if (!gitStatus.status) return null;
    const map = new Map<string, GitStatusCode>();

    const toStatusCode = (s: GitFileStatus['status']): GitStatusCode => {
      switch (s) {
        case 'modified': return 'M';
        case 'added': return 'A';
        case 'deleted': return 'D';
        case 'renamed': return 'R';
        case 'untracked': return '?';
        default: return 'M';
      }
    };

    for (const file of gitStatus.status.staged) {
      map.set(file.path, toStatusCode(file.status));
    }
    for (const file of gitStatus.status.unstaged) {
      map.set(file.path, toStatusCode(file.status));
    }

    return map;
  }, [gitStatus.status]);

  // ========== Set menu container after mount ==========
  useEffect(() => {
    setMenuContainer(menuContainerRef.current);
  }, []);

  // ========== Global data-tooltip event delegation ==========
  useEffect(() => {
    const container = menuContainerRef.current;
    if (!container) return;
    const findTooltip = (target: EventTarget | null): string | null => {
      let el = target as HTMLElement | null;
      while (el && el !== container) {
        if (el.dataset.tooltip) return el.dataset.tooltip;
        el = el.parentElement;
      }
      return null;
    };
    const onOver = (e: MouseEvent) => {
      const text = findTooltip(e.target);
      if (text) {
        setHoverTooltip({ text, x: e.clientX, y: e.clientY });
      } else {
        setHoverTooltip(null);
      }
    };
    const onMove = (e: MouseEvent) => {
      setHoverTooltip(prev => {
        if (!prev) return null;
        const text = findTooltip(e.target);
        if (!text) return null;
        return { text, x: e.clientX, y: e.clientY };
      });
    };
    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !container.contains(related) || !findTooltip(related)) {
        setHoverTooltip(null);
      }
    };
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseout', onOut);
    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseout', onOut);
    };
  }, []);

  // ========== Update activeTab when initialTab changes ==========
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, tabSwitchTrigger]);

  // ========== Handle external search query (from Chat) ==========
  useEffect(() => {
    if (initialSearchQuery) {
      setActiveTab('search');
      contentSearch.setContentSearchQuery(initialSearchQuery);
      contentSearch.performContentSearch(initialSearchQuery);
    }
  }, [searchQueryTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // ========== Tab Switch Handler ==========
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    fileTree.setBlameSelectedCommit(null);
    // Refresh commits when switching to the history tab as a fallback (prevents stale data from missed watch events)
    if (tab === 'history' && gitHistory.selectedBranch) {
      gitHistory.loadCommits(gitHistory.selectedBranch);
    }
  }, [fileTree, gitHistory.selectedBranch, gitHistory.loadCommits]);

  // ========== Navigation History: Go Back / Go Forward ==========
  const handleNavBack = useCallback(() => {
    if (!fileTree.selectedPath) return;
    const current = { filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current };
    const target = navHistory.goBack(current);
    if (!target) return;
    if (target.filePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(target.lineNumber);
    } else {
      handleSelectFileWithSave(target.filePath, target.lineNumber);
    }
  }, [fileTree, navHistory]);

  const handleNavForward = useCallback(() => {
    if (!fileTree.selectedPath) return;
    const current = { filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current };
    const target = navHistory.goForward(current);
    if (!target) return;
    if (target.filePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(target.lineNumber);
    } else {
      handleSelectFileWithSave(target.filePath, target.lineNumber);
    }
  }, [fileTree, navHistory]);

  // ========== Copy / Paste Handlers ==========
  const handleCopyFile = useCallback(async (path: string) => {
    const fileName = path.split('/').pop() || path;
    try {
      await fetch('/api/files/clipboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, path }),
      });
      toast(t('toast.copiedName', { name: fileName }), 'success');
    } catch {
      toast(t('toast.copyFailed'), 'error');
    }
  }, [cwd]);

  const handlePaste = useCallback(async (targetDir: string) => {
    try {
      // Read the file path from the system clipboard
      const clipRes = await fetch('/api/files/clipboard');
      const clipData = await clipRes.json();
      if (!clipData.path) {
        toast(t('toast.noFileToPaste'), 'info');
        return;
      }

      const res = await fetch('/api/files/paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, targetDir, sourceAbsPath: clipData.path }),
      });
      const data = await res.json();
      if (res.ok) {
        toast(t('toast.pastedFile', { name: data.newName }), 'success');
        fileTree.loadDirectory(targetDir);
        fileTree.loadFileIndex();
      } else {
        toast(data.error || t('toast.pasteFailed'), 'error');
      }
    } catch {
      toast(t('toast.pasteFailed'), 'error');
    }
  }, [cwd, fileTree]);

  // ========== Keyboard Shortcuts ==========
  const lastEscTimeRef = useRef<number>(0);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts when Explorer panel is active (except ESC which always works)
      const isExplorerActive = activeView === 'explorer';

      // Ctrl+- → Go Back / Ctrl+Shift+- → Go Forward
      // Use e.code to detect the physical key, avoiding Shift turning '-' into '_'
      if (isExplorerActive && e.ctrlKey && !e.metaKey && e.code === 'Minus') {
        e.preventDefault();
        if (e.shiftKey) {
          handleNavForward();
        } else {
          handleNavBack();
        }
        return;
      }

      // Cmd+P / Ctrl+P → Quick file open
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setShowQuickOpen(prev => !prev);
        return;
      }

      // Cmd+C → copy selected file to system clipboard (only in tree/recent tab and not inside an input)
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'c' && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        const sel = window.getSelection()?.toString();
        if ((activeTab === 'tree' || activeTab === 'recent') && fileTree.selectedPath && !sel && tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          handleCopyFile(fileTree.selectedPath);
          return;
        }
      }

      // Cmd+V → paste into the directory of the selected file
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'v') {
        const tag = (e.target as HTMLElement)?.tagName;
        if ((activeTab === 'tree' || activeTab === 'recent') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          handlePaste(getTargetDirPath(fileTree.selectedPath, fileTree.files));
          return;
        }
      }

      // Cmd+F in JSON readable mode → open JSON search
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'f') {
        if (jsonPreview) {
          e.preventDefault();
          jsonPreviewSearch.open();
          return;
        }
        if (jsonReadable && fileTree.selectedPath?.endsWith('.json')) {
          e.preventDefault();
          jsonSearch.open();
          return;
        }
      }

      if (isExplorerActive && e.key === 'Escape') {
        // Close quick open first
        if (showQuickOpen) {
          setShowQuickOpen(false);
          return;
        }

        // Close JSON search bar first
        if (jsonPreviewSearch.isVisible) {
          jsonPreviewSearch.close();
          return;
        }
        if (jsonSearch.isVisible) {
          jsonSearch.close();
          return;
        }
        // jsonPreview modal → close modal
        if (jsonPreview) {
          setJsonPreview(null);
          return;
        }

        const now = Date.now();
        if (now - lastEscTimeRef.current < 3000) {
          return;
        }
        lastEscTimeRef.current = now;

        // Close bottom panel first
        if (lspReferences.visible) {
          lspReferences.closeReferences();
        } else if (showSearchPanel) {
          setShowSearchPanel(false);
        } else if (fileTree.blameSelectedCommit) {
          fileTree.setBlameSelectedCommit(null);
        } else if (fileTree.showBlame) {
          fileTree.setShowBlame(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, fileTree.showBlame, fileTree.blameSelectedCommit, fileTree, showQuickOpen, lspReferences.visible, lspReferences.closeReferences, showSearchPanel, handleNavBack, handleNavForward, jsonReadable, jsonSearch, jsonPreview, jsonPreviewSearch, activeTab, handleCopyFile, handlePaste, activeView]);

  // ========== Initial Data Load (once on mount) ==========
  useEffect(() => {
    fileTree.loadFiles();
    fileTree.loadFileIndex();
    fileTree.loadRecentFiles();
    gitStatus.fetchStatus();
    gitHistory.loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for external git operations (e.g., ChatInput's stage button) to trigger a refresh
  useEffect(() => {
    const handler = () => { gitStatus.fetchStatus(); };
    window.addEventListener('git-status-changed', handler);
    return () => window.removeEventListener('git-status-changed', handler);
  }, [gitStatus.fetchStatus]);

  // Refresh data once when the iframe becomes visible again (changes may be missed while WS is paused)
  const prevVisibleRef = useRef(pageVisible);
  useEffect(() => {
    if (pageVisible && !prevVisibleRef.current) {
      fileTree.loadFiles();
      fileTree.loadFileIndex();
      fileTree.loadRecentFiles();
      gitStatus.fetchStatus();
      gitHistory.loadBranches();
    }
    prevVisibleRef.current = pageVisible;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageVisible]);

  // Load commits when branch changes
  useEffect(() => {
    if (gitHistory.selectedBranch) {
      gitHistory.loadCommits(gitHistory.selectedBranch);
    }
  }, [gitHistory.selectedBranch, gitHistory.loadCommits]);

  // ========== Auto-select first recent file when switching to tree/recent tab ==========
  const prevTabRef = useRef<TabType>(activeTab);
  useEffect(() => {
    const prevTab = prevTabRef.current;
    prevTabRef.current = activeTab;

    if ((activeTab === 'tree' || activeTab === 'recent') && fileTree.recentFiles.length > 0) {
      const isFromOtherTab = prevTab === 'status' || prevTab === 'history';
      const firstRecentPath = fileTree.recentFiles[0].path;
      const needsUpdate = !fileTree.selectedPath || (isFromOtherTab && fileTree.selectedPath !== firstRecentPath);

      if (needsUpdate) {
        fileTree.setShouldScrollToSelected(true);
        handleSelectFileWithSave(firstRecentPath);
      }
    }
  }, [activeTab, fileTree.recentFiles, fileTree.selectedPath, handleSelectFileWithSave, fileTree]);

  // ========== Refresh Handler ==========
  const handleRefresh = useCallback(() => {
    if (activeTab === 'tree' || activeTab === 'recent') {
      fileTree.loadFiles();
      fileTree.loadRecentFiles();
    } else if (activeTab === 'status') {
      gitStatus.fetchStatus();
    } else if (activeTab === 'history') {
      gitHistory.loadBranches();
      if (gitHistory.selectedBranch) {
        gitHistory.loadCommits(gitHistory.selectedBranch);
      }
    }
  }, [activeTab, fileTree, gitStatus, gitHistory]);

  const isRefreshLoading = fileTree.isLoadingFiles || gitStatus.statusLoading || gitHistory.isLoadingBranches || gitHistory.isLoadingCommits;

  // ========== Auto-sync via SSE file watching ==========
  // Use ref to store the latest values, avoiding SSE callbacks depending on frequently changing state
  const selectedBranchRef = useRef(gitHistory.selectedBranch);
  selectedBranchRef.current = gitHistory.selectedBranch;
  const selectedPathRef = useRef(fileTree.selectedPath);
  selectedPathRef.current = fileTree.selectedPath;
  const fileContentTypeRef = useRef(fileTree.fileContent?.type);
  fileContentTypeRef.current = fileTree.fileContent?.type;

  const handleWatchMessage = useCallback(async (msg: unknown) => {
    try {
      const { data: events } = msg as { type: string; data: Array<{ type: 'file' | 'git' }> };
      if (!events) return;

      const hasGitChange = events.some(ev => ev.type === 'git');
      const hasFileChange = events.some(ev => ev.type === 'file');

      const promises: Promise<void>[] = [];

      if (hasFileChange || hasGitChange) {
        promises.push(
          fetch(`/api/files/init?cwd=${encodeURIComponent(cwd)}`)
            .then(res => res.json())
            .then(data => { if (!data.error) fileTree.setFiles(data.files || []); })
        );
        promises.push(
          fetch(`/api/files/index?cwd=${encodeURIComponent(cwd)}`)
            .then(res => res.json())
            .then(data => { if (data.paths) fileTree.setFileIndex(data.paths); })
        );
        promises.push(
          fetch(`/api/files/recent?cwd=${encodeURIComponent(cwd)}`)
            .then(res => res.json())
            .then(data => { fileTree.setRecentFiles(data.files || []); })
        );
      }

      if (hasGitChange || hasFileChange) {
        promises.push(
          fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
            .then(res => {
              if (!res.ok) return;
              return res.json().then((statusData: GitStatusResponse) => {
                gitStatus.setStatus(statusData);
                const staged = buildGitFileTree(statusData.staged);
                const unstaged = buildGitFileTree(statusData.unstaged);
                gitStatus.setStagedTree(staged);
                gitStatus.setUnstagedTree(unstaged);
                const newPaths = new Set<string>([
                  ...collectGitTreeDirPaths(staged),
                  ...collectGitTreeDirPaths(unstaged),
                ]);
                gitStatus.setStatusExpandedPaths(prev => new Set([...prev, ...newPaths]));
              });
            })
        );
        // Refresh the currently viewed diff
        gitStatus.refreshDiff();

        if (hasGitChange) {
          // Sync BranchSelector when the branch changes
          gitHistory.loadBranches();
        }
        // Refresh commits list (needed for git events like commit/rebase/merge and file change events)
        const branch = selectedBranchRef.current;
        if (branch) {
          promises.push(
            fetch(`/api/git/commits?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}&limit=${COMMITS_PER_PAGE}`)
              .then(res => res.json())
              .then(data => {
                const newCommits = data.commits || [];
                gitHistory.setCommits(newCommits);
                gitHistory.setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
              })
          );
        }
      }

      const currentPath = selectedPathRef.current;
      const currentType = fileContentTypeRef.current;
      if (currentPath && currentType === 'text') {
        promises.push(
          fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(currentPath)}`)
            .then(res => res.json())
            .then(data => { if (data.type === 'text') fileTree.setFileContent(data); })
        );
      }

      await Promise.all(promises);
    } catch (err) {
      console.error('File watch handler error:', err);
    }
  // fileTree/gitStatus/gitHistory are stable object references returned by hooks and do not change frequently
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: handleWatchMessage,
    enabled: pageVisible,  // Pause file watching for hidden iframes to avoid unnecessary concurrent requests
  });

  // ========== Helper: locate in tree ==========
  const locateInTree = useCallback((filePath: string) => {
    const parts = filePath.split('/');
    if (parts.length > 1) {
      const parentPaths: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        parentPaths.push(parts.slice(0, i).join('/'));
      }
      fileTree.setExpandedPaths(prev => {
        const next = new Set(prev);
        for (const p of parentPaths) {
          next.add(p);
        }
        fileTree.saveExpandedPaths(next);
        return next;
      });
    }
    fileTree.setSelectedPath(filePath);
    fileTree.setShouldScrollToSelected(true);
    setActiveTab('tree');
  }, [fileTree]);

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
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'tree'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.directoryTree')}
              </button>
              <button
                onClick={() => handleTabChange('search')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'search'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.searchTab')}
              </button>
              <button
                onClick={() => handleTabChange('recent')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.recentTab')}
              </button>
              <button
                onClick={() => handleTabChange('status')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'status'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.changesTab')}
              </button>
              <button
                onClick={() => handleTabChange('history')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'history'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.historyTab')}
              </button>
            </div>

            {/* Tab-specific content above list */}
            {activeTab === 'tree' && (
              <div className="p-2 border-b border-border flex items-center gap-2">
                <div className="flex-1 relative">
                  <input
                    ref={fileTree.searchInputRef}
                    type="text"
                    value={fileTree.searchQuery}
                    onChange={e => fileTree.setSearchQuery(e.target.value)}
                    placeholder={t('fileBrowser.searchFiles')}
                    className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {fileTree.searchQuery && (
                    <button
                      onClick={() => fileTree.setSearchQuery('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-9 hover:text-foreground rounded-sm transition-colors"
                      title={t('fileBrowser.clear')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {/* Exact directory match toggle */}
                <button
                  onClick={() => fileTree.setSearchDirExact(v => !v)}
                  className={`px-1 py-0.5 rounded transition-colors text-xs font-mono font-bold border ${
                    fileTree.searchExactMatch
                      ? 'border-brand text-brand bg-brand/10'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title={fileTree.searchExactMatch ? t('fileBrowser.exactMatchOn') : t('fileBrowser.exactMatchOff')}
                >
                  ab
                </button>
                {/* Action button group */}
                <div className="flex items-center gap-0.5">
                  {/* Refresh */}
                  <button
                    onClick={() => fileTree.loadFiles()}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    title={t('fileBrowser.refreshTree')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  {/* Collapse all */}
                  <button
                    onClick={() => fileTree.searchTreeExpandedPaths ? fileTree.setSearchTreeExpandedPaths(new Set()) : fileTree.setExpandedPaths(new Set())}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    title={t('fileBrowser.collapseAll')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'search' && (
              <div className="p-2 border-b border-border space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <input
                      ref={contentSearch.contentSearchInputRef}
                      type="text"
                      value={contentSearch.contentSearchQuery}
                      onChange={e => contentSearch.setContentSearchQuery(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          contentSearch.performContentSearch(contentSearch.contentSearchQuery);
                        }
                      }}
                      placeholder={t('fileBrowser.searchFileContent')}
                      className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {contentSearch.contentSearchQuery && (
                      <button
                        onClick={() => contentSearch.setContentSearchQuery('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-9 hover:text-foreground rounded-sm transition-colors"
                        title={t('fileBrowser.clear')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => contentSearch.performContentSearch(contentSearch.contentSearchQuery)}
                    disabled={contentSearch.isSearching || !contentSearch.contentSearchQuery.trim()}
                    className="px-3 py-1.5 text-sm bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {contentSearch.isSearching ? '...' : t('common.search')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.caseSensitive}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, caseSensitive: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">{t('fileBrowser.caseSensitive')}</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.wholeWord}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, wholeWord: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">{t('fileBrowser.wholeWord')}</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.regex}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, regex: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">{t('fileBrowser.regex')}</span>
                  </label>
                  <input
                    type="text"
                    value={contentSearch.searchOptions.fileType}
                    onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, fileType: e.target.value }))}
                    placeholder={t('fileBrowser.fileTypes')}
                    className="w-24 px-2 py-0.5 text-xs border border-border rounded bg-card text-foreground placeholder-slate-9"
                  />
                </div>
              </div>
            )}

            {activeTab === 'history' && (
              <div className="p-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <BranchSelector
                      branches={gitHistory.branches}
                      selectedBranch={gitHistory.selectedBranch}
                      onSelect={(branch) => {
                        gitHistory.setSelectedBranch(branch);
                        // Auto-refresh when switching branches in compare mode
                        if (gitHistory.compareMode) {
                          gitHistory.loadCompareFiles(branch);
                        }
                      }}
                      isLoading={gitHistory.isLoadingBranches}
                    />
                  </div>
                  <button
                    onClick={() => gitHistory.toggleCompareMode(!gitHistory.compareMode)}
                    className={`flex-shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      gitHistory.compareMode
                        ? 'bg-brand text-white'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent border border-border'
                    }`}
                    title={gitHistory.compareMode ? t('fileBrowser.compareModeOff') : t('fileBrowser.compareModeOn')}
                  >
                    {t('fileBrowser.compareMode')}
                  </button>
                </div>
              </div>
            )}

            {/* List Content - use CSS show/hide to avoid component remounting */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Tree Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'tree' ? '' : 'hidden'}`}>
                {/* New file input box */}
                {fileTree.creatingItem && (
                  <div className="px-2 py-1.5 border-b border-border bg-secondary flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {fileTree.creatingItem.parentPath ? t('fileBrowser.createFileIn', { path: fileTree.creatingItem.parentPath }) : t('fileBrowser.createFile')}
                    </span>
                    <input
                      type="text"
                      autoFocus
                      placeholder={t('fileBrowser.fileName')}
                      className="flex-1 px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      onCompositionStart={() => { composingRef.current = true; }}
                      onCompositionEnd={() => { composingRef.current = false; }}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          if (composingRef.current) return;
                          const name = (e.target as HTMLInputElement).value.trim();
                          if (!name) return;
                          const parentPath = fileTree.creatingItem!.parentPath;
                          const fullPath = parentPath ? `${parentPath}/${name}` : name;
                          try {
                            const res = await fetch('/api/files/save', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                cwd,
                                path: fullPath,
                                content: '',
                              }),
                            });
                            if (res.ok) {
                              toast(t('toast.createdFile', { name }), 'success');
                              fileTree.setCreatingItem(null);
                              fileTree.loadDirectory(parentPath);
                              fileTree.loadFileIndex();
                              if (parentPath) {
                                fileTree.setExpandedPaths(prev => new Set([...prev, parentPath]));
                              }
                              handleSelectFileWithSave(fullPath);
                            } else {
                              const data = await res.json();
                              toast(data.error || t('toast.createFailed'), 'error');
                            }
                          } catch (err) {
                            toast(t('toast.createFailed'), 'error');
                          }
                        } else if (e.key === 'Escape') {
                          fileTree.setCreatingItem(null);
                        }
                      }}
                      onBlur={() => fileTree.setCreatingItem(null)}
                    />
                  </div>
                )}
                {fileTree.isLoadingFiles ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">{t('common.loading')}</div>
                ) : fileTree.fileError ? (
                  <div className="p-4 text-center text-red-11 text-sm">{fileTree.fileError}</div>
                ) : (
                  <FileTree
                    files={fileTree.files}
                    selectedPath={fileTree.selectedPath}
                    expandedPaths={fileTree.effectiveExpandedPaths}
                    matchedPaths={fileTree.matchedPaths}
                    gitStatusMap={gitStatusMap}
                    loadingDirs={fileTree.loadingDirs}
                    onSelect={(path) => {
                      fileTree.setShouldScrollToSelected(false);
                      handleSelectFileWithSave(path);
                    }}
                    onToggle={fileTree.handleToggle}
                    cwd={cwd}
                    shouldScrollToSelected={fileTree.shouldScrollToSelected}
                    onScrolledToSelected={() => fileTree.setShouldScrollToSelected(false)}
                    onCreateFile={(dirPath) => fileTree.setCreatingItem({ type: 'file', parentPath: dirPath })}
                    onDelete={(path, isDir, name) => setDeleteConfirm({ path, isDirectory: isDir, name })}
                    onRefresh={() => fileTree.loadFiles()}
                    onCopyFile={handleCopyFile}
                    onPaste={handlePaste}
                  />
                )}
              </div>

              {/* Search Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'search' ? '' : 'hidden'}`}>
                {contentSearch.isSearching ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : contentSearch.searchError ? (
                  <div className="p-4 text-center text-red-11 text-sm">{contentSearch.searchError}</div>
                ) : contentSearch.contentSearchResults.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    {contentSearch.contentSearchQuery ? t('fileBrowser.noContentSearchResults') : t('fileBrowser.enterKeywordToSearch')}
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
                    {/* Search statistics */}
                    {contentSearch.searchStats && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground bg-secondary border-b border-border flex-shrink-0">
                        {t('fileBrowser.nFilesNMatches', { files: contentSearch.searchStats.totalFiles, matches: contentSearch.searchStats.totalMatches })}
                        {contentSearch.searchStats.truncated && <span className="text-amber-11 ml-1">({t('fileBrowser.resultsTruncated')})</span>}
                      </div>
                    )}
                    {/* Search result directory tree — built from search result paths */}
                    <FileTree
                      files={searchData.files}
                      selectedPath={fileTree.selectedPath}
                      expandedPaths={searchTreeExpanded}
                      onSelect={(path) => {
                        const result = searchData.matchMap.get(path);
                        handleSelectFileWithSave(path, result?.matches[0]?.lineNumber);
                        if (!showSearchPanel) setShowSearchPanel(true);
                      }}
                      onToggle={handleSearchTreeToggle}
                      cwd={cwd}
                      renderActions={renderSearchActions}
                      className="flex-1 overflow-y-auto py-1 min-w-max"
                    />
                  </div>
                )}
              </div>

              {/* Recent Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'recent' ? '' : 'hidden'}`}>
                {fileTree.recentFiles.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    {t('fileBrowser.noRecentFiles')}
                  </div>
                ) : (
                  <FileTree
                    files={fileTree.recentFilesTree}
                    selectedPath={fileTree.selectedPath}
                    expandedPaths={fileTree.recentTreeDirPaths}
                    onSelect={handleSelectFileWithSave}
                    onToggle={NOOP}
                    cwd={cwd}
                  />
                )}
              </div>

              {/* Status Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'status' ? '' : 'hidden'}`}>
                {gitStatus.statusLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : gitStatus.statusError ? (
                  <div className="flex-1 flex items-center justify-center p-4">
                    <span className="text-red-11 text-sm">{gitStatus.statusError}</span>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {/* Staged Section */}
                    <div className="border-b border-border">
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-muted-foreground">
                            {t('fileBrowser.stagingArea', { count: gitStatus.status?.staged.length || 0 })}
                          </span>
                          <button
                            onClick={() => gitStatus.fetchStatus()}
                            className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                            title={t('fileBrowser.refreshChanges')}
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>
                        </div>
                        {(gitStatus.status?.staged.length || 0) > 0 && (
                          <button
                            onClick={gitStatus.handleUnstageAll}
                            className="text-sm text-amber-11 hover:text-amber-10 hover:underline"
                          >
                            {t('fileBrowser.unstageAll')}
                          </button>
                        )}
                      </div>
                      <GitFileTree
                        files={gitStatus.stagedTree}
                        selectedPath={gitStatus.statusSelectedFile?.type === 'staged' ? gitStatus.statusSelectedFile.file.path : null}
                        expandedPaths={gitStatus.statusExpandedPaths}
                        onSelect={(node) => node.file && gitStatus.handleStatusFileSelect(node.file as GitFileStatus, 'staged')}
                        onToggle={gitStatus.handleStatusToggle}
                        cwd={cwd}
                        emptyMessage={t('fileBrowser.noStagedFiles')}
                        className="py-1"
                        renderActions={(node) => {
                          if (node.isDirectory) {
                            const files = collectFilesUnderNode(node);
                            if (files.length === 0) return null;
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  gitStatus.handleUnstageFiles(files.map(f => f.path));
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 dark:hover:bg-amber-9/20 rounded transition-all"
                                title={t('fileBrowser.unstageNFiles', { count: files.length })}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                                </svg>
                              </button>
                            );
                          }
                          return (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                gitStatus.handleUnstage(node.path);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 dark:hover:bg-amber-9/20 rounded transition-all"
                              title={t('fileBrowser.unstageFile')}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                              </svg>
                            </button>
                          );
                        }}
                      />
                    </div>

                    {/* Unstaged Section */}
                    <div>
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary">
                        <span className="text-sm font-medium text-muted-foreground">
                          {t('fileBrowser.workspace', { count: gitStatus.status?.unstaged.length || 0 })}
                        </span>
                        {(gitStatus.status?.unstaged.length || 0) > 0 && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={gitStatus.handleDiscardAll}
                              className="text-sm text-red-11 hover:text-red-10 hover:underline"
                            >
                              {t('fileBrowser.discardAll')}
                            </button>
                            <button
                              onClick={gitStatus.handleStageAll}
                              className="text-sm text-green-11 hover:text-green-10 hover:underline"
                            >
                              {t('fileBrowser.stageAll')}
                            </button>
                          </div>
                        )}
                      </div>
                      <GitFileTree
                        files={gitStatus.unstagedTree}
                        selectedPath={gitStatus.statusSelectedFile?.type === 'unstaged' ? gitStatus.statusSelectedFile.file.path : null}
                        expandedPaths={gitStatus.statusExpandedPaths}
                        onSelect={(node) => node.file && gitStatus.handleStatusFileSelect(node.file as GitFileStatus, 'unstaged')}
                        onToggle={gitStatus.handleStatusToggle}
                        cwd={cwd}
                        emptyMessage={t('fileBrowser.noUnstagedChanges')}
                        className="py-1"
                        renderActions={(node) => {
                          if (node.isDirectory) {
                            const files = collectFilesUnderNode(node);
                            if (files.length === 0) return null;
                            const fileObjects = files.map(f => f.file as GitFileStatus).filter(Boolean);
                            return (
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    gitStatus.handleDiscardFiles(fileObjects);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-red-11 hover:text-red-10 hover:bg-red-9/10 dark:hover:bg-red-9/20 rounded transition-all"
                                  title={t('fileBrowser.discardNFiles', { count: files.length })}
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                  </svg>
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    gitStatus.handleStageFiles(files.map(f => f.path));
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-green-11 hover:text-green-10 hover:bg-green-9/10 dark:hover:bg-green-9/20 rounded transition-all"
                                  title={t('fileBrowser.stageNFiles', { count: files.length })}
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                  </svg>
                                </button>
                              </div>
                            );
                          }
                          if (!node.file) return null;
                          return (
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  gitStatus.handleDiscardFile(node.file as GitFileStatus);
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-red-11 hover:text-red-10 hover:bg-red-9/10 dark:hover:bg-red-9/20 rounded transition-all"
                                title={t('fileBrowser.discardChanges')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  gitStatus.handleStage(node.path);
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-green-11 hover:text-green-10 hover:bg-green-9/10 dark:hover:bg-green-9/20 rounded transition-all"
                                title={t('fileBrowser.stageFile')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                            </div>
                          );
                        }}
                      />
                    </div>

                  </div>
                )}
              </div>

              {/* History Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'history' ? '' : 'hidden'}`}>
                {gitHistory.historyError ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-16 h-16 mx-auto text-slate-7 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <p className="text-muted-foreground">{gitHistory.historyError}</p>
                    </div>
                  </div>
                ) : gitHistory.compareMode ? (
                  /* Compare mode: show file changes list on the left (replaces commit list) */
                  <div className="flex-1 overflow-y-auto">
                    {gitHistory.isLoadingCompareFiles ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.loadingDiff')}</div>
                    ) : gitHistory.compareFiles.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.noDiffFiles')}</div>
                    ) : (
                      <>
                        <div className="px-3 py-2 border-b border-border">
                          <span className="text-xs text-muted-foreground">
                            {t('fileBrowser.nFilesChanged', { count: gitHistory.compareFiles.length, branch: gitHistory.selectedBranch })}
                          </span>
                        </div>
                        <GitFileTree
                          files={gitHistory.compareFileTree}
                          expandedPaths={gitHistory.compareExpandedPaths}
                          onToggle={gitHistory.handleCompareToggle}
                          selectedPath={gitHistory.compareSelectedFile?.path || null}
                          onSelect={(node) => {
                            if (node.file) {
                              gitHistory.handleSelectCompareFile(node.file as import('./fileBrowser/types').FileChange);
                            }
                          }}
                          cwd={cwd}
                          showChanges={true}
                        />
                      </>
                    )}
                  </div>
                ) : (
                  <div
                    ref={gitHistory.commitListRef}
                    className="flex-1 overflow-y-auto"
                    onScroll={gitHistory.handleCommitListScroll}
                  >
                    {gitHistory.isLoadingCommits ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.loadingCommits')}</div>
                    ) : gitHistory.commits.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.noCommits')}</div>
                    ) : (
                      <>
                        {gitHistory.commits.map(commit => (
                          <div
                            key={commit.hash}
                            onClick={() => gitHistory.handleSelectCommit(commit)}
                            className={`px-3 py-2 border-b border-border cursor-pointer hover:bg-accent ${
                              gitHistory.selectedCommit?.hash === commit.hash ? 'bg-brand/10' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-brand">{commit.shortHash}</span>
                              <span className="text-xs text-slate-9" title={commit.date}>
                                {commit.relativeDate} · {formatDateTime(commit.date)}
                              </span>
                            </div>
                            <div className="text-sm text-foreground truncate mt-0.5" data-tooltip={commit.subject}>{commit.subject}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{commit.author}</div>
                          </div>
                        ))}
                        {gitHistory.isLoadingMore && (
                          <div className="p-3 text-center">
                            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        {!gitHistory.hasMoreCommits && gitHistory.commits.length > 0 && (
                          <div className="p-3 text-center text-xs text-slate-9">
                            {t('fileBrowser.allLoaded', { count: gitHistory.commits.length })}
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
            {/* File Browser / Recent / Search - Right Panel */}
            {(activeTab === 'tree' || activeTab === 'search' || activeTab === 'recent') && (
              fileTree.blameSelectedCommit ? (
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => fileTree.setBlameSelectedCommit(null)}
                  commit={fileTree.blameSelectedCommit}
                  cwd={cwd}
                  embedded={true}
                  initialFilePath={fileTree.selectedPath || undefined}
                  onContentSearch={(query) => {
                    setActiveTab('search');
                    contentSearch.setContentSearchQuery(query);
                    contentSearch.performContentSearch(query);
                  }}
                />
              ) : fileTree.selectedPath ? (
                <>
                  <div className="px-4 py-2 bg-secondary border-b border-border flex-shrink-0 flex items-center justify-between">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-sm text-muted-foreground truncate">
                        {fileTree.selectedPath}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(`${cwd}/${fileTree.selectedPath}`);
                          toast(t('common.copiedPath'));
                        }}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                        title={t('common.copyAbsPath')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      {/* Locate button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          locateInTree(fileTree.selectedPath!);
                        }}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                        title={t('fileBrowser.locateInTree')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10" strokeWidth={2} />
                          <circle cx="12" cy="12" r="3" strokeWidth={2} />
                          <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {fileTree.showEditor ? (
                        <>
                          {/* Edit mode: save + close */}
                          {editorState.isDirty && (
                            <span className="text-xs text-amber-11">{t('fileBrowser.unsaved')}</span>
                          )}
                          <button
                            onClick={() => editorHandleRef.current?.save()}
                            disabled={!editorState.isDirty || editorState.isSaving}
                            className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                              editorState.isDirty && !editorState.isSaving
                                ? 'bg-brand text-white hover:bg-brand/90'
                                : 'bg-secondary text-muted-foreground cursor-not-allowed'
                            }`}
                          >
                            {editorState.isSaving ? (
                              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            ) : (
                              t('common.save')
                            )}
                          </button>
                          <button
                            onClick={() => editorHandleRef.current?.close()}
                            className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                            title={t('fileBrowser.closeEdit')}
                          >
                            {t('fileBrowser.closeBtn')}
                          </button>
                        </>
                      ) : (
                        <>
                          {/* View mode: copy/edit/preview/blame */}
                          {fileTree.fileContent?.type === 'text' && fileTree.fileContent.content && (
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(fileTree.fileContent!.content!);
                                toast(t('toast.copiedFileContent'));
                              }}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                              title={t('fileBrowser.copyFileContent')}
                            >
                              {t('common.copy')}
                            </button>
                          )}
                          {fileTree.selectedPath?.endsWith('.json') && fileTree.fileContent?.type === 'text' && (
                            <button
                              onClick={() => setJsonReadable(v => !v)}
                              className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                                jsonReadable
                                  ? 'bg-brand text-white'
                                  : 'text-muted-foreground hover:bg-accent'
                              }`}
                              title={t('fileBrowser.toggleJsonReadable')}
                            >
                              {t('common.readable')}
                            </button>
                          )}
                          {fileTree.fileContent?.type === 'text' && isMarkdownFile(fileTree.selectedPath) && (
                              <button
                                onClick={() => fileTree.setShowMarkdownPreview(true)}
                                className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                                title={t('fileBrowser.previewMarkdown')}
                              >
                                {t('common.preview')}
                              </button>
                          )}
                          {fileTree.fileContent?.type === 'text' && (
                            <button
                              onClick={fileTree.handleToggleBlame}
                              disabled={fileTree.isLoadingBlame}
                              className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                                fileTree.showBlame
                                  ? 'bg-brand text-white'
                                  : 'text-muted-foreground hover:bg-accent'
                              } disabled:opacity-50`}
                              title={t('fileBrowser.viewBlame')}
                            >
                              {fileTree.isLoadingBlame ? (
                                <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                              ) : (
                                'Blame'
                              )}
                            </button>
                          )}
                          {fileTree.fileContent?.type === 'text' && (
                            <button
                              onClick={() => fileTree.setShowEditor(true)}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                              title={t('fileBrowser.editFile')}
                            >
                              {t('common.edit')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {fileTree.isLoadingContent ? (
                      <div className="h-full flex items-center justify-center">
                        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : fileTree.fileContent ? (
                      fileTree.fileContent.type === 'text' && typeof fileTree.fileContent.content === 'string' ? (
                        fileTree.showBlame && fileTree.blameError ? (
                          <div className="h-full flex items-center justify-center text-muted-foreground">
                            <div className="text-center">
                              <p className="text-red-11">{fileTree.blameError}</p>
                              <button
                                onClick={() => fileTree.setShowBlame(false)}
                                className="mt-2 text-brand hover:underline text-sm"
                              >
                                {t('fileBrowser.backToPreview')}
                              </button>
                            </div>
                          </div>
                        ) : fileTree.showBlame && fileTree.blameLines.length === 0 && fileTree.isLoadingBlame ? (
                          <div className="h-full flex items-center justify-center">
                            <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                          </div>
                        ) : jsonReadable && fileTree.selectedPath?.endsWith('.json') ? (
                          <div className="h-full flex flex-col bg-[#0d1117]">
                            <JsonSearchBar search={jsonSearch} />
                            <div className="flex-1 overflow-auto px-6 py-4">
                              <pre ref={jsonPreRef} className="whitespace-pre-wrap break-words font-mono" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
                                {formatAsHumanReadable(fileTree.fileContent.content)}
                              </pre>
                            </div>
                          </div>
                        ) : (
                          <CodeViewer
                            ref={editorHandleRef}
                            content={fileTree.fileContent.content}
                            filePath={fileTree.selectedPath}
                            cwd={cwd}
                            enableComments={true}
                            scrollToLine={editorReturnLine ?? fileTree.targetLineNumber}
                            scrollToLineAlign={editorReturnLine != null ? 'start' : fileTree.targetScrollAlign}
                            onScrollToLineComplete={() => {
                              setEditorReturnLine(null);
                              fileTree.setTargetLineNumber(null);
                            }}
                            highlightKeyword={activeTab === 'search' ? contentSearch.contentSearchQuery : null}
                            visibleLineRef={visibleLineRef}
                            viStateRef={viStateRef}
                            initialCursorLine={fileTree.initialCursorLine}
                            initialCursorCol={fileTree.initialCursorCol}
                            onInitialCursorSet={() => {
                              fileTree.setInitialCursorLine(null);
                              fileTree.setInitialCursorCol(null);
                            }}
                            onCmdClick={isLSPSupported ? handleLSPCmdClick : undefined}
                            onTokenHover={isLSPSupported ? handleLSPTokenHover : undefined}
                            onTokenHoverLeave={isLSPSupported ? lspHover.onTokenMouseLeave : undefined}
                            onTokenHoverCancel={isLSPSupported ? lspHover.clearHover : undefined}
                            blameLines={fileTree.showBlame && fileTree.blameLines.length > 0 ? fileTree.blameLines : undefined}
                            inlineBlameLines={fileTree.blameLines.length > 0 ? fileTree.blameLines : undefined}
                            onSelectCommit={fileTree.setBlameSelectedCommit}
                            editable={fileTree.showEditor}
                            initialMtime={fileTree.fileContent.mtime}
                            onEditorClose={(currentLine) => {
                              fileTree.setShowEditor(false);
                              setEditorReturnLine(currentLine);
                            }}
                            onSaved={() => {
                              const line = visibleLineRef.current ?? 1;
                              fileTree.loadFileContent(fileTree.selectedPath!);
                              fileTree.setShowEditor(false);
                              setEditorReturnLine(line);
                            }}
                            onEditorStateChange={setEditorState}
                            viMode={true}
                            onContentMutate={handleViContentMutate}
                            onEnterInsertMode={handleViEnterInsert}
                            onViSave={handleViSave}
                            onContentSearch={(query) => {
                              setActiveTab('search');
                              contentSearch.setContentSearchQuery(query);
                              contentSearch.performContentSearch(query);
                            }}
                          />
                        )
                      ) : fileTree.fileContent.type === 'image' && fileTree.fileContent.content ? (
                        <div className="h-full flex items-center justify-center p-4 bg-secondary">
                          <img
                            src={fileTree.fileContent.content}
                            alt={fileTree.selectedPath}
                            className="max-w-full max-h-full object-contain"
                          />
                        </div>
                      ) : (
                        <div className="h-full flex items-center justify-center text-muted-foreground">
                          <div className="text-center">
                            <svg className="w-16 h-16 mx-auto text-slate-7 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p>{fileTree.fileContent.message || t('fileBrowser.cannotPreview')}</p>
                          </div>
                        </div>
                      )
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        {t('fileBrowser.selectFileToPreview')}
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
                    <p>{t('fileBrowser.selectFileToPreview')}</p>
                  </div>
                </div>
              )
            )}

            {/* Status - Right Panel */}
            {activeTab === 'status' && (
              gitStatus.statusSelectedFile && gitStatus.statusDiff ? (
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="px-4 py-2 bg-secondary border-b border-border flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">
                      {gitStatus.statusSelectedFile.file.path}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(`${cwd}/${gitStatus.statusSelectedFile!.file.path}`);
                        toast(t('common.copiedPath'));
                      }}
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                      title={t('common.copyAbsPath')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                    {/* Locate in directory tree */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        locateInTree(gitStatus.statusSelectedFile!.file.path);
                      }}
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                      title={t('fileBrowser.locateInTree')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" strokeWidth={2} />
                        <circle cx="12" cy="12" r="3" strokeWidth={2} />
                        <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                      </svg>
                    </button>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      gitStatus.statusSelectedFile.type === 'staged'
                        ? 'bg-green-9/15 text-green-11 dark:bg-green-9/25'
                        : 'bg-amber-9/15 text-amber-11 dark:bg-amber-9/25'
                    }`}>
                      {gitStatus.statusSelectedFile.type === 'staged' ? t('fileBrowser.staged') : t('fileBrowser.unstaged')}
                    </span>
                    <div className="flex-1" />
                  </div>
                  <div className="flex-1 overflow-auto">
                    {isImageFile(gitStatus.statusSelectedFile.file.path) ? (
                      <div className="p-4 flex items-center justify-center">
                        <img
                          src={`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(gitStatus.statusSelectedFile.file.path)}&raw=1`}
                          alt={gitStatus.statusSelectedFile.file.path}
                          className="max-w-full max-h-[60vh] object-contain"
                        />
                      </div>
                    ) : (
                      <DiffView
                        oldContent={gitStatus.statusDiff.oldContent}
                        newContent={gitStatus.statusDiff.newContent}
                        filePath={gitStatus.statusDiff.filePath}
                        isNew={gitStatus.statusDiff.isNew}
                        isDeleted={gitStatus.statusDiff.isDeleted}
                        cwd={cwd}
                        enableComments={true}
                        onPreview={
                          !gitStatus.statusDiff.isDeleted && isMarkdownFile(gitStatus.statusSelectedFile!.file.path)
                            ? () => gitStatus.setShowStatusDiffPreview(true)
                            : !gitStatus.statusDiff.isDeleted && gitStatus.statusSelectedFile!.file.path.endsWith('.json')
                              ? () => setJsonPreview({ content: gitStatus.statusDiff!.newContent, filePath: gitStatus.statusDiff!.filePath })
                              : undefined
                        }
                        previewLabel={gitStatus.statusSelectedFile!.file.path.endsWith('.json') ? t('common.readable') : t('common.preview')}
                        onContentSearch={(query) => {
                          setActiveTab('search');
                          contentSearch.setContentSearchQuery(query);
                          contentSearch.performContentSearch(query);
                        }}
                      />
                    )}
                  </div>
                  {/* Git changes Markdown preview modal (supports selection comments + send to AI) */}
                  {gitStatus.showStatusDiffPreview && gitStatus.statusDiff && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => gitStatus.setShowStatusDiffPreview(false)}>
                      <div
                        className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-full flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <InteractiveMarkdownPreview
                          content={gitStatus.statusDiff.newContent}
                          filePath={gitStatus.statusDiff.filePath}
                          cwd={cwd}
                          onClose={() => gitStatus.setShowStatusDiffPreview(false)}
                        />
                      </div>
                    </div>
                  )}
                  {/* JSON readable preview modal */}
                  {jsonPreview && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setJsonPreview(null)}>
                      <div
                        className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90%] flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
                          <span className="text-sm text-muted-foreground font-mono truncate">{jsonPreview.filePath}</span>
                          <button
                            onClick={() => setJsonPreview(null)}
                            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <JsonSearchBar search={jsonPreviewSearch} />
                        <div className="flex-1 overflow-auto px-6 py-4 bg-[#0d1117]">
                          <pre ref={jsonPreviewPreRef} className="whitespace-pre-wrap break-words font-mono" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
                            {formatAsHumanReadable(jsonPreview.content)}
                          </pre>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-9">
                  <span>{t('fileBrowser.selectFileToViewDiff')}</span>
                </div>
              )
            )}

            {/* History - Right Panel */}
            {activeTab === 'history' && !gitHistory.historyError && (
              gitHistory.compareMode ? (
                /* Compare mode: right panel shows diff only */
                gitHistory.isLoadingCompareDiff ? (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                    {t('fileBrowser.loadingDiffContent')}
                  </div>
                ) : gitHistory.compareFileDiff ? (
                  <DiffView
                    oldContent={gitHistory.compareFileDiff.oldContent}
                    newContent={gitHistory.compareFileDiff.newContent}
                    filePath={gitHistory.compareFileDiff.filePath}
                    isNew={gitHistory.compareFileDiff.isNew}
                    isDeleted={gitHistory.compareFileDiff.isDeleted}
                    cwd={cwd}
                    enableComments={true}
                    onPreview={
                      !gitHistory.compareFileDiff.isDeleted && gitHistory.compareFileDiff.filePath.endsWith('.json')
                        ? () => setJsonPreview({ content: gitHistory.compareFileDiff!.newContent, filePath: gitHistory.compareFileDiff!.filePath })
                        : undefined
                    }
                    previewLabel={t('common.readable')}
                    onContentSearch={(query) => {
                      setActiveTab('search');
                      contentSearch.setContentSearchQuery(query);
                      contentSearch.performContentSearch(query);
                    }}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-slate-9">
                    <span>{gitHistory.compareFiles.length > 0 ? t('fileBrowser.selectFileToViewDiff') : t('fileBrowser.clickCompareToLoad')}</span>
                  </div>
                )
              ) : gitHistory.selectedCommit ? (
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => gitHistory.setSelectedCommit(null)}
                  commit={gitHistory.selectedCommit}
                  cwd={cwd}
                  embedded={true}
                  onContentSearch={(query) => {
                    setActiveTab('search');
                    contentSearch.setContentSearchQuery(query);
                    contentSearch.performContentSearch(query);
                  }}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-9">
                  <span>{t('fileBrowser.selectCommitToView')}</span>
                </div>
              )
            )}
          </div>
        </div>

        {/* Markdown preview modal (supports selection comments + send to AI) */}
        {fileTree.showMarkdownPreview && fileTree.fileContent?.type === 'text' && fileTree.selectedPath && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => fileTree.setShowMarkdownPreview(false)}>
            <div
              className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-full flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <InteractiveMarkdownPreview
                content={fileTree.fileContent.content || ''}
                filePath={fileTree.selectedPath}
                cwd={cwd}
                onClose={() => fileTree.setShowMarkdownPreview(false)}
              />
            </div>
          </div>
        )}

        {/* Quick File Open (Cmd+P) */}
        {showQuickOpen && (
          <QuickFileOpen
            files={fileTree.files}
            fileIndex={fileTree.fileIndex}
            recentFiles={fileTree.recentFilePaths}
            onSelectFile={(path) => {
              handleSelectFileWithSave(path);
              fileTree.setShouldScrollToSelected(true);
              setActiveTab('tree');
            }}
            onClose={() => setShowQuickOpen(false)}
          />
        )}
        {/* Bottom panel - search results / references, split equally when both are visible */}
        {(showSearchResults || lspReferences.visible) && (
          <div className={`flex ${lspReferences.visible && showSearchResults ? '' : 'flex-col'}`}>
            {showSearchResults && (
              <div className={lspReferences.visible ? 'flex-1 min-w-0 border-r border-border' : ''}>
                <SearchResultsPanel
                  results={contentSearch.contentSearchResults}
                  loading={contentSearch.isSearching}
                  totalMatches={contentSearch.searchStats?.totalMatches ?? 0}
                  onSelect={(path, lineNumber) => {
                    // Push current position to navigation history before jumping
                    if (fileTree.selectedPath) {
                      navHistory.push({ filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current });
                    }
                    handleSelectFileWithSave(path, lineNumber);
                  }}
                  onClose={() => setShowSearchPanel(false)}
                />
              </div>
            )}
            {lspReferences.visible && (
              <div className={showSearchResults ? 'flex-1 min-w-0' : ''}>
                <ReferencesPanel
                  references={lspReferences.references}
                  loading={lspReferences.loading}
                  onSelect={handleLSPReferenceSelect}
                  onClose={lspReferences.closeReferences}
                />
              </div>
            )}
          </div>
        )}
      </div>
      {/* Global tooltip - portaled to document body top */}
      {hoverTooltip && createPortal(
        <div
          className="fixed z-[9999] px-2 py-1 bg-popover text-popover-foreground text-xs font-mono rounded shadow-lg border border-brand whitespace-nowrap pointer-events-none"
          style={{ left: hoverTooltip.x + 12, top: hoverTooltip.y + 16 }}
        >
          {hoverTooltip.text}
        </div>,
        document.body
      )}
      {/* Delete confirmation dialog */}
      {deleteConfirm && createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-card border border-border rounded-lg shadow-xl p-4 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-foreground mb-2">{t('fileBrowser.confirmDelete')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t('fileBrowser.confirmDeleteMessage', { name: deleteConfirm.name }).split(/<\/?file>/g).map((part, i) =>
                i === 1 ? <span key={i} className="font-mono text-foreground">{part}</span> : part
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-accent transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  const { path, name } = deleteConfirm;
                  setDeleteConfirm(null);
                  try {
                    const res = await fetch('/api/files/delete', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ cwd, path }),
                    });
                    if (res.ok) {
                      toast(t('toast.movedToTrash', { name }), 'success');
                      const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
                      fileTree.loadDirectory(parentDir);
                      fileTree.loadFileIndex();
                      if (fileTree.selectedPath === path) {
                        handleSelectFileWithSave('');
                      }
                    } else {
                      const data = await res.json();
                      toast(data.error || t('toast.deleteFailed'), 'error');
                    }
                  } catch { toast(t('toast.deleteFailed'), 'error'); }
                }}
                className="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* LSP HoverTooltip - portaled inside menuContainer, using absolute positioning */}
      {lspHover.hoverInfo && menuContainer && createPortal(
        <HoverTooltip
          ref={(el: HTMLDivElement | null) => { lspHover.tooltipElRef.current = el; }}
          displayString={lspHover.hoverInfo.displayString}
          documentation={lspHover.hoverInfo.documentation}
          x={lspHover.hoverInfo.x}
          y={lspHover.hoverInfo.y}
          container={menuContainer}
          onMouseEnter={lspHover.onCardMouseEnter}
          onMouseLeave={lspHover.onCardMouseLeave}
          onFindReferences={() => {
            const { filePath, line, column } = lspHover.hoverInfo!;
            lspHover.clearHover();
            lspReferences.findReferences(filePath, line, column);
          }}
          onSearch={(keyword) => {
            lspHover.clearHover();
            setActiveTab('search');
            contentSearch.setContentSearchQuery(keyword);
            contentSearch.performContentSearch(keyword);
          }}
        />,
        menuContainer,
      )}
    </MenuContainerProvider>
  );
}
