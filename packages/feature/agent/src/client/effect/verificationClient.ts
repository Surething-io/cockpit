/**
 * POST /api/decisions/verification — decision-mode verification of a review
 * range (docs/DECISION_MODE.md §5). Handler lives in this feature
 * (server/api/decisions-verification.ts), so the client does too.
 */
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { VerificationResult, VerificationRunInput } from '@cockpit/feature-decisions';

export const loadVerification = (
  cwd: string,
  orderedToolIds: ReadonlyArray<string>,
  runs: ReadonlyArray<VerificationRunInput>,
  claimedPass: boolean,
): Effect.Effect<VerificationResult, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch('/api/decisions/verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, orderedToolIds, runs, claimedPass }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as VerificationResult;
    },
    catch: (cause) => new AppError({ message: 'POST /api/decisions/verification failed', cause }),
  });
