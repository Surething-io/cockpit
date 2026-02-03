'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from './Toast';

// 生成随机可读单词（辅音 + 元音/韵母，2组）
function generateRandomWord(): string {
  const consonants = 'bcdfghjklmnprstvwz';
  const vowels = ['a', 'e', 'i', 'o', 'u', 'ai', 'au', 'ea', 'ee', 'ia', 'io', 'oa', 'oo', 'ou', 'ui'];

  let word = '';
  // 生成 2 组（辅音 + 元音/韵母）
  for (let i = 0; i < 2; i++) {
    word += consonants[Math.floor(Math.random() * consonants.length)];
    word += vowels[Math.floor(Math.random() * vowels.length)];
  }

  return word;
}

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
  nextRandomWord: string | null;
  currentPath: string;
  gitUserName?: string;
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

export function GitWorktreeModal({
  isOpen,
  onClose,
  cwd,
}: GitWorktreeModalProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [nextPath, setNextPath] = useState<string | null>(null);
  const [nextRandomWord, setNextRandomWord] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // 删除确认状态
  const [deleteTarget, setDeleteTarget] = useState<WorktreeInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Git user name（用于自动生成分支名）
  const [gitUserName, setGitUserName] = useState<string>('');

  // 加载 worktree 列表
  const loadWorktrees = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/git/worktree?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data: WorktreeListResponse = await response.json();
        setWorktrees(data.worktrees);
        setNextPath(data.nextPath);
        setNextRandomWord(data.nextRandomWord);
        if (data.gitUserName) {
          setGitUserName(data.gitUserName);
        }
      }
    } catch (error) {
      console.error('Failed to load worktrees:', error);
      toast('加载 worktree 列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  // 获取默认源分支（优先级：origin/main → origin/master → main → master → 第一个）
  const getDefaultBaseBranch = useCallback((data: BranchesResponse): string => {
    const { local, remote } = data;

    // 优先级顺序
    if (remote.includes('origin/main')) return 'origin/main';
    if (remote.includes('origin/master')) return 'origin/master';
    if (local.includes('main')) return 'main';
    if (local.includes('master')) return 'master';

    // 如果都没有，返回第一个远程分支或本地分支
    if (remote.length > 0) return remote[0];
    if (local.length > 0) return local[0];

    return 'main';
  }, []);

  // 打开时加载数据
  useEffect(() => {
    if (isOpen) {
      loadWorktrees();
      setDeleteTarget(null);
    }
  }, [isOpen, loadWorktrees]);

  // 快速创建 worktree（直接使用自动生成的分支名）
  const handleQuickCreate = async () => {
    if (!nextPath) return;

    // 先获取分支列表以确定默认源分支
    let defaultBase = 'origin/main';
    try {
      const response = await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data: BranchesResponse = await response.json();
        defaultBase = getDefaultBaseBranch(data);
      }
    } catch {
      // 忽略错误，使用默认值
    }

    // 使用 API 返回的随机单词（目录名和分支名使用同一个）
    const randomWord = nextRandomWord || generateRandomWord();
    const branchName = gitUserName ? `${gitUserName}/${randomWord}` : randomWord;

    setIsCreating(true);
    try {
      const response = await fetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          cwd,
          path: nextPath,
          newBranch: branchName,
          baseBranch: defaultBase,
        }),
      });

      if (response.ok) {
        toast(`Worktree 创建成功: ${branchName}`, 'success');
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
          <span className="text-sm font-medium text-foreground">
            Git Worktrees
          </span>
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
        <div className="flex-1 p-4 overflow-y-auto">
          {loading ? (
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
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between flex-shrink-0">
          <div className="text-xs text-muted-foreground">
            {worktrees.length} 个 worktree
          </div>
          <button
            onClick={handleQuickCreate}
            disabled={!nextPath || isCreating}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              nextPath && !isCreating
                ? 'bg-brand text-white hover:bg-brand/90'
                : 'bg-secondary text-muted-foreground cursor-not-allowed'
            }`}
          >
            {isCreating ? (
              <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              '+ 添加 Worktree'
            )}
          </button>
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
