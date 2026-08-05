/**
 * Shared payload for the subscription engines' remaining-allowance endpoints
 * (/api/kimi/usage, /api/glm/usage).
 *
 * Both providers sell a plan rather than credit, and both report the SAME idea in
 * different words: an allowance measured against more than one time window at once
 * (a plan cycle plus a rolling short window), each with its own remaining/limit and
 * reset time. Normalising here means one client component renders both.
 *
 * Deliberately NOT unified with /api/deepseek/balance: that one is a prepaid
 * balance in currency, which has no windows and no reset — folding the two together
 * would produce a shape that describes neither.
 *
 * Both upstream endpoints are undocumented (they are what the vendors' own CLIs
 * call), so every field is optional-chained at the mapping site and the UI degrades
 * to a console link when a route errors.
 */

export interface EngineQuotaWindow {
  /** 'plan' for the subscription cycle, else a duration like '5h' / '1w'. */
  label: string;
  limit: number | null;
  remaining: number | null;
  /** ISO timestamp, or null — a rolling window may not have started yet. */
  resetTime: string | null;
}

export interface EngineQuotaPayload {
  /** Plan/membership tier as the provider names it, e.g. 'TRIAL', 'lite'. May be ''. */
  tier: string;
  windows: EngineQuotaWindow[];
}
