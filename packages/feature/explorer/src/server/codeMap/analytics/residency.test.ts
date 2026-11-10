/**
 * Analytics lifecycle against the shared Code Map budget.
 *
 * Two regressions pinned here, both from a production OOM where two ~149K-node
 * analytics entries held 2.5 GB:
 *   - precompute left its finished Promise in an in-flight table, so a rebuild
 *     for a new index (the "refresh project graph" path) got the OLD entry;
 *   - analytics were invisible to the index budget, so they never got evicted.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ANALYTICS_OVER_BUDGET,
  analyticsDegradedReason,
  getAnalytics,
  getOrTriggerAnalytics,
  invalidateAnalytics,
  precomputeAnalytics,
} from './cache';
import {
  ANALYTICS_SYMBOLS_PER_NODE,
  MAX_CACHED_SYMBOLS,
  codeMapBudgetForHeap,
  __indexCacheTesting as T,
} from '../projectGraph/codeIndex';
import type { CodeIndex } from '../projectGraph/codeIndex';

/** A real-enough index: buildAnalyticsGraph reads symbols, calls and imports. */
function smallIndex(cwd: string, names: string[]): CodeIndex {
  const flatSymbols = names.map((name, i) => ({
    name, qualifiedName: name, kind: 'function', startLine: i * 10, endLine: i * 10 + 5,
  }));
  const files = new Map([['src/app.ts', {
    flatSymbols, intraCalls: [], outgoingCalls: [], incomingCalls: [], importedFiles: [],
  }]]);
  return { cwd, files } as unknown as CodeIndex;
}

/** Only the symbol count matters to the budget. */
function sizedIndex(cwd: string, symbols: number): CodeIndex {
  const files = new Map<string, { flatSymbols: unknown[] }>();
  for (let left = symbols, i = 0; left > 0; left -= 1000, i++) {
    files.set(`f${i}.ts`, { flatSymbols: new Array(Math.min(1000, left)).fill(null) });
  }
  return { cwd, files } as unknown as CodeIndex;
}

describe('analytics residency', () => {
  beforeEach(() => {
    invalidateAnalytics();
    T.clear();
  });

  it('rebuilds for a new index instead of returning the previous entry', async () => {
    const first = await precomputeAnalytics('/p', smallIndex('/p', ['alpha']));
    const second = await precomputeAnalytics('/p', smallIndex('/p', ['alpha', 'beta']));
    expect(second).not.toBe(first);
    expect(getAnalytics('/p')).toBe(second);
    expect([...second.graph.nodes.values()].some((n) => n.name === 'beta')).toBe(true);
  });

  it('is counted by the shared budget and dropped before any index', async () => {
    // /old's analytics alone (3 nodes × weight) cannot matter; make its index
    // big enough that index + analytics + the newcomer cross the budget.
    const big = Math.floor(MAX_CACHED_SYMBOLS * 0.45);
    T.seed('/old', sizedIndex('/old', big));
    await precomputeAnalytics('/old', smallIndex('/old', ['a', 'b']));
    expect(getAnalytics('/old')).not.toBeNull();

    // /old's analytics (3 nodes) are the only thing over budget: dropping
    // them suffices, so its index (the expensive one to rebuild) must stay.
    T.seed('/new', sizedIndex('/new', big));
    T.evict('/new', MAX_CACHED_SYMBOLS - 2 * big);
    expect(getAnalytics('/old')).toBeNull();
    expect(T.has('/old')).toBe(true);
  });

  it('charges each analytics node at ANALYTICS_SYMBOLS_PER_NODE', async () => {
    expect(ANALYTICS_SYMBOLS_PER_NODE).toBeGreaterThan(1);
    // Exactly at budget once /x's analytics (2 symbols + 1 file node) count.
    const nodes = 3;
    T.seed('/x', sizedIndex('/x', MAX_CACHED_SYMBOLS - nodes * ANALYTICS_SYMBOLS_PER_NODE));
    await precomputeAnalytics('/x', smallIndex('/x', ['a', 'b']));
    T.seed('/y', sizedIndex('/y', 0));
    T.evict('/y');
    expect(getAnalytics('/x')).not.toBeNull();
    T.evict('/y', 1);
    expect(getAnalytics('/x')).toBeNull();
  });
});

/**
 * Two projects whose analytics cannot both fit. /a: 2 symbols + 1 file node
 * = 3 nodes = 9 symbol-equivalents; /b reserves 2 symbols × 3 = 6. With /a's
 * index at MAX - 12, /a fits alone (MAX - 3) and /b only fits once /a's
 * analytics go (MAX + 3 → MAX - 6).
 */
describe('analytics admission without thrashing', () => {
  const crowd = async () => {
    T.seed('/a', sizedIndex('/a', MAX_CACHED_SYMBOLS - 12));
    await precomputeAnalytics('/a', smallIndex('/a', ['a1', 'a2']));
    expect(getAnalytics('/a')).not.toBeNull();
  };
  const idle = (cwd: string) => { getAnalytics(cwd)!.lastUsedAt = 0; };

  beforeEach(() => {
    invalidateAnalytics();
    T.clear();
  });

  it('refuses a newcomer instead of evicting analytics in use', async () => {
    await crowd();
    await expect(precomputeAnalytics('/b', smallIndex('/b', ['b1', 'b2']))).rejects.toThrow(ANALYTICS_OVER_BUDGET);
    expect(getAnalytics('/a')).not.toBeNull();
    expect(getAnalytics('/b')).toBeNull();
    expect(analyticsDegradedReason(smallIndex('/b', ['b1', 'b2']))).toBe('analytics-over-budget');
  });

  it('keeps refusing on every request without touching the incumbent', async () => {
    await crowd();
    for (let i = 0; i < 3; i++) {
      expect(getOrTriggerAnalytics('/b', smallIndex('/b', ['b1', 'b2']))).toBeNull();
      await Promise.resolve();
    }
    expect(getAnalytics('/a')).not.toBeNull();
  });

  it('takes the memory of a project nobody has used recently', async () => {
    await crowd();
    idle('/a');
    const entry = await precomputeAnalytics('/b', smallIndex('/b', ['b1', 'b2']));
    expect(getAnalytics('/b')).toBe(entry);
    expect(getAnalytics('/a')).toBeNull();
    // Its index is untouched: analytics never cost an index its place.
    expect(T.has('/a')).toBe(true);
    expect(analyticsDegradedReason(smallIndex('/b', ['b1', 'b2']))).toBe('analytics-warming');
  });

  it('drops nothing when even idle analytics could not make room', async () => {
    // /a's index alone overflows once /b's reserve is added; dropping /a's
    // analytics would not help, so they must survive the refusal.
    T.seed('/a', sizedIndex('/a', MAX_CACHED_SYMBOLS - 9));
    await precomputeAnalytics('/a', smallIndex('/a', ['a1', 'a2']));
    idle('/a');
    T.seed('/a', sizedIndex('/a', MAX_CACHED_SYMBOLS));
    await expect(precomputeAnalytics('/b', smallIndex('/b', ['b1', 'b2']))).rejects.toThrow(ANALYTICS_OVER_BUDGET);
    expect(getAnalytics('/a')).not.toBeNull();
  });
});

describe('codeMapBudgetForHeap', () => {
  const GB = 1024 ** 3;
  it('is about the original 1M symbols at Node\'s default heap', () => {
    const n = codeMapBudgetForHeap(4.2 * GB);
    expect(n).toBeGreaterThan(900_000);
    expect(n).toBeLessThan(1_100_000);
  });
  it('grows with a raised heap', () => {
    expect(codeMapBudgetForHeap(16 * GB)).toBeGreaterThan(4 * codeMapBudgetForHeap(4.2 * GB) * 0.9);
  });
  it('never drops below the floor on a tiny heap', () => {
    expect(codeMapBudgetForHeap(0.5 * GB)).toBe(250_000);
  });
});
