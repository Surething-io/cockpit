/**
 * Verification states for a review range (docs/DECISION_MODE.md §5).
 *
 * Lives in the chat feature (not feature-decisions) because relevance of a
 * filtered test run needs the explorer's code index, and decisions must not
 * depend on explorer (explorer will depend on decisions for its markers).
 */
import { isAbsolute, relative, sep } from 'node:path';
import { Effect } from 'effect';
import type { AppError, FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { SnapshotService } from '@cockpit/effect-services';
import {
  classifyCommand,
  computeReview,
  expectedKinds,
  readCheckOverrides,
  readProjectSetup,
  requireProject,
  type CheckInfo,
  type CheckKind,
  type VerificationKindRow,
  type VerificationResult,
  type VerificationRunInput,
  type VerificationRunRow,
  type VerificationState,
} from '@cockpit/feature-decisions/server';
import { ensureCodeIndex, peekCodeIndex } from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import { findAffected } from '@cockpit/feature-explorer/server/codeMap/analytics/index';

export interface VerificationInputs {
  runs: ReadonlyArray<VerificationRunInput>;
  /** Every tool call of the range, in conversation order (runs index into it). */
  orderedToolIds: ReadonlyArray<string>;
  /** This task's own snapshot commits. */
  ownCommits: ReadonlyArray<{ toolId: string; files: ReadonlyArray<string> }>;
  /** Other sessions' / baseline commits in the window (unix seconds). */
  foreignCommits: ReadonlyArray<{ timestamp: number; files: ReadonlyArray<string> }>;
  /** Files that belong to the task (every review category except other-session). */
  taskFiles: ReadonlySet<string>;
  classify: (command: string) => CheckInfo | null;
  expected: ReadonlyArray<CheckKind>;
  claimedPass: boolean;
  /** Do changes to `changed` reach any of `targets`? null = cannot tell (no index). */
  affects: (changed: string[], targets: string[]) => boolean | null;
}

const KIND_ORDER: CheckKind[] = ['test', 'typecheck', 'lint', 'custom'];

/** Pure core. */
export function computeVerification(inp: VerificationInputs): VerificationResult {
  const orderOf = new Map(inp.orderedToolIds.map((id, i) => [id, i]));
  const runs: VerificationRunRow[] = [];
  const otherCommands: VerificationResult['otherCommands'] = [];

  for (const r of [...inp.runs].sort((a, b) => a.order - b.order)) {
    const info = inp.classify(r.command);
    if (!info) {
      otherCommands.push({ toolId: r.toolId, command: r.command });
      continue;
    }
    const later = new Set<string>();
    for (const c of inp.ownCommits) {
      if ((orderOf.get(c.toolId) ?? -1) > r.order) for (const f of c.files) if (inp.taskFiles.has(f)) later.add(f);
    }
    const runAt = r.at ? Date.parse(r.at) : NaN;
    if (!Number.isNaN(runAt)) {
      for (const c of inp.foreignCommits) {
        if (c.timestamp * 1000 > runAt) for (const f of c.files) if (inp.taskFiles.has(f)) later.add(f);
      }
    }
    const changedAfter = [...later].sort();

    let approximate = false;
    const relevant = (() => {
      if (changedAfter.length === 0) return false;
      if (!info.filtered || info.targets.length === 0) return true;
      if (changedAfter.some((f) => info.targets.includes(f))) return true;
      const hit = inp.affects(changedAfter, info.targets);
      if (hit === null) {
        approximate = true;
        return true; // cannot tell → assume it matters
      }
      return hit;
    })();

    let state: VerificationState;
    let exitCode: number | undefined;
    if (r.outcome.kind === 'running') state = 'running';
    else if (r.outcome.kind === 'unknown') state = 'unknown';
    else {
      exitCode = r.outcome.code;
      if (relevant) state = 'needs-rerun';
      else if (exitCode !== 0) state = 'failed';
      else if (info.kind === 'test' && r.noTestsRan) state = 'no-tests';
      else state = 'verified';
    }
    runs.push({
      toolId: r.toolId,
      command: r.command,
      kind: info.kind,
      filtered: info.filtered,
      targets: info.targets,
      state,
      ...(exitCode !== undefined ? { exitCode } : {}),
      changedAfter,
      approximate,
      tail: r.tail,
    });
  }

  // One row per kind: the latest run decides; expected kinds with no run are unverified.
  const kinds: VerificationKindRow[] = [];
  const seen = new Set<CheckKind>([...inp.expected, ...runs.map((r) => r.kind)]);
  for (const kind of KIND_ORDER) {
    if (!seen.has(kind)) continue;
    const latest = [...runs].reverse().find((r) => r.kind === kind);
    if (latest) kinds.push({ kind, state: latest.state, toolId: latest.toolId });
    else kinds.push({ kind, state: kind === 'test' && inp.claimedPass ? 'claimed' : 'unverified' });
  }
  if (inp.claimedPass && !seen.has('test')) kinds.unshift({ kind: 'test', state: 'claimed' });

  return { kinds, runs, otherCommands };
}

/** Agent-typed paths (`./a.test.ts`, absolute) → cwd-relative POSIX, as snapshot paths are. */
const toCwdRelative = (cwd: string, p: string): string => {
  const rel = isAbsolute(p) ? relative(cwd, p).split(sep).join('/') : p;
  return rel.replace(/^\.\//, '');
};

export const verifyRange = (
  cwd: string,
  orderedToolIds: ReadonlyArray<string>,
  runs: ReadonlyArray<VerificationRunInput>,
  claimedPass: boolean,
): Effect.Effect<VerificationResult, AppError | FSError | NotFoundError | ValidationError, SnapshotService> =>
  Effect.gen(function* () {
    const project = yield* requireProject(cwd);
    const setup = yield* readProjectSetup(cwd);
    const overrides = yield* readCheckOverrides(project.projectId);
    const review = yield* computeReview(cwd, orderedToolIds, false);

    let ownCommits: VerificationInputs['ownCommits'] = [];
    let foreignCommits: VerificationInputs['foreignCommits'] = [];
    let taskFiles = new Set<string>();
    if (!review.empty) {
      const snapshots = yield* SnapshotService;
      const own = new Set(orderedToolIds);
      const window = yield* snapshots.listWindow(cwd, review.base, review.head);
      ownCommits = window.filter((c) => c.toolId && own.has(c.toolId)).map((c) => ({ toolId: c.toolId as string, files: c.files }));
      foreignCommits = window.filter((c) => !(c.toolId && own.has(c.toolId))).map((c) => ({ timestamp: c.timestamp, files: c.files }));
      taskFiles = new Set(review.files.filter((f) => f.category !== 'other-session').map((f) => f.path));
    }

    // Never await a full index build inside a request (constraints/file-functions-never-awaits-full-build):
    // use the index if it is ready, otherwise start it and answer conservatively.
    const index = peekCodeIndex(cwd);
    if (!index) ensureCodeIndex(cwd);
    const affects = (changed: string[], targets: string[]): boolean | null => {
      if (!index) return null;
      const tests = new Set(findAffected(index, { files: changed }).testFiles);
      return targets.some((t) => tests.has(t) || [...tests].some((x) => x.startsWith(`${t.replace(/\/$/, '')}/`)));
    };

    return computeVerification({
      runs: runs.map((r) => r),
      orderedToolIds,
      ownCommits,
      foreignCommits,
      taskFiles,
      classify: (cmd) => {
        const info = classifyCommand(cmd, setup.scripts, overrides);
        return info ? { ...info, targets: info.targets.map((t) => toCwdRelative(cwd, t)) } : null;
      },
      expected: expectedKinds(setup.scripts, setup.markers),
      claimedPass,
      affects,
    });
  });
