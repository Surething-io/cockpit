'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ============================================
// Chat Header
// ============================================
//
// Migrated from src/components/project/ChatHeader.tsx as the first feature-agent
// pilot. TokenUsageBar (originally in the same file) was left in the source
// location because it depends on @/types/chat, which has not yet been moved
// into a shared package. Bring it over once those types live in
// @cockpit/shared-* (or copied into this package's local types/).

interface ChatHeaderProps {
  cwd?: string;
  sessionId: string | null;
  onOpenProjectSessions: () => void;
  // Optional host-delegated callbacks (rendered by app layer when standalone
  // Chat is mounted; left undefined when wrapped in TabManager).
  onOpenSessionBrowser?: () => void;
  onOpenSettings?: () => void;
}

export function ChatHeader({
  cwd,
  sessionId,
  onOpenProjectSessions,
  onOpenSessionBrowser,
  onOpenSettings,
}: ChatHeaderProps) {
  const { t } = useTranslation();
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
          {/* Show project path */}
          {cwd && (
            <span
              className="text-sm text-foreground max-w-md truncate cursor-help"
              title={`CWD: ${cwd}`}
            >
              {cwd}
            </span>
          )}
          {/* If no cwd but sessionId exists, show sessionId */}
          {!cwd && sessionId && (
            <span className="text-xs text-muted-foreground">
              Session: {sessionId.slice(0, 8)}...
            </span>
          )}
          {/* Current project Sessions button (only shown when cwd is present) */}
          {cwd && (
            <button
              onClick={onOpenProjectSessions}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title={t('sessions.projectSessions')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>
          )}
          {/* Global Session Browser button */}
          <button
            onClick={onOpenSessionBrowser}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('sessions.browseAllSessions')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </button>
          {/* Copy claude -r command button */}
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
              title={copiedCommand ? t('chat.copiedCommandTooltip') : t('chat.copyCommandTooltip', { sessionId })}
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
          {/* Settings button */}
          <button
            onClick={onOpenSettings}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('settings.title')}
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
