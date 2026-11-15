/**
 * Constraint: CodeIndexBuildsOnlyOnDemand (memory, L1 static).
 *
 * Only code that answers an explicit code-graph question may build a whole-project index:
 * the /api/projectGraph/* routes (Code Map UI, the /cg skill, `cockpit
 * codegraph`). Everything else — symbol previews, end-of-turn review, anything
 * that runs merely because a project is open — must use `peekCodeIndex` and
 * degrade when there is no index.
 *
 * Why: background builds from the block view and review fired for every
 * mounted project after a server restart and held 7.3 GB live on a production
 * heap, with ~3 s full-GC pauses that stalled every request.
 *
 * Exception: file-functions may query relations on `relations=1` for supported
 * source files, or rebuild on explicit `refresh=1`. Symbol-only previews stay local.
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
        let source = readFileSync(abs, 'utf8');
        if (rel === FILE_FUNCTIONS) {
          expect(source).toMatch(/const\s+includeRelations\s*=\s*sp\.get\(["']relations["']\)\s*===\s*["']1["']/);
          // Remove only the explicitly gated project query. Any other build
          // in this route must still be reported by the scan below.
          source = source.replace(/if\s*\(includeRelations\s*&&\s*isIndexSource\(normalizedPath\)\)\s*\{\s*await\s+getCodeIndex\(cwd,\s*\{\s*forceRefresh\s*\}\)\s*\}/g, '');
        }
        const calls = source
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
