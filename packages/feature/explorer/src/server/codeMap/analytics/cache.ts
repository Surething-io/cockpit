/**
 * Per-cwd analytics cache.
 *
 * Holds the AnalyticsGraph + algorithm-result objects (PageRank, TF-IDF)
 * that are expensive to build but cheap to query against. Lifecycle:
 *
 *   - `precompute(cwd, index)` builds everything from a CodeIndex,
 *     called fire-and-forget from `getCodeIndex` after a fresh build.
 *   - `get(cwd)` returns the entry if ready, `null` if not (route
 *     handlers degrade gracefully).
 *   - `invalidate(cwd)` is wired to the same dirty-tracking that the
 *     codeIndex cache uses — we drop our cache whenever the CodeIndex
 *     is invalidated.
 *
 * Memory budget: at 10K nodes / 100K edges the cache is well under
 * 50 MB (PR scores: 10K floats; TF-IDF: ~10K × ~10 terms each). For
 * Cockpit's typical project sizes (`MAX_FILES = 15000`) this is fine
 * to keep resident. Note the analytics entry is the SMALL half of the
 * per-project footprint — the CodeIndex itself measured ~0.8 GB
 * resident for a 7.7K-file project, and neither cache has an eviction
 * policy, so every project visited stays until the process restarts.
 *
 * Concurrency: precompute is idempotent and synchronous (all algos
 * are pure CPU). We don't lock — multiple precompute calls overlap
 * harmlessly; last writer wins.
 */
import type { CodeIndex } from '../projectGraph/codeIndex';
import type { AnalyticsGraph, NodeId } from './types';
import { buildAnalyticsGraph } from './graph';
import { pagerank, personalizedPageRank } from './pagerank';
import type { PPROptions, PPRResult } from './pagerank';
import { TfidfIndex } from './tfidf';
import { detectCommunities } from './louvain';
import type { CommunityId } from './louvain';

/** P1-3: LRU cache for PPR results, keyed by canonicalised seed list +
 *  damping. PPR is the dominant cost in `related` and `context` — the
 *  same seed appearing twice in a session(LLM follow-up queries,
 *  "look at X again") should reuse the previous computation. */
class PPRLruCache {
  private readonly cap: number;
  private readonly map = new Map<string, PPRResult[]>();

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: string): PPRResult[] | undefined {
    const v = this.map.get(key);
    if (!v) return undefined;
    // LRU touch: re-insert to move to most-recent end.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: PPRResult[]): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      // Evict the LRU entry (oldest, first inserted).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const PPR_CACHE_CAP = 200;

export interface AnalyticsEntry {
  cwd: string;
  /** Bumped on each precompute; routes can compare to detect staleness
   *  but at present we just rely on invalidate() for staleness. */
  version: number;
  graph: AnalyticsGraph;
  pagerank: Map<NodeId, number>;
  tfidf: TfidfIndex;
  /** P1-1: Louvain community id per node — same community ≈ tightly
   *  coupled cluster. Used by relatedBuilder to surface
   *  sibling-in-community relations. */
  communities: Map<NodeId, CommunityId>;
  /** P1-3: PPR LRU cache, keyed by sorted seeds + damping. Invalidated
   *  together with the AnalyticsEntry it lives on (i.e. on next
   *  precompute). */
  pprCache: PPRLruCache;
  /** ms epoch when this entry finished building. */
  builtAt: number;
  /** Total build time (excluding the underlying CodeIndex parse). */
  buildMs: number;
}

/** Canonical cache key for a PPR query. Order-independent in seeds:
 *  sorting prevents `[A, B]` and `[B, A]` from missing each other. */
function pprCacheKey(
  seeds: ReadonlyArray<NodeId> | ReadonlyMap<NodeId, number>,
  opts: PPROptions = {},
): string {
  const entries: Array<[NodeId, number]> = Array.isArray(seeds)
    ? (seeds as NodeId[]).map((id) => [id, 1])
    : [...(seeds as Map<NodeId, number>).entries()];
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const damping = opts.damping ?? 0.85;
  const topK = opts.topK ?? 0;
  return `d${damping}|k${topK}|` + entries.map((e) => `${e[0]}=${e[1]}`).join(',');
}

/** P1-3: cached PPR — same shape as `personalizedPageRank` but reuses
 *  AnalyticsEntry.pprCache. Call this from builders instead of the raw
 *  algorithm. Cache miss falls through to `personalizedPageRank` and
 *  records the result. */
export function cachedPPR(
  entry: AnalyticsEntry,
  seeds: ReadonlyArray<NodeId> | ReadonlyMap<NodeId, number>,
  opts: PPROptions = {},
): PPRResult[] {
  const key = pprCacheKey(seeds, opts);
  const hit = entry.pprCache.get(key);
  if (hit) return hit;
  const result = personalizedPageRank(entry.graph, seeds, opts);
  entry.pprCache.set(key, result);
  return result;
}

const cache = new Map<string, AnalyticsEntry>();
const inflight = new Map<string, Promise<AnalyticsEntry>>();
let versionCounter = 0;

/** Read the cached entry; returns null if not yet built / invalidated. */
export function getAnalytics(cwd: string): AnalyticsEntry | null {
  return cache.get(cwd) ?? null;
}

/** Drop the cached entry — wired to the same lifecycle hook that
 *  invalidates the CodeIndex. */
export function invalidateAnalytics(cwd?: string): void {
  if (!cwd) {
    cache.clear();
    inflight.clear();
    return;
  }
  cache.delete(cwd);
  inflight.delete(cwd);
}

/** Build (or rebuild) the analytics entry for a given index snapshot.
 *  Safe to fire-and-forget — callers don't need to await unless they
 *  want guaranteed freshness for the next read. */
export function precomputeAnalytics(
  cwd: string,
  index: CodeIndex,
): Promise<AnalyticsEntry> {
  const pending = inflight.get(cwd);
  if (pending) return pending;
  const p = (async () => {
    const t0 = Date.now();
    versionCounter += 1;
    const version = versionCounter;
    const graph = buildAnalyticsGraph(index, version);
    const pr = pagerank(graph);
    const tf = new TfidfIndex(graph);
    const communities = detectCommunities(graph);
    const entry: AnalyticsEntry = {
      cwd,
      version,
      graph,
      pagerank: pr,
      tfidf: tf,
      communities,
      pprCache: new PPRLruCache(PPR_CACHE_CAP),
      builtAt: Date.now(),
      buildMs: Date.now() - t0,
    };
    cache.set(cwd, entry);
    inflight.delete(cwd);
    return entry;
  })();
  inflight.set(cwd, p);
  return p;
}

/** Convenience for routes: if analytics are ready use them; otherwise
 *  trigger an async build and return null so the caller can degrade. */
export function getOrTriggerAnalytics(
  cwd: string,
  index: CodeIndex,
): AnalyticsEntry | null {
  const hit = cache.get(cwd);
  if (hit) return hit;
  // Kick off build in the background; don't await.
  precomputeAnalytics(cwd, index).catch((err) => {
    console.error('[analytics] precompute failed:', err);
  });
  return null;
}
