/**
 * /api/kimi/usage
 *
 * Remaining Kimi Code quota, from GET /coding/v1/usages — the endpoint the Kimi
 * CLI's own `/usage` command calls. It is NOT in the published API docs, so treat
 * its shape as unstable: everything below is optional-chained and the button
 * degrades to a console link when this route errors.
 *
 * Kimi Code is a subscription, not a prepaid balance (contrast ../deepseek/balance):
 * quota refreshes on a 7-day cycle and is additionally capped by a rolling 5-hour
 * window, so this returns a LIST of windows rather than one number. Values arrive
 * as strings and windows as `{duration: 300, timeUnit: 'TIME_UNIT_MINUTE'}` — both
 * are normalised here so the client renders plain numbers and '5h'.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { AgentError } from '@cockpit/effect-core';
import { kimiApiKey } from '../../engines/credentials';
import { KIMI_OPENAI_BASE_URL } from '../../engines/kimi';
import { agentErrorKind, getJsonWithKey } from '../engineHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USAGE_URL = `${KIMI_OPENAI_BASE_URL}/usages`;

interface RawDetail {
  limit?: string;
  remaining?: string;
  resetTime?: string;
}

interface RawUsage {
  user?: { membership?: { level?: string } };
  usage?: RawDetail;
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: RawDetail }>;
}

export interface KimiQuotaWindow {
  /** 'plan' for the subscription cycle, else a duration like '5h'. */
  label: string;
  limit: number | null;
  remaining: number | null;
  /** ISO timestamp, or null when the provider omits it. */
  resetTime: string | null;
}

export interface KimiUsagePayload {
  /** Membership tier with the wire prefix stripped, e.g. LEVEL_TRIAL → 'TRIAL'. */
  membership: string;
  windows: KimiQuotaWindow[];
}

const toNumber = (v: string | undefined): number | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `{duration: 300, timeUnit: 'TIME_UNIT_MINUTE'}` → '5h'. */
function windowLabel(w: { duration?: number; timeUnit?: string } | undefined): string {
  const duration = w?.duration;
  if (typeof duration !== 'number' || duration <= 0) return 'window';
  const perUnitMinutes: Record<string, number> = {
    TIME_UNIT_SECOND: 1 / 60,
    TIME_UNIT_MINUTE: 1,
    TIME_UNIT_HOUR: 60,
    TIME_UNIT_DAY: 1440,
  };
  const minutes = duration * (perUnitMinutes[w?.timeUnit ?? ''] ?? 1);
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

const toWindow = (label: string, d: RawDetail | undefined): KimiQuotaWindow => ({
  label,
  limit: toNumber(d?.limit),
  remaining: toNumber(d?.remaining),
  resetTime: d?.resetTime ?? null,
});

async function fetchUsage(): Promise<KimiUsagePayload> {
  const data = await getJsonWithKey<RawUsage>({
    url: USAGE_URL,
    store: kimiApiKey,
    label: 'Kimi',
  });
  return {
    membership: (data.user?.membership?.level ?? '').replace(/^LEVEL_/, ''),
    windows: [
      toWindow('plan', data.usage),
      ...(data.limits || []).map((l) => toWindow(windowLabel(l.window), l.detail)),
    ],
  };
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => fetchUsage(),
      catch: (cause) => new AgentError({ provider: 'kimi', kind: agentErrorKind(cause), cause }),
    });
    return ok(payload);
  })
);
