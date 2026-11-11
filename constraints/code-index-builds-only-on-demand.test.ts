/**
 * Constraint: CodeIndexBuildsOnlyOnDemand (memory, L1 static).
 *
 * A whole-project Code Map index (plus its analytics) costs ~1.3 GB on a large
 * repo. Only code that answers an explicit code-graph question may build one:
 * the /api/projectGraph/* routes (Code Map UI, the /cg skill, `cockpit
 * codegraph`). Everything else — the block view, end-of-turn review, anything
 * that runs merely because a project is open — must use `peekCodeIndex` and
 * degrade when there is no index.
 *
 * Why: background builds from the block view and review fired for every
 * mounted project after a server restart and held 7.3 GB live on a production
 * heap, with ~3 s full-GC pauses that stalled every request.
 *
 * Exception: file-functions may rebuild on an explicit `refresh=1` (the user
 * clicked rebuild), written as `ensureCodeIndex(cwd, { forceRefresh: true })`.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN = ['packages', 'src'];
const GRAPH_ROUTES = 'packages/feature/explorer/src/server/api/projectGraph/';
const CODE_INDEX = 'packages/feature/explorer/src/server/codeMap/projectGraph/codeIndex.ts';
const FILE_FUNCTIONS = `${GRAPH_ROUTES}file-functions.ts`;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* sourceFiles(abs);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield abs;
  }
}

describe('CodeIndexBuildsOnlyOnDemand', () => {
  it('only the code-graph routes build a project index', () => {
    const offenders: string[] = [];
    for (const top of SCAN) {
      for (const abs of sourceFiles(join(ROOT, top))) {
        const rel = relative(ROOT, abs).split('\\').join('/');
        if (rel === CODE_INDEX) continue;
        // Comment lines mention these names in prose; only code counts.
        const calls = readFileSync(abs, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .filter((line) => /\b(?:ensureCodeIndex|getCodeIndex)\(/.test(line));
        for (const call of calls) {
          if (rel === FILE_FUNCTIONS) {
            if (/ensureCodeIndex\(cwd, \{ forceRefresh: true \}\)/.test(call)) continue;
          } else if (rel.startsWith(GRAPH_ROUTES)) {
            continue;
          }
          offenders.push(`${rel}: ${call.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
