'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TabInfo } from './useTabState';
import { ViewSwitcherBar } from './SwipeableViewContainer';
import { toast } from '../shared/Toast';

// ============================================
// TopBar
// ============================================

interface TabManagerTopBarProps {
  initialCwd?: string;
  activeTab?: TabInfo;
  isGitRepo: boolean;
  currentBranch: string | null;
  onOpenWorktree: () => void;
  onOpenProjectSessions: () => void;
  onOpenAliasManager: () => void;
  onBranchSwitched?: () => void;
}

// ============================================
// BranchSwitchDropdown
// ============================================

function BranchSwitchDropdown({ cwd, currentBranch, onSwitched }: {
  cwd: string;
  currentBranch: string | null;
  onSwitched: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadBranches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) {
        const data = await res.json();
        const all = [
          ...(data.local || []),
          ...(data.remote || []).filter((b: string) => !data.local.includes(b.replace(/^origin\//, ''))),
        ];
        setBranches(all);
      }
    } catch {
      toast('加载分支列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    setSearch('');
    loadBranches();
  }, [loadBranches]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, handleClose]);

  // 打开后聚焦搜索框
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  const handleCheckout = async (branch: string) => {
    setSwitching(true);
    try {
      const response = await fetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'checkout',
          cwd,
          path: cwd,
          branch,
        }),
      });
      if (response.ok) {
        const localBranch = branch.replace(/^origin\//, '');
        toast(`已切换到 ${localBranch}`, 'success');
        handleClose();
        onSwitched();
      } else {
        const data = await response.json();
        toast(data.error || '切换分支失败', 'error');
      }
    } catch {
      toast('切换分支失败', 'error');
    } finally {
      setSwitching(false);
    }
  };

  const filtered = branches.filter(b =>
    b !== currentBranch && b.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={open ? handleClose : handleOpen}
        className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        title="切换分支"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          {/* 搜索框 */}
          <div className="p-2 border-b border-border">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索分支..."
              className="w-full px-2.5 py-1.5 text-sm bg-muted rounded border-none outline-none placeholder:text-muted-foreground"
              onKeyDown={e => {
                if (e.key === 'Escape') handleClose();
              }}
            />
          </div>

          {/* 分支列表 */}
          <div className="max-h-60 overflow-y-auto p-1">
            {loading ? (
              <div className="text-xs text-muted-foreground text-center py-4">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                {search ? '无匹配分支' : '无可切换分支'}
              </div>
            ) : (
              filtered.map(branch => (
                <button
                  key={branch}
                  onClick={() => handleCheckout(branch)}
                  disabled={switching}
                  className="w-full text-left px-2.5 py-1.5 text-sm rounded hover:bg-accent transition-colors truncate disabled:opacity-50"
                >
                  <span className={branch.startsWith('origin/') ? 'text-muted-foreground' : 'text-foreground'}>
                    {branch}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// TabManagerTopBar
// ============================================

export function TabManagerTopBar({
  initialCwd,
  activeTab,
  isGitRepo,
  currentBranch,
  onOpenWorktree,
  onOpenProjectSessions,
  onOpenAliasManager,
  onBranchSwitched,
}: TabManagerTopBarProps) {
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center justify-between px-4 py-2 relative">
        {/* 左侧：Logo + 项目路径 + Git 分支 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img
              src="/icons/icon-72x72.png"
              alt="Cockpit"
              className="w-6 h-6 cursor-pointer"
              title="复制页面地址"
              onClick={() => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                  toast('已复制页面地址', 'success');
                });
              }}
            />
            {initialCwd ? (
              <>
                <span
                  className="text-sm text-foreground max-w-md truncate cursor-help"
                  title={`CWD: ${initialCwd}`}
                >
                  {initialCwd}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(initialCwd);
                    toast('已复制目录路径');
                  }}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  title="复制目录路径"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </>
            ) : (
              <h1 className="text-lg font-semibold text-foreground">
                Cockpit
              </h1>
            )}
          </div>
          {/* Git 分支 + Worktree + 切换 */}
          {isGitRepo && initialCwd && (
            <div className="flex items-center gap-1">
              <button
                onClick={onOpenWorktree}
                className="flex items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                title="Git Worktrees"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0l-4-4m4 4l-4 4M3 7v6a4 4 0 004 4h5" />
                </svg>
                <span className="text-sm">{currentBranch || 'main'}</span>
              </button>
              <BranchSwitchDropdown
                cwd={initialCwd}
                currentBranch={currentBranch}
                onSwitched={() => onBranchSwitched?.()}
              />
            </div>
          )}
        </div>

        {/* 中间：视图切换按钮 - 绝对定位居中 */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ViewSwitcherBar />
        </div>

        {/* 右侧：会话相关 */}
        <div className="flex items-center gap-2">
          {/* 刷新当前项目 */}
          <button
            onClick={() => window.location.reload()}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="刷新当前项目"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {/* 当前项目 Sessions 按钮 */}
          {initialCwd && (
            <button
              onClick={onOpenProjectSessions}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title="项目会话"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>
          )}
          {/* Cursor 打开按钮 */}
          <button
            onClick={async () => {
              if (activeTab?.cwd) {
                try {
                  await fetch('/api/open-cursor', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cwd: activeTab.cwd }),
                  });
                } catch {
                  // 忽略错误
                }
              }
            }}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="在 Cursor 中打开"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.5 2L20.5 12L4.5 22V2Z" />
            </svg>
          </button>
          {/* 复制 claude -r 命令按钮 */}
          {activeTab?.sessionId && (
            <button
              onClick={() => {
                const command = `claude -r ${activeTab.sessionId}`;
                navigator.clipboard.writeText(command).then(() => {
                  toast('已复制: ' + command, 'success');
                });
              }}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title={`复制命令: claude -r ${activeTab.sessionId}`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          )}
          {/* 全局命令别名 */}
          <button
            onClick={onOpenAliasManager}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="命令别名（全局）"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12h-6m-4 0a8 8 0 1116 0 8 8 0 01-16 0zm4 0h.01" />
            </svg>
          </button>
          {/* Token 统计 */}
          <button
            onClick={() => window.parent.postMessage({ type: 'OPEN_TOKEN_STATS' }, '*')}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="Token 统计"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
