/**
 * Task review — the deterministic part (docs/DECISION_MODE.md §4).
 *
 * A review range is identified by the tool calls of the selected turns. Their
 * snapshot commits give the range (`base` = parent of the first, `head` = the
 * last); the snapshot window between them holds EVERY session's commits, which
 * is what lets each changed file be attributed (§4.3).
 */
import { relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import type { AppError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { SnapshotService, type SnapshotFileDiff, type SnapshotWindowCommit } from '@cockpit/effect-services';
import type { FileAttribution, FileCategory, ReviewFile, ReviewResult } from '../shared/review';

export interface FileTouches {
  /** Own commit that declared the file (Edit / Write …). */
  declared: boolean;
  /** Own commit from a tool that declares nothing (Bash …). */
  bash: boolean;
  /** Own commit that declared OTHER files — this one changed alongside. */
  undeclared: boolean;
  /** Run-start baseline: changes made outside any tool call. */
  external: boolean;
  /** Session keys of other sessions' tool commits that touched the file. */
  others: Set<string>;
}

/** Fold the window's commits into per-file touches. Pure. */
export function collectTouches(
  window: ReadonlyArray<SnapshotWindowCommit>,
  ownToolIds: ReadonlySet<string>,
): Map<string, FileTouches> {
  const touches = new Map<string, FileTouches>();
  const get = (p: string) => {
    let t = touches.get(p);
    if (!t) touches.set(p, (t = { declared: false, bash: false, undeclared: false, external: false, others: new Set() }));
    return t;
  };
  for (const c of window) {
    const own = !!c.toolId && ownToolIds.has(c.toolId);
    for (const f of c.files) {
      const t = get(f);
      if (own) {
        if (c.toolFiles.includes(f)) t.declared = true;
        else if (c.toolFiles.length === 0) t.bash = true;
        else t.undeclared = true;
      } else if (c.baseline) {
        t.external = true;
      } else {
        t.others.add(c.sessionKey ?? 'unknown');
      }
    }
  }
  return touches;
}

/**
 * The §4.3 table. Precedence: anything another session touched AND this task
 * touched is `mixed` — the two cannot be separated in one net diff, so it is
 * shown whole and flagged rather than pretending to split it.
 */
export function categorize(t: FileTouches | undefined): FileCategory {
  if (!t) return 'non-agent';
  const ownish = t.declared || t.bash || t.undeclared || t.external;
  if (t.others.size > 0) return ownish ? 'mixed' : 'other-session';
  if (t.declared) return 'task';
  if (t.bash) return 'task-maybe';
  return 'non-agent';
}

export function attribute(path: string, touches: Map<string, FileTouches>): FileAttribution {
  const t = touches.get(path);
  return { category: categorize(t), otherSessions: t ? [...t.others].sort() : [] };
}

/** Categories that belong to the task: frozen on accept and fed to every check. */
export const TASK_CATEGORIES: ReadonlySet<FileCategory> = new Set(['task', 'task-maybe', 'mixed', 'non-agent']);

/** cwd-relative (snapshot) path → path relative to the git toplevel, POSIX separators. */
export const toToplevelPath = (toplevel: string, cwd: string, p: string): string =>
  relative(toplevel, resolve(cwd, p)).split(sep).join('/');

/**
 * Compute the review of the range spanned by `toolIds`. `withContent` false
 * drops file contents (the status bar only needs counts).
 */
export const computeReview = (
  cwd: string,
  toolIds: ReadonlyArray<string>,
  withContent: boolean,
): Effect.Effect<ReviewResult, AppError | ValidationError | NotFoundError, SnapshotService> =>
  Effect.gen(function* () {
    const snapshots = yield* SnapshotService;
    const own = yield* snapshots.listByToolIds(cwd, toolIds);
    if (own.length === 0) return { empty: true } as const;
    const base = own[0].parent;
    const head = own[own.length - 1];
    const window = yield* snapshots.listWindow(cwd, base, head.hash);
    const range = yield* snapshots.rangeDiff(cwd, base, head.hash);
    const touches = collectTouches(window, new Set(toolIds));
    const files: ReviewFile[] = range.files.map((f: SnapshotFileDiff) => ({
      ...(withContent ? f : { ...f, oldContent: null, newContent: null }),
      ...attribute(f.path, touches),
    }));
    return {
      empty: false,
      base,
      head: head.hash,
      headAt: head.timestamp,
      files,
      truncated: range.truncated,
      ownCommits: own.length,
      windowCommits: window.length,
    } as const;
  });
