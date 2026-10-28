/**
 * Constraint: FileFunctionsNeverAwaitsFullBuild (latency, L2 behavioural).
 *
 * GET /api/projectGraph/file-functions answers from the focal file alone
 * whenever the project index is not built yet. The file-local layer
 * (`functions`, `intraCalls`) comes back at once, flagged
 * `crossFilePending: true`; the build is started in the background and a
 * later request, after the index exists, returns the full projection
 * (cross-file edges included) with the flag cleared.
 *
 * Why: the route used to `await getCodeIndex(cwd)` before looking at the one
 * file it was asked about. On a 12.8K-file repo that is a ~45s cold build
 * (tree-sitter parse of every file), so opening a single diff — which only
 * wanted a function name for the compact-gap label — hung for 47s, and every
 * other request queued behind the parse on the main thread.
 *
 * Pinned through the real route against a fresh fixture repo: had the route
 * awaited the build, the first response would already carry the full index
 * and no `crossFilePending` flag.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GET } from '../packages/feature/explorer/src/server/api/projectGraph/file-functions';
import {
  getCodeIndex,
  invalidateIndex,
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
  it('answers from the focal file while the index is cold, then serves the full projection', async () => {
    const cold = await fetchFunctions('src/a.ts');
    expect(cold.crossFilePending).toBe(true);
    expect(cold.functions.map((f) => f.name)).toEqual(expect.arrayContaining(['inner', 'outer']));
    expect(cold.intraCalls).toEqual([expect.objectContaining({ from: 'outer', to: 'inner' })]);
    // Import-dependent data belongs to the cross-file layer: without the
    // project fileset `./b` cannot be resolved, and must not be passed off
    // as an npm package instead.
    expect(cold.externalCalls).toEqual([]);
    expect(cold.downstreamCalls).toEqual([]);

    // The cold request started the build; once it lands, the same route
    // returns cross-file edges and drops the flag.
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
