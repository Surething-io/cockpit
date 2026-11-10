/**
 * Client-side decision-mode IO — Effect wrappers around /api/decisions*.
 */
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { DecisionProjectResolution } from '../../shared/types';

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
