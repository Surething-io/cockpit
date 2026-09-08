/**
 * /api/projectGraph/context — multi-source semantic context retrieval.
 *
 * Inputs:
 *   - query        : free-text → TF-IDF seeds
 *   - cursor       : `<filePath>::<qualifiedName>` (or `<filePath>:<line>`) → strong seed
 *   - openFiles    : files in user's editor → weak seeds (first symbol of each)
 *
 * Pipeline:
 *   1. Resolve seeds (each tagged with origin + weight).
 *   2. PPR over the analytics graph (single power-iteration sweep).
 *   3. TF-IDF re-score (small boost so query-matching nodes outrank
 *      purely structurally-relevant ones when there's a direct lexical hit).
 *   4. PageRank adds a gentle global-importance prior.
 *   5. Top-K by final blended score, with signals attached.
 *
 * Returns coordinates only — same contract as the other /api/projectGraph/*
 * endpoints. The LLM reads source with the existing Read tool.
 */
import type { CodeIndex } from '../projectGraph/codeIndex';
import type { AnalyticsEntry } from './cache';
import { cachedPPR, analyticsDegradedReason } from './cache';
import type { NodeId } from './types';
import { makeNodeId, parseNodeId } from './types';
import type { SymbolKind } from '../types';

/** Synthetic block names emitted by the codeMap extractors (filler over
 *  uncovered lines, imports header block, etc.). These are render-only
 *  placeholders, not real symbols — we filter them out of analytics
 *  results so LLMs / users don't see `__imports__` / `__code_1_5__` as
 *  "relevant code". They DO still participate in the analytics graph
 *  (their import edges contribute to PageRank flow), we just hide them
 *  at the projection layer. */
const SYNTHETIC_QNAME = /^__(imports?|code_\d+_\d+|filler|file)/;
function isSynthetic(qname: string): boolean {
  return SYNTHETIC_QNAME.test(qname);
}

/** Deterministic secondary sort: when scores tie (common on uniform
 *  graphs like the route-handler fan in Cockpit), break ties by
 *  filePath asc, qname asc, startLine asc. Same comparator used by all
 *  three builders so output ordering is identical across processes /
 *  restarts. */
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

export type ContextSignal =
  | { type: 'query-match'; tfidf: number }
  | { type: 'ppr'; pprScore: number }
  | { type: 'pagerank'; pagerank: number }
  | { type: 'open'; filePath: string };

export interface ContextHit {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  score: number;
  signals: ContextSignal[];
}

export interface ContextSeedDebug {
  node: { filePath: string; qualifiedName: string };
  weight: number;
  from: 'query' | 'cursor' | 'open';
}

export interface ContextResponse {
  results: ContextHit[];
  seeds: ContextSeedDebug[];
  /** P1-4: When a `cursor` parameter was supplied, this tells the
   *  caller exactly what we resolved it to (or why we couldn't).
   *  Critical because cursor is the highest-weight seed (2.0) — a
   *  silent mismatch used to make the whole anchoring effect vanish
   *  without any indication. LLMs can use the suggestions to retry
   *  with a corrected cursor format. */
  cursorResolution?: {
    matched: boolean;
    resolvedTo?: { filePath: string; qualifiedName: string };
    suggestions?: Array<{
      filePath: string;
      qualifiedName: string;
      reason: 'name-collision' | 'fuzzy-line' | 'case-insensitive';
    }>;
    /** Format adjustment hint for the LLM, e.g. "interpreted '.' as '::'". */
    notes?: string;
  };
  degraded: boolean;
  degradedReason?: string;
}

export interface ContextInput {
  query?: string;
  /** `<filePath>::<qualifiedName>` or `<filePath>:<line>` */
  cursor?: string;
  openFiles?: string[];
  topK?: number;
  damping?: number;
}

/** Internal result of cursor resolution — carries both the matched node
 *  (if any) and diagnostics for the response's `cursorResolution` field. */
interface CursorMatch {
  matched: boolean;
  nodeId?: NodeId;
  resolvedTo?: { filePath: string; qualifiedName: string };
  suggestions?: NonNullable<ContextResponse['cursorResolution']>['suggestions'];
  notes?: string;
}

/** Parse a cursor parameter into a concrete NodeId — P1-4 tolerant version.
 *
 *  Accepted forms (tried in order):
 *
 *    1. `<filePath>::<qualifiedName>`       (canonical)
 *    2. `<filePath>::<qualifiedName>` but qname uses `.` not `>`
 *    3. `<filePath>:<line>` with FUZZY line (±5 line tolerance)
 *    4. bare qualified name (no filePath) — global lookup; succeeds
 *       only if uniquely matched, otherwise returns suggestions
 *    5. case-insensitive fallback when (1) or (4) just-missed
 *
 *  Returns a discriminated result so the caller can surface a
 *  `cursorResolution` block in the response. We DO NOT silently return
 *  null any more — every failure path carries a reason and (when
 *  possible) actionable suggestions.
 */
function resolveCursor(cursor: string, index: CodeIndex): CursorMatch {
  const trimmed = cursor.trim();

  // ----------------------------------------------------------------
  // Form 1 + 2: contains `::` OR ends with what looks like a qname
  // ----------------------------------------------------------------
  const dblIdx = trimmed.indexOf('::');
  if (dblIdx > 0) {
    const filePath = trimmed.slice(0, dblIdx);
    const rawQname = trimmed.slice(dblIdx + 2);
    // Form 2 normalisation: LLMs often write `Parent.Child` instead of
    // `Parent>Child` (JS/Python member access vs Cockpit's convention).
    const normQname = rawQname.replace(/\./g, '>');
    const file = index.files.get(filePath);
    if (file) {
      if (file.symbolsByQname.has(normQname)) {
        return {
          matched: true,
          nodeId: makeNodeId(filePath, normQname),
          resolvedTo: { filePath, qualifiedName: normQname },
          notes:
            rawQname !== normQname ? "interpreted '.' as '>' in qname" : undefined,
        };
      }
      // Case-insensitive fallback (form 5).
      const lower = normQname.toLowerCase();
      for (const known of file.symbolsByQname.keys()) {
        if (known.toLowerCase() === lower) {
          return {
            matched: true,
            nodeId: makeNodeId(filePath, known),
            resolvedTo: { filePath, qualifiedName: known },
            notes: "matched case-insensitively",
          };
        }
      }
      // qname not found in that file — suggest similar names in the file.
      const sims: CursorMatch['suggestions'] = [];
      const target = rawQname.toLowerCase();
      for (const sym of file.flatSymbols) {
        if (sym.name.toLowerCase() === target.split('>').pop()) {
          sims.push({
            filePath,
            qualifiedName: sym.qualifiedName,
            reason: 'case-insensitive',
          });
        }
      }
      return {
        matched: false,
        suggestions: sims.slice(0, 3),
        notes: `no symbol '${rawQname}' in ${filePath}`,
      };
    }
    // filePath unknown — fall through to other forms.
  }

  // ----------------------------------------------------------------
  // Form 2b: `<filePath>.<qname>` — LLM used `.` between file & qname.
  //   Detect by finding a source file extension followed by `.` then a
  //   plausible qname. The extension must be one we actually index.
  // ----------------------------------------------------------------
  const EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs)(\.[A-Za-z_])/;
  const extMatch = EXT_RE.exec(trimmed);
  if (extMatch) {
    // Cut just BEFORE the second `.` (after the file extension).
    const splitAt = extMatch.index + extMatch[1].length + 1;
    const filePath = trimmed.slice(0, splitAt);
    const rawQname = trimmed.slice(splitAt + 1);
    const normQname = rawQname.replace(/\./g, '>');
    const file = index.files.get(filePath);
    if (file?.symbolsByQname.has(normQname)) {
      return {
        matched: true,
        nodeId: makeNodeId(filePath, normQname),
        resolvedTo: { filePath, qualifiedName: normQname },
        notes: "interpreted '.' as '::' between filePath and qname",
      };
    }
    if (file) {
      // Case-insensitive within the file.
      const lower = normQname.toLowerCase();
      for (const known of file.symbolsByQname.keys()) {
        if (known.toLowerCase() === lower) {
          return {
            matched: true,
            nodeId: makeNodeId(filePath, known),
            resolvedTo: { filePath, qualifiedName: known },
            notes: "interpreted '.' as '::' and matched case-insensitively",
          };
        }
      }
    }
    // Fall through to Form 3 / Form 4 if file/symbol still not found.
  }

  // ----------------------------------------------------------------
  // Form 3: filePath:line  (with ±5 line tolerance, synthetic-aware)
  // ----------------------------------------------------------------
  // Use lastIndexOf so Windows-style paths or unusual basenames don't
  // confuse us — we only care about the FINAL `:N` segment.
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx > 0 && /^\d+$/.test(trimmed.slice(colonIdx + 1))) {
    const filePath = trimmed.slice(0, colonIdx);
    const line = parseInt(trimmed.slice(colonIdx + 1), 10);
    const file = index.files.get(filePath);
    if (file) {
      // Filter out synthetic blocks (`__code_*`, `__imports__`, etc.)
      // before line matching — otherwise the fuzzy ±5 pass tends to
      // anchor to a filler block above the real function the user
      // meant. Real symbols take precedence even when farther away.
      const realSymbols = file.flatSymbols.filter(
        (s) => !/^__(imports?|code_\d+_\d+|filler|file)/.test(s.qualifiedName),
      );

      // Pass 1: strict enclosing match (most specific).
      let best: { qname: string; size: number } | null = null;
      for (const sym of realSymbols) {
        if (sym.startLine <= line && line <= sym.endLine) {
          const size = sym.endLine - sym.startLine;
          if (!best || size < best.size) {
            best = { qname: sym.qualifiedName, size };
          }
        }
      }
      if (best) {
        return {
          matched: true,
          nodeId: makeNodeId(filePath, best.qname),
          resolvedTo: { filePath, qualifiedName: best.qname },
        };
      }
      // Pass 2: fuzzy ±5 — common when LLM points at a blank line just
      // before / after a function declaration.
      let fuzzyBest: { qname: string; dist: number } | null = null;
      for (const sym of realSymbols) {
        const dist = Math.min(
          Math.abs(sym.startLine - line),
          Math.abs(sym.endLine - line),
        );
        if (dist <= 5 && (!fuzzyBest || dist < fuzzyBest.dist)) {
          fuzzyBest = { qname: sym.qualifiedName, dist };
        }
      }
      if (fuzzyBest) {
        return {
          matched: true,
          nodeId: makeNodeId(filePath, fuzzyBest.qname),
          resolvedTo: { filePath, qualifiedName: fuzzyBest.qname },
          notes: `fuzzy line match: line ${line} → '${fuzzyBest.qname}' (±${fuzzyBest.dist})`,
        };
      }
      return {
        matched: false,
        notes: `no symbol within ±5 lines of ${filePath}:${line}`,
      };
    }
  }

  // ----------------------------------------------------------------
  // Form 4: bare qualified name (no filePath separator at all)
  // ----------------------------------------------------------------
  if (!trimmed.includes('/') && !trimmed.includes(':')) {
    const normQname = trimmed.replace(/\./g, '>');
    const candidates: NonNullable<CursorMatch['suggestions']> = [];
    for (const [fp, file] of index.files) {
      if (file.symbolsByQname.has(normQname)) {
        candidates.push({
          filePath: fp,
          qualifiedName: normQname,
          reason: 'name-collision',
        });
      }
    }
    if (candidates.length === 1) {
      return {
        matched: true,
        nodeId: makeNodeId(candidates[0].filePath, candidates[0].qualifiedName),
        resolvedTo: candidates[0],
        notes: `bare name '${trimmed}' uniquely matched`,
      };
    }
    if (candidates.length > 1) {
      return {
        matched: false,
        suggestions: candidates.slice(0, 5),
        notes: `bare name '${trimmed}' matched in ${candidates.length} files — pass filePath to disambiguate`,
      };
    }
  }

  return {
    matched: false,
    notes: `could not parse cursor '${cursor}' — expected '<filePath>::<qname>' or '<filePath>:<line>'`,
  };
}

/** Pick the "anchor" symbol for an openFile: smallest startLine. */
function anchorOfFile(filePath: string, index: CodeIndex): NodeId | null {
  const file = index.files.get(filePath);
  if (!file || file.flatSymbols.length === 0) return null;
  let earliest = file.flatSymbols[0];
  for (const s of file.flatSymbols) {
    if (s.startLine < earliest.startLine) earliest = s;
  }
  return makeNodeId(filePath, earliest.qualifiedName);
}

export function buildContext(
  index: CodeIndex,
  analytics: AnalyticsEntry | null,
  input: ContextInput,
): ContextResponse {
  const topK = Math.min(Math.max(input.topK ?? 15, 1), 50);
  const damping = Math.min(Math.max(input.damping ?? 0.85, 0.5), 0.95);

  const seeds = new Map<NodeId, number>();
  const seedDebug: ContextSeedDebug[] = [];
  const tfidfHits = new Map<NodeId, number>(); // node → tfidf score
  let cursorResolution: ContextResponse['cursorResolution']; // P1-4: surface to caller

  // 1. cursor (weight 2.0)
  if (input.cursor) {
    const m = resolveCursor(input.cursor, index);
    if (m.matched && m.nodeId && m.resolvedTo) {
      seeds.set(m.nodeId, 2.0);
      seedDebug.push({ node: m.resolvedTo, weight: 2.0, from: 'cursor' });
    }
    cursorResolution = {
      matched: m.matched,
      resolvedTo: m.resolvedTo,
      suggestions: m.suggestions,
      notes: m.notes,
    };
  }

  // 2. open files (weight 0.5 each)
  if (input.openFiles && input.openFiles.length > 0) {
    for (const f of input.openFiles) {
      const id = anchorOfFile(f, index);
      if (id && !seeds.has(id)) {
        seeds.set(id, 0.5);
        const parsed = parseNodeId(id);
        if (parsed) {
          seedDebug.push({ node: parsed, weight: 0.5, from: 'open' });
        }
      }
    }
  }

  // 3. query → TF-IDF top-3 (weight 1.0 each)
  if (input.query && analytics) {
    const hits = analytics.tfidf.search(input.query, 5);
    for (const hit of hits) {
      tfidfHits.set(hit.node, hit.score);
      if (!seeds.has(hit.node) && hit.score > 0.05) {
        // Only top-3 of these become PPR seeds; the rest contribute as
        // tf-idf signals only.
        if (seedDebug.filter((s) => s.from === 'query').length < 3) {
          seeds.set(hit.node, 1.0);
          const parsed = parseNodeId(hit.node);
          if (parsed) {
            seedDebug.push({ node: parsed, weight: 1.0, from: 'query' });
          }
        }
      }
    }
  } else if (input.query && !analytics) {
    // Degraded path — fall back to a substring match against node names
    // and treat top hits as direct results (no PPR).
    const q = input.query.toLowerCase();
    for (const [id, meta] of index.files.size > 0
      ? walkAllNodes(index)
      : []) {
      if (
        meta.name.toLowerCase().includes(q) ||
        meta.qualifiedName.toLowerCase().includes(q)
      ) {
        tfidfHits.set(id, 0.5);
      }
    }
  }

  if (seeds.size === 0 && tfidfHits.size === 0) {
    return {
      results: [],
      seeds: seedDebug,
      cursorResolution,
      degraded: !analytics,
      degradedReason: analytics ? undefined : analyticsDegradedReason(index),
    };
  }

  // 4. PPR (skip if no analytics OR no PPR-eligible seeds). P1-3:
  //    cachedPPR — same seed configuration in a follow-up query hits
  //    the LRU cache and returns instantly.
  const pprScores = new Map<NodeId, number>();
  if (analytics && seeds.size > 0) {
    const results = cachedPPR(analytics, seeds, {
      damping,
      maxIter: 30,
      topK: 60,
    });
    for (const r of results) pprScores.set(r.node, r.score);
  }

  // 5. Combine: pull in all candidate nodes (union of seeds, ppr results,
  //    tfidf hits) and compute final score.
  const candidates = new Set<NodeId>();
  for (const n of pprScores.keys()) candidates.add(n);
  for (const n of tfidfHits.keys()) candidates.add(n);

  // Normalisation: rescale PPR scores to [0,1] for blending.
  let maxPpr = 0;
  for (const v of pprScores.values()) if (v > maxPpr) maxPpr = v;
  let maxTf = 0;
  for (const v of tfidfHits.values()) if (v > maxTf) maxTf = v;
  let maxPr = 0;
  if (analytics) {
    for (const v of analytics.pagerank.values()) if (v > maxPr) maxPr = v;
  }

  const scored: ContextHit[] = [];
  for (const id of candidates) {
    if (seeds.has(id)) continue; // hide seeds themselves
    const parsed = parseNodeId(id);
    if (!parsed) continue;
    if (isSynthetic(parsed.qualifiedName)) continue; // P0-1: drop synthetic blocks
    const file = index.files.get(parsed.filePath);
    const sym = file?.symbolsByQname.get(parsed.qualifiedName);
    if (!file || !sym) continue;

    const pprRaw = pprScores.get(id) ?? 0;
    const tfRaw = tfidfHits.get(id) ?? 0;
    const prRaw = analytics?.pagerank.get(id) ?? 0;

    const pprNorm = maxPpr > 0 ? pprRaw / maxPpr : 0;
    const tfNorm = maxTf > 0 ? tfRaw / maxTf : 0;
    const prNorm = maxPr > 0 ? prRaw / maxPr : 0;

    const score =
      0.55 * pprNorm + 0.30 * tfNorm + 0.15 * prNorm;
    if (score === 0) continue;

    const signals: ContextSignal[] = [];
    if (tfRaw > 0) signals.push({ type: 'query-match', tfidf: tfRaw });
    if (pprRaw > 0) signals.push({ type: 'ppr', pprScore: pprRaw });
    if (prRaw > 0) signals.push({ type: 'pagerank', pagerank: prRaw });
    if (input.openFiles?.includes(parsed.filePath)) {
      signals.push({ type: 'open', filePath: parsed.filePath });
    }

    scored.push({
      filePath: parsed.filePath,
      qualifiedName: parsed.qualifiedName,
      name: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      score,
      signals,
    });
  }

  // P0-4: deterministic secondary sort — when scores tie, break by
  // filePath / qname / startLine. Without this, ties produced arbitrary
  // (and unstable across processes) ordering, which hurts LLM caching
  // and makes debugging non-reproducible.
  scored.sort((a, b) => (b.score - a.score) || cmpDeterministic(a, b));
  const sliced = scored.slice(0, topK);

  return {
    results: sliced,
    seeds: seedDebug,
    cursorResolution,
    degraded: !analytics,
    degradedReason: analytics ? undefined : analyticsDegradedReason(index),
  };
}

/** Iterate every (NodeId, meta-like) tuple from a CodeIndex — used by
 *  the degraded path where we don't have an AnalyticsGraph built. */
function* walkAllNodes(
  index: CodeIndex,
): Iterable<[NodeId, { name: string; qualifiedName: string }]> {
  for (const [filePath, file] of index.files) {
    for (const sym of file.flatSymbols) {
      yield [
        makeNodeId(filePath, sym.qualifiedName),
        { name: sym.name, qualifiedName: sym.qualifiedName },
      ];
    }
  }
}
