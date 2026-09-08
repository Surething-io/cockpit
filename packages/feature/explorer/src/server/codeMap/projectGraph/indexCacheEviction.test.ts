/**
 * Symbol-budgeted eviction for the per-cwd CodeIndex cache.
 *
 * Before this, `indexCache` was a bare `Map` with no bound at all: every
 * project ever opened stayed resident until the process died. One measured
 * index was 2.63 GB (60,598 files / 809K symbols) against Node's ~4.19 GB
 * default heap, so two large projects were enough to OOM.
 *
 * The budget is per SYMBOL rather than per entry because entry count bounds
 * nothing when a single entry can be 2.63 GB — a 3-entry cap still admits
 * 7.9 GB. These tests pin that distinction: many small projects must all
 * survive, while a few large ones must not.
 *
 * Driven through `__indexCacheTesting` rather than by stubbing
 * `buildCodeIndex`: `getCodeIndex` calls the builder through a direct local
 * binding, so an ESM module-export spy never intercepts it. A first version
 * of this file did exactly that and four of its five cases passed
 * vacuously — the stub never ran, and every assertion happened to be
 * `toEqual([])`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_CACHED_SYMBOLS,
  countIndexSymbols,
  getCodeIndex,
  __indexCacheTesting as T,
} from './codeIndex';
import type { CodeIndex } from './codeIndex';

/** Only `cwd`, `files` and each file's `flatSymbols.length` are read here. */
function fakeIndex(cwd: string, symbols: number): CodeIndex {
  const files = new Map<string, { flatSymbols: unknown[] }>();
  const perFile = 1000;
  let left = symbols;
  let i = 0;
  while (left > 0) {
    const n = Math.min(perFile, left);
    files.set(`f${i++}.ts`, { flatSymbols: new Array(n).fill(null) });
    left -= n;
  }
  if (symbols === 0) files.set('empty.ts', { flatSymbols: [] });
  return { cwd, files } as unknown as CodeIndex;
}

/** Seed then run the same eviction the build path runs. */
function admit(cwd: string, symbols: number): void {
  T.seed(cwd, fakeIndex(cwd, symbols));
  T.evict(cwd);
}

describe('countIndexSymbols', () => {
  it('sums flatSymbols across files', () => {
    expect(countIndexSymbols(fakeIndex('/a', 2500))).toBe(2500);
    expect(countIndexSymbols(fakeIndex('/a', 0))).toBe(0);
  });
});

describe('indexCache symbol budget', () => {
  beforeEach(() => T.clear());

  it('keeps many small projects — a count-based cap would have evicted them', () => {
    const each = Math.floor(MAX_CACHED_SYMBOLS / 100);
    for (let i = 0; i < 20; i++) admit(`/small${i}`, each);
    // 20 × 1% of budget = 20% of it. Nothing may be dropped.
    expect(T.keys()).toHaveLength(20);
    expect(T.has('/small0')).toBe(true);
  });

  it('evicts the least-recently-used project when the budget is exceeded', () => {
    const big = Math.floor(MAX_CACHED_SYMBOLS * 0.6);
    admit('/a', big);
    admit('/b', big); // /a + /b = 120% of budget
    expect(T.has('/b')).toBe(true);
    expect(T.has('/a')).toBe(false);
  });

  it('honours recency via getCodeIndex, not insertion order', async () => {
    const third = Math.floor(MAX_CACHED_SYMBOLS * 0.45);
    admit('/x', third);
    admit('/y', third); // 90% — both still fit
    expect(T.keys()).toEqual(['/x', '/y']);

    // A cache HIT must re-insert, making /x most-recent. This is the real
    // coupling: the evictor reads Map order as recency order, and it is
    // getCodeIndex that maintains it.
    await getCodeIndex('/x');
    expect(T.keys()).toEqual(['/y', '/x']);

    admit('/z', third); // 135% → the LRU entry (/y) goes, not /x
    expect(T.has('/x')).toBe(true);
    expect(T.has('/y')).toBe(false);
    expect(T.has('/z')).toBe(true);
  });

  it('never evicts the index just admitted, even if it alone busts the budget', () => {
    // A single oversized project cannot be made to fit. Dropping it would
    // waste the build and return an index that is no longer cached, so the
    // next call would rebuild it forever.
    admit('/huge', MAX_CACHED_SYMBOLS * 2);
    expect(T.has('/huge')).toBe(true);
  });

  it('drops older entries to make room for an oversized newcomer', () => {
    admit('/old1', Math.floor(MAX_CACHED_SYMBOLS * 0.3));
    admit('/old2', Math.floor(MAX_CACHED_SYMBOLS * 0.3));
    admit('/huge', MAX_CACHED_SYMBOLS * 2);
    // Can't get under budget, but everything evictable must still be gone —
    // otherwise the oversized project stacks on top of the old ones.
    expect(T.keys()).toEqual(['/huge']);
  });
});
