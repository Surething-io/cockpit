import { useState, useCallback, useEffect } from 'react';
import { buildGitFileTree, collectGitTreeDirPaths, type GitFileNode } from '../components/project/GitFileTree';
import { toast } from '../components/shared/Toast';
import type { GitFileStatus, GitStatusResponse, GitDiffResponse } from '../components/project/fileBrowser/types';
import i18n from '@/lib/i18n';

interface UseGitStatusOptions {
  cwd: string;
  addToRecentFiles: (path: string) => Promise<void>;
}

export function useGitStatus({ cwd, addToRecentFiles }: UseGitStatusOptions) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSelectedFile, setStatusSelectedFile] = useState<{ file: GitFileStatus; type: 'staged' | 'unstaged' } | null>(null);
  const [statusDiff, setStatusDiff] = useState<GitDiffResponse | null>(null);
  const [statusDiffLoading, setStatusDiffLoading] = useState(false);
  const [statusExpandedPaths, setStatusExpandedPaths] = useState<Set<string>>(new Set());
  const [stagedTree, setStagedTree] = useState<GitFileNode<unknown>[]>([]);
  const [unstagedTree, setUnstagedTree] = useState<GitFileNode<unknown>[]>([]);
  const [showStatusDiffPreview, setShowStatusDiffPreview] = useState(false);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const url = `/api/git/status?cwd=${encodeURIComponent(cwd)}`;
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to fetch git status');
      }
      const data: GitStatusResponse = await response.json();
      setStatus(data);

      const staged = buildGitFileTree(data.staged);
      const unstaged = buildGitFileTree(data.unstaged);
      setStagedTree(staged);
      setUnstagedTree(unstaged);

      const allPaths = new Set<string>([
        ...collectGitTreeDirPaths(staged),
        ...collectGitTreeDirPaths(unstaged),
      ]);
      setStatusExpandedPaths(allPaths);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStatusLoading(false);
    }
  }, [cwd]);

  const handleStatusToggle = useCallback((path: string) => {
    setStatusExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleStatusFileSelect = useCallback((file: GitFileStatus, type: 'staged' | 'unstaged') => {
    setStatusSelectedFile({ file, type });
    addToRecentFiles(file.path);
  }, [addToRecentFiles]);

  const handleStage = useCallback(async (path: string) => {
    try {
      const response = await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: [path] }),
      });
      if (!response.ok) {
        throw new Error('Failed to stage file');
      }
      await fetchStatus();
      toast(i18n.t('toast.staged'), 'success');
    } catch (err) {
      console.error('Error staging file:', err);
      toast(i18n.t('toast.stageFailed'), 'error');
    }
  }, [cwd, fetchStatus]);

  const handleUnstage = useCallback(async (path: string) => {
    try {
      const response = await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: [path] }),
      });
      if (!response.ok) {
        throw new Error('Failed to unstage file');
      }
      await fetchStatus();
      toast(i18n.t('toast.unstaged'), 'success');
    } catch (err) {
      console.error('Error unstaging file:', err);
      toast(i18n.t('toast.unstageFailed'), 'error');
    }
  }, [cwd, fetchStatus]);

  // Stage all files under a directory
  const handleStageFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const response = await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: paths }),
      });
      if (!response.ok) {
        throw new Error('Failed to stage files');
      }
      await fetchStatus();
      toast(i18n.t('toast.stagedNFiles', { count: paths.length }), 'success');
    } catch (err) {
      console.error('Error staging files:', err);
      toast(i18n.t('toast.stageFailed'), 'error');
    }
  }, [cwd, fetchStatus]);

  // Unstage all files under a directory
  const handleUnstageFiles = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const response = await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: paths }),
      });
      if (!response.ok) {
        throw new Error('Failed to unstage files');
      }
      await fetchStatus();
      toast(i18n.t('toast.unstagedNFiles', { count: paths.length }), 'success');
    } catch (err) {
      console.error('Error unstaging files:', err);
      toast(i18n.t('toast.unstageFailed'), 'error');
    }
  }, [cwd, fetchStatus]);

  // Discard changes for all files under a directory
  const handleDiscardFiles = useCallback(async (files: GitFileStatus[]) => {
    if (files.length === 0) return;
    try {
      const untrackedFiles = files.filter(f => f.status === 'untracked').map(f => f.path);
      const trackedFiles = files.filter(f => f.status !== 'untracked').map(f => f.path);

      // Delete untracked files
      if (untrackedFiles.length > 0) {
        const response = await fetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, files: untrackedFiles, isUntracked: true }),
        });
        if (!response.ok) {
          throw new Error('Failed to discard untracked files');
        }
      }

      // Checkout tracked files
      if (trackedFiles.length > 0) {
        const response = await fetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, files: trackedFiles, isUntracked: false }),
        });
        if (!response.ok) {
          throw new Error('Failed to discard tracked files');
        }
      }

      await fetchStatus();
      toast(i18n.t('toast.discardedNFiles', { count: files.length }), 'success');
    } catch (err) {
      console.error('Error discarding files:', err);
      toast(i18n.t('toast.discardFailed'), 'error');
    }
  }, [cwd, fetchStatus]);

  const handleStageAll = useCallback(async () => {
    if (!status?.unstaged.length) return;
    try {
      const response = await fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: status.unstaged.map(f => f.path) }),
      });
      if (!response.ok) {
        throw new Error('Failed to stage all files');
      }
      await fetchStatus();
      toast(i18n.t('toast.stagedNFiles', { count: status.unstaged.length }), 'success');
    } catch (err) {
      console.error('Error staging all files:', err);
      toast(i18n.t('toast.stageFailed'), 'error');
    }
  }, [cwd, status, fetchStatus]);

  const handleUnstageAll = useCallback(async () => {
    if (!status?.staged.length) return;
    try {
      const response = await fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: status.staged.map(f => f.path) }),
      });
      if (!response.ok) {
        throw new Error('Failed to unstage all files');
      }
      await fetchStatus();
      toast(i18n.t('toast.unstagedNFiles', { count: status.staged.length }), 'success');
    } catch (err) {
      console.error('Error unstaging all files:', err);
      toast(i18n.t('toast.unstageFailed'), 'error');
    }
  }, [cwd, status, fetchStatus]);

  // Discard changes for a single file
  const handleDiscardFile = useCallback(async (file: GitFileStatus) => {
    try {
      const isUntracked = file.status === 'untracked';
      const response = await fetch('/api/git/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, files: [file.path], isUntracked }),
      });
      if (!response.ok) {
        throw new Error('Failed to discard file');
      }
      await fetchStatus();
      toast(isUntracked ? i18n.t('toast.deletedFile') : i18n.t('toast.discardedChanges'), 'success');
    } catch (err) {
      console.error('Error discarding file:', err);
      toast(i18n.t('toast.discardFailed'), 'error');
    }
  }, [cwd, fetchStatus]);

  // Discard all working tree changes
  const handleDiscardAll = useCallback(async () => {
    if (!status?.unstaged.length) return;
    if (!confirm(i18n.t('git.discardAllConfirm', { count: status.unstaged.length }))) return;

    try {
      // Separate untracked and tracked files
      const untrackedFiles = status.unstaged.filter(f => f.status === 'untracked').map(f => f.path);
      const trackedFiles = status.unstaged.filter(f => f.status !== 'untracked').map(f => f.path);

      // Discard changes for tracked files
      if (trackedFiles.length > 0) {
        await fetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, files: trackedFiles, isUntracked: false }),
        });
      }

      // Delete untracked files
      if (untrackedFiles.length > 0) {
        await fetch('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, files: untrackedFiles, isUntracked: true }),
        });
      }

      await fetchStatus();
      toast(i18n.t('toast.discardedNFiles', { count: status.unstaged.length }), 'success');
    } catch (err) {
      console.error('Error discarding all:', err);
      toast(i18n.t('toast.discardFailed'), 'error');
    }
  }, [cwd, status, fetchStatus]);

  // Fetch status diff
  useEffect(() => {
    if (!statusSelectedFile) {
      setStatusDiff(null);
      return;
    }

    const fetchDiff = async () => {
      setStatusDiffLoading(true);
      try {
        const params = new URLSearchParams({
          file: statusSelectedFile.file.path,
          type: statusSelectedFile.type,
        });
        params.set('cwd', cwd);

        const response = await fetch(`/api/git/diff?${params}`);
        if (!response.ok) {
          throw new Error('Failed to fetch diff');
        }
        const data: GitDiffResponse = await response.json();
        setStatusDiff(data);
      } catch (err) {
        console.error('Error fetching diff:', err);
      } finally {
        setStatusDiffLoading(false);
      }
    };

    fetchDiff();
  }, [statusSelectedFile, cwd, diffRefreshKey]);

  return {
    status,
    setStatus,
    statusLoading,
    statusError,
    statusSelectedFile,
    statusDiff,
    statusDiffLoading,
    statusExpandedPaths,
    setStatusExpandedPaths,
    stagedTree,
    setStagedTree,
    unstagedTree,
    setUnstagedTree,
    showStatusDiffPreview,
    setShowStatusDiffPreview,
    fetchStatus,
    handleStatusToggle,
    handleStatusFileSelect,
    handleStage,
    handleUnstage,
    handleStageFiles,
    handleUnstageFiles,
    handleDiscardFiles,
    handleStageAll,
    handleUnstageAll,
    handleDiscardFile,
    handleDiscardAll,
    refreshDiff: useCallback(() => setDiffRefreshKey(k => k + 1), []),
  };
}
