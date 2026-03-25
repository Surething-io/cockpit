'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../shared/Toast';

// Generate a random readable word (consonant + vowel/rime, 2 pairs)
function generateRandomWord(): string {
  const consonants = 'bcdfghjklmnprstvwz';
  const vowels = ['a', 'e', 'i', 'o', 'u', 'ai', 'au', 'ea', 'ee', 'ia', 'io', 'oa', 'oo', 'ou', 'ui'];

  let word = '';
  // Generate 2 pairs (consonant + vowel/rime)
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
  const { t } = useTranslation();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [nextPath, setNextPath] = useState<string | null>(null);
  const [nextRandomWord, setNextRandomWord] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<WorktreeInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Git user name (used for auto-generating branch names)
  const [gitUserName, setGitUserName] = useState<string>('');

  // Branch picker state
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);


  // Load worktree list
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
      toast(t('toast.worktreeLoadFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  // Get the default base branch (priority: origin/main → origin/master → main → master → first available)
  const getDefaultBaseBranch = useCallback((data: BranchesResponse): string => {
    const { local, remote } = data;

    // Priority order
    if (remote.includes('origin/main')) return 'origin/main';
    if (remote.includes('origin/master')) return 'origin/master';
    if (local.includes('main')) return 'main';
    if (local.includes('master')) return 'master';

    // Fall back to the first remote or local branch
    if (remote.length > 0) return remote[0];
    if (local.length > 0) return local[0];

    return 'main';
  }, []);

  // Load data when opened
  useEffect(() => {
    if (isOpen) {
      loadWorktrees();
      setDeleteTarget(null);
    }
  }, [isOpen, loadWorktrees]);

  // Quick-create a worktree using the auto-generated branch name
  const handleQuickCreate = async () => {
    if (!nextPath) return;

    // Fetch branch list first to determine the default base branch
    let defaultBase = 'origin/main';
    try {
      const response = await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data: BranchesResponse = await response.json();
        defaultBase = getDefaultBaseBranch(data);
      }
    } catch {
      // Ignore error, use default value
    }

    // Use the random word returned by the API (shared for both directory name and branch name)
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
        toast(t('toast.worktreeCreateSuccess', { name: branchName }), 'success');
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || t('toast.worktreeCreateFailed'), 'error');
      }
    } catch (error) {
      console.error('Failed to create worktree:', error);
      toast(t('toast.worktreeCreateFailed'), 'error');
    } finally {
      setIsCreating(false);
    }
  };

  // Open the branch picker
  const handleOpenBranchPicker = async () => {
    setBranchesLoading(true);
    setBranchSearch('');
    setShowBranchPicker(true);
    try {
      const response = await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`);
      if (response.ok) {
        const data: BranchesResponse = await response.json();
        // Branches already used by a worktree
        const usedBranches = new Set(worktrees.map(w => w.branch).filter(Boolean));
        // Merge local + remote, excluding already-used branches
        const allBranches = [
          ...data.local.filter(b => !usedBranches.has(b)),
          ...data.remote.filter(b => !usedBranches.has(b) && !data.local.includes(b.replace(/^origin\//, ''))),
        ];
        setBranches(allBranches);
      }
    } catch {
      toast(t('toast.loadBranchFailed'), 'error');
    } finally {
      setBranchesLoading(false);
    }
  };

  // Create a worktree from an existing branch
  const handleCreateFromBranch = async (branch: string) => {
    if (!nextPath) return;
    setShowBranchPicker(false);
    setIsCreating(true);
    try {
      const response = await fetch('/api/git/worktree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          cwd,
          path: nextPath,
          branch,
        }),
      });
      if (response.ok) {
        toast(t('toast.worktreeCreateSuccess', { name: branch }), 'success');
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || t('toast.worktreeCreateFailed'), 'error');
      }
    } catch (error) {
      console.error('Failed to create worktree:', error);
      toast(t('toast.worktreeCreateFailed'), 'error');
    } finally {
      setIsCreating(false);
    }
  };

  // Delete worktree
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
        toast(t('toast.worktreeDeleted'), 'success');
        setDeleteTarget(null);
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || t('toast.worktreeDeleteFailed'), 'error');
      }
    } catch (error) {
      console.error('Failed to delete worktree:', error);
      toast(t('toast.worktreeDeleteFailed'), 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  // Lock/unlock worktree
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
        toast(worktree.isLocked ? t('toast.worktreeUnlocked') : t('toast.worktreeLocked'), 'success');
        loadWorktrees();
      } else {
        const data = await response.json();
        toast(data.error || t('toast.operationFailed'), 'error');
      }
    } catch (error) {
      console.error('Failed to toggle lock:', error);
      toast(t('toast.operationFailed'), 'error');
    }
  };

  // Click worktree to switch — notify parent Workspace to open/switch project
  const handleClickWorktree = (worktree: WorktreeInfo) => {
    if (worktree.path === cwd) return; // Already in this worktree

    window.parent.postMessage({
      type: 'OPEN_PROJECT',
      cwd: worktree.path,
    }, '*');
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
            title={t('common.close')}
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
                        {/* Status indicator */}
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isCurrent ? 'bg-brand' : 'bg-muted-foreground/30'}`} />
                        {/* Branch name */}
                        <span className="font-medium text-foreground truncate">
                          {worktree.branch || (worktree.isDetached ? 'detached' : 'unknown')}
                        </span>
                        {/* Locked indicator */}
                        {worktree.isLocked && (
                          <span className="text-amber-11" title={t('git.worktree.locked')}>🔒</span>
                        )}
                        {/* Current indicator */}
                        {isCurrent && (
                          <span className="text-xs text-brand">({t('common.current')})</span>
                        )}
                      </div>
                      {/* Action buttons */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Lock/unlock (non-current only) */}
                        {!isCurrent && (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleLock(worktree);
                              }}
                              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                              title={worktree.isLocked ? t('git.worktree.unlock') : t('git.worktree.lock')}
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
                            {/* Delete */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(worktree);
                              }}
                              className="p-1.5 text-muted-foreground hover:text-red-11 hover:bg-secondary rounded transition-colors"
                              title={t('common.delete')}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {/* Path */}
                    <div className="mt-1 text-xs text-muted-foreground truncate pl-4">
                      {worktree.path}
                    </div>
                    {/* Detached warning */}
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

        {/* Branch picker */}
        {showBranchPicker && (
          <div className="border-t border-border px-4 py-3 flex-shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <input
                value={branchSearch}
                onChange={(e) => setBranchSearch(e.target.value)}
                placeholder={t('git.worktree.searchBranch')}
                className="flex-1 bg-secondary text-sm text-foreground rounded px-2.5 py-1.5 outline-none placeholder:text-muted-foreground"
                autoFocus
                autoComplete="off"
                spellCheck="false"
              />
              <button
                onClick={() => setShowBranchPicker(false)}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5"
              >
                {t('common.cancel')}
              </button>
            </div>
            <div className="max-h-[200px] overflow-y-auto space-y-0.5">
              {branchesLoading ? (
                <div className="text-xs text-muted-foreground text-center py-4">{t('common.loading')}</div>
              ) : (() => {
                const filtered = branches.filter(b => b.toLowerCase().includes(branchSearch.toLowerCase()));
                return filtered.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4">{t('git.worktree.noBranches')}</div>
                ) : (
                  filtered.map((branch) => (
                    <button
                      key={branch}
                      onClick={() => handleCreateFromBranch(branch)}
                      className="w-full text-left px-2.5 py-1.5 text-sm rounded hover:bg-accent transition-colors truncate"
                    >
                      <span className={`${branch.startsWith('origin/') ? 'text-muted-foreground' : 'text-foreground'}`}>
                        {branch}
                      </span>
                    </button>
                  ))
                );
              })()}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between flex-shrink-0">
          <div className="text-xs text-muted-foreground">
            {t('git.worktree.count', { count: worktrees.length })}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleOpenBranchPicker}
              disabled={!nextPath || isCreating}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                nextPath && !isCreating
                  ? 'bg-secondary text-foreground hover:bg-accent'
                  : 'bg-secondary text-muted-foreground cursor-not-allowed'
              }`}
            >
              {t('git.worktree.selectBranch')}
            </button>
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
                t('git.worktree.addWorktree')
              )}
            </button>
          </div>
        </div>

        {/* Delete confirmation dialog */}
        {deleteTarget && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-lg"
            onClick={() => setDeleteTarget(null)}
          >
            <div
              className="bg-card rounded-lg shadow-xl w-[360px] p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-sm font-medium text-foreground mb-3">{t('git.worktree.confirmDelete')}</div>
              <div className="text-sm text-muted-foreground mb-4">
                <p className="mb-2">{t('git.worktree.confirmDeleteMsg')}</p>
                <p className="text-xs">
                  <span className="text-muted-foreground">{t('git.worktree.path')}</span>
                  <span className="text-foreground">{deleteTarget.path}</span>
                </p>
                <p className="text-xs">
                  <span className="text-muted-foreground">{t('git.worktree.branch')}</span>
                  <span className="text-foreground">{deleteTarget.branch || 'detached'}</span>
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="px-3 py-1.5 text-sm bg-red-9 text-white rounded hover:bg-red-10 transition-colors disabled:opacity-50"
                >
                  {isDeleting ? (
                    <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  ) : (
                    t('common.delete')
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
