/**
 * POST /api/decisions/impact — decision check + impact & gaps (docs/DECISION_MODE.md §6, §7.2).
 */
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { ImpactResult, VerificationRunInput } from '@cockpit/feature-decisions';

export const loadImpact = (
  cwd: string,
  orderedToolIds: ReadonlyArray<string>,
  runs: ReadonlyArray<VerificationRunInput>,
  claimedPass: boolean,
  decisionsOnly = false,
): Effect.Effect<ImpactResult, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch('/api/decisions/impact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, orderedToolIds, runs, claimedPass, decisionsOnly }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ImpactResult;
    },
    catch: (cause) => new AppError({ message: 'POST /api/decisions/impact failed', cause }),
  });
