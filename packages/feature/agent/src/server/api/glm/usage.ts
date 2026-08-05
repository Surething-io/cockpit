/**
 * /api/glm/usage
 *
 * Remaining GLM Coding Plan allowance, from GET /api/monitor/usage/quota/limit —
 * undocumented, and what the community quota tools call. Normalised into the shared
 * EngineQuotaPayload (see ../engineQuota).
 *
 * Two traps live in this response, both verified by diffing it across one chat call:
 *
 * 1. The field names read backwards. `usage` is the LIMIT (2000), `remaining` is what
 *    actually decrements, and `currentValue` stays 0 — it is NOT the consumed amount,
 *    so never compute remaining from it.
 * 2. A window is `{unit, number}`, e.g. `{unit: 3, number: 5}`. The units are opaque
 *    integers; 3 = hour and 6 = week are confirmed by comparing nextResetTime against
 *    the clock (4.99h and 168h out). Anything else falls back to a neutral label rather
 *    than guessing — a wrong unit would misreport when the user's quota comes back.
 *
 * Also note `nextResetTime` is absent on the rolling window until the first request of
 * a cycle, and an account with no Coding Plan gets HTTP 200 with
 * `{code: 500, msg: '当前用户不存在coding plan'}` — a normal state for a pay-as-you-go
 * key, reported as an error so the button can degrade to the console link.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { AgentError } from '@cockpit/effect-core';
import { glmApiKey } from '../../engines/credentials';
import { readEngineEndpoints } from '../../engines/anthropicCompat';
import { glmProvider } from '../../engines/glm';
import { agentErrorKind, getJsonWithKey } from '../engineHttp';
import type { EngineQuotaPayload, EngineQuotaWindow } from '../engineQuota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RawLimit {
  type?: string;
  /** Opaque time-unit enum; 3 = hour, 6 = week (confirmed against nextResetTime). */
  unit?: number;
  /** How many of `unit` the window spans. */
  number?: number;
  /** The CAP, despite the name. */
  usage?: number;
  remaining?: number;
  /** Always 0 in practice — do not use. */
  currentValue?: number;
  percentage?: number;
  /** Epoch milliseconds. Absent until the window's first request. */
  nextResetTime?: number;
}

export interface RawQuota {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: { level?: string; limits?: RawLimit[] };
}

const UNIT_SUFFIX: Record<number, string> = { 3: 'h', 6: 'w' };

/** `{unit: 3, number: 5}` → '5h'. Unknown units get a neutral label, never a guess. */
function windowLabel(l: RawLimit): string {
  const suffix = typeof l.unit === 'number' ? UNIT_SUFFIX[l.unit] : undefined;
  if (!suffix || typeof l.number !== 'number') return 'quota';
  return `${l.number}${suffix}`;
}

const toWindow = (l: RawLimit): EngineQuotaWindow => ({
  label: windowLabel(l),
  limit: typeof l.usage === 'number' ? l.usage : null,
  remaining: typeof l.remaining === 'number' ? l.remaining : null,
  resetTime: typeof l.nextResetTime === 'number' ? new Date(l.nextResetTime).toISOString() : null,
});

/**
 * Pure mapper, exported for tests — the two traps above are exactly the kind of thing a
 * later reader "fixes" into `usage - currentValue`, and only a test says otherwise.
 * Throws on the in-body error codes, which arrive with HTTP 200.
 */
export function toQuotaPayload(data: RawQuota): EngineQuotaPayload {
  // Errors arrive as HTTP 200 with a code in the body — the most common being an account
  // that simply has no Coding Plan.
  if (data.success === false || (data.code && data.code !== 200)) {
    throw new Error(data.msg || `Quota query failed (${data.code})`);
  }
  return {
    tier: data.data?.level ?? '',
    windows: (data.data?.limits || []).map(toWindow),
  };
}

async function fetchQuota(): Promise<EngineQuotaPayload> {
  const { openAiBaseUrl } = await readEngineEndpoints(glmProvider);
  // The quota endpoint hangs off the host root, not the /coding/paas/v4 API prefix.
  const host = new URL(openAiBaseUrl).origin;
  return toQuotaPayload(
    await getJsonWithKey<RawQuota>({
      url: `${host}/api/monitor/usage/quota/limit`,
      store: glmApiKey,
      label: 'GLM',
    })
  );
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => fetchQuota(),
      catch: (cause) => new AgentError({ provider: 'glm', kind: agentErrorKind(cause), cause }),
    });
    return ok(payload);
  })
);
