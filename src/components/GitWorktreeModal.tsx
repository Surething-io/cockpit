'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from './Toast';

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isBare: boolean;
}

interface WorktreeListResponse {
  isGitRepo: boolean;
  worktrees: WorktreeInfo[];
  nextPath: string | null;
  currentPath: string;
}

interface BranchesResponse {
  current: string;
  local: string[];
  remote: string[];
}

interface GitWorktreeModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
}

type ViewMode = 'list' | 'add';

export function GitWorktreeModal({
  isOpen,
  onClose,
  cwd,
}: GitWorktreeModalProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [nextPath, setNextPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // 添加 worktree 的表单状态
  const [branches, setBranches] = useState<BranchesResponse | null>(null);
  const [branchMode, setBranchMode] = useState<'existing' | 'new'>('existing');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('main'); // 新分支的基础分支
  const [isCreating, setIsCreating] = useState(false);

  // 自定义下拉选择器状态
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showBaseBranchDropdown, setShowBaseBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [baseBranchFilter, setBaseBranchFilter] = useState('');

  // 删除确认状态
  const [deleteTarget, setDeleteTarget] = useState<WorktreeInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // 加载 worktree 列表
  const loadWorktrees = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/git/worktree?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data: WorktreeListResponse = await response.json();
        setWorktrees(data.worktrees);
        setNextPath(data.nextPath);
      }
    } catch (error) {
      console.error('Failed to load worktrees:', error);
      toast('加载 worktree 列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  // 加载分支列表
  const loadBranches = useCallback(async () => {
    try {
      const response = await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data: BranchesResponse = await response.json();
        setBranches(data);
        // 默认选择第一个本地分支（排除已被 worktree 使用的分支）
        const usedBranches = new Set(worktrees.map(w => w.branch).filter(Boolean));
        const available = data.local.filter(b => !usedBranches.has(b));
        if (available.length > 0) {
          setSelectedBranch(available[0]);
        }
      }
    } catch (error) {
      console.error('Failed to load branches:', error);
    }
  }, [cwd, worktrees]);

  // 打开时加载数据
  useEffect(() => {
    if (isOpen) {
      loadWorktrees();
      setViewMode('list');
      setDeleteTarget(null);
    }
  }, [isOpen, loadWorktrees]);

  // 进入添加模式时加载分支
  useEffect(() => {
    if (viewMode === 'add') {
      loadBranches();
      setBranchMode('existing');
      setNewBranchName('');
      setBaseBranch('main');
      setShowBranchDropdown(false);
      setShowBaseBranchDropdown(false);
      setBranchFilter('');
      setBaseBranchFilter('');
    }
  }, [viewMode, loadBranches]);

  // 点击外部关闭下拉框
  useEffect(() => {
    if (!showBranchDropdown && !showBaseBranchDropdown) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-dropdown]')) {
        setShowBranchDropdown(false);
        setShowBaseBranchDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showBranchDropdown, showBaseBranchDropdown]);

  // 创建 worktree
  const handleCreate = async () => {
    if (!nextPath) return;

    if (branchMode === 'existing' && !selectedBranch) {
      toast('请选择分支', 'error');
      return;
    }

    if (branchMode === 'new' && !newBranchName.trim()) {
      toast('请输入新分支名称', 'error');
      return;
    }

    setIsCreating(true);
    try {
      const body: Record<string, string> = {
        action: 'add',
        cwd,
        path: nextPath,
      };

      if (branchMode === 'existing') {
        body.branch = selectedBranch;
      } else {
        body.newBranch = newBranchName.trim();
        body.baseBranch = baseBranch;
      }

      const response = await fetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        toast('Worktree 创建成功', 'success');
        setViewMode('list');
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || '创建失败', 'error');
      }
    } catch (error) {
      console.error('Failed to create worktree:', error);
      toast('创建 worktree 失败', 'error');
    } finally {
      setIsCreating(false);
    }
  };

  // 删除 worktree
  const handleDelete = async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);
    try {
      const response = await fetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove',
          cwd,
          path: deleteTarget.path,
        }),
      });

      if (response.ok) {
        toast('Worktree 已删除', 'success');
        setDeleteTarget(null);
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || '删除失败', 'error');
      }
    } catch (error) {
      console.error('Failed to delete worktree:', error);
      toast('删除 worktree 失败', 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  // 锁定/解锁 worktree
  const handleToggleLock = async (worktree: WorktreeInfo) => {
    const action = worktree.isLocked ? 'unlock' : 'lock';
    try {
      const response = await fetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          cwd,
          path: worktree.path,
        }),
      });

      if (response.ok) {
        toast(worktree.isLocked ? '已解锁' : '已锁定', 'success');
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || '操作失败', 'error');
      }
    } catch (error) {
      console.error('Failed to toggle lock:', error);
      toast('操作失败', 'error');
    }
  };

  // 点击 worktree 切换
  const handleClickWorktree = async (worktree: WorktreeInfo) => {
    if (worktree.path === cwd) return; // 当前已在该 worktree

    const targetPath = worktree.path;
    const targetUrl = `/?cwd=${encodeURIComponent(targetPath)}`;

    // 检查 Service Worker 是否可用
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.ready;

        if (registration.active) {
          const messageChannel = new MessageChannel();

          const response = await new Promise<{ found: boolean }>((resolve) => {
            messageChannel.port1.onmessage = (event) => {
              resolve(event.data);
            };

            registration.active!.postMessage(
              {
                type: 'FIND_TAB',
                cwd: targetPath,
              },
              [messageChannel.port2]
            );

            // 超时处理
            setTimeout(() => resolve({ found: false }), 500);
          });

          if (response.found) {
            // 已有 tab，发送通知让用户点击切换
            let permission = Notification.permission;
            if (permission === 'default') {
              permission = await Notification.requestPermission();
            }

            if (permission === 'granted') {
              const projectName = targetPath.split('/').pop() || targetPath;
              await registration.showNotification(`切换到 ${projectName}`, {
                body: `点击切换到 ${worktree.branch || 'worktree'}`,
                tag: `switch-worktree-${targetPath}`,
                data: { cwd: targetPath },
              });
            }
            onClose();
            return;
          }
        }
      } catch {
        // 忽略 SW 错误
      }
    }

    // 没有找到或 SW 不可用，打开新 tab
    window.open(targetUrl, '_blank');
    onClose();
  };

  if (!isOpen) return null;

  // 获取可用分支（排除已被 worktree 使用的）
  const usedBranches = new Set(worktrees.map(w => w.branch).filter(Boolean));
  const availableBranches = branches?.local.filter(b => !usedBranches.has(b)) || [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            {viewMode === 'add' && (
              <button
                onClick={() => setViewMode('list')}
                className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                title="返回"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <span className="text-sm font-medium text-foreground">
              {viewMode === 'list' ? 'Git Worktrees' : '添加 Worktree'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className={`flex-1 p-4 ${viewMode === 'list' ? 'overflow-y-auto' : 'overflow-visible'}`}>
          {viewMode === 'list' ? (
            /* 列表视图 */
            loading ? (
              <div className="flex items-center justify-center py-8">
                <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="space-y-2">
                {worktrees.map((worktree) => {
                  const isCurrent = worktree.path === cwd;
                  return (
                    <div
                      key={worktree.path}
                      className={`group p-3 rounded-lg border transition-colors ${
                        isCurrent
                          ? 'border-brand bg-brand/5'
                          : 'border-border hover:bg-accent cursor-pointer'
                      }`}
                      onClick={() => handleClickWorktree(worktree)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* 状态指示器 */}
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isCurrent ? 'bg-brand' : 'bg-muted-foreground/30'}`} />
                          {/* 分支名 */}
                          <span className="font-medium text-foreground truncate">
                            {worktree.branch || (worktree.isDetached ? 'detached' : 'unknown')}
                          </span>
                          {/* 锁定标记 */}
                          {worktree.isLocked && (
                            <span className="text-amber-11" title="已锁定">🔒</span>
                          )}
                          {/* 当前标记 */}
                          {isCurrent && (
                            <span className="text-xs text-brand">(当前)</span>
                          )}
                        </div>
                        {/* 操作按钮 */}
                        {!isCurrent && (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {/* 锁定/解锁 */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleLock(worktree);
                              }}
                              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                              title={worktree.isLocked ? '解锁' : '锁定'}
                            >
                              {worktree.isLocked ? (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                                </svg>
                              ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                              )}
                            </button>
                            {/* 删除 */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(worktree);
                              }}
                              className="p-1.5 text-muted-foreground hover:text-red-11 hover:bg-secondary rounded transition-colors"
                              title="删除"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                      {/* 路径 */}
                      <div className="mt-1 text-xs text-muted-foreground truncate pl-4">
                        {worktree.path}
                      </div>
                      {/* Detached 提示 */}
                      {worktree.isDetached && (
                        <div className="mt-1 text-xs text-amber-11 pl-4">
                          (detached HEAD)
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            /* 添加视图 */
            <div className="space-y-4">
              {/* 路径 */}
              <div>
                <label className="block text-sm text-muted-foreground mb-1">路径</label>
                <div className="px-3 py-2 bg-secondary rounded text-sm text-foreground truncate">
                  {nextPath || '无可用路径'}
                </div>
              </div>

              {/* 分支选择 */}
              <div>
                <label className="block text-sm text-muted-foreground mb-2">分支</label>
                <div className="space-y-3">
                  {/* 选择已有分支 */}
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="branchMode"
                      checked={branchMode === 'existing'}
                      onChange={() => {
                        setBranchMode('existing');
                        setShowBaseBranchDropdown(false);
                      }}
                      className="mt-1 cursor-pointer"
                    />
                    <div className="flex-1">
                      <div
                        className="text-sm text-foreground cursor-pointer"
                        onClick={() => {
                          setBranchMode('existing');
                          setShowBaseBranchDropdown(false);
                        }}
                      >
                        选择已有分支
                      </div>
                      {branchMode === 'existing' && (
                        <div className="mt-2 relative" data-dropdown>
                          <button
                            type="button"
                            onClick={() => {
                              setShowBranchDropdown(!showBranchDropdown);
                              setShowBaseBranchDropdown(false);
                              setBranchFilter('');
                            }}
                            className="w-full px-3 py-2 bg-secondary rounded text-sm text-foreground text-left flex items-center justify-between focus:outline-none focus:ring-2 focus:ring-brand"
                          >
                            <span className={selectedBranch ? '' : 'text-muted-foreground'}>
                              {selectedBranch || (availableBranches.length === 0 ? '无可用分支' : '选择分支...')}
                            </span>
                            <svg className={`w-4 h-4 transition-transform ${showBranchDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                          {showBranchDropdown && availableBranches.length > 0 && (
                            <div className="absolute z-[100] mt-1 w-full bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                              <div className="p-2 border-b border-border">
                                <input
                                  type="text"
                                  value={branchFilter}
                                  onChange={(e) => setBranchFilter(e.target.value)}
                                  placeholder="搜索分支..."
                                  className="w-full px-2 py-1.5 bg-secondary rounded text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                                  autoFocus
                                />
                              </div>
                              <div className="max-h-48 overflow-y-auto">
                                {availableBranches
                                  .filter(b => b.toLowerCase().includes(branchFilter.toLowerCase()))
                                  .map((branch) => (
                                    <button
                                      key={branch}
                                      type="button"
                                      onClick={() => {
                                        setSelectedBranch(branch);
                                        setShowBranchDropdown(false);
                                      }}
                                      className={`w-full px-3 py-2 text-sm text-left hover:bg-accent transition-colors ${
                                        selectedBranch === branch ? 'bg-accent text-brand' : 'text-foreground'
                                      }`}
                                    >
                                      {branch}
                                    </button>
                                  ))}
                                {availableBranches.filter(b => b.toLowerCase().includes(branchFilter.toLowerCase())).length === 0 && (
                                  <div className="px-3 py-2 text-sm text-muted-foreground">无匹配分支</div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 新建分支 */}
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="branchMode"
                      checked={branchMode === 'new'}
                      onChange={() => {
                        setBranchMode('new');
                        setShowBranchDropdown(false);
                      }}
                      className="mt-1 cursor-pointer"
                    />
                    <div className="flex-1">
                      <div
                        className="text-sm text-foreground cursor-pointer"
                        onClick={() => {
                          setBranchMode('new');
                          setShowBranchDropdown(false);
                        }}
                      >
                        新建分支
                      </div>
                      {branchMode === 'new' && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="text"
                            value={newBranchName}
                            onChange={(e) => setNewBranchName(e.target.value)}
                            placeholder="输入新分支名称"
                            className="w-full px-3 py-2 bg-secondary rounded text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand"
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground flex-shrink-0">基于:</span>
                            <div className="flex-1 relative" data-dropdown>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowBaseBranchDropdown(!showBaseBranchDropdown);
                                  setShowBranchDropdown(false);
                                  setBaseBranchFilter('');
                                }}
                                className="w-full px-2 py-1.5 bg-secondary rounded text-sm text-foreground text-left flex items-center justify-between focus:outline-none focus:ring-2 focus:ring-brand"
                              >
                                <span>{baseBranch}</span>
                                <svg className={`w-4 h-4 transition-transform ${showBaseBranchDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>
                              {showBaseBranchDropdown && (
                                <div className="absolute z-[100] bottom-full mb-1 w-full bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
                                  <div className="p-2 border-b border-border">
                                    <input
                                      type="text"
                                      value={baseBranchFilter}
                                      onChange={(e) => setBaseBranchFilter(e.target.value)}
                                      placeholder="搜索分支..."
                                      className="w-full px-2 py-1.5 bg-secondary rounded text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                                      autoFocus
                                    />
                                  </div>
                                  <div className="max-h-48 overflow-y-auto">
                                    {/* 本地分支 */}
                                    {branches?.local.filter(b => b.toLowerCase().includes(baseBranchFilter.toLowerCase())).length ? (
                                      <>
                                        <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/50">本地分支</div>
                                        {branches.local
                                          .filter(b => b.toLowerCase().includes(baseBranchFilter.toLowerCase()))
                                          .map((branch) => (
                                            <button
                                              key={branch}
                                              type="button"
                                              onClick={() => {
                                                setBaseBranch(branch);
                                                setShowBaseBranchDropdown(false);
                                              }}
                                              className={`w-full px-3 py-2 text-sm text-left hover:bg-accent transition-colors ${
                                                baseBranch === branch ? 'bg-accent text-brand' : 'text-foreground'
                                              }`}
                                            >
                                              {branch}
                                            </button>
                                          ))}
                                      </>
                                    ) : null}
                                    {/* 远程分支 */}
                                    {branches?.remote.filter(b => b.toLowerCase().includes(baseBranchFilter.toLowerCase())).length ? (
                                      <>
                                        <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/50">远程分支</div>
                                        {branches.remote
                                          .filter(b => b.toLowerCase().includes(baseBranchFilter.toLowerCase()))
                                          .map((branch) => (
                                            <button
                                              key={branch}
                                              type="button"
                                              onClick={() => {
                                                setBaseBranch(branch);
                                                setShowBaseBranchDropdown(false);
                                              }}
                                              className={`w-full px-3 py-2 text-sm text-left hover:bg-accent transition-colors ${
                                                baseBranch === branch ? 'bg-accent text-brand' : 'text-foreground'
                                              }`}
                                            >
                                              {branch}
                                            </button>
                                          ))}
                                      </>
                                    ) : null}
                                    {(!branches?.local.filter(b => b.toLowerCase().includes(baseBranchFilter.toLowerCase())).length &&
                                      !branches?.remote.filter(b => b.toLowerCase().includes(baseBranchFilter.toLowerCase())).length) && (
                                      <div className="px-3 py-2 text-sm text-muted-foreground">无匹配分支</div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between flex-shrink-0">
          {viewMode === 'list' ? (
            <>
              <div className="text-xs text-muted-foreground">
                {worktrees.length} 个 worktree
              </div>
              <button
                onClick={() => setViewMode('add')}
                disabled={!nextPath}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${
                  nextPath
                    ? 'bg-brand text-white hover:bg-brand/90'
                    : 'bg-secondary text-muted-foreground cursor-not-allowed'
                }`}
              >
                + 添加 Worktree
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setViewMode('list')}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={isCreating || !nextPath}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${
                  !isCreating && nextPath
                    ? 'bg-brand text-white hover:bg-brand/90'
                    : 'bg-secondary text-muted-foreground cursor-not-allowed'
                }`}
              >
                {isCreating ? (
                  <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  '创建'
                )}
              </button>
            </>
          )}
        </div>

        {/* 删除确认弹窗 */}
        {deleteTarget && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-lg"
            onClick={() => setDeleteTarget(null)}
          >
            <div
              className="bg-card rounded-lg shadow-xl w-[360px] p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-sm font-medium text-foreground mb-3">确认删除</div>
              <div className="text-sm text-muted-foreground mb-4">
                <p className="mb-2">确定要删除 worktree 吗？</p>
                <p className="text-xs">
                  <span className="text-muted-foreground">路径：</span>
                  <span className="text-foreground">{deleteTarget.path}</span>
                </p>
                <p className="text-xs">
                  <span className="text-muted-foreground">分支：</span>
                  <span className="text-foreground">{deleteTarget.branch || 'detached'}</span>
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="px-3 py-1.5 text-sm bg-red-9 text-white rounded hover:bg-red-10 transition-colors disabled:opacity-50"
                >
                  {isDeleting ? (
                    <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    '删除'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
