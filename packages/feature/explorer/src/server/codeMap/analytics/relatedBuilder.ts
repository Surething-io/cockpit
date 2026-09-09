/**
 * /api/projectGraph/related — broader 1-hop relatedness around a single symbol.
 *
 * Covers what callers/callees alone miss:
 *   - direct caller / callee (from the call graph)
 *   - PPR neighbours (structurally close via multi-hop random walks)
 *   - frequent coedit partners (git history; pulled from coedit.ts)
 *
 * Output is a unified Top-K list, each result tagged with one or more
 * `relations` so the LLM can see why something showed up.
 */
import type { CodeIndex } from '../projectGraph/codeIndex';
import type { AnalyticsEntry } from './cache';
import { cachedPPR, analyticsDegradedReason } from './cache';
import type { NodeId } from './types';
import { makeNodeId, parseNodeId } from './types';
import type { SymbolKind } from '../types';
import { coEditAuto } from '../projectGraph/coedit';

/** Mirror of contextBuilder's synthetic filter. See P0-1 in contextBuilder.ts. */
const SYNTHETIC_QNAME = /^__(imports?|code_\d+_\d+|filler|file)/;
function isSynthetic(qname: string): boolean {
  return SYNTHETIC_QNAME.test(qname);
}

/** Mirror of contextBuilder's deterministic comparator. See P0-4. */
function cmpDeterministic(
  a: { filePath: string; qualifiedName: string; startLine: number },
  b: { filePath: string; qualifiedName: string; startLine: number },
): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    a.qualifiedName.localeCompare(b.qualifiedName) ||
    a.startLine - b.startLine
  );
}

export type Relation =
  | { type: 'caller'; callLines: number[] }
  | { type: 'callee'; callLines: number[] }
  | { type: 'frequent-coedit'; cooccurrence: number; totalCommits: number }
  | { type: 'ppr-neighbor'; pprScore: number }
  | { type: 'sibling-in-community'; communityId: number };

export interface RelatedHit {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  score: number;
  relations: Relation[];
}

/** Coedit signal we already fetched. Single definition lives in
 *  impactScorer.ts — this used to be a byte-identical copy, which is how
 *  the two drifted apart in the first place. */
export type { CoeditEntry } from './impactScorer';
import type { CoeditEntry } from './impactScorer';

export interface RelatedResponse {
  target: { filePath: string; qualifiedName: string } | null;
  ambiguousIn?: string[];
  results: RelatedHit[];
  /** Coedit history for the TARGET file (sorted by cooccurrence desc,
   *  capped at 30). Reuse this instead of issuing a separate
   *  /coedit?filePath=<target.filePath> call. Empty when coedit was
   *  unavailable for the target file (squash-style git, non-repo, etc.). */
  coedit: CoeditEntry[];
  degraded: boolean;
  degradedReason?: string;
}

export interface RelatedInput {
  qname: string;
  filePath?: string;
  topK?: number;
  include?: 'structural' | 'coedit' | 'all';
}

/** Resolve qname (+ optional filePath disambiguation) → the matching files. */
function findTargets(
  index: CodeIndex,
  qname: string,
  filePath?: string,
): Array<{ filePath: string; sym: { name: string; kind: SymbolKind; startLine: number; endLine: number } }> {
  const matches: Array<{ filePath: string; sym: { name: string; kind: SymbolKind; startLine: number; endLine: number } }> = [];
  for (const [fp, file] of index.files) {
    if (filePath && fp !== filePath) continue;
    const sym = file.symbolsByQname.get(qname);
    if (sym) {
      matches.push({ filePath: fp, sym });
    }
  }
  return matches;
}

export async function buildRelated(
  index: CodeIndex,
  analytics: AnalyticsEntry | null,
  input: RelatedInput,
): Promise<RelatedResponse> {
  const topK = Math.min(Math.max(input.topK ?? 10, 1), 30);
  const include = input.include ?? 'all';
  const wantStructural = include === 'structural' || include === 'all';
  const wantCoedit = include === 'coedit' || include === 'all';

  const targets = findTargets(index, input.qname, input.filePath);
  if (targets.length === 0) {
    return {
      target: null,
      results: [],
      coedit: [],
      degraded: !analytics,
      degradedReason: analytics ? undefined : analyticsDegradedReason(index),
    };
  }

  const primary = targets[0];
  const ambiguousIn =
    targets.length > 1 ? targets.map((t) => t.filePath) : undefined;

  // Collect candidates with per-source signals.
  // key = NodeId; value = { relations, scoreContributions }
  type Aggregated = {
    relations: Relation[];
    pprScore?: number;
    isCaller?: boolean;
    isCallee?: boolean;
    coeditProb?: number;
    /** P1-1: same Louvain community as the target. Contributes a small
     *  boost to score and surfaces nodes that are clustered with the
     *  target but don't have any direct call edge. */
    sameCommunity?: boolean;
  };
  const agg = new Map<NodeId, Aggregated>();
  const get = (id: NodeId): Aggregated => {
    let a = agg.get(id);
    if (!a) {
      a = { relations: [] };
      agg.set(id, a);
    }
    return a;
  };

  // 1. Direct callers / callees (always — these are the most precise signals).
  if (wantStructural) {
    const targetFile = index.files.get(primary.filePath);
    if (targetFile) {
      // Intra-file callers/callees
      for (const call of targetFile.intraCalls) {
        if (call.to === input.qname) {
          const id = makeNodeId(primary.filePath, call.from);
          const a = get(id);
          a.isCaller = true;
          a.relations.push({ type: 'caller', callLines: call.lines });
        }
        if (call.from === input.qname) {
          const id = makeNodeId(primary.filePath, call.to);
          const a = get(id);
          a.isCallee = true;
          a.relations.push({ type: 'callee', callLines: call.lines });
        }
      }
      // Cross-file: incoming = others call us; outgoing = we call others.
      for (const call of targetFile.incomingCalls) {
        if (call.to !== input.qname) continue;
        const id = makeNodeId(call.from.filePath, call.from.qualifiedName);
        const a = get(id);
        a.isCaller = true;
        a.relations.push({ type: 'caller', callLines: call.lines });
      }
      for (const call of targetFile.outgoingCalls) {
        if (call.from !== input.qname) continue;
        const id = makeNodeId(call.to.filePath, call.to.qualifiedName);
        const a = get(id);
        a.isCallee = true;
        a.relations.push({ type: 'callee', callLines: call.lines });
      }
    }
  }

  // 2. PPR neighbours. P1-3: cached — same seed in a follow-up query
  //    returns instantly from the LRU cache.
  if (wantStructural && analytics) {
    const seedId = makeNodeId(primary.filePath, input.qname);
    if (analytics.graph.nodes.has(seedId)) {
      const ppr = cachedPPR(analytics, [seedId], {
        topK: 30,
        maxIter: 25,
      });
      for (const r of ppr) {
        const a = get(r.node);
        a.pprScore = r.score;
        if (!a.relations.some((x) => x.type === 'ppr-neighbor')) {
          a.relations.push({ type: 'ppr-neighbor', pprScore: r.score });
        }
      }
    }
  }

  // 2b. P1-1: sibling-in-community — nodes sharing the target's Louvain
  //     community. These surface architectural neighbours that don't
  //     have a direct call edge (sibling React components in the same
  //     feature folder, etc.). Capped at 10 to keep results focused.
  if (wantStructural && analytics) {
    const seedId = makeNodeId(primary.filePath, input.qname);
    const myCommunity = analytics.communities.get(seedId);
    if (myCommunity !== undefined) {
      // Pre-compute PR of each candidate so we can pick the "top" community
      // members rather than dumping the whole cluster.
      const inCommunity: Array<{ id: NodeId; pr: number }> = [];
      for (const [id, c] of analytics.communities) {
        if (c !== myCommunity || id === seedId) continue;
        inCommunity.push({ id, pr: analytics.pagerank.get(id) ?? 0 });
      }
      inCommunity.sort((a, b) => b.pr - a.pr);
      for (const { id } of inCommunity.slice(0, 10)) {
        const a = get(id);
        a.sameCommunity = true;
        if (!a.relations.some((x) => x.type === 'sibling-in-community')) {
          a.relations.push({
            type: 'sibling-in-community',
            communityId: myCommunity,
          });
        }
      }
    }
  }

  // 3. Coedit-partner files → take their high-PageRank symbols as candidates.
  //    Capture the full coedit history (not just the > 0.2 prob slice) so
  //    we can echo it back to the caller and they don't re-fetch.
  const coeditEcho: CoeditEntry[] = [];
  if (wantCoedit) {
    try {
      const co = await coEditAuto(
        index.cwd,
        primary.filePath,
        100,
      );
      const total = co.totalCommits;
      // Echo every history row (capped at 30) for the response.
      if (total > 0) {
        for (const h of co.history.slice(0, 30)) {
          coeditEcho.push({
            filePath: h.filePath,
            cooccurrence: h.cooccurrence,
            totalCommits: total,
            probability: h.probability,
            lastCoEdit: h.lastCoEdit,
          });
        }
      }
      if (total > 0) {
        for (const h of co.history.slice(0, 8)) {
          const prob = h.cooccurrence / total;
          if (prob < 0.2) continue; // weak signal, skip
          // Anchor symbol of coedit partner file.
          const file = index.files.get(h.filePath);
          if (!file || file.flatSymbols.length === 0) continue;
          let pick = file.flatSymbols[0];
          // Prefer the highest-pagerank symbol if analytics ready.
          if (analytics) {
            let bestPr = -Infinity;
            for (const s of file.flatSymbols) {
              const id = makeNodeId(h.filePath, s.qualifiedName);
              const pr = analytics.pagerank.get(id) ?? 0;
              if (pr > bestPr) {
                bestPr = pr;
                pick = s;
              }
            }
          }
          const id = makeNodeId(h.filePath, pick.qualifiedName);
          const a = get(id);
          a.coeditProb = prob;
          a.relations.push({
            type: 'frequent-coedit',
            cooccurrence: h.cooccurrence,
            totalCommits: total,
          });
        }
      }
    } catch (err) {
      // git not available / not a repo — skip, signal degradation through
      // missing coedit relations but don't fail the request.
      console.warn('[analytics/related] coedit failed:', err);
    }
  }

  // 4. Self-filter: never recommend the target itself.
  const targetId = makeNodeId(primary.filePath, input.qname);
  agg.delete(targetId);

  // 5. Final score: combine signal strengths.
  //    caller/callee: +0.4 each (high confidence)
  //    ppr-neighbor:  +0.3 normalised
  //    coedit:        +0.3 normalised
  let maxPpr = 0;
  for (const a of agg.values()) if (a.pprScore && a.pprScore > maxPpr) maxPpr = a.pprScore;

  const results: RelatedHit[] = [];
  for (const [id, a] of agg) {
    const parsed = parseNodeId(id);
    if (!parsed) continue;
    if (isSynthetic(parsed.qualifiedName)) continue; // P0-1
    const file = index.files.get(parsed.filePath);
    const sym = file?.symbolsByQname.get(parsed.qualifiedName);
    if (!file || !sym) continue;

    let score = 0;
    if (a.isCaller) score += 0.4;
    if (a.isCallee) score += 0.4;
    if (a.pprScore && maxPpr > 0) score += 0.3 * (a.pprScore / maxPpr);
    if (a.coeditProb) score += 0.3 * a.coeditProb;
    // P1-1: gentle boost for being in the same Louvain community —
    // smaller than caller/callee (less specific signal) but enough to
    // float up cluster-mates that otherwise have no edge.
    if (a.sameCommunity) score += 0.15;
    if (score === 0) continue;

    results.push({
      filePath: parsed.filePath,
      qualifiedName: parsed.qualifiedName,
      name: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      score,
      relations: a.relations,
    });
  }

  // P0-4: deterministic secondary sort.
  results.sort((a, b) => (b.score - a.score) || cmpDeterministic(a, b));

  return {
    target: { filePath: primary.filePath, qualifiedName: input.qname },
    ambiguousIn,
    results: results.slice(0, topK),
    coedit: coeditEcho,
    degraded: !analytics,
    degradedReason: analytics ? undefined : analyticsDegradedReason(index),
  };
}
