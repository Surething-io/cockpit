/**
 * Derived decision state and the review-time decision check
 * (docs/DECISION_MODE.md §7.1, §7.2, §10).
 *
 * A decision's links carry the blob ids frozen at accept. The commit that
 * first introduced such a blob is where the decision landed — found by
 * content, so it survives rebase and squash. Ancestry of HEAD then says
 * whether it applies on this branch. Nothing here is stored except a cache
 * of landing commits; a decision is never invalidated automatically.
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import { mutateJsonFile, readJsonFile } from '@cockpit/shared-utils';
import type { Decision, DerivedDecisionState } from '../shared/types';
import { projectDir } from './paths';
import { readGitInfo } from './projectIdentity';

const execFileAsync = promisify(execFile);

interface LandingCache {
  /** blob → first commit that introduced it, or null (not found as of `head`). */
  blobs: Record<string, { commit: string | null; head: string }>;
}

const landingFile = (projectId: string) => join(projectDir(projectId), 'landing.json');

const git = (cwd: string, args: string[]) =>
  execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }).then(
    (r) => ({ ok: true as const, out: r.stdout.trim() }),
    () => ({ ok: false as const, out: '' }),
  );

const exists = (p: string) => stat(p).then(() => true, () => false);

export interface DerivedContext {
  toplevel: string;
  isGit: boolean;
  head: string;
  /** Landing commit per blob (null = not in any commit). */
  landing: Map<string, string | null>;
  /** Commits known to be ancestors of HEAD (memoized per call). */
  ancestors: Map<string, boolean>;
}

/** Landing commits for `blobs`, from cache when still valid. */
const resolveLanding = (projectId: string, toplevel: string, head: string, blobs: string[]): Effect.Effect<Map<string, string | null>> =>
  Effect.promise(async () => {
    const out = new Map<string, string | null>();
    const cache = await readJsonFile<LandingCache>(landingFile(projectId), { blobs: {} });
    const fresh: LandingCache['blobs'] = {};
    for (const blob of blobs) {
      const hit = cache.blobs?.[blob];
      // A found commit never changes; "not found" is only trusted for the same HEAD.
      if (hit && (hit.commit || hit.head === head)) {
        out.set(blob, hit.commit);
        continue;
      }
      const r = await git(toplevel, ['log', '--all', '--reverse', '--format=%H', `--find-object=${blob}`]);
      const commit = r.ok ? r.out.split('\n').find(Boolean) ?? null : null;
      out.set(blob, commit);
      fresh[blob] = { commit, head };
    }
    if (Object.keys(fresh).length > 0) {
      await mutateJsonFile<LandingCache>(landingFile(projectId), { blobs: {} }, (cur) => ({ blobs: { ...cur.blobs, ...fresh } })).catch(() => undefined);
    }
    return out;
  });

export const derivedContext = (projectId: string, cwd: string, decisions: readonly Decision[]): Effect.Effect<DerivedContext> =>
  Effect.gen(function* () {
    const info = yield* readGitInfo(cwd);
    if (!info) return { toplevel: cwd, isGit: false, head: '', landing: new Map(), ancestors: new Map() };
    const head = (yield* Effect.promise(() => git(info.toplevel, ['rev-parse', 'HEAD']))).out;
    const blobs = [...new Set(decisions.flatMap((d) => d.links.map((l) => l.blob).filter((b): b is string => !!b)))];
    const landing = yield* resolveLanding(projectId, info.toplevel, head, blobs);
    return { toplevel: info.toplevel, isGit: true, head, landing, ancestors: new Map() };
  });

const isAncestor = async (ctx: DerivedContext, commit: string): Promise<boolean> => {
  const known = ctx.ancestors.get(commit);
  if (known !== undefined) return known;
  const r = await git(ctx.toplevel, ['merge-base', '--is-ancestor', commit, 'HEAD']);
  ctx.ancestors.set(commit, r.ok);
  return r.ok;
};

/** The state of one decision. Pure apart from git / fs reads. */
export const deriveState = (d: Decision, ctx: DerivedContext): Effect.Effect<DerivedDecisionState> =>
  Effect.promise(async () => {
    if (d.status === 'superseded' || d.status === 'retired') return d.status;
    if (d.links.length > 0) {
      const present = await Promise.all(d.links.map((l) => exists(join(ctx.toplevel, l.path))));
      if (!present.some(Boolean)) return 'link-lost';
    }
    const blobs = d.links.map((l) => l.blob).filter((b): b is string => !!b);
    if (!ctx.isGit || blobs.length === 0) return 'applicable';
    const commits = blobs.map((b) => ctx.landing.get(b)).filter((c): c is string => !!c);
    if (commits.length === 0) return 'not-landed';
    for (const c of commits) if (await isAncestor(ctx, c)) return 'applicable';
    return 'other-branch';
  });

export interface TouchedDecision {
  decision: Decision;
  state: DerivedDecisionState;
  /** direct: the task changed a linked file; neighbor: it changed a direct caller / callee of one. */
  reason: 'direct' | 'neighbor';
  /** Linked paths the change hit. */
  paths: string[];
}

/**
 * Active decisions whose linked files this task changed (`changed`) or whose
 * files are one hop away in the call graph (`neighbors`). Paths are relative
 * to the git toplevel. Decisions living only on another branch are left out;
 * a decision whose file the task deleted is still touched (that is the point).
 */
export const findTouched = (
  projectId: string,
  cwd: string,
  decisions: readonly Decision[],
  changed: ReadonlySet<string>,
  neighbors: ReadonlySet<string>,
): Effect.Effect<TouchedDecision[]> =>
  Effect.gen(function* () {
    const candidates = decisions.filter(
      (d) => d.status === 'active' && d.links.some((l) => changed.has(l.path) || neighbors.has(l.path)),
    );
    if (candidates.length === 0) return [];
    const ctx = yield* derivedContext(projectId, cwd, candidates);
    const out: TouchedDecision[] = [];
    for (const d of candidates) {
      const state = yield* deriveState(d, ctx);
      if (state === 'other-branch') continue;
      const direct = d.links.filter((l) => changed.has(l.path)).map((l) => l.path);
      out.push(
        direct.length > 0
          ? { decision: d, state, reason: 'direct', paths: direct }
          : { decision: d, state, reason: 'neighbor', paths: d.links.filter((l) => neighbors.has(l.path)).map((l) => l.path) },
      );
    }
    // Direct first; within each, decisions last marked "unrelated" go last.
    const rank = (t: TouchedDecision) => (t.reason === 'direct' ? 0 : 2) + (t.decision.lastReview?.verdict === 'unrelated' ? 1 : 0);
    return out.sort((a, b) => rank(a) - rank(b));
  });
