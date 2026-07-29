import { useState, useCallback, useEffect, useRef } from 'react';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { fetchGitDiff } from '../effect/gitClient';
import type { GitDiffResponse } from '../fileBrowser/types';
import type { GitStatusMap } from '../FileTree';

/**
 * Directory-tree viewer diff mode.
 *
 * Opening a file that git reports as modified/renamed drops straight into a
 * diff instead of the plain viewer, with an explicit toggle back to full text.
 *
 * Scope decisions (deliberate, see the guards below):
 *  - Only 'M' / 'R' auto-enter. 'A' / '?' have no HEAD side, so their diff is
 *    just the whole file in green — no more readable than the normal viewer.
 *  - The diff is HEAD -> working tree ('worktree'), so a fully-staged file
 *    still shows its changes rather than an empty index-vs-disk diff.
 *  - The default is decided ONCE per file, and the resulting mode is remembered
 *    per path — revisiting a file restores how you left it, and a git-status
 *    refresh while it is open never yanks you into diff mode mid-read.
 */
export function useTreeFileDiff({
  cwd,
  selectedPath,
  gitStatusMap,
  renameOldPaths,
  isText,
  refreshKey,
}: {
  cwd: string;
  selectedPath: string | null;
  gitStatusMap: GitStatusMap | null;
  /** New path -> pre-rename path, for the HEAD side of an 'R' file. */
  renameOldPaths: ReadonlyMap<string, string> | null;
  /** Only text files can diff — a modified png stays on the image preview. */
  isText: boolean;
  /** Bump to refetch (file mtime): keeps the diff fresh after a save. */
  refreshKey?: number;
}) {
  const status = selectedPath ? gitStatusMap?.get(selectedPath) : undefined;
  const canDiff = isText && (status === 'M' || status === 'R');

  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  /** Paths currently in diff mode. Keyed per path rather than a single boolean
   *  so revisiting a file restores the mode it was left in — a plain flag gets
   *  clobbered by any intervening non-diffable file (an image, a clean file). */
  const [diffPaths, setDiffPaths] = useState<ReadonlySet<string>>(() => new Set());
  /** Paths whose auto-entry has already been evaluated, so the default applies
   *  once per file and never re-fires. Without it, a git-status refresh while
   *  the file is open (an agent editing it, a stage elsewhere) would yank the
   *  user into diff mode mid-read, or undo an explicit exit. */
  const decidedRef = useRef<Set<string>>(new Set());

  // `canDiff` is re-checked on every render, so a file that stops being modified
  // (reverted, committed) falls back to the plain viewer on its own.
  const showDiff = canDiff && !!selectedPath && diffPaths.has(selectedPath);

  useEffect(() => {
    if (!selectedPath) return;
    if (decidedRef.current.has(selectedPath)) return;
    // Git status still loading — decide once it lands, otherwise a changed file
    // opened during the initial fetch would always miss its auto-diff.
    if (!gitStatusMap) return;
    // Same for file content: `isText` is false until the read resolves.
    if (!isText) return;
    decidedRef.current.add(selectedPath);
    if (canDiff) {
      setDiffPaths((prev) => new Set(prev).add(selectedPath));
    }
  }, [selectedPath, gitStatusMap, isText, canDiff]);

  useEffect(() => {
    if (!showDiff || !selectedPath) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setIsLoadingDiff(true);
    BrowserRuntime.runPromiseExit(
      fetchGitDiff(cwd, selectedPath, 'worktree', renameOldPaths?.get(selectedPath)).pipe(
        Effect.withSpan('explorer.treeFileDiff'),
      ),
    ).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success') {
        setDiff(exit.value as GitDiffResponse);
      } else {
        console.error('Error fetching tree file diff:', exit.cause);
        setDiff(null);
      }
      setIsLoadingDiff(false);
    });
    return () => {
      cancelled = true;
    };
  }, [showDiff, selectedPath, cwd, refreshKey, renameOldPaths]);

  const toggleDiff = useCallback(() => {
    if (!selectedPath) return;
    setDiffPaths((prev) => {
      const next = new Set(prev);
      if (next.has(selectedPath)) next.delete(selectedPath);
      else next.add(selectedPath);
      return next;
    });
  }, [selectedPath]);

  return { canDiff, showDiff, toggleDiff, diff, isLoadingDiff };
}
