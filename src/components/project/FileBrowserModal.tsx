'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CommitDetailPanel, type CommitInfo } from './CommitDetailPanel';
import { DiffView } from './DiffView';
import { toast } from '../shared/Toast';
import { FileTree, type GitStatusMap, type GitStatusCode } from './FileTree';
import { GitFileTree, type GitFileNode, buildGitFileTree, collectGitTreeDirPaths, collectFilesUnderNode } from './GitFileTree';
import { MenuContainerProvider } from './FileContextMenu';
import { CodeViewer } from './CodeViewer';
import { isMarkdownFile } from './MarkdownFileViewer';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { FileIcon } from '../shared/FileIcon';
import { FileEditorInline, type FileEditorHandle } from './FileEditorModal';
import { QuickFileOpen } from './QuickFileOpen';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePageVisible } from '@/hooks/usePageVisible';

import type { TabType, GitFileStatus, GitStatusResponse, FileBrowserModalProps, SearchResult } from './fileBrowser/types';
import { getTargetDirPath, isImageFile, formatDateTime, NOOP, COMMITS_PER_PAGE } from './fileBrowser/utils';
import { BlameView } from './fileBrowser/BlameView';
import { BranchSelector } from './fileBrowser/BranchSelector';

import { useFileTree } from '../../hooks/useFileTree';
import { useContentSearch } from '../../hooks/useContentSearch';
import { useGitStatus } from '../../hooks/useGitStatus';
import { useGitHistory } from '../../hooks/useGitHistory';
import { useLSPDefinition, useLSPHover, useLSPReferences, useLSPWarmup } from '../../hooks/useLSP';
import { getLanguageForFile } from '@/lib/lsp/types';
import { HoverTooltip } from './HoverTooltip';
import { ReferencesPanel } from './ReferencesPanel';
import { SearchResultsPanel } from './SearchResultsPanel';
import type { Location } from '@/lib/lsp/types';

export function FileBrowserModal({ onClose, cwd, initialTab = 'tree', tabSwitchTrigger }: FileBrowserModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; isDirectory: boolean; name: string } | null>(null);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  // CodeViewer 当前可见行号（1-based），用于编辑器 ↔ 查看器行位置同步
  const visibleLineRef = useRef<number>(1);
  // 从编辑器返回时要跳转的行号
  const [editorReturnLine, setEditorReturnLine] = useState<number | null>(null);
  // 编辑器 ref 和状态（用于顶部工具栏渲染保存/关闭按钮）
  const editorHandleRef = useRef<FileEditorHandle>(null);
  const [editorState, setEditorState] = useState({ isDirty: false, isSaving: false });
  const [showSearchPanel, setShowSearchPanel] = useState(false);

  // ========== Hooks ==========
  const lspDefinition = useLSPDefinition(cwd);
  const lspHover = useLSPHover(cwd);
  const lspReferences = useLSPReferences(cwd);

  const pageVisible = usePageVisible();
  const fileTree = useFileTree({ cwd });
  useLSPWarmup(cwd, fileTree.selectedPath);
  const contentSearch = useContentSearch({ cwd, onSearchComplete: () => setShowSearchPanel(true) });
  const gitStatus = useGitStatus({ cwd, addToRecentFiles: fileTree.addToRecentFiles });
  const gitHistory = useGitHistory({ cwd, addToRecentFiles: fileTree.addToRecentFiles });

  // ========== Search results tree ==========
  const searchTree = useMemo(() => {
    const results = contentSearch.contentSearchResults;
    if (results.length === 0) return { tree: [] as GitFileNode<SearchResult>[], dirPaths: new Set<string>(), matchMap: new Map<string, SearchResult>() };
    // 构建 path → SearchResult 查找表
    const matchMap = new Map<string, SearchResult>();
    const input = results.map(r => {
      matchMap.set(r.path, r);
      return { path: r.path, status: 'modified' as const };
    });
    const tree = buildGitFileTree(input);
    const dirPaths = new Set(collectGitTreeDirPaths(tree));
    return { tree: tree as unknown as GitFileNode<SearchResult>[], dirPaths, matchMap };
  }, [contentSearch.contentSearchResults]);

  // 搜索树展开路径 — 搜索完成后默认全展开
  const [searchTreeExpanded, setSearchTreeExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSearchTreeExpanded(searchTree.dirPaths);
  }, [searchTree.dirPaths]);

  const handleSearchTreeToggle = useCallback((path: string) => {
    setSearchTreeExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderSearchActions = useCallback((node: GitFileNode<unknown>) => {
    if (node.isDirectory) return null;
    const result = searchTree.matchMap.get(node.path);
    if (!result) return null;
    return <span className="text-xs text-muted-foreground">{result.matches.length}</span> as ReactNode;
  }, [searchTree.matchMap]);

  const showSearchResults = showSearchPanel && contentSearch.contentSearchResults.length > 0;

  // ========== LSP handlers (depend on fileTree) ==========
  const isLSPSupported = fileTree.selectedPath ? getLanguageForFile(fileTree.selectedPath) !== null : false;

  const handleLSPCmdClick = useCallback(async (line: number, column: number) => {
    if (!fileTree.selectedPath || !isLSPSupported) return;

    const definitions = await lspDefinition.goToDefinition(fileTree.selectedPath, line, column);
    if (definitions.length === 0) return;

    const def = definitions[0];
    // tsserver 返回绝对路径，转为相对路径（相对于 cwd）
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const relativePath = def.file.startsWith(cwdPrefix)
      ? def.file.slice(cwdPrefix.length)
      : def.file;

    if (relativePath === fileTree.selectedPath) {
      // 同文件：滚动到目标行
      fileTree.setTargetLineNumber(def.line);
    } else {
      fileTree.handleSelectFile(relativePath, def.line);
    }
  }, [fileTree, cwd, isLSPSupported, lspDefinition]);

  const handleLSPTokenHover = useCallback((line: number, column: number, rect: { x: number; y: number }) => {
    if (!fileTree.selectedPath || !isLSPSupported) return;
    lspHover.onTokenMouseEnter(fileTree.selectedPath, line, column, rect);
  }, [fileTree.selectedPath, isLSPSupported, lspHover]);

  const handleLSPReferenceSelect = useCallback((ref: Location) => {
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const relativePath = ref.file.startsWith(cwdPrefix)
      ? ref.file.slice(cwdPrefix.length)
      : ref.file;

    if (relativePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(ref.line);
    } else {
      fileTree.handleSelectFile(relativePath, ref.line);
    }
  }, [fileTree, cwd]);

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

  // ========== 全局 data-tooltip 事件代理 ==========
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

  // ========== Tab 切换处理 ==========
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    fileTree.setBlameSelectedCommit(null);
  }, [fileTree]);

  // ========== Keyboard Shortcuts ==========
  const lastEscTimeRef = useRef<number>(0);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+P / Ctrl+P → Quick file open
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setShowQuickOpen(prev => !prev);
        return;
      }

      if (e.key === 'Escape') {
        // Close quick open first
        if (showQuickOpen) {
          setShowQuickOpen(false);
          return;
        }

        const now = Date.now();
        if (now - lastEscTimeRef.current < 3000) {
          return;
        }
        lastEscTimeRef.current = now;

        // 优先关闭底部面板
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
  }, [onClose, fileTree.showBlame, fileTree.blameSelectedCommit, fileTree, showQuickOpen, lspReferences.visible, lspReferences.closeReferences, showSearchPanel]);

  // ========== Initial Data Load (once on mount) ==========
  useEffect(() => {
    fileTree.loadExpandedPaths();
    fileTree.loadFiles();
    fileTree.loadRecentFiles();
    gitStatus.fetchStatus();
    gitHistory.loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听外部 git 操作（如 ChatInput 的暂存按钮）触发刷新
  useEffect(() => {
    const handler = () => { gitStatus.fetchStatus(); };
    window.addEventListener('git-status-changed', handler);
    return () => window.removeEventListener('git-status-changed', handler);
  }, [gitStatus.fetchStatus]);

  // iframe 恢复可见时，刷新一次数据（WS 暂停期间可能遗漏变更）
  const prevVisibleRef = useRef(pageVisible);
  useEffect(() => {
    if (pageVisible && !prevVisibleRef.current) {
      fileTree.loadFiles();
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
      const needsUpdate = !fileTree.selectedPath || (isFromOtherTab && fileTree.selectedPath !== fileTree.recentFiles[0]);

      if (needsUpdate) {
        fileTree.setShouldScrollToSelected(true);
        fileTree.handleSelectFile(fileTree.recentFiles[0]);
      }
    }
  }, [activeTab, fileTree.recentFiles, fileTree.selectedPath, fileTree.handleSelectFile, fileTree]);

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
  // 用 ref 保存最新值，避免 SSE 回调依赖频繁变化的 state
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
          fetch(`/api/files/list?cwd=${encodeURIComponent(cwd)}`)
            .then(res => res.json())
            .then(data => { if (!data.error) fileTree.setFiles(data.files || []); })
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
        // 刷新当前正在查看的 diff
        gitStatus.refreshDiff();

        if (hasGitChange) {
          // 分支切换时同步 BranchSelector：重新获取分支列表和当前分支
          // loadBranches 内部会 setSelectedBranch(data.current)，
          // useEffect[selectedBranch] 会自动重新加载 commits
          gitHistory.loadBranches();
        } else {
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
  // fileTree/gitStatus/gitHistory 是 hooks 返回的稳定对象引用，不会频繁变化
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: handleWatchMessage,
    enabled: pageVisible,  // 隐藏的 iframe 暂停文件监听，避免无效并发请求
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
                目录树
              </button>
              <button
                onClick={() => handleTabChange('search')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'search'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                搜索
              </button>
              <button
                onClick={() => handleTabChange('recent')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                最近
              </button>
              <button
                onClick={() => handleTabChange('status')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'status'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                变更
              </button>
              <button
                onClick={() => handleTabChange('history')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'history'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                历史
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
                    placeholder="搜索文件..."
                    className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {fileTree.searchQuery && (
                    <button
                      onClick={() => fileTree.setSearchQuery('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-9 hover:text-foreground rounded-sm transition-colors"
                      title="清除"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {/* 目录全匹配开关 */}
                <button
                  onClick={() => fileTree.setSearchDirExact(v => !v)}
                  className={`px-1 py-0.5 rounded transition-colors text-xs font-mono font-bold border ${
                    fileTree.searchExactMatch
                      ? 'border-brand text-brand bg-brand/10'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title={fileTree.searchExactMatch ? '全词匹配（已开启）' : '全词匹配（已关闭）'}
                >
                  ab
                </button>
                {/* 功能按钮组 */}
                <div className="flex items-center gap-0.5">
                  {/* 刷新 */}
                  <button
                    onClick={() => fileTree.loadFiles()}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    title="刷新目录树"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  {/* 折叠所有 */}
                  <button
                    onClick={() => fileTree.searchTreeExpandedPaths ? fileTree.setSearchTreeExpandedPaths(new Set()) : fileTree.setExpandedPaths(new Set())}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    title="折叠所有目录"
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
                      placeholder="搜索文件内容..."
                      className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {contentSearch.contentSearchQuery && (
                      <button
                        onClick={() => contentSearch.setContentSearchQuery('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-9 hover:text-foreground rounded-sm transition-colors"
                        title="清除"
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
                    {contentSearch.isSearching ? '...' : '搜索'}
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
                    <span className="text-muted-foreground">区分大小写</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.wholeWord}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, wholeWord: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">完整词</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.regex}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, regex: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">正则</span>
                  </label>
                  <input
                    type="text"
                    value={contentSearch.searchOptions.fileType}
                    onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, fileType: e.target.value }))}
                    placeholder="文件类型 (ts,tsx)"
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
                        // 对比模式下切换分支自动刷新
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
                    title={gitHistory.compareMode ? '关闭分支对比' : '与选定分支对比'}
                  >
                    对比
                  </button>
                </div>
              </div>
            )}

            {/* List Content - 使用 CSS 显示/隐藏避免组件重新挂载 */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Tree Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'tree' ? '' : 'hidden'}`}>
                {/* 新建文件输入框 */}
                {fileTree.creatingItem && (
                  <div className="px-2 py-1.5 border-b border-border bg-secondary flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      新建文件
                      {fileTree.creatingItem.parentPath && ` (在 ${fileTree.creatingItem.parentPath}/)`}
                    </span>
                    <input
                      type="text"
                      autoFocus
                      placeholder="文件名..."
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
                              toast(`已创建文件: ${name}`, 'success');
                              fileTree.setCreatingItem(null);
                              fileTree.loadFiles();
                              if (parentPath) {
                                fileTree.setExpandedPaths(prev => new Set([...prev, parentPath]));
                              }
                              fileTree.handleSelectFile(fullPath);
                            } else {
                              const data = await res.json();
                              toast(data.error || '创建失败', 'error');
                            }
                          } catch (err) {
                            toast('创建失败', 'error');
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
                  <div className="p-4 text-center text-muted-foreground text-sm">加载中...</div>
                ) : fileTree.fileError ? (
                  <div className="p-4 text-center text-red-11 text-sm">{fileTree.fileError}</div>
                ) : (
                  <FileTree
                    files={fileTree.files}
                    selectedPath={fileTree.selectedPath}
                    expandedPaths={fileTree.effectiveExpandedPaths}
                    matchedPaths={fileTree.matchedPaths}
                    gitStatusMap={gitStatusMap}
                    onSelect={(path) => {
                      fileTree.setShouldScrollToSelected(false);
                      fileTree.handleSelectFile(path);
                    }}
                    onToggle={fileTree.handleToggle}
                    cwd={cwd}
                    shouldScrollToSelected={fileTree.shouldScrollToSelected}
                    onCreateFile={(dirPath) => fileTree.setCreatingItem({ type: 'file', parentPath: dirPath })}
                    onDelete={(path, isDir, name) => setDeleteConfirm({ path, isDirectory: isDir, name })}
                    onRefresh={() => fileTree.loadFiles()}
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
                    {contentSearch.contentSearchQuery ? '无匹配结果' : '输入关键词搜索文件内容'}
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
                    {/* 搜索统计 */}
                    {contentSearch.searchStats && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground bg-secondary border-b border-border flex-shrink-0">
                        {contentSearch.searchStats.totalFiles} 个文件，{contentSearch.searchStats.totalMatches} 处匹配
                        {contentSearch.searchStats.truncated && <span className="text-amber-11 ml-1">(结果已截断)</span>}
                      </div>
                    )}
                    {/* 搜索结果目录树 */}
                    <GitFileTree
                      files={searchTree.tree}
                      selectedPath={fileTree.selectedPath}
                      expandedPaths={searchTreeExpanded}
                      onSelect={(node) => {
                        const result = searchTree.matchMap.get(node.path);
                        fileTree.handleSelectFile(node.path, result?.matches[0]?.lineNumber);
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
                    暂无最近浏览的文件
                  </div>
                ) : (
                  <FileTree
                    files={fileTree.recentFilesTree}
                    selectedPath={fileTree.selectedPath}
                    expandedPaths={fileTree.recentTreeDirPaths}
                    onSelect={fileTree.handleSelectFile}
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
                            暂存区 ({gitStatus.status?.staged.length || 0})
                          </span>
                          <button
                            onClick={() => gitStatus.fetchStatus()}
                            className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                            title="刷新变更列表"
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
                            全部取消
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
                        emptyMessage="无暂存的文件"
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
                                title={`取消暂存 ${files.length} 个文件`}
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
                              title="取消暂存"
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
                          工作区 ({gitStatus.status?.unstaged.length || 0})
                        </span>
                        {(gitStatus.status?.unstaged.length || 0) > 0 && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={gitStatus.handleDiscardAll}
                              className="text-sm text-red-11 hover:text-red-10 hover:underline"
                            >
                              放弃所有
                            </button>
                            <button
                              onClick={gitStatus.handleStageAll}
                              className="text-sm text-green-11 hover:text-green-10 hover:underline"
                            >
                              全部暂存
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
                        emptyMessage="无未暂存的变更"
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
                                  title={`放弃 ${files.length} 个文件的变更`}
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
                                  title={`暂存 ${files.length} 个文件`}
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
                                title="放弃变更"
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
                                title="暂存文件"
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
                  /* 对比模式：左侧显示文件变更列表（替换 commit 列表） */
                  <div className="flex-1 overflow-y-auto">
                    {gitHistory.isLoadingCompareFiles ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">加载对比文件中...</div>
                    ) : gitHistory.compareFiles.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">无差异文件</div>
                    ) : (
                      <>
                        <div className="px-3 py-2 border-b border-border">
                          <span className="text-xs text-muted-foreground">
                            {gitHistory.compareFiles.length} 个文件变更（vs {gitHistory.selectedBranch}）
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
                      <div className="p-4 text-center text-muted-foreground text-sm">加载提交记录中...</div>
                    ) : gitHistory.commits.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">无提交记录</div>
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
                            已加载全部 {gitHistory.commits.length} 条记录
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
                          toast('已复制路径');
                        }}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                        title="复制绝对路径"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      {/* 定位按钮 */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          locateInTree(fileTree.selectedPath!);
                        }}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                        title="在目录树中定位"
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
                          {/* 编辑模式：保存 + 关闭 */}
                          {editorState.isDirty && (
                            <span className="text-xs text-amber-11">未保存</span>
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
                              '保存'
                            )}
                          </button>
                          <button
                            onClick={() => editorHandleRef.current?.close()}
                            className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                            title="关闭编辑 (ESC)"
                          >
                            关闭
                          </button>
                        </>
                      ) : (
                        <>
                          {/* 查看模式：复制/编辑/预览/Blame */}
                          {fileTree.fileContent?.type === 'text' && fileTree.fileContent.content && (
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(fileTree.fileContent!.content!);
                                toast('已复制文件内容');
                              }}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                              title="复制文件内容"
                            >
                              复制
                            </button>
                          )}
                          {fileTree.fileContent?.type === 'text' && isMarkdownFile(fileTree.selectedPath) && (
                            <button
                              onClick={() => fileTree.setShowMarkdownPreview(true)}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-accent"
                              title="预览 Markdown 渲染效果"
                            >
                              预览
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
                              title="查看每行代码的修改记录"
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
                              title="编辑文件"
                            >
                              编辑
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
                        fileTree.showBlame ? (
                          fileTree.blameError ? (
                            <div className="h-full flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <p className="text-red-11">{fileTree.blameError}</p>
                                <button
                                  onClick={() => fileTree.setShowBlame(false)}
                                  className="mt-2 text-brand hover:underline text-sm"
                                >
                                  返回预览
                                </button>
                              </div>
                            </div>
                          ) : fileTree.blameLines.length > 0 ? (
                            <BlameView blameLines={fileTree.blameLines} cwd={cwd} onSelectCommit={fileTree.setBlameSelectedCommit} />
                          ) : (
                            <div className="h-full flex items-center justify-center">
                              <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                            </div>
                          )
                        ) : fileTree.showEditor ? (
                          <FileEditorInline
                            ref={editorHandleRef}
                            filePath={fileTree.selectedPath!}
                            initialContent={fileTree.fileContent.content}
                            initialMtime={fileTree.fileContent.mtime}
                            cwd={cwd}
                            initialLine={visibleLineRef.current}
                            onClose={(currentLine) => {
                              fileTree.setShowEditor(false);
                              setEditorReturnLine(currentLine);
                            }}
                            onSaved={() => {
                              fileTree.loadFileContent(fileTree.selectedPath!);
                            }}
                            onStateChange={setEditorState}
                          />
                        ) : (
                          <CodeViewer
                            content={fileTree.fileContent.content}
                            filePath={fileTree.selectedPath}
                            cwd={cwd}
                            enableComments={true}
                            scrollToLine={editorReturnLine ?? fileTree.targetLineNumber}
                            onScrollToLineComplete={() => {
                              setEditorReturnLine(null);
                              fileTree.setTargetLineNumber(null);
                            }}
                            highlightKeyword={activeTab === 'search' ? contentSearch.contentSearchQuery : null}
                            visibleLineRef={visibleLineRef}
                            onCmdClick={isLSPSupported ? handleLSPCmdClick : undefined}
                            onTokenHover={isLSPSupported ? handleLSPTokenHover : undefined}
                            onTokenHoverLeave={isLSPSupported ? lspHover.onTokenMouseLeave : undefined}
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
                            <p>{fileTree.fileContent.message || '无法预览此文件'}</p>
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
                        toast('已复制路径');
                      }}
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                      title="复制绝对路径"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                    {/* 在目录树中定位 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        locateInTree(gitStatus.statusSelectedFile!.file.path);
                      }}
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                      title="在目录树中定位"
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
                      {gitStatus.statusSelectedFile.type === 'staged' ? '已暂存' : '未暂存'}
                    </span>
                    <div className="flex-1" />
                    {/* Markdown 预览按钮 */}
                    {isMarkdownFile(gitStatus.statusSelectedFile.file.path) && gitStatus.statusDiff && !gitStatus.statusDiff.isDeleted && (
                      <button
                        onClick={() => gitStatus.setShowStatusDiffPreview(true)}
                        className="px-2 py-1 text-xs rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent"
                        title="预览 Markdown 渲染效果"
                      >
                        预览
                      </button>
                    )}
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
                      />
                    )}
                  </div>
                  {/* Git 变更 Markdown 预览 Modal */}
                  {gitStatus.showStatusDiffPreview && gitStatus.statusDiff && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => gitStatus.setShowStatusDiffPreview(false)}>
                      <div
                        className="bg-card rounded-lg shadow-xl w-full max-w-[70%] h-full flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
                          <span className="text-sm font-medium text-foreground truncate">{gitStatus.statusDiff.filePath}</span>
                          <button
                            onClick={() => gitStatus.setShowStatusDiffPreview(false)}
                            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                            title="关闭"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex-1 overflow-auto p-6">
                          <MarkdownRenderer content={gitStatus.statusDiff.newContent} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-9">
                  <span>选择文件查看差异</span>
                </div>
              )
            )}

            {/* History - Right Panel */}
            {activeTab === 'history' && !gitHistory.historyError && (
              gitHistory.compareMode ? (
                /* 对比模式：右侧仅显示 diff */
                gitHistory.isLoadingCompareDiff ? (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                    加载差异中...
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
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-slate-9">
                    <span>{gitHistory.compareFiles.length > 0 ? '选择文件查看差异' : '点击「对比」加载分支差异'}</span>
                  </div>
                )
              ) : gitHistory.selectedCommit ? (
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => gitHistory.setSelectedCommit(null)}
                  commit={gitHistory.selectedCommit}
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

        {/* Markdown 预览 Modal */}
        {fileTree.showMarkdownPreview && fileTree.fileContent?.type === 'text' && fileTree.selectedPath && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => fileTree.setShowMarkdownPreview(false)}>
            <div
              className="bg-card rounded-lg shadow-xl w-full max-w-[70%] h-full flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
                <span className="text-sm font-medium text-foreground truncate">{fileTree.selectedPath}</span>
                <button
                  onClick={() => fileTree.setShowMarkdownPreview(false)}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  title="关闭"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Modal Content */}
              <div className="flex-1 overflow-auto p-6">
                <MarkdownRenderer content={fileTree.fileContent.content || ''} />
              </div>
            </div>
          </div>
        )}

        {/* Quick File Open (Cmd+P) */}
        {showQuickOpen && (
          <QuickFileOpen
            files={fileTree.files}
            recentFiles={fileTree.recentFiles}
            onSelectFile={(path) => {
              fileTree.handleSelectFile(path);
              fileTree.setShouldScrollToSelected(true);
              setActiveTab('tree');
            }}
            onClose={() => setShowQuickOpen(false)}
          />
        )}
        {/* 底部面板 - 搜索结果 / 引用，同时存在时左右各半 */}
        {(showSearchResults || lspReferences.visible) && (
          <div className={`flex ${lspReferences.visible && showSearchResults ? '' : 'flex-col'}`}>
            {showSearchResults && (
              <div className={lspReferences.visible ? 'flex-1 min-w-0 border-r border-border' : ''}>
                <SearchResultsPanel
                  results={contentSearch.contentSearchResults}
                  loading={contentSearch.isSearching}
                  totalMatches={contentSearch.searchStats?.totalMatches ?? 0}
                  onSelect={(path, lineNumber) => {
                    fileTree.handleSelectFile(path, lineNumber);
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
      {/* 全局 tooltip - portal 到 body 顶层 */}
      {hoverTooltip && createPortal(
        <div
          className="fixed z-[9999] px-2 py-1 bg-popover text-popover-foreground text-xs font-mono rounded shadow-lg border border-brand whitespace-nowrap pointer-events-none"
          style={{ left: hoverTooltip.x + 12, top: hoverTooltip.y + 16 }}
        >
          {hoverTooltip.text}
        </div>,
        document.body
      )}
      {/* 删除确认对话框 */}
      {deleteConfirm && createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-card border border-border rounded-lg shadow-xl p-4 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-foreground mb-2">确认删除</h3>
            <p className="text-sm text-muted-foreground mb-4">
              确定要删除 <span className="font-mono text-foreground">{deleteConfirm.name}</span> 吗？此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-accent transition-colors"
              >
                取消
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
                      toast(`已删除 ${name}`, 'success');
                      fileTree.loadFiles();
                      if (fileTree.selectedPath === path) {
                        fileTree.handleSelectFile('');
                      }
                    } else {
                      const data = await res.json();
                      toast(data.error || '删除失败', 'error');
                    }
                  } catch { toast('删除失败', 'error'); }
                }}
                className="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* LSP HoverTooltip - portal 到 menuContainer 内，使用 absolute 定位 */}
      {lspHover.hoverInfo && menuContainer && createPortal(
        <HoverTooltip
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
