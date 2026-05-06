'use client';

/**
 * BlockDiffViewer — git-diff "Code Map / 代码地图" view.
 *
 * Mounts when the user toggles the diff toolbar to "Code Map". This is
 * the SAME chip layout users already know from the directory tree's
 * "Code Map" (BlockViewer) — caller pins on the left, code body in the
 * middle, callee pins on the right — but filtered to the functions
 * touched by the diff and overlaid with line-level change highlights.
 *
 * Naming note: the user-visible feature is "Code Map / 代码地图" (in
 * i18n as `common.codeMap`). The component is still called
 * `BlockDiffViewer` because internally a Code Map is composed of per-
 * function "blocks" / chips — the Block* names describe that
 * primitive, not the user-facing feature.
 *
 * Why we don't have a separate "split before/after" mode anymore: file
 * mode (DiffView's unified line diff) already covers "show me what
 * lines changed", and the Code Map view on top of that gives "show me
 * what functions changed and how they're connected". A third split-
 * panel mode was redundant and inconsistent with the directory tree's
 * Code Map — the same word now means the same chip layout everywhere.
 *
 * Focal-following: when the user pin-jumps from the diff target to
 * ANOTHER changed file, BlockDiffViewer re-fetches that file's
 * old/new content via `/api/git/diff` and recomputes the projection.
 * This way chip-diff highlighting follows pin navigation across the
 * entire change set instead of dropping back to a plain chip view the
 * moment focal leaves the original diff target. Files that AREN'T in
 * the change set (review-time peeking at unchanged code) leave
 * projection null — BlockViewer falls back to its standard full-file
 * rendering, no overlay, no filter.
 *
 * Implementation: an `activeFile` state tracks BlockViewer's current
 * focal (via `onFocalChange`). A separate effect, keyed on `activeFile`,
 * fetches diff content and rebuilds the projection. All anchor props
 * (`qnameFilterFile`, `accentFile`, `addedLinesFile`) point to
 * `activeFile` rather than the original `filePath`, so BlockViewer's
 * "anchor === data.filePath" gates apply the projection on whichever
 * file is currently shown.
 */

import { useEffect, useState } from 'react';
import { BlockViewer, type BlockViewerHeaderState } from './BlockViewer';
import {
  buildImpactProjection,
  type ImpactProjection,
} from './blockDiffProjection';

interface BlockDiffViewerProps {
  cwd: string;
  /** Project-relative path of the file under review. */
  filePath: string;
  oldContent: string;
  newContent: string;
  isNew?: boolean;
  isDeleted?: boolean;
  changedFiles: ReadonlySet<string>;
  /** Per-file git-status lookup. Required for focal-following: when
   *  the user pin-jumps to another changed file, we need to know
   *  whether to ask `/api/git/diff` for its staged or unstaged diff. */
  fileGitStatusMap?: ReadonlyMap<string, 'staged' | 'unstaged'>;
  enableComments?: boolean;
  /** Forwarded to BlockViewer — adds a "Search" button to the
   *  FloatingToolbar that hands the selected text off for project-wide
   *  content search. Omit to hide the button. */
  onContentSearch?: (query: string) => void;
  /** Forwarded straight to BlockViewer — see its `headerExtraLeft` /
   *  `headerExtraRight` for semantics. The host (FileBrowserModal)
   *  uses these to inject copy-path + dynamic git-status badge on the
   *  left, and the file/block mode toggle on the right. */
  headerExtraLeft?: (state: BlockViewerHeaderState) => React.ReactNode;
  headerExtraRight?: (state: BlockViewerHeaderState) => React.ReactNode;
}

/** Diff content for a file — what we feed to `buildImpactProjection`. */
interface DiffContent {
  oldContent: string;
  newContent: string;
  isNew: boolean;
  isDeleted: boolean;
}

/** Shape of the response from /api/git/diff. */
interface GitDiffResponse {
  oldContent: string;
  newContent: string;
  isNew?: boolean;
  isDeleted?: boolean;
}

export function BlockDiffViewer({
  cwd,
  filePath,
  oldContent,
  newContent,
  isNew = false,
  isDeleted = false,
  changedFiles,
  fileGitStatusMap,
  enableComments = false,
  onContentSearch,
  headerExtraLeft,
  headerExtraRight,
}: BlockDiffViewerProps) {
  // Active file — BlockViewer's current focal. Starts as the original
  // diff target; updated by `onFocalChange` whenever the user pin-jumps
  // / Cmd+K-jumps / clicks a history-drawer entry.
  const [activeFile, setActiveFile] = useState<string>(filePath);

  // If the host swaps the diff target out (e.g. user picks a different
  // file in the git changes panel), reset activeFile so the projection
  // re-anchors to the new target.
  useEffect(() => {
    setActiveFile(filePath);
  }, [filePath]);

  // Async projection — parse both sides, derive changed qnames + added
  // line numbers. Held in state so the same Set identity flows through
  // to BlockViewer's CodeBlock (which keeps `addedLines` in its
  // highlight effect's deps).
  //
  // `buildImpactProjection` always resolves to an `ImpactProjection`
  // (no 'unsupported' literal anymore). For files in languages we
  // don't bundle a tree-sitter grammar for (CSS / Go / Java / etc),
  // the returned projection has `changedQnames === undefined` but
  // still populates `addedLines` — so chip diff degrades gracefully.
  // BlockViewer's filter / accent props are gated on `qnameFilter`
  // being defined, so passing `undefined` cleanly disables them.
  const [projection, setProjection] = useState<ImpactProjection | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProjection(null);

    (async () => {
      try {
        const content = await loadDiffContent(
          activeFile,
          filePath,
          oldContent,
          newContent,
          isNew,
          isDeleted,
          changedFiles,
          fileGitStatusMap,
          cwd,
        );
        if (cancelled || !content) return;
        const result = await buildImpactProjection(
          content.oldContent,
          content.newContent,
          activeFile,
          content.isNew,
          content.isDeleted,
        );
        if (cancelled) return;
        setProjection(result);
      } catch (err) {
        if (!cancelled) {
          console.error('[BlockDiffViewer] projection failed:', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeFile,
    filePath,
    oldContent,
    newContent,
    isNew,
    isDeleted,
    changedFiles,
    fileGitStatusMap,
    cwd,
  ]);

  return (
    <BlockViewer
      cwd={cwd}
      highlightedFilePath={filePath}
      changedFiles={changedFiles}
      enableComments={enableComments}
      // All anchors point to the ACTIVE file (the one BlockViewer is
      // currently rendering), not the original diff target. That's
      // what makes the overlay follow pin navigation: when activeFile
      // becomes file B, projection is for B, anchors say B, BlockViewer
      // sees `data.filePath === addedLinesFile` and applies overlay.
      qnameFilter={projection?.changedQnames}
      qnameFilterFile={activeFile}
      accentQnames={projection?.changedQnames}
      accentFile={activeFile}
      addedLines={projection?.addedLines}
      addedLinesFile={activeFile}
      onFocalChange={(f) => f && setActiveFile(f)}
      onContentSearch={onContentSearch}
      headerExtraLeft={headerExtraLeft}
      headerExtraRight={headerExtraRight}
      // No `onSwitchToCode` — the Code button is hidden in diff context
      // because the toolbar above already provides the file/block toggle.
    />
  );
}

/**
 * Resolve the diff content for the file BlockViewer is currently
 * showing. Three cases:
 *
 *   1. activeFile === filePath (user is on the original diff target)
 *      → use the old/new content already passed in as props. No fetch.
 *
 *   2. activeFile is in changedFiles (pin-jumped to another changed
 *      file in the same change set) → call `/api/git/diff` to grab
 *      that file's diff content. Status type ('staged' / 'unstaged')
 *      comes from `fileGitStatusMap`; without it the API would 400.
 *
 *   3. activeFile is not in the change set (peeking at unchanged code)
 *      → return null. Caller leaves projection null; BlockViewer
 *      renders the full file with no overlay/filter, identical to
 *      its non-diff behaviour.
 */
async function loadDiffContent(
  activeFile: string,
  originalFilePath: string,
  originalOld: string,
  originalNew: string,
  originalIsNew: boolean,
  originalIsDeleted: boolean,
  changedFiles: ReadonlySet<string>,
  fileGitStatusMap: ReadonlyMap<string, 'staged' | 'unstaged'> | undefined,
  cwd: string,
): Promise<DiffContent | null> {
  if (activeFile === originalFilePath) {
    return {
      oldContent: originalOld,
      newContent: originalNew,
      isNew: originalIsNew,
      isDeleted: originalIsDeleted,
    };
  }
  if (!changedFiles.has(activeFile)) return null;
  const statusType = fileGitStatusMap?.get(activeFile);
  if (!statusType) return null; // can't fetch without knowing staged vs unstaged

  const params = new URLSearchParams({ cwd, file: activeFile, type: statusType });
  const res = await fetch(`/api/git/diff?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as GitDiffResponse;
  return {
    oldContent: data.oldContent,
    newContent: data.newContent,
    isNew: data.isNew ?? false,
    isDeleted: data.isDeleted ?? false,
  };
}
