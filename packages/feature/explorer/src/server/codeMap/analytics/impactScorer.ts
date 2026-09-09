/**
 * /api/projectGraph/risk — risk-scored impact analysis.
 *
 * Wraps the existing `impactFromIndex` BFS, then for each impact node
 * computes a risk score that blends:
 *   - callFreq   — how often this node calls into the target
 *                  (proxy: 1-hop call-site count via callers; for
 *                  deeper nodes we fall back to a depth-decayed default)
 *   - coeditProb — git history co-occurrence between the impact node's
 *                  file and the target's file (uses coedit.ts)
 *   - hasTest    — whether a sibling `.test.*` / `.spec.*` file exists
 *   - pagerank   — global importance from the analytics cache
 *
 * Returns the top-K high-risk nodes plus a per-result `tags` array and
 * a `suggestedTests` list. The total impacted count is returned so the
 * LLM can tell whether top-K truncated something material.
 */
import path from 'node:path';
import type { CodeIndex } from '../projectGraph/codeIndex';
import type { AnalyticsEntry } from './cache';
import { analyticsDegradedReason } from './cache';
import { impactFromIndex } from '../projectGraph/codeIndex';
import { coEditAuto } from '../projectGraph/coedit';
import { makeNodeId } from './types';
import type { SymbolKind } from '../types';

/** P0-1: same synthetic filter as contextBuilder. */
const SYNTHETIC_QNAME = /^__(imports?|code_\d+_\d+|filler|file)/;
function isSynthetic(qname: string): boolean {
  return SYNTHETIC_QNAME.test(qname);
}

export interface RiskNode {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  depth: number;
  risk: {
    score: number;
    callFreq: number;
    coeditProb: number;
    hasTest: boolean;
    pagerank: number;
  };
  tags: Array<'high-risk' | 'untested' | 'frequent-coedit' | 'core' | 'leaf'>;
}

export interface TestSuggestion {
  filePath: string;
  reason: 'direct-test' | 'coedit-history' | 'sibling-test';
  coveredNodes: string[];
}

/** Coedit signal we already fetched while scoring — exposed in the
 *  response so LLM callers don't re-fetch the same data with a separate
 *  `/coedit` call. Seen in session 41e0b5ca: Claude ran 3 manual
 *  coedit calls right after 5 risk calls, two of which we had the
 *  data for already. Cap at 30 to keep payload bounded. */
export interface CoeditEntry {
  filePath: string;
  cooccurrence: number;
  totalCommits: number;
  /** cooccurrence / totalCommits (precomputed for convenience). */
  probability: number;
  /** ISO date of the most recent co-edit. Carried so this echo is a strict
   *  superset of /coedit's history entry — a caller never has to fall back
   *  to a second request just to learn recency. */
  lastCoEdit: string;
}

export interface RiskResponse {
  target: { filePath: string; qualifiedName: string } | null;
  totalImpactedNodes: number;
  highRisk: RiskNode[];
  suggestedTests: TestSuggestion[];
  /** Coedit history for the TARGET file (sorted by cooccurrence desc,
   *  capped at 30). Reuse this instead of issuing a separate
   *  /coedit?filePath=<target.filePath> call. Empty when degraded ⇒
   *  coedit-unavailable. */
  coedit: CoeditEntry[];
  degraded: boolean;
  degradedReason?: string;
}

export interface RiskInput {
  qname: string;
  filePath?: string;
  depth?: number;
  topK?: number;
}

const TEST_SUFFIXES = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i;

function isTestFile(filePath: string): boolean {
  return TEST_SUFFIXES.test(filePath);
}

/** Look for a co-located test file matching the impact node's file.
 *  Searches sibling files and a sibling `__tests__` directory. */
function findSiblingTests(
  filePath: string,
  fileSet: Set<string>,
): string[] {
  const dir = path.posix.dirname(filePath);
  const base = path.posix.basename(filePath).replace(/\.[^.]+$/, '');
  const out: string[] = [];
  // siblings: foo.ts → foo.test.ts / foo.spec.ts (any extension match)
  for (const candidate of fileSet) {
    if (!isTestFile(candidate)) continue;
    if (path.posix.dirname(candidate) === dir) {
      const candBase = path.posix
        .basename(candidate)
        .replace(/\.(test|spec)\.[^.]+$/i, '');
      if (candBase === base) out.push(candidate);
    }
    // __tests__/foo.test.ts
    if (path.posix.dirname(candidate) === path.posix.join(dir, '__tests__')) {
      const candBase = path.posix
        .basename(candidate)
        .replace(/\.(test|spec)\.[^.]+$/i, '');
      if (candBase === base) out.push(candidate);
    }
  }
  return out;
}

export async function scoreImpact(
  index: CodeIndex,
  analytics: AnalyticsEntry | null,
  input: RiskInput,
): Promise<RiskResponse> {
  const safeDepth = Math.min(Math.max(input.depth ?? 2, 1), 5);
  const topK = Math.min(Math.max(input.topK ?? 20, 1), 50);

  // 1. Run existing impact BFS.
  const impact = impactFromIndex(
    index,
    input.qname,
    safeDepth,
    input.filePath,
  );
  if (!impact.target) {
    return {
      target: null,
      totalImpactedNodes: 0,
      highRisk: [],
      suggestedTests: [],
      coedit: [],
      degraded: !analytics,
      degradedReason: analytics ? undefined : analyticsDegradedReason(index),
    };
  }

  const target = impact.target;

  // 2. Coedit lookup for the target file (one git call, used for every
  //    impact node's coeditProb). P0-2: use coEditAuto which tries
  //    commit-granularity first then falls back to merge-granularity
  //    for squash-style projects.
  const coeditByFile = new Map<
    string,
    { cooccurrence: number; total: number; lastCoEdit: string }
  >();
  let coeditOk = true;
  try {
    const co = await coEditAuto(index.cwd, target.filePath, 100);
    const total = co.totalCommits;
    for (const h of co.history) {
      coeditByFile.set(h.filePath, {
        cooccurrence: h.cooccurrence,
        total,
        lastCoEdit: h.lastCoEdit,
      });
    }
    if (total === 0 || co.history.length === 0) coeditOk = false;
  } catch {
    coeditOk = false;
  }

  // 3. Per-node risk score.
  let maxPr = 0;
  if (analytics) {
    for (const v of analytics.pagerank.values()) if (v > maxPr) maxPr = v;
  }

  const scored: RiskNode[] = [];
  for (const node of impact.nodes) {
    if (node.depth === 0) continue; // skip the target itself
    if (isSynthetic(node.symbol.qualifiedName)) continue; // P0-1
    const sym = node.symbol;
    // callFreq: for 1-hop, count actual call-site lines from this node.
    //           for deeper hops, fall back to a depth-decayed default 1.
    let callFreq = 1;
    if (node.depth === 1) {
      const file = index.files.get(sym.filePath);
      if (file) {
        let total = 0;
        for (const c of file.intraCalls) {
          if (c.from === sym.qualifiedName && c.to === input.qname) {
            total += c.lines.length;
          }
        }
        for (const c of file.outgoingCalls) {
          if (
            c.from === sym.qualifiedName &&
            c.to.qualifiedName === input.qname &&
            c.to.filePath === target.filePath
          ) {
            total += c.lines.length;
          }
        }
        callFreq = Math.max(1, total);
      }
    }

    const coeditEntry = coeditByFile.get(sym.filePath);
    const coeditProb =
      coeditEntry && coeditEntry.total > 0
        ? coeditEntry.cooccurrence / coeditEntry.total
        : 0;

    const tests = findSiblingTests(sym.filePath, index.fileSet);
    const hasTest = tests.length > 0;

    const prRaw = analytics
      ? analytics.pagerank.get(makeNodeId(sym.filePath, sym.qualifiedName)) ?? 0
      : 0;
    const prNorm = maxPr > 0 ? prRaw / maxPr : 0;

    // Normalise callFreq into [0,1] with a soft cap at 10.
    const callFreqNorm = Math.min(1, callFreq / 10);
    // Depth decay: deeper nodes are less risky for the same signal strength.
    const depthDecay = 1 / Math.max(1, node.depth);

    // P0-2: weight rebalance.
    //   - When coedit is available: 0.30 callFreq / 0.25 coedit / 0.20 untested / 0.25 PR
    //   - When coedit is unavailable: redistribute the 0.25 to callFreq + untested
    //     (callFreq becomes 0.40, untested becomes 0.35, PR stays 0.25)
    //   The redistribution prevents "no coedit data" from silently
    //   tanking all scores via the 0.25 zero-contribution gap.
    const wCallFreq = coeditOk ? 0.30 : 0.40;
    const wCoedit = coeditOk ? 0.25 : 0;
    const wUntested = coeditOk ? 0.20 : 0.35;
    const wPagerank = 0.25;

    const score =
      depthDecay *
      (wCallFreq * callFreqNorm +
        wCoedit * coeditProb +
        wUntested * (hasTest ? 0 : 1) +
        wPagerank * prNorm);

    const tags: RiskNode['tags'] = [];
    if (score >= 0.5) tags.push('high-risk');
    if (!hasTest) tags.push('untested');
    if (coeditProb >= 0.4) tags.push('frequent-coedit');
    if (prNorm >= 0.5) tags.push('core');
    if (node.depth >= safeDepth) tags.push('leaf');

    scored.push({
      filePath: sym.filePath,
      qualifiedName: sym.qualifiedName,
      name: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      depth: node.depth,
      risk: {
        score,
        callFreq,
        coeditProb,
        hasTest,
        pagerank: prRaw,
      },
      tags,
    });
  }

  // P0-4: deterministic secondary sort — when risk scores tie (common
  // on uniform fan-in/fan-out, like a util called once by N route
  // handlers), break by depth asc, filePath asc, qname asc, line asc.
  scored.sort(
    (a, b) =>
      b.risk.score - a.risk.score ||
      a.depth - b.depth ||
      a.filePath.localeCompare(b.filePath) ||
      a.qualifiedName.localeCompare(b.qualifiedName) ||
      a.startLine - b.startLine,
  );
  const highRisk = scored.slice(0, topK);

  // 4. Test suggestions: union of sibling tests of high-risk nodes,
  //    plus coedit-history test files.
  const testMap = new Map<string, TestSuggestion>();
  for (const node of highRisk) {
    const sibs = findSiblingTests(node.filePath, index.fileSet);
    for (const t of sibs) {
      let entry = testMap.get(t);
      if (!entry) {
        entry = { filePath: t, reason: 'direct-test', coveredNodes: [] };
        testMap.set(t, entry);
      }
      entry.coveredNodes.push(node.qualifiedName);
    }
  }
  for (const [file] of coeditByFile) {
    if (!isTestFile(file)) continue;
    if (testMap.has(file)) continue;
    testMap.set(file, {
      filePath: file,
      reason: 'coedit-history',
      coveredNodes: [],
    });
  }

  const degraded = !analytics || !coeditOk;
  const reason = !analytics
    ? analyticsDegradedReason(index)
    : !coeditOk
      ? 'coedit-unavailable'
      : undefined;

  // 5. Coedit echo: reflect the coedit data we already fetched so the
  //    caller doesn't re-issue a /coedit?filePath=<target> request.
  //    Sorted by cooccurrence desc, capped at 30 entries. (See session
  //    41e0b5ca: Claude ran 3 manual coedit calls after 5 risk calls —
  //    this avoids the duplicate work for the target file at least.)
  const coeditEcho: CoeditEntry[] = [];
  for (const [filePath, c] of coeditByFile) {
    if (c.total === 0) continue;
    coeditEcho.push({
      filePath,
      cooccurrence: c.cooccurrence,
      totalCommits: c.total,
      probability: c.cooccurrence / c.total,
      lastCoEdit: c.lastCoEdit,
    });
  }
  coeditEcho.sort((a, b) => b.cooccurrence - a.cooccurrence || a.filePath.localeCompare(b.filePath));

  return {
    target,
    totalImpactedNodes: impact.nodes.length - 1, // exclude target itself
    highRisk,
    suggestedTests: Array.from(testMap.values()),
    coedit: coeditEcho.slice(0, 30),
    degraded,
    degradedReason: reason,
  };
}
