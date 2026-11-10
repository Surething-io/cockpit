/**
 * Accepted tasks — one immutable JSON file per accepted review under
 * <COCKPIT_DIR>/decisions/<projectId>/tasks/<taskId>.json (§3, §4.4).
 *
 * Accepting freezes the range and the content fingerprints (blob ids) of the
 * task's files, so later steps can find where the change landed and whether a
 * check ran against this exact content. The server recomputes the review on
 * accept rather than trusting what the client displayed.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import { FSError, NotFoundError, ValidationError, type AppError } from '@cockpit/effect-core';
import { SnapshotService } from '@cockpit/effect-services';
import type { AcceptedTask, AcceptedTaskFile, AcceptedTaskSummary, ReviewTurn } from '../shared/review';
import type { Decision, DecisionContent, DecisionSource } from '../shared/types';
import { createDecision, listDecisions, parseContent, parseSource, recordReview } from './store';
import { findTouched } from './derived';
import { projectDir } from './paths';
import { readGitInfo } from './projectIdentity';
import { computeReview, TASK_CATEGORIES, toToplevelPath } from './review';

const execFileAsync = promisify(execFile);

const tasksDir = (projectId: string): string => join(projectDir(projectId), 'tasks');
const TASK_ID = /^task-[a-z0-9]+-[a-z0-9]+$/;
const taskFile = (projectId: string, id: string): string => join(tasksDir(projectId), `${id}.json`);

const projectHead = (cwd: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise(() => execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).pipe(
    Effect.map((r) => r.stdout.trim() || undefined),
    Effect.orElseSucceed(() => undefined),
  );

const isTask = (v: unknown): v is AcceptedTask =>
  typeof v === 'object' && v !== null && typeof (v as AcceptedTask).id === 'string' && Array.isArray((v as AcceptedTask).toolIds);

const readTaskFile = (file: string): Effect.Effect<AcceptedTask | null> =>
  Effect.tryPromise(() => readFile(file, 'utf8')).pipe(
    Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw) as unknown)),
    Effect.map((v) => (isTask(v) ? v : null)),
    Effect.orElseSucceed(() => null),
  );

const allTasks = (projectId: string): Effect.Effect<AcceptedTask[]> =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise(() => readdir(tasksDir(projectId))).pipe(Effect.orElseSucceed(() => [] as string[]));
    const tasks = yield* Effect.forEach(
      names.filter((n) => n.endsWith('.json')),
      (n) => readTaskFile(join(tasksDir(projectId), n)),
      { concurrency: 16 },
    );
    return tasks.filter((t): t is AcceptedTask => t !== null).sort((a, b) => b.acceptedAt - a.acceptedAt);
  });

/** Accepted tasks of one session, newest first. */
export const listSessionTasks = (projectId: string, sessionId: string): Effect.Effect<AcceptedTaskSummary[]> =>
  allTasks(projectId).pipe(
    Effect.map((ts) =>
      ts
        .filter((t) => t.sessionId === sessionId)
        .map(({ id, acceptedAt, goal, toolIds, turns, files }) => ({ id, acceptedAt, goal, toolIds, turns, fileCount: files.length })),
    ),
  );

export const readTask = (projectId: string, id: string): Effect.Effect<AcceptedTask, NotFoundError | ValidationError> =>
  Effect.gen(function* () {
    if (!TASK_ID.test(id)) return yield* Effect.fail(new ValidationError({ field: 'id', reason: 'malformed' }));
    const t = yield* readTaskFile(taskFile(projectId, id));
    return t ?? (yield* Effect.fail(new NotFoundError({ resource: 'task', id })));
  });

/** A decision the user kept in the review (candidate or typed by hand). */
export interface KeptDecision {
  content: DecisionContent;
  source: DecisionSource;
  /** cwd-relative paths of task files the decision is about. */
  files: string[];
}

/** The user's answer for one existing decision the change touched (§4.4, §7.2). */
export type DecisionVerdict =
  | { decisionId: string; verdict: 'holds' | 'unrelated' }
  | { decisionId: string; verdict: 'superseded'; replacement: DecisionContent };

export interface AcceptInput {
  cwd: string;
  sessionId: string;
  goal: string;
  turns: ReviewTurn[];
  decisions?: KeptDecision[];
  verdicts?: DecisionVerdict[];
}

/** Recompute the review for the given turns and freeze it. */
export const acceptTask = (
  projectId: string,
  input: AcceptInput,
): Effect.Effect<{ task: AcceptedTask; decisions: Decision[] }, AppError | FSError | NotFoundError | ValidationError, SnapshotService> =>
  Effect.gen(function* () {
    const toolIds = [...new Set(input.turns.flatMap((t) => t.toolIds))];
    const review = yield* computeReview(input.cwd, toolIds, false);
    if (review.empty) return yield* Effect.fail(new ValidationError({ field: 'turns', reason: 'no file changes in the selected turns' }));

    const info = yield* readGitInfo(input.cwd);
    // git reports the toplevel through realpath (macOS: /var → /private/var), so
    // the cwd must be resolved the same way or every relative path climbs out.
    const realCwd = yield* Effect.promise(() => realpath(input.cwd).catch(() => input.cwd));
    const toplevel = info?.toplevel ?? realCwd;
    const kept = review.files.filter((f) => TASK_CATEGORIES.has(f.category));
    const blobs = yield* (yield* SnapshotService).blobIds(
      input.cwd,
      review.head,
      kept.filter((f) => f.status !== 'deleted').map((f) => f.path),
    );
    const files: AcceptedTaskFile[] = kept.map((f) => ({
      path: toToplevelPath(toplevel, realCwd, f.path),
      category: f.category as AcceptedTaskFile['category'],
      status: f.status,
      ...(blobs.get(f.path) ? { blob: blobs.get(f.path) } : {}),
    }));
    const head = info ? yield* projectHead(input.cwd) : undefined;

    // Every existing decision whose files this task changed must have an answer
    // before anything is written — the safety net is not skippable (§4.4).
    // (Neighbor-only touches are enforced by the review UI; they need the code index.)
    const verdicts = new Map((input.verdicts ?? []).map((v) => [v.decisionId, v]));
    const existing = yield* listDecisions(projectId);
    const touched = yield* findTouched(projectId, input.cwd, existing, new Set(files.map((f) => f.path)), new Set());
    const unanswered = touched.filter((t) => t.reason === 'direct' && !verdicts.has(t.decision.id));
    if (unanswered.length > 0) {
      return yield* Effect.fail(new ValidationError({ field: 'verdicts', reason: `missing for ${unanswered.map((t) => t.decision.id).join(', ')}` }));
    }
    const known = new Map(existing.map((d) => [d.id, d]));
    for (const v of verdicts.values()) {
      if (!known.has(v.decisionId)) return yield* Effect.fail(new NotFoundError({ resource: 'decision', id: v.decisionId }));
    }

    const task: AcceptedTask = {
      id: `task-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      sessionId: input.sessionId,
      cwd: input.cwd,
      acceptedAt: Date.now(),
      goal: input.goal,
      turns: input.turns.map(({ id, at, text }) => ({ id, ...(at ? { at } : {}), text })),
      toolIds,
      snapshot: { base: review.base, head: review.head },
      ...(head ? { projectHead: head } : {}),
      files,
      otherSessionFiles: review.files.filter((f) => f.category === 'other-session').map((f) => toToplevelPath(toplevel, realCwd, f.path)),
    };
    const file = taskFile(projectId, task.id);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(tasksDir(projectId), { recursive: true, mode: 0o700 });
        // 'wx': an accepted task is written exactly once.
        await writeFile(file, JSON.stringify(task, null, 2), { mode: 0o600, flag: 'wx' });
      },
      catch: (cause) => new FSError({ path: file, op: 'write', cause }),
    });

    // Decisions are written after the task exists, so each can point at it. Links use
    // the task's toplevel-relative paths and the blobs frozen just above.
    const byCwdPath = new Map(kept.map((f, i) => [f.path, files[i]]));
    const decisions = yield* Effect.forEach(input.decisions ?? [], (d) =>
      createDecision(projectId, {
        content: d.content,
        source: d.source,
        links: d.files
          .map((p) => byCwdPath.get(p))
          .filter((f): f is AcceptedTaskFile => !!f)
          .map((f) => ({ path: f.path, ...(f.blob ? { blob: f.blob } : {}) })),
        origin: { sessionId: input.sessionId, taskId: task.id, ...(head ? { head } : {}) },
      }),
    );

    // Verdicts: a review entry for holds / unrelated; a replacement decision for superseded
    // (createDecision marks the old one superseded and links both ways).
    const replacements: Decision[] = [];
    for (const v of verdicts.values()) {
      if (v.verdict === 'superseded') {
        const old = known.get(v.decisionId)!;
        replacements.push(
          yield* createDecision(projectId, {
            content: v.replacement,
            source: { kind: 'manual' },
            links: old.links.map((l) => {
              const now = files.find((f) => f.path === l.path);
              return { path: l.path, ...(l.symbol ? { symbol: l.symbol } : {}), ...(now?.blob ? { blob: now.blob } : {}) };
            }),
            origin: { sessionId: input.sessionId, taskId: task.id, ...(head ? { head } : {}) },
            supersedes: v.decisionId,
          }),
        );
      } else {
        yield* recordReview(projectId, v.decisionId, task.id, v.verdict);
      }
    }
    return { task, decisions: [...decisions, ...replacements] };
  });

/** Validate verdicts from a request body. */
export function parseVerdicts(raw: unknown): DecisionVerdict[] | ValidationError {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 500) return new ValidationError({ field: 'verdicts', reason: 'must be an array' });
  const out: DecisionVerdict[] = [];
  for (const v of raw as Array<Record<string, unknown>>) {
    if (!v || typeof v.decisionId !== 'string') return new ValidationError({ field: 'verdicts.decisionId', reason: 'missing' });
    if (v.verdict === 'holds' || v.verdict === 'unrelated') out.push({ decisionId: v.decisionId, verdict: v.verdict });
    else if (v.verdict === 'superseded') {
      const replacement = parseContent(v.replacement, false);
      if (replacement instanceof ValidationError) return replacement;
      out.push({ decisionId: v.decisionId, verdict: 'superseded', replacement });
    } else return new ValidationError({ field: 'verdicts.verdict', reason: 'holds | unrelated | superseded' });
  }
  return out;
}

/** Validate kept decisions from a request body. */
export function parseKeptDecisions(raw: unknown): KeptDecision[] | ValidationError {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return new ValidationError({ field: 'decisions', reason: 'must be an array (max 100)' });
  const out: KeptDecision[] = [];
  for (const d of raw as Array<Record<string, unknown>>) {
    const content = parseContent(d?.content, false);
    if (content instanceof ValidationError) return content;
    const source = parseSource(d?.source);
    if (source instanceof ValidationError) return source;
    const files = Array.isArray(d?.files) ? d.files.filter((x): x is string => typeof x === 'string') : [];
    out.push({ content, source, files });
  }
  return out;
}

/** Validate untrusted turns from a request body. */
export function parseTurns(raw: unknown): ReviewTurn[] | ValidationError {
  if (!Array.isArray(raw) || raw.length === 0) return new ValidationError({ field: 'turns', reason: 'must be a non-empty array' });
  const out: ReviewTurn[] = [];
  for (const t of raw) {
    const r = t as Partial<ReviewTurn> | null;
    if (!r || typeof r.id !== 'string' || !Array.isArray(r.toolIds) || !r.toolIds.every((x) => typeof x === 'string')) {
      return new ValidationError({ field: 'turns', reason: 'each turn needs id and toolIds' });
    }
    out.push({ id: r.id, toolIds: r.toolIds, text: typeof r.text === 'string' ? r.text.slice(0, 200) : '', ...(typeof r.at === 'string' ? { at: r.at } : {}) });
  }
  return out;
}
