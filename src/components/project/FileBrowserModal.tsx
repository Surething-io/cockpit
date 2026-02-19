'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { CommitDetailPanel, type CommitInfo } from './CommitDetailPanel';
import { DiffView } from './DiffView';
import { toast } from '../shared/Toast';
import { FileTree, type GitStatusMap, type GitStatusCode } from './FileTree';
import { GitFileTree, buildGitFileTree, collectGitTreeDirPaths, collectFilesUnderNode } from './GitFileTree';
import { MenuContainerProvider } from './FileContextMenu';
import { CodeViewer } from './CodeViewer';
import { isMarkdownFile } from './MarkdownFileViewer';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { FileIcon } from '../shared/FileIcon';
import { FileEditorModal } from './FileEditorModal';
import { QuickFileOpen } from './QuickFileOpen';

import type { TabType, GitFileStatus, GitStatusResponse, FileBrowserModalProps } from './fileBrowser/types';
import { getTargetDirPath, isImageFile, formatDateTime, NOOP, COMMITS_PER_PAGE } from './fileBrowser/utils';
import { BlameView } from './fileBrowser/BlameView';
import { BranchSelector } from './fileBrowser/BranchSelector';

import { useFileTree } from '../../hooks/useFileTree';
import { useContentSearch } from '../../hooks/useContentSearch';
import { useGitStatus } from '../../hooks/useGitStatus';
import { useGitHistory } from '../../hooks/useGitHistory';

export function FileBrowserModal({ onClose, cwd, initialTab = 'tree', tabSwitchTrigger }: FileBrowserModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  // ========== Hooks ==========
  const fileTree = useFileTree({ cwd });
  const contentSearch = useContentSearch({ cwd });
  const gitStatus = useGitStatus({ cwd, addToRecentFiles: fileTree.addToRecentFiles });
  const gitHistory = useGitHistory({ cwd, addToRecentFiles: fileTree.addToRecentFiles });

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

        if (fileTree.blameSelectedCommit) {
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
  }, [onClose, fileTree.showBlame, fileTree.blameSelectedCommit, fileTree, showQuickOpen]);

  // ========== Initial Data Load (once on mount) ==========
  useEffect(() => {
    fileTree.loadExpandedPaths();
    fileTree.loadFiles();
    fileTree.loadRecentFiles();
    gitStatus.fetchStatus();
    gitHistory.loadBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    const eventSource = new EventSource(`/api/watch?cwd=${encodeURIComponent(cwd)}`);

    eventSource.onmessage = async (e) => {
      try {
        const events: Array<{ type: 'file' | 'git' }> = JSON.parse(e.data);

        const hasGitChange = events.some(ev => ev.type === 'git');
        const hasFileChange = events.some(ev => ev.type === 'file');

        // 构建并行请求
        const promises: Promise<void>[] = [];

        // 文件变更 → 刷新目录树和最近文件
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

        // git 变更 → 刷新 git status 和 commits
        if (hasGitChange) {
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

        // 当前打开的文件：有任何变化都刷新内容
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
        console.error('File watch SSE handler error:', err);
      }
    };

    eventSource.onerror = () => {
      // EventSource 会自动重连，这里只做日志
      console.warn('File watch SSE connection error, will auto-reconnect');
    };

    return () => {
      eventSource.close();
    };
  // fileTree/gitStatus/gitHistory 是 hooks 返回的稳定对象引用，不会频繁变化
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

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
                  {/* 新建文件 */}
                  <button
                    onClick={() => {
                      const targetDir = getTargetDirPath(fileTree.selectedPath, fileTree.files);
                      fileTree.setCreatingItem({ type: 'file', parentPath: targetDir });
                    }}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    title="新建文件"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </button>
                  {/* 新建文件夹 */}
                  <button
                    onClick={() => {
                      const targetDir = getTargetDirPath(fileTree.selectedPath, fileTree.files);
                      fileTree.setCreatingItem({ type: 'folder', parentPath: targetDir });
                    }}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    title="新建文件夹"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                  </button>
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
                <BranchSelector
                  branches={gitHistory.branches}
                  selectedBranch={gitHistory.selectedBranch}
                  onSelect={gitHistory.setSelectedBranch}
                  isLoading={gitHistory.isLoadingBranches}
                />
              </div>
            )}

            {/* List Content - 使用 CSS 显示/隐藏避免组件重新挂载 */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Tree Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'tree' ? '' : 'hidden'}`}>
                {/* 新建文件/文件夹输入框 */}
                {fileTree.creatingItem && (
                  <div className="px-2 py-1.5 border-b border-border bg-secondary flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {fileTree.creatingItem.type === 'file' ? '新建文件' : '新建文件夹'}
                      {fileTree.creatingItem.parentPath && ` (在 ${fileTree.creatingItem.parentPath}/)`}
                    </span>
                    <input
                      type="text"
                      autoFocus
                      placeholder={fileTree.creatingItem.type === 'file' ? '文件名...' : '文件夹名...'}
                      className="flex-1 px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          const name = (e.target as HTMLInputElement).value.trim();
                          if (!name) return;
                          const fullPath = fileTree.creatingItem!.parentPath ? `${fileTree.creatingItem!.parentPath}/${name}` : name;
                          try {
                            const res = await fetch('/api/files/save', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                cwd,
                                path: fullPath,
                                content: fileTree.creatingItem!.type === 'file' ? '' : null,
                                createDir: fileTree.creatingItem!.type === 'folder',
                              }),
                            });
                            if (res.ok) {
                              toast(`已创建 ${fileTree.creatingItem!.type === 'file' ? '文件' : '文件夹'}: ${name}`, 'success');
                              fileTree.setCreatingItem(null);
                              fileTree.loadFiles();
                              if (fileTree.creatingItem!.parentPath) {
                                fileTree.setExpandedPaths(prev => new Set([...prev, fileTree.creatingItem!.parentPath]));
                              }
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
                  <div className="flex-1 overflow-y-auto">
                    {/* 搜索统计 */}
                    {contentSearch.searchStats && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground bg-secondary border-b border-border">
                        {contentSearch.searchStats.totalFiles} 个文件，{contentSearch.searchStats.totalMatches} 处匹配
                        {contentSearch.searchStats.truncated && <span className="text-amber-11 ml-1">(结果已截断)</span>}
                      </div>
                    )}
                    {/* 搜索结果列表 */}
                    {contentSearch.contentSearchResults.map((result) => (
                      <div key={result.path} className="border-b border-border">
                        {/* 文件头 */}
                        <div
                          className="flex items-center gap-2 px-3 py-1.5 bg-secondary hover:bg-accent cursor-pointer"
                          onClick={() => contentSearch.handleSearchToggle(result.path)}
                          data-tooltip={result.path}
                        >
                          <svg
                            className={`w-3 h-3 flex-shrink-0 text-muted-foreground transition-transform ${
                              contentSearch.searchExpandedPaths.has(result.path) ? 'rotate-90' : ''
                            }`}
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <path d="M6 4 L10 8 L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <FileIcon name={result.path.split('/').pop() || ''} size={14} className="flex-shrink-0" />
                          <span className="text-sm text-foreground truncate flex-1">{result.path}</span>
                          <span className="text-xs text-muted-foreground">{result.matches.length}</span>
                        </div>
                        {/* 匹配行 */}
                        {contentSearch.searchExpandedPaths.has(result.path) && (
                          <div className="bg-card">
                            {result.matches.map((match, idx) => (
                              <div
                                key={idx}
                                className="flex items-start gap-2 px-3 py-1 hover:bg-accent cursor-pointer text-sm font-mono"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  fileTree.handleSelectFile(result.path, match.lineNumber);
                                }}
                                data-tooltip={match.content.trim()}
                              >
                                <span className="text-muted-foreground w-8 text-right flex-shrink-0">
                                  {match.lineNumber}
                                </span>
                                <span className="text-foreground truncate">
                                  {match.content}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
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
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* 编辑按钮 */}
                      {fileTree.fileContent?.type === 'text' && (
                        <button
                          onClick={() => fileTree.setShowEditor(true)}
                          className="px-2 py-1 text-sm rounded transition-colors text-muted-foreground hover:bg-accent"
                          title="编辑文件"
                        >
                          编辑
                        </button>
                      )}
                      {/* Markdown 预览按钮 */}
                      {fileTree.fileContent?.type === 'text' && isMarkdownFile(fileTree.selectedPath) && (
                        <button
                          onClick={() => fileTree.setShowMarkdownPreview(true)}
                          className="px-2 py-1 text-sm rounded transition-colors text-muted-foreground hover:bg-accent"
                          title="预览 Markdown 渲染效果"
                        >
                          预览
                        </button>
                      )}
                      {/* Blame 按钮 */}
                      {fileTree.fileContent?.type === 'text' && (
                        <button
                          onClick={fileTree.handleToggleBlame}
                          disabled={fileTree.isLoadingBlame}
                          className={`px-2 py-1 text-sm rounded transition-colors ${
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
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {fileTree.isLoadingContent ? (
                      <div className="h-full flex items-center justify-center">
                        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : fileTree.fileContent ? (
                      fileTree.fileContent.type === 'text' && fileTree.fileContent.content ? (
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
                        ) : (
                          <CodeViewer
                            content={fileTree.fileContent.content}
                            filePath={fileTree.selectedPath}
                            cwd={cwd}
                            enableComments={true}
                            scrollToLine={fileTree.targetLineNumber}
                            onScrollToLineComplete={() => fileTree.setTargetLineNumber(null)}
                            highlightKeyword={activeTab === 'search' ? contentSearch.contentSearchQuery : null}
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
              gitHistory.selectedCommit ? (
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

        {/* 文件编辑 Modal */}
        {fileTree.selectedPath && fileTree.fileContent?.type === 'text' && (
          <FileEditorModal
            isOpen={fileTree.showEditor}
            onClose={() => fileTree.setShowEditor(false)}
            filePath={fileTree.selectedPath}
            initialContent={fileTree.fileContent.content || ''}
            initialMtime={fileTree.fileContent.mtime}
            cwd={cwd}
            onSaved={() => {
              fileTree.loadFileContent(fileTree.selectedPath!);
            }}
          />
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
    </MenuContainerProvider>
  );
}
