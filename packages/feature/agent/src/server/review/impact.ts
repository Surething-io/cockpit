/**
 * Impact & gaps and the decision check for a review range
 * (docs/DECISION_MODE.md §6, §7.2).
 *
 * Changed symbols come from parsing each changed file's before / after
 * content with the SAME per-language handlers the code index uses. Callers,
 * neighbors and affected tests come from the index — only if it is already
 * built (never awaited inside a request); otherwise that is reported as a
 * blind spot, not silently skipped.
 */
import { realpath } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import type { AppError, FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import type { SnapshotService } from '@cockpit/effect-services';
import {
  computeReview,
  findTouched,
  IMPACT_TOP_N,
  listDecisions,
  readGitInfo,
  requireProject,
  type BlindSpot,
  type BodyChange,
  type CallerGap,
  type ImpactResult,
  type SymbolChange,
  type TestCoverage,
  type VerificationResult,
  type VerificationRunInput,
} from '@cockpit/feature-decisions/server';
import '@cockpit/feature-explorer/server/codeMap/handlers/index';
import { getHandler } from '@cockpit/feature-explorer/server/codeMap/handlers/registry';
import { getServerParser, grammarForExtension } from '@cockpit/feature-explorer/server/codeMap/projectGraph/serverTreeSitter';
import {
  calleesFromIndex,
  callersFromIndex,
  ensureCodeIndex,
  peekCodeIndex,
  type CodeIndex,
} from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import { findAffected } from '@cockpit/feature-explorer/server/codeMap/analytics/index';
import type { ExtractedSymbol } from '@cockpit/feature-explorer/server/codeMap/types';
import { verifyRange } from './verification';

// ─────────────────────────────────────────────────────────
// Symbol diff (pure)
// ─────────────────────────────────────────────────────────

export interface SymbolShape {
  qname: string;
  kind: string;
  /** Kind + parameters + first source line: what callers depend on. */
  header: string;
  hash: string;
}

export function flattenSymbols(tree: readonly ExtractedSymbol[], source: string): SymbolShape[] {
  const lines = source.split('\n');
  const out: SymbolShape[] = [];
  const walk = (s: ExtractedSymbol) => {
    if (s.kind !== 'unknown') {
      out.push({
        qname: s.qualifiedName,
        kind: s.kind,
        header: `${s.kind}|${(s.params ?? []).join(',')}|${(lines[s.startLine - 1] ?? '').trim()}`,
        hash: s.contentHash,
      });
    }
    s.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

export function diffSymbols(before: readonly SymbolShape[], after: readonly SymbolShape[]): Array<{ qname: string; change: SymbolChange }> {
  const old = new Map(before.map((s) => [s.qname, s]));
  const now = new Map(after.map((s) => [s.qname, s]));
  const out: Array<{ qname: string; change: SymbolChange }> = [];
  for (const [q, s] of now) {
    const o = old.get(q);
    if (!o) out.push({ qname: q, change: 'added' });
    else if (o.hash !== s.hash) out.push({ qname: q, change: o.header === s.header ? 'body' : 'interface' });
  }
  for (const q of old.keys()) if (!now.has(q)) out.push({ qname: q, change: 'removed' });
  return out;
}

export async function parseShapes(path: string, source: string | null): Promise<SymbolShape[] | null> {
  if (source === null || source === '') return [];
  const grammar = grammarForExtension(path);
  if (!grammar || source.length > 1_000_000) return null;
  const parser = await getServerParser(grammar);
  const tree = parser.parse(source);
  if (!tree) return null;
  try {
    return flattenSymbols(getHandler(grammar).extractSymbols(tree.rootNode, source), source);
  } finally {
    tree.delete();
  }
}

/** Source extensions the analysis would want but has no grammar for → "unsupported language". */
const CODE_EXT = new Set(['.java', '.kt', '.kts', '.swift', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.scala', '.dart', '.vue', '.svelte', '.ex', '.exs', '.erl', '.clj', '.lua', '.r', '.jl', '.zig', '.sh']);

// ─────────────────────────────────────────────────────────
// Tests × verification (pure)
// ─────────────────────────────────────────────────────────

export function testCoverage(tests: readonly string[], verification: VerificationResult): TestCoverage[] {
  const testRuns = verification.runs.filter((r) => r.kind === 'test');
  return tests.map((test) => {
    // Latest run that covers this test: a full run, or a filtered one naming it (or its directory).
    const run = [...testRuns].reverse().find((r) => !r.filtered || r.targets.some((t) => test === t || test.startsWith(`${t.replace(/\/$/, '')}/`)));
    return run ? { test, state: run.state, toolId: run.toolId } : { test, state: 'not-run' };
  });
}

// ─────────────────────────────────────────────────────────
// Effect
// ─────────────────────────────────────────────────────────

const MAX_NEIGHBOR_SYMBOLS = 100;

export const analyzeImpact = (
  cwd: string,
  orderedToolIds: ReadonlyArray<string>,
  runs: ReadonlyArray<VerificationRunInput>,
  claimedPass: boolean,
  /** Status bar: only the decisions this change directly touches — no parsing, no index. */
  decisionsOnly = false,
): Effect.Effect<ImpactResult, AppError | FSError | NotFoundError | ValidationError, SnapshotService> =>
  Effect.gen(function* () {
    const project = yield* requireProject(cwd);
    const review = yield* computeReview(cwd, orderedToolIds, !decisionsOnly);
    const files = review.empty ? [] : review.files.filter((f) => f.category !== 'other-session');
    const changedPaths = new Set(files.map((f) => f.path));
    const toplevelOf = Effect.gen(function* () {
      const toplevel = (yield* readGitInfo(cwd))?.toplevel ?? cwd;
      const realCwd = yield* Effect.promise(() => realpath(cwd).catch(() => cwd));
      return (p: string) => relative(toplevel, resolve(realCwd, p)).split(sep).join('/');
    });
    if (decisionsOnly) {
      const top = yield* toplevelOf;
      const touched = yield* findTouched(project.projectId, cwd, yield* listDecisions(project.projectId), new Set([...changedPaths].map(top)), new Set());
      return { touched, interfaceGaps: [], tests: [], bodyOnly: [], blindSpots: [], totals: { interfaceGaps: 0, tests: 0, bodyOnly: 0 } };
    }

    // ── changed symbols ──
    const blind: BlindSpot[] = [];
    const unsupported: string[] = [];
    const parseFailed: string[] = [];
    const changes: Array<{ file: string; qname: string; change: SymbolChange }> = [];
    for (const f of files) {
      if (!grammarForExtension(f.path)) {
        if (CODE_EXT.has(extname(f.path).toLowerCase())) unsupported.push(f.path);
        continue;
      }
      if (f.oldContent === null && f.newContent === null && f.status === 'modified') {
        parseFailed.push(f.path); // binary / over the size cap
        continue;
      }
      const [before, after] = yield* Effect.promise(() =>
        Promise.all([parseShapes(f.path, f.status === 'added' ? '' : f.oldContent), parseShapes(f.path, f.status === 'deleted' ? '' : f.newContent)]).catch(() => [null, null] as const),
      );
      if (!before || !after) {
        parseFailed.push(f.path);
        continue;
      }
      for (const c of diffSymbols(before, after)) changes.push({ file: f.path, ...c });
    }
    if (unsupported.length) blind.push({ kind: 'unsupported-language', files: unsupported });
    if (parseFailed.length) blind.push({ kind: 'parse-failed', files: parseFailed });

    // ── index-backed parts ──
    const index: CodeIndex | null = peekCodeIndex(cwd);
    if (!index) {
      ensureCodeIndex(cwd);
      blind.push({ kind: 'index-building', files: [] });
    } else if (index.truncated) {
      blind.push({ kind: 'index-truncated', files: [] });
    }

    const gaps: CallerGap[] = [];
    const neighbors = new Set<string>();
    if (index) {
      for (const c of changes) {
        if (c.change === 'added') continue;
        if (c.change !== 'body') {
          const callers = callersFromIndex(index, c.qname, c.file).callers
            .filter((x) => !changedPaths.has(x.caller.filePath))
            .map((x) => ({ file: x.caller.filePath, qname: x.caller.qualifiedName, lines: x.callLines }));
          if (callers.length) gaps.push({ file: c.file, qname: c.qname, change: c.change, callers });
        }
      }
      for (const c of changes.filter((x) => x.change !== 'added').slice(0, MAX_NEIGHBOR_SYMBOLS)) {
        for (const x of callersFromIndex(index, c.qname, c.file).callers) neighbors.add(x.caller.filePath);
        for (const x of calleesFromIndex(index, c.qname, c.file).callees) neighbors.add(x.callee.filePath);
      }
    }
    // Deleted-but-referenced first, then by how many callers are left behind.
    gaps.sort((a, b) => (a.change === 'removed' ? 0 : 1) - (b.change === 'removed' ? 0 : 1) || b.callers.length - a.callers.length);

    const verification = yield* verifyRange(cwd, orderedToolIds, runs, claimedPass);
    let tests: TestCoverage[] = [];
    const testsByFile = new Map<string, string[]>();
    if (index && changedPaths.size > 0) {
      const affected = findAffected(index, { files: [...changedPaths] });
      tests = testCoverage(affected.testFiles, verification);
      for (const b of affected.byInput) testsByFile.set(b.filePath, b.reachableTests.map((t) => t.filePath));
      if (affected.unresolved.length) blind.push({ kind: 'unresolved-import', files: affected.unresolved });
    }
    // Not run / failed / rerun first: those are the gaps.
    const testRank = (t: TestCoverage) => (t.state === 'verified' ? 2 : t.state === 'not-run' ? 0 : 1);
    tests.sort((a, b) => testRank(a) - testRank(b));

    const bodyOnly: BodyChange[] = changes
      .filter((c) => c.change === 'body')
      .map((c) => ({ file: c.file, qname: c.qname, tests: testsByFile.get(c.file) ?? [] }));

    // ── decision check: paths relative to the git toplevel, like decision links ──
    const top = yield* toplevelOf;
    const decisions = yield* listDecisions(project.projectId);
    const touched = yield* findTouched(
      project.projectId,
      cwd,
      decisions,
      new Set([...changedPaths].map(top)),
      new Set([...neighbors].filter((p) => !changedPaths.has(p)).map(top)),
    );

    return {
      touched,
      interfaceGaps: gaps.slice(0, IMPACT_TOP_N),
      tests: tests.slice(0, IMPACT_TOP_N),
      bodyOnly: bodyOnly.slice(0, IMPACT_TOP_N),
      blindSpots: blind,
      totals: { interfaceGaps: gaps.length, tests: tests.length, bodyOnly: bodyOnly.length },
    };
  });
