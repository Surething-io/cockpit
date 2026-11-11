/**
 * Constraint: FileFunctionsNeverAwaitsFullBuild (latency, L2 behavioural).
 *
 * GET /api/projectGraph/file-functions answers from the focal file alone
 * whenever the project index is not built yet. The file-local layer
 * (`functions`, `intraCalls`) comes back at once. The route does NOT start a
 * build, so the answer is not flagged `crossFilePending`; once something
 * else builds the index (Code Map, the graph routes), the same route returns
 * the full projection with cross-file edges.
 *
 * Why: the route used to `await getCodeIndex(cwd)` before looking at the one
 * file it was asked about. On a 12.8K-file repo that is a ~45s cold build
 * (tree-sitter parse of every file), so opening a single diff — which only
 * wanted a function name for the compact-gap label — hung for 47s, and every
 * other request queued behind the parse on the main thread.
 *
 * Why it does not start one either (changed 2026-11-11, human-reviewed): it
 * used to kick off the build in the background. Every project stays mounted,
 * so after a server restart each project with a file open in the block view
 * hit this route at once and started a whole-project build plus analytics —
 * ~1.3 GB per large repo, 7.3 GB live across five worktrees on a production
 * heap, with ~3 s full-GC pauses that stalled every request on the server.
 *
 * Pinned through the real route against a fresh fixture repo: had the route
 * awaited the build, the first response would already carry the full index;
 * had it started one, the index would exist (or be building) afterwards.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GET } from '../packages/feature/explorer/src/server/api/projectGraph/file-functions';
import {
  codeIndexBuilding,
  getCodeIndex,
  invalidateIndex,
  peekCodeIndex,
} from '../packages/feature/explorer/src/server/codeMap/projectGraph/codeIndex';

const work = mkdtempSync(join(tmpdir(), 'cockpit-file-functions-'));
afterAll(() => {
  invalidateIndex(work);
  rmSync(work, { recursive: true, force: true });
});

mkdirSync(join(work, 'src'), { recursive: true });
writeFileSync(
  join(work, 'src/a.ts'),
  [
    "import { helper } from './b';",
    'export function outer() {',
    '  return inner() + helper();',
    '}',
    'function inner() {',
    '  return 1;',
    '}',
    '',
  ].join('\n'),
);
writeFileSync(join(work, 'src/b.ts'), 'export function helper() {\n  return 2;\n}\n');
execFileSync('git', ['init', '-q'], { cwd: work });

interface Payload {
  functions: { name: string }[];
  intraCalls: { from: string; to: string }[];
  externalCalls: unknown[];
  downstreamCalls: { external: { filePath: string; name: string } }[];
  crossFilePending?: boolean;
}

const fetchFunctions = async (path: string): Promise<Payload> => {
  const url = `http://localhost/api/projectGraph/file-functions?cwd=${encodeURIComponent(work)}&path=${encodeURIComponent(path)}`;
  const res = await (GET as (req: Request) => Promise<Response>)(new Request(url));
  expect(res.status).toBe(200);
  return (await res.json()) as Payload;
};

describe('FileFunctionsNeverAwaitsFullBuild', () => {
  it('answers from the focal file while the index is cold, without starting a build, then serves the full projection', async () => {
    const cold = await fetchFunctions('src/a.ts');
    // No build was started, so no cross-file data is promised.
    expect(cold.crossFilePending).toBeFalsy();
    expect(codeIndexBuilding(work)).toBe(false);
    expect(peekCodeIndex(work)).toBeNull();
    expect(cold.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['inner', 'outer']));
    expect(cold.intraCalls).toEqual([expect.objectContaining({ from: 'outer', to: 'inner' })]);
    // Import-dependent data belongs to the cross-file layer: without the
    // project fileset `./b` cannot be resolved, and must not be passed off
    // as an npm package instead.
    expect(cold.externalCalls).toEqual([]);
    expect(cold.downstreamCalls).toEqual([]);

    // Once something else builds the index, the same route returns
    // cross-file edges.
    await getCodeIndex(work);
    const warm = await fetchFunctions('src/a.ts');
    expect(warm.crossFilePending).toBeFalsy();
    // The file-local layer is final, not a preview: identical once indexed.
    expect(warm.functions).toEqual(cold.functions);
    expect(warm.intraCalls).toEqual(cold.intraCalls);
    expect(warm.downstreamCalls.map((e) => `${e.external.filePath}#${e.external.name}`)).toEqual([
      'src/b.ts#helper',
    ]);
  });
});
