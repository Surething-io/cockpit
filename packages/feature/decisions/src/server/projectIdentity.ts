/**
 * Project identity for decision mode (docs/DECISION_MODE.md §10).
 *
 * Decisions must survive moving the checkout, re-cloning it, and opening it
 * through another worktree, so they are NOT keyed by absolute path:
 *
 * - git checkouts → `git-<root commit>`. Worktrees share a git common dir and
 *   therefore one registry entry. A checkout whose common dir is new is matched
 *   to an existing project by root commit: if every other checkout with that
 *   root is gone from disk, this is a move and it binds automatically; if one
 *   still exists, it may be a separate clone of the same template, so the user
 *   is asked (`ambiguous`) and nothing is written until they choose.
 * - non-git directories (or repos with no commits) → `path-<hash of realpath>`;
 *   moving such a directory loses its decisions, which the UI says up front.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import { FSError, ValidationError } from '@cockpit/effect-core';
import { readJsonFile, readJsonFileForUpdate, withFileLock, writeJsonFile } from '@cockpit/shared-utils';
import type {
  AmbiguousCandidate,
  DecisionProjectResolution,
  DecisionProjectState,
  ProjectKind,
} from '../shared/types';
import { checkoutsFile, projectStateFile } from './paths';

const execFileAsync = promisify(execFile);

interface CheckoutEntry {
  projectId: string;
  rootCommit: string;
  /** Toplevels seen for this common dir (main checkout + worktrees). */
  toplevels: string[];
  lastSeen: number;
}

interface CheckoutsRegistry {
  checkouts: Record<string, CheckoutEntry>;
}

interface ProjectStateFile {
  enabled?: boolean;
  enabledAt?: number;
}

export interface GitInfo {
  toplevel: string;
  commonDir: string;
  rootCommit: string;
}

const EMPTY_REGISTRY: CheckoutsRegistry = { checkouts: {} };

const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 })).stdout.trim();

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * Toplevel, common dir and root commit of the repo containing `cwd`; null when
 * `cwd` is not inside a git repo or the repo has no commits yet. Several root
 * commits (merged unrelated histories) → the lexicographically smallest, so the
 * choice is stable across checkouts.
 */
export const readGitInfo = (cwd: string): Effect.Effect<GitInfo | null> =>
  Effect.tryPromise(async () => {
    const [toplevel, commonDirRaw] = (await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'])).split('\n');
    const roots = (await git(cwd, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean).sort();
    if (!toplevel || !commonDirRaw || roots.length === 0) return null;
    const commonDir = await realpath(isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw));
    return { toplevel: await realpath(toplevel), commonDir, rootCommit: roots[0] };
  }).pipe(Effect.orElseSucceed(() => null));

const pathProjectId = (cwd: string): Effect.Effect<string> =>
  Effect.promise(() => realpath(cwd).catch(() => resolve(cwd))).pipe(
    Effect.map((p) => `path-${createHash('sha256').update(p).digest('hex').slice(0, 16)}`),
  );

const readState = (projectId: string, kind: ProjectKind): Effect.Effect<DecisionProjectState> =>
  Effect.promise(() => readJsonFile<ProjectStateFile>(projectStateFile(projectId), {})).pipe(
    Effect.map((s) => ({
      projectId,
      kind,
      enabled: s.enabled === true,
      ...(typeof s.enabledAt === 'number' ? { enabledAt: s.enabledAt } : {}),
    })),
  );

type Binding =
  | { status: 'bound'; projectId: string }
  | { status: 'ambiguous'; candidates: AmbiguousCandidate[] };

/**
 * Look up (and when unambiguous, record) the project a git checkout belongs to.
 * The whole lookup runs under the registry lock so two tabs opening a new
 * checkout at once cannot bind it twice.
 */
const bindCheckout = (info: GitInfo, now: number): Effect.Effect<Binding, FSError> => {
  const file = checkoutsFile();
  return Effect.tryPromise({
    try: () =>
      withFileLock(file, async (): Promise<Binding> => {
        const reg = await readJsonFileForUpdate<CheckoutsRegistry>(file, EMPTY_REGISTRY);
        const checkouts = reg.checkouts ?? {};
        const own = checkouts[info.commonDir];
        if (own) {
          if (!own.toplevels.includes(info.toplevel)) own.toplevels.push(info.toplevel);
          own.lastSeen = now;
          await writeJsonFile(file, { checkouts });
          return { status: 'bound', projectId: own.projectId };
        }

        const siblings = Object.entries(checkouts).filter(([, e]) => e.rootCommit === info.rootCommit);
        let projectId: string;
        if (siblings.length === 0) {
          projectId = `git-${info.rootCommit}`;
        } else {
          const live: Array<[string, CheckoutEntry]> = [];
          for (const s of siblings) if (await exists(s[0])) live.push(s);
          if (live.length > 0) return { status: 'ambiguous', candidates: groupCandidates(live) };
          // Every other checkout of this root is gone: the repo was moved or re-cloned.
          projectId = siblings.reduce((a, b) => (b[1].lastSeen > a[1].lastSeen ? b : a))[1].projectId;
        }
        checkouts[info.commonDir] = { projectId, rootCommit: info.rootCommit, toplevels: [info.toplevel], lastSeen: now };
        await writeJsonFile(file, { checkouts });
        return { status: 'bound', projectId };
      }),
    catch: (cause) => new FSError({ path: file, op: 'write', cause }),
  });
};

function groupCandidates(entries: Array<[string, CheckoutEntry]>): AmbiguousCandidate[] {
  const byProject = new Map<string, string[]>();
  for (const [, e] of entries) byProject.set(e.projectId, [...(byProject.get(e.projectId) ?? []), ...e.toplevels]);
  return [...byProject].map(([projectId, toplevels]) => ({ projectId, toplevels }));
}

/** Resolve the decision project for `cwd`, binding a new checkout when unambiguous. */
export const resolveProject = (cwd: string): Effect.Effect<DecisionProjectResolution, FSError> =>
  Effect.gen(function* () {
    const info = yield* readGitInfo(cwd);
    if (!info) {
      const state = yield* readState(yield* pathProjectId(cwd), 'path');
      return { status: 'resolved', ...state } as const;
    }
    const binding = yield* bindCheckout(info, Date.now());
    if (binding.status === 'ambiguous') {
      return { status: 'ambiguous', rootCommit: info.rootCommit, candidates: binding.candidates } as const;
    }
    const state = yield* readState(binding.projectId, 'git');
    return { status: 'resolved', ...state } as const;
  });

/** Like resolveProject, but an ambiguous checkout is an error (for every route except the binding one). */
export const requireProject = (cwd: string): Effect.Effect<DecisionProjectState, FSError | ValidationError> =>
  resolveProject(cwd).pipe(
    Effect.flatMap((r) =>
      r.status === 'resolved'
        ? Effect.succeed({ projectId: r.projectId, kind: r.kind, enabled: r.enabled, ...(r.enabledAt !== undefined ? { enabledAt: r.enabledAt } : {}) })
        : Effect.fail(new ValidationError({ field: 'project', reason: 'ambiguous' })),
    ),
  );

/**
 * Settle an ambiguous checkout: join an existing project with the same root
 * commit, or start a separate one (`'new'`).
 */
export const bindProject = (
  cwd: string,
  choice: string,
): Effect.Effect<DecisionProjectState, FSError | ValidationError> =>
  Effect.gen(function* () {
    const info = yield* readGitInfo(cwd);
    if (!info) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'not a git checkout with commits' }));
    const file = checkoutsFile();
    const projectId = yield* Effect.tryPromise({
      try: () =>
        withFileLock(file, async (): Promise<string | null> => {
          const reg = await readJsonFileForUpdate<CheckoutsRegistry>(file, EMPTY_REGISTRY);
          const checkouts = reg.checkouts ?? {};
          const sameRoot = new Set(
            Object.values(checkouts)
              .filter((e) => e.rootCommit === info.rootCommit)
              .map((e) => e.projectId),
          );
          let id: string;
          if (choice === 'new') id = `git-${info.rootCommit}-${randomUUID().slice(0, 8)}`;
          else if (sameRoot.has(choice)) id = choice;
          else return null;
          checkouts[info.commonDir] = { projectId: id, rootCommit: info.rootCommit, toplevels: [info.toplevel], lastSeen: Date.now() };
          await writeJsonFile(file, { checkouts });
          return id;
        }),
      catch: (cause) => new FSError({ path: file, op: 'write', cause }),
    });
    if (!projectId) return yield* Effect.fail(new ValidationError({ field: 'choice', reason: 'not a project sharing this root commit' }));
    return yield* readState(projectId, 'git');
  });

/** Flip the decision-mode switch. Turning it on stamps `enabledAt`; turning it off keeps every record. */
export const setEnabled = (
  cwd: string,
  enabled: boolean,
): Effect.Effect<DecisionProjectState, FSError | ValidationError> =>
  Effect.gen(function* () {
    const project = yield* requireProject(cwd);
    const file = projectStateFile(project.projectId);
    const next = yield* Effect.tryPromise({
      try: () =>
        withFileLock(file, async () => {
          const cur = await readJsonFileForUpdate<ProjectStateFile>(file, {});
          const updated: ProjectStateFile = enabled
            ? { ...cur, enabled: true, enabledAt: cur.enabled ? cur.enabledAt ?? Date.now() : Date.now() }
            : { ...cur, enabled: false };
          await writeJsonFile(file, updated);
          return updated;
        }),
      catch: (cause) => new FSError({ path: file, op: 'write', cause }),
    });
    return {
      projectId: project.projectId,
      kind: project.kind,
      enabled: next.enabled === true,
      ...(typeof next.enabledAt === 'number' ? { enabledAt: next.enabledAt } : {}),
    };
  });
