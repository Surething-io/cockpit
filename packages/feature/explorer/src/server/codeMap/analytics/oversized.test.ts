/**
 * The analytics size guard.
 *
 * Regression cover for a failure that only appears at scale: with
 * `MAX_FILES` raised to 100000, a 809K-symbol index drove the four
 * synchronous analytics passes to 82.8s and a 10.12 GB peak, OOM-killing the
 * server ~4 minutes after the first query. The guard skips them.
 *
 * The two non-obvious properties tested here are the ones that turn a
 * working guard into a broken one:
 *   - `getOrTriggerAnalytics` must not RE-TRIGGER for an oversized index
 *     (it re-triggers by default, which would re-run the 83s passes on every
 *     /context, /related and /risk request).
 *   - the degraded reason must not claim `analytics-warming`, which tells
 *     consumers to retry for a result that will never arrive.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_ANALYTICS_SYMBOLS,
  isAnalyticsOversized,
  analyticsDegradedReason,
  getOrTriggerAnalytics,
  getAnalytics,
  invalidateAnalytics,
} from './cache';
import type { CodeIndex } from '../projectGraph/codeIndex';

/** Minimal CodeIndex stand-in: the guard only reads `cwd` and each file's
 *  `flatSymbols.length`, so a real index (257s to build) is unnecessary. */
function fakeIndex(cwd: string, symbolCount: number): CodeIndex {
  const files = new Map<string, { flatSymbols: unknown[] }>();
  // Spread across files so the count comes from summation, not one array.
  const perFile = 1000;
  let left = symbolCount;
  let i = 0;
  while (left > 0) {
    const n = Math.min(perFile, left);
    files.set(`f${i++}.ts`, { flatSymbols: new Array(n).fill(null) });
    left -= n;
  }
  return { cwd, files } as unknown as CodeIndex;
}

describe('analytics size guard', () => {
  beforeEach(() => invalidateAnalytics());

  it('lets an index at the ceiling through', () => {
    expect(isAnalyticsOversized(fakeIndex('/a', MAX_ANALYTICS_SYMBOLS))).toBe(false);
  });

  it('blocks an index one symbol over the ceiling', () => {
    expect(isAnalyticsOversized(fakeIndex('/b', MAX_ANALYTICS_SYMBOLS + 1))).toBe(true);
  });

  it('does not trigger a precompute for an oversized index', () => {
    const idx = fakeIndex('/c', MAX_ANALYTICS_SYMBOLS + 5000);
    expect(getOrTriggerAnalytics('/c', idx)).toBeNull();
    // The load-bearing assertion: had it triggered, the (synchronous) passes
    // would have populated the cache before this line ran.
    expect(getAnalytics('/c')).toBeNull();
  });

  it('reports a reason that does not invite a retry', () => {
    const big = fakeIndex('/d', MAX_ANALYTICS_SYMBOLS + 1);
    const small = fakeIndex('/e', 10);
    expect(analyticsDegradedReason(big)).toBe('analytics-skipped-oversized');
    expect(analyticsDegradedReason(small)).toBe('analytics-warming');
  });

  it('re-admits an index that shrinks back under the ceiling', () => {
    // refreshFocalFile mutates index.files in place, so the verdict must be
    // recomputed from the live index rather than latched per cwd.
    const idx = fakeIndex('/f', MAX_ANALYTICS_SYMBOLS + 2000);
    expect(isAnalyticsOversized(idx)).toBe(true);
    idx.files.clear();
    expect(isAnalyticsOversized(idx)).toBe(false);
  });

  it('rejects a direct precompute rather than caching an empty entry', async () => {
    const { precomputeAnalytics } = await import('./cache');
    const idx = fakeIndex('/g', MAX_ANALYTICS_SYMBOLS + 1);
    await expect(precomputeAnalytics('/g', idx)).rejects.toThrow(
      'analytics-skipped-oversized',
    );
    // An empty-but-cached entry would be handed to the builders as if real,
    // silently scoring every symbol zero instead of flagging `degraded`.
    expect(getAnalytics('/g')).toBeNull();
  });
});
