'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TabInfo } from './useTabState';
import { ViewSwitcherBar } from './SwipeableViewContainer';
import { ReviewDropdown } from './ReviewDropdown';
import { toast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
      toast(t('toast.loadBranchFailed'), 'error');
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

  // Close on outside click
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

  // Focus the search box when opened
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
        toast(t('toast.switchedToBranch', { branch: localBranch }), 'success');
        handleClose();
        onSwitched();
      } else {
        const data = await response.json();
        toast(data.error || t('toast.switchBranchFailed'), 'error');
      }
    } catch {
      toast(t('toast.switchBranchFailed'), 'error');
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
        title={t('git.switchBranch')}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Search box */}
          <div className="p-2 border-b border-border">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('git.searchBranch')}
              className="w-full px-2.5 py-1.5 text-sm bg-muted rounded border-none outline-none placeholder:text-muted-foreground"
              onKeyDown={e => {
                if (e.key === 'Escape') handleClose();
              }}
            />
          </div>

          {/* Branch list */}
          <div className="max-h-60 overflow-y-auto p-1">
            {loading ? (
              <div className="text-xs text-muted-foreground text-center py-4">{t('common.loading')}</div>
            ) : filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                {search ? t('git.noMatchingBranches') : t('git.noBranches')}
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
  const { t } = useTranslation();
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center justify-between px-4 py-2 relative">
        {/* Left: Logo + project path + Git branch */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img
              src="/icons/icon-72x72.png"
              alt="Cockpit"
              className="w-6 h-6 cursor-pointer"
              title={t('tabManagerTopBar.copyPageUrl')}
              onClick={() => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                  toast(t('toast.copiedPageUrl'), 'success');
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
                    toast(t('toast.copiedDirPath'));
                  }}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  title={t('tabManagerTopBar.copyDirPath')}
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
          {/* Git branch + Worktree + switch */}
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

        {/* Center: view switcher buttons - absolutely positioned at center */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ViewSwitcherBar />
        </div>

        {/* Right: session-related */}
        <div className="flex items-center gap-2">
          {/* Review management */}
          <ReviewDropdown cwd={initialCwd} />
          {/* Reload current project */}
          <button
            onClick={() => window.location.reload()}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.refreshProject')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {/* Current project Sessions button */}
          {initialCwd && (
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
          {/* Open in VS Code button */}
          <button
            onClick={async () => {
              if (activeTab?.cwd) {
                try {
                  await fetch('/api/open-vscode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cwd: activeTab.cwd }),
                  });
                } catch {
                  // Ignore errors
                }
              }
            }}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.openInVSCode')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.583 2.213L12 7.393 6.417 2.213 1 6.17v11.66l5.417 3.957L12 16.607l5.583 5.18L23 17.83V6.17l-5.417-3.957zM6.417 17.83L3 15.33V8.67l3.417-2.5v11.66zm11.166 0V6.17L21 8.67v6.66l-3.417 2.5z" />
            </svg>
          </button>
          {/* Open in Cursor button */}
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
                  // Ignore errors
                }
              }
            }}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.openInCursor')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.5 2L20.5 12L4.5 22V2Z" />
            </svg>
          </button>
          {/* Copy claude -r command button */}
          {activeTab?.sessionId && (
            <button
              onClick={() => {
                const command = `claude -r ${activeTab.sessionId}`;
                navigator.clipboard.writeText(command).then(() => {
                  toast(t('toast.copiedCommand', { command }), 'success');
                });
              }}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              title={t('chat.copyCommandTooltip', { sessionId: activeTab.sessionId })}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          )}
          {/* Global command aliases */}
          <button
            onClick={onOpenAliasManager}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.aliasesGlobal')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12h-6m-4 0a8 8 0 1116 0 8 8 0 01-16 0zm4 0h.01" />
            </svg>
          </button>
          {/* Token stats */}
          <button
            onClick={() => window.parent.postMessage({ type: 'OPEN_TOKEN_STATS' }, '*')}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.tokenStats')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
          {/* Surething website */}
          <button
            onClick={() => window.open('https://surething.io?from=cockpit', '_blank')}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.openSurething')}
          >
            <img src="https://surething.io/logo.png?from=cockpit" alt="Surething" className="w-5 h-5 rounded-sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
