import { useState, useCallback, useEffect, useMemo } from 'react';
import { buildGitFileTree, collectGitTreeDirPaths, type GitFileNode } from '../GitFileTree';
import { toast, confirm } from '@cockpit/shared-ui';
import type { GitFileStatus, GitStatusResponse, GitDiffResponse } from '../fileBrowser/types';
import i18n from '@cockpit/shared-i18n';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  fetchGitStatus,
  stageFiles as stageFilesEff,
  unstageFiles as unstageFilesEff,
  discardFiles as discardFilesEff,
  fetchGitDiff,
} from '../effect/gitClient';

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
  // Track only user-collapsed directories (blacklist). Everything not in this set is expanded.
  // This way, refetching git status (via watcher / visibility / external events) cannot revive
  // a folder the user just collapsed — the user's intent is preserved across data refreshes.
  // Staged and unstaged keep independent fold state: the same directory path may be collapsed
  // in one area and expanded in the other.
  const [stagedCollapsedPaths, setStagedCollapsedPaths] = useState<Set<string>>(new Set());
  const [unstagedCollapsedPaths, setUnstagedCollapsedPaths] = useState<Set<string>>(new Set());
  const [stagedTree, setStagedTree] = useState<GitFileNode<unknown>[]>([]);
  const [unstagedTree, setUnstagedTree] = useState<GitFileNode<unknown>[]>([]);

  // Derive the expanded-set the tree component expects: all directory paths minus collapsed ones.
  const stagedExpandedPaths = useMemo(() => {
    const expanded = new Set<string>(collectGitTreeDirPaths(stagedTree));
    for (const p of stagedCollapsedPaths) expanded.delete(p);
    return expanded;
  }, [stagedTree, stagedCollapsedPaths]);
  const unstagedExpandedPaths = useMemo(() => {
    const expanded = new Set<string>(collectGitTreeDirPaths(unstagedTree));
    for (const p of unstagedCollapsedPaths) expanded.delete(p);
    return expanded;
  }, [unstagedTree, unstagedCollapsedPaths]);
  const [showStatusDiffPreview, setShowStatusDiffPreview] = useState(false);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    await BrowserRuntime.runPromise(
      fetchGitStatus(cwd).pipe(
        Effect.match({
          onSuccess: (data) => {
            const typed = data as unknown as GitStatusResponse;
            setStatus(typed);
            const staged = buildGitFileTree(typed.staged);
            const unstaged = buildGitFileTree(typed.unstaged);
            setStagedTree(staged);
            setUnstagedTree(unstaged);
            // Note: do NOT touch staged/unstagedCollapsedPaths here — refetching must not undo user folding.
          },
          onFailure: (err) => {
            // AppError.cause already carries the backend body.error or the HTTP status
            const msg =
              err.cause instanceof Error
                ? err.cause.message
                : 'Unknown error';
            setStatusError(msg);
          },
        })
      )
    );
    setStatusLoading(false);
  }, [cwd]);

  // Membership in collapsedPaths is inverted from the visible state:
  //   path ∈ collapsedPaths  ⇔  folder is currently collapsed
  // Toggling moves a path in/out of the blacklist. Staged and unstaged each
  // have their own setter so the two trees fold independently.
  // Bodies are inlined (rather than factored through a `makeToggle` helper)
  // because the react-hooks/use-memo lint rule requires the first argument
  // to useCallback to be an inline function expression.
  const handleStagedToggle = useCallback((path: string) => {
    setStagedCollapsedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); // user re-expands
      else next.add(path);                   // user collapses
      return next;
    });
  }, []);
  const handleUnstagedToggle = useCallback((path: string) => {
    setUnstagedCollapsedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleStatusFileSelect = useCallback((file: GitFileStatus, type: 'staged' | 'unstaged') => {
    setStatusSelectedFile({ file, type });
    addToRecentFiles(file.path);
  }, [addToRecentFiles]);

  // Run a mutation Effect with toast feedback and auto-refetch on success.
  // Centralizes the repetitive try/await/toast/console.error/refetch boilerplate.
  const runMutation = useCallback(
    async (
      eff: Effect.Effect<void, unknown>,
      successToast: string,
      failureLog: string,
      failureToast: string,
    ) => {
      const exit = await BrowserRuntime.runPromiseExit(eff);
      if (exit._tag === 'Success') {
        await fetchStatus();
        toast(successToast, 'success');
      } else {
        console.error(failureLog, exit.cause);
        toast(failureToast, 'error');
      }
    },
    [fetchStatus],
  );

  const handleStage = useCallback(
    (path: string) =>
      runMutation(
        stageFilesEff(cwd, [path]),
        i18n.t('toast.staged'),
        'Error staging file:',
        i18n.t('toast.stageFailed'),
      ),
    [cwd, runMutation],
  );

  const handleUnstage = useCallback(
    (path: string) =>
      runMutation(
        unstageFilesEff(cwd, [path]),
        i18n.t('toast.unstaged'),
        'Error unstaging file:',
        i18n.t('toast.unstageFailed'),
      ),
    [cwd, runMutation],
  );

  // Stage all files under a directory
  const handleStageFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      await runMutation(
        stageFilesEff(cwd, paths),
        i18n.t('toast.stagedNFiles', { count: paths.length }),
        'Error staging files:',
        i18n.t('toast.stageFailed'),
      );
    },
    [cwd, runMutation],
  );

  // Unstage all files under a directory
  const handleUnstageFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      await runMutation(
        unstageFilesEff(cwd, paths),
        i18n.t('toast.unstagedNFiles', { count: paths.length }),
        'Error unstaging files:',
        i18n.t('toast.unstageFailed'),
      );
    },
    [cwd, runMutation],
  );

  // Discard changes for all files under a directory.
  // Order: untracked first (delete files), then tracked (checkout).
  const handleDiscardFiles = useCallback(
    async (files: GitFileStatus[]) => {
      if (files.length === 0) return;
      const untrackedFiles = files.filter(f => f.status === 'untracked').map(f => f.path);
      const trackedFiles = files.filter(f => f.status !== 'untracked').map(f => f.path);
      const compound = Effect.gen(function* () {
        if (untrackedFiles.length > 0) yield* discardFilesEff(cwd, untrackedFiles, true);
        if (trackedFiles.length > 0) yield* discardFilesEff(cwd, trackedFiles, false);
      });
      await runMutation(
        compound,
        i18n.t('toast.discardedNFiles', { count: files.length }),
        'Error discarding files:',
        i18n.t('toast.discardFailed'),
      );
    },
    [cwd, runMutation],
  );

  const handleStageAll = useCallback(async () => {
    if (!status?.unstaged.length) return;
    await runMutation(
      stageFilesEff(cwd, status.unstaged.map(f => f.path)),
      i18n.t('toast.stagedNFiles', { count: status.unstaged.length }),
      'Error staging all files:',
      i18n.t('toast.stageFailed'),
    );
  }, [cwd, status, runMutation]);

  const handleUnstageAll = useCallback(async () => {
    if (!status?.staged.length) return;
    await runMutation(
      unstageFilesEff(cwd, status.staged.map(f => f.path)),
      i18n.t('toast.unstagedNFiles', { count: status.staged.length }),
      'Error unstaging all files:',
      i18n.t('toast.unstageFailed'),
    );
  }, [cwd, status, runMutation]);

  // Discard changes for a single file
  const handleDiscardFile = useCallback(
    async (file: GitFileStatus) => {
      const isUntracked = file.status === 'untracked';
      await runMutation(
        discardFilesEff(cwd, [file.path], isUntracked),
        isUntracked ? i18n.t('toast.deletedFile') : i18n.t('toast.discardedChanges'),
        'Error discarding file:',
        i18n.t('toast.discardFailed'),
      );
    },
    [cwd, runMutation],
  );

  // Discard all working tree changes
  const handleDiscardAll = useCallback(async () => {
    if (!status?.unstaged.length) return;
    if (!await confirm(i18n.t('git.discardAllConfirm', { count: status.unstaged.length }), { danger: true })) return;

    // Separate untracked and tracked files
    const untrackedFiles = status.unstaged.filter(f => f.status === 'untracked').map(f => f.path);
    const trackedFiles = status.unstaged.filter(f => f.status !== 'untracked').map(f => f.path);
    const total = status.unstaged.length;
    // Order: tracked first (restore), then untracked (delete files).
    const compound = Effect.gen(function* () {
      if (trackedFiles.length > 0) yield* discardFilesEff(cwd, trackedFiles, false);
      if (untrackedFiles.length > 0) yield* discardFilesEff(cwd, untrackedFiles, true);
    });
    await runMutation(
      compound,
      i18n.t('toast.discardedNFiles', { count: total }),
      'Error discarding all:',
      i18n.t('toast.discardFailed'),
    );
  }, [cwd, status, runMutation]);

  // Fetch status diff
  useEffect(() => {
    if (!statusSelectedFile) {
      setStatusDiff(null);
      return;
    }

    setStatusDiffLoading(true);
    BrowserRuntime.runPromiseExit(
      fetchGitDiff(cwd, statusSelectedFile.file.path, statusSelectedFile.type)
    ).then((exit) => {
      if (exit._tag === 'Success') {
        setStatusDiff(exit.value as GitDiffResponse);
      } else {
        console.error('Error fetching diff:', exit.cause);
      }
      setStatusDiffLoading(false);
    });
  }, [statusSelectedFile, cwd, diffRefreshKey]);

  return {
    status,
    setStatus,
    statusLoading,
    statusError,
    statusSelectedFile,
    statusDiff,
    statusDiffLoading,
    stagedExpandedPaths,
    unstagedExpandedPaths,
    stagedTree,
    setStagedTree,
    unstagedTree,
    setUnstagedTree,
    showStatusDiffPreview,
    setShowStatusDiffPreview,
    fetchStatus,
    handleStagedToggle,
    handleUnstagedToggle,
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
