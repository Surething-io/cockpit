/**
 * /api/projectGraph/affected — file-level reverse-import closure for test impact.
 *
 * Sister to `/risk`. Where risk is symbol-level, precision-oriented, and
 * built for human/LLM analysis, `affected` is:
 *   - File-level (input is a SET of file paths, e.g. `git diff --name-only`)
 *   - Recall-oriented (BFS the full importedBy closure; better to over-
 *     include a test than to miss one in CI)
 *   - Output-oriented for pipelines (plain test paths, xargs-friendly)
 *
 * Algorithm:
 *   For each input file F:
 *     1. Look up F in CodeIndex.files. Miss → unresolved, skip.
 *     2. BFS frontier = [F]; visited = {F}.
 *     3. Each hop pulls the next-level importers from
 *        IndexedFile.importedBy. Record depth-of-first-discovery.
 *     4. Test files hit during the walk are added to reachableTests.
 *     5. Stop when frontier empty, depth >= cap, or global visited
 *        count exceeds NODE_CAP (truncation guard).
 *   Union test sets across all inputs → testFiles (sorted, unique).
 *
 * Why file-level (not symbol-level): the goal is to feed a test runner.
 * Even if a function isn't called by a test, the test file may import
 * the changed file for types / re-exports / fixtures — and the test
 * runner's module loader will re-evaluate it on every run. Symbol-
 * level analysis would falsely conclude "no test affected" in those
 * cases. File-level mirrors what tools like Jest --findRelatedTests,
 * Nx affected, and Turbo prune do, and matches CI's actual semantics.
 */
import type { CodeIndex } from '../projectGraph/codeIndex';

// ============================================================================
// Public types
// ============================================================================

export interface AffectedInput {
  /** Source files (project-relative paths). */
  files: string[];
  /** BFS depth cap, clamp [1, 20]. Default 10. */
  depth?: number;
  /** Glob filter for the returned test paths (e.g. `**\/*.e2e.ts`). */
  filter?: string;
  /** Include all non-test affected files in the response as well. */
  includeAll?: boolean;
}

export interface AffectedTestEntry {
  filePath: string;
  /** BFS depth at first discovery (1 = direct importer). */
  depth: number;
}

export interface AffectedByInput {
  /** Spelled `filePath` like every other path slot in this API. */
  filePath: string;
  /** Total downstream files reachable via importedBy (incl. tests). */
  reachable: number;
  /** Tests reached from THIS input, ordered by discovery (BFS order). */
  reachableTests: AffectedTestEntry[];
}

export interface AffectedStats {
  /** Sum of unique files visited across all input BFS runs. */
  visited: number;
  /** ms spent in BFS (excludes serialization / glob compile). */
  bfsMs: number;
  /** True when any input BFS hit NODE_CAP. */
  truncated: boolean;
}

export interface AffectedResponse {
  /** Union of test files reached from ALL inputs, unique + sorted. */
  testFiles: string[];
  byInput: AffectedByInput[];
  unresolved: string[];
  allAffected?: string[];
  stats: AffectedStats;
  degraded: boolean;
  degradedReason?:
    | 'all-unresolved'
    | 'analytics-warming'
    | 'truncated';
}

// ============================================================================
// Test file detection
// ============================================================================

/**
 * Patterns that mean "this is a test file". We deliberately union several
 * conventions because monorepos mix languages and styles freely.
 *
 *   - foo.test.ts / foo.spec.py    (JS/TS/Python Jest / pytest)
 *   - test_foo.py                  (pytest underscore-prefix convention)
 *   - foo_test.go                  (Go convention)
 *   - tests/foo.rs                 (Rust integration test directory)
 *   - __tests__/foo.ts             (Jest co-located tests)
 *   - foo.e2e.ts                   (Playwright / Cypress style)
 */
const TEST_PATTERNS: RegExp[] = [
  /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|pyi)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /[^/]+_test\.go$/i,
  /(^|\/)tests?\/[^/]+\.rs$/i,
  /(^|\/)__tests__\/[^/]+\.(ts|tsx|js|jsx|mjs|cjs)$/i,
  /\.e2e\.(ts|tsx|js|jsx)$/i,
];

export function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(filePath));
}

// ============================================================================
// Glob → RegExp (tiny implementation, covers `*` and `**`)
//
// We avoid pulling in `picomatch` etc. — projectGraph already has a small
// glob helper in buildGraph.ts (`globMatchesDir`) but it doesn't anchor
// on full paths the same way. Keep it local + minimal.
// ============================================================================

function globToRegex(glob: string): RegExp {
  // Use a sentinel token to protect `**` while we expand single `*`.
  // (Same pattern as buildGraph.ts:globMatchesDir.)
  const SENTINEL = '___DOUBLESTAR___';
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, SENTINEL)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(SENTINEL, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

// ============================================================================
// Core BFS
// ============================================================================

/** Global cap to keep the BFS bounded on huge monorepos. Tuned so a 10K
 *  file project can walk the whole graph in well under a second; if
 *  you're hitting this, the input set is suspiciously broad. */
const NODE_CAP = 10000;

export function findAffected(
  index: CodeIndex,
  input: AffectedInput,
): AffectedResponse {
  const t0 = Date.now();
  const maxDepth = Math.min(Math.max(input.depth ?? 10, 1), 20);
  const filter = input.filter ? globToRegex(input.filter) : null;

  // Normalise + dedupe inputs.
  const normalised = Array.from(new Set(input.files.map((f) => f.trim()).filter(Boolean)));

  const testUnion = new Set<string>();
  const allAffected = input.includeAll ? new Set<string>() : null;
  const byInput: AffectedByInput[] = [];
  const unresolved: string[] = [];
  const globalVisited = new Set<string>();
  let truncated = false;

  for (const startFile of normalised) {
    const indexed = index.files.get(startFile);
    if (!indexed) {
      unresolved.push(startFile);
      continue;
    }

    const visited = new Set<string>([startFile]);
    const reachableTests: AffectedTestEntry[] = [];
    let frontier: string[] = [startFile];

    // BFS up through importedBy, recording depth-of-first-discovery.
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      if (truncated) break;
      const next: string[] = [];
      for (const f of frontier) {
        if (truncated) break;
        const node = index.files.get(f);
        if (!node) continue;
        for (const importer of node.importedBy) {
          if (visited.has(importer)) continue;
          visited.add(importer);
          globalVisited.add(importer);
          if (globalVisited.size > NODE_CAP) {
            truncated = true;
            break;
          }
          next.push(importer);

          if (isTestFile(importer)) {
            if (filter && !filter.test(importer)) {
              // Filter rejects → still mark visited (don't re-walk) but
              // don't add to test results. Note we DO still walk past
              // it via the next pass, so transitive tests behind a
              // filtered test still surface.
            } else {
              reachableTests.push({ filePath: importer, depth });
              testUnion.add(importer);
            }
          } else if (allAffected) {
            allAffected.add(importer);
          }
        }
      }
      frontier = next;
    }

    byInput.push({
      filePath: startFile,
      reachable: visited.size - 1, // exclude the input itself
      reachableTests,
    });
  }

  const stats: AffectedStats = {
    visited: globalVisited.size,
    bfsMs: Date.now() - t0,
    truncated,
  };

  // Build response with the right degraded signal.
  const allUnresolved =
    normalised.length > 0 && unresolved.length === normalised.length;
  const degraded = truncated || allUnresolved;
  const degradedReason: AffectedResponse['degradedReason'] = truncated
    ? 'truncated'
    : allUnresolved
      ? 'all-unresolved'
      : undefined;

  const result: AffectedResponse = {
    testFiles: Array.from(testUnion).sort(),
    byInput,
    unresolved,
    stats,
    degraded,
    degradedReason,
  };
  if (allAffected) {
    result.allAffected = Array.from(allAffected).sort();
  }
  return result;
}
