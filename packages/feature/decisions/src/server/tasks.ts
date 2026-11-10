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

export interface AcceptInput {
  cwd: string;
  sessionId: string;
  goal: string;
  turns: ReviewTurn[];
}

/** Recompute the review for the given turns and freeze it. */
export const acceptTask = (
  projectId: string,
  input: AcceptInput,
): Effect.Effect<AcceptedTask, AppError | FSError | NotFoundError | ValidationError, SnapshotService> =>
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
    return task;
  });

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
