/**
 * Decision-mode extraction IO (docs/DECISION_MODE.md §9). The handler lives in
 * this feature (server/api/decisions-extraction.ts), so the client does too.
 */
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { ExtractionEngine, ExtractionMessage, ExtractionResult, VerificationRunInput } from '@cockpit/feature-decisions';

export interface ExtractionCall {
  cwd: string;
  sessionId: string;
  engine: ExtractionEngine;
  model: string;
  messages: ExtractionMessage[];
  orderedToolIds: string[];
  runs: VerificationRunInput[];
  claimedPass: boolean;
}

export const loadExtraction = (call: ExtractionCall): Effect.Effect<ExtractionResult, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch('/api/decisions/extraction', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(call),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return (await res.json()) as ExtractionResult;
    },
    catch: (cause) => new AppError({ message: 'POST /api/decisions/extraction failed', cause }),
  });

/** Model ids an engine offers, for the picker's suggestions. Failure → none (free text still works). */
export const loadModelIds = (engine: ExtractionEngine): Effect.Effect<string[]> =>
  Effect.tryPromise(async () => {
    if (engine === 'claude' || engine === 'codex') return [];
    const res = await fetch(`/api/${engine}/models`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ id?: string; name?: string }> };
    return (data.models ?? []).map((m) => m.id ?? m.name ?? '').filter(Boolean);
  }).pipe(Effect.orElseSucceed(() => [] as string[]));
