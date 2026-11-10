/**
 * Client-side decision-mode IO — Effect wrappers around /api/decisions*.
 */
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { DecisionProjectResolution } from '../../shared/types';
import type { AcceptedTask, AcceptedTaskSummary, ReviewResult, ReviewTurn } from '../../shared/review';

const httpJson = <A>(url: string, init?: RequestInit): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      return (await res.json()) as A;
    },
    catch: (cause) => new AppError({ message: `${init?.method ?? 'GET'} ${url} failed`, cause }),
  });

const postJson = <A>(url: string, body: unknown): Effect.Effect<A, AppError> =>
  httpJson<A>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const loadDecisionProject = (cwd: string): Effect.Effect<DecisionProjectResolution, AppError> =>
  httpJson(`/api/decisions/project?cwd=${encodeURIComponent(cwd)}`);

export const setDecisionMode = (cwd: string, enabled: boolean): Effect.Effect<DecisionProjectResolution, AppError> =>
  postJson('/api/decisions/project', { cwd, enabled });

/** Settle an ambiguous checkout: join `projectId`, or `'new'` for a separate project. */
export const bindDecisionProject = (cwd: string, choice: string): Effect.Effect<DecisionProjectResolution, AppError> =>
  postJson('/api/decisions/project', { cwd, bind: choice });

export const decisionsExportUrl = (cwd: string): string => `/api/decisions/export?cwd=${encodeURIComponent(cwd)}`;

// ─────────────────────────────────────────────────────────
// Task review (docs/DECISION_MODE.md §3–§4)
// ─────────────────────────────────────────────────────────

/** Deterministic review of the range spanned by `toolIds`; `summary` omits file contents. */
export const loadReview = (cwd: string, toolIds: ReadonlyArray<string>, summary: boolean): Effect.Effect<ReviewResult, AppError> =>
  postJson('/api/decisions/review', { cwd, toolIds, summary });

export const loadSessionTasks = (cwd: string, sessionId: string): Effect.Effect<{ tasks: AcceptedTaskSummary[] }, AppError> =>
  httpJson(`/api/decisions/tasks?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`);

export const loadAcceptedTask = (cwd: string, id: string): Effect.Effect<{ task: AcceptedTask }, AppError> =>
  httpJson(`/api/decisions/tasks?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`);

export const acceptReview = (
  cwd: string,
  sessionId: string,
  goal: string,
  turns: ReadonlyArray<ReviewTurn>,
): Effect.Effect<{ task: AcceptedTask }, AppError> => postJson('/api/decisions/tasks', { cwd, sessionId, goal, turns });

/** Correct check detection for one command in this project (§5). */
export const setCheckOverride = (cwd: string, command: string, isCheck: boolean): Effect.Effect<{ include: string[]; exclude: string[] }, AppError> =>
  postJson('/api/decisions/checks', { cwd, command, isCheck });
