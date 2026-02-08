'use client';

import React, { useState } from 'react';
import { TokenUsage } from '@/types/chat';

// ============================================
// Chat Header
// ============================================

interface ChatHeaderProps {
  cwd?: string;
  sessionId: string | null;
  onOpenProjectSessions: () => void;
  onOpenSessionBrowser: () => void;
  onOpenSettings: () => void;
}

export function ChatHeader({
  cwd,
  sessionId,
  onOpenProjectSessions,
  onOpenSessionBrowser,
  onOpenSettings,
}: ChatHeaderProps) {
  const [copiedCommand, setCopiedCommand] = useState(false);

  return (
    <div className="border-b border-border px-4 py-3 bg-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/icons/icon-72x72.png" alt="Cockpit" className="w-6 h-6" />
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-foreground">
              Cockpit
            </h1>
            <span className="text-xs text-muted-foreground">
              One seat. One AI. Everything under control.
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* 显示项目路径 */}
          {cwd && (
            <span
              className="text-sm text-foreground max-w-md truncate cursor-help"
              title={`CWD: ${cwd}`}
            >
              {cwd}
            </span>
          )}
          {/* 如果没有 cwd 但有 sessionId，则显示 sessionId */}
          {!cwd && sessionId && (
            <span className="text-xs text-muted-foreground">
              Session: {sessionId.slice(0, 8)}...
            </span>
          )}
          {/* 当前项目 Sessions 按钮（仅当有 cwd 时显示） */}
          {cwd && (
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
          {/* 全局 Session Browser 按钮 */}
          <button
            onClick={onOpenSessionBrowser}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="浏览所有会话"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </button>
          {/* 复制 claude -r 命令按钮 */}
          {sessionId && (
            <button
              onClick={() => {
                const command = `claude -r ${sessionId}`;
                navigator.clipboard.writeText(command).then(() => {
                  setCopiedCommand(true);
                  setTimeout(() => setCopiedCommand(false), 2000);
                });
              }}
              className={`p-2 rounded-lg transition-colors ${
                copiedCommand
                  ? 'text-green-500 bg-green-500/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              title={copiedCommand ? '已复制!' : `复制命令: claude -r ${sessionId}`}
            >
              {copiedCommand ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
              )}
            </button>
          )}
          {/* 设置按钮 */}
          <button
            onClick={onOpenSettings}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title="设置"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Token Usage Display
// ============================================

interface TokenUsageBarProps {
  tokenUsage: TokenUsage;
}

export function TokenUsageBar({ tokenUsage }: TokenUsageBarProps) {
  return (
    <div className="px-4 py-1.5 border-t border-border bg-secondary">
      <div className="flex items-center justify-end gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
          <span>上下文: <strong className="text-foreground">{(tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens).toLocaleString()}</strong></span>
        </span>
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span>输出: <strong className="text-foreground">{tokenUsage.outputTokens.toLocaleString()}</strong></span>
        </span>
        {(tokenUsage.cacheReadInputTokens > 0 || tokenUsage.cacheCreationInputTokens > 0) && (
          <span className="flex items-center gap-1 text-brand">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            <span>Cache: {((tokenUsage.cacheReadInputTokens / (tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens)) * 100).toFixed(0)}%</span>
          </span>
        )}
        {tokenUsage.totalCostUsd > 0 && (
          <span className="flex items-center gap-1 text-green-11">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>${tokenUsage.totalCostUsd.toFixed(4)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
