'use client';

import React from 'react';
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
}

export function TabManagerTopBar({
  initialCwd,
  activeTab,
  isGitRepo,
  currentBranch,
  onOpenWorktree,
  onOpenProjectSessions,
  onOpenAliasManager,
}: TabManagerTopBarProps) {
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center justify-between px-4 py-2 relative">
        {/* 左侧：Logo + 项目路径 + Git 分支 */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img src="/icons/icon-72x72.png" alt="Cockpit" className="w-6 h-6" />
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
          {/* Git Worktree 按钮 */}
          {isGitRepo && (
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
          )}
        </div>

        {/* 中间：视图切换按钮 - 绝对定位居中 */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ViewSwitcherBar />
        </div>

        {/* 右侧：会话相关 */}
        <div className="flex items-center gap-2">
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
        </div>
      </div>
    </div>
  );
}
