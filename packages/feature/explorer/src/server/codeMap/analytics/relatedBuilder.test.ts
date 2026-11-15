import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodeIndex, invalidateIndex, type CodeIndex } from '../projectGraph/codeIndex';
import { buildRelated } from './relatedBuilder';
import { coEditAuto } from '../projectGraph/coedit';

vi.mock('../projectGraph/coedit', () => ({ coEditAuto: vi.fn() }));
const coedit = vi.mocked(coEditAuto);
let cwd: string;
let index: CodeIndex;
const run = (input: Parameters<typeof buildRelated>[1]) => Effect.runPromise(buildRelated(index, input));

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cg-related-'));
  await writeFile(join(cwd, 'core.ts'), 'export function leaf() {}\nexport function target() { leaf(); }\n');
  await writeFile(join(cwd, 'caller.ts'), "import { target } from './core';\nexport function caller() { target(); }\n");
  await writeFile(join(cwd, 'partner.ts'), "import './core';\nexport const partner = 'registry';\n");
  await writeFile(join(cwd, 'other.ts'), 'export function target() {}\n');
  execFileSync('git', ['init', '-q'], { cwd });
  index = await getCodeIndex(cwd);
});
afterAll(async () => { invalidateIndex(cwd); await rm(cwd, { recursive: true, force: true }); });
beforeEach(() => {
  coedit.mockReset();
  coedit.mockResolvedValue({ target: 'core.ts', totalCommits: 0, history: [], uncommitted: [] });
});

describe('related from the base index', () => {
  it('returns real callers and callees without git or a secondary index', async () => {
    const response = await run({ qname: 'target', filePath: 'core.ts', include: 'structural' });
    expect(response.degraded).toBe(false);
    expect(response.results.map((s) => [s.name, s.relations])).toEqual([
      ['caller', [{ type: 'caller', callLines: [2] }]],
      ['leaf', [{ type: 'callee', callLines: [2] }]],
    ]);
    expect(coedit).not.toHaveBeenCalled();
    expect(await run({ qname: 'target', filePath: 'core.ts', include: 'structural', topK: 1 }))
      .toMatchObject({ results: [response.results[0]] });
  });

  it('reports ambiguous and missing targets', async () => {
    expect(await run({ qname: 'target' })).toMatchObject({ target: null, ambiguousIn: ['core.ts', 'other.ts'], results: [], coedit: [] });
    expect(await run({ qname: 'missing' })).toMatchObject({ target: null, results: [], degraded: false });
    expect(coedit).not.toHaveBeenCalled();
  });

  it('uses a real symbol for coedit navigation and retains non-code history', async () => {
    coedit.mockResolvedValue({ target: 'core.ts', totalCommits: 10, uncommitted: [], history: [
      { filePath: 'partner.ts', cooccurrence: 5, probability: 0.5, lastCoEdit: '2026-01-01' },
      { filePath: 'registry.json', cooccurrence: 3, probability: 0.3, lastCoEdit: '2026-01-01' },
    ] });
    const response = await run({ qname: 'target', filePath: 'core.ts', include: 'coedit' });
    expect(response.degraded).toBe(false);
    expect(response.results).toMatchObject([{ name: 'partner', relations: [
      { type: 'frequent-coedit', cooccurrence: 5, totalCommits: 10 },
    ] }]);
    expect(response.coedit.map((row) => row.filePath)).toEqual(['partner.ts', 'registry.json']);
  });

  it('distinguishes empty git history from unavailable history', async () => {
    expect((await run({ qname: 'target', filePath: 'core.ts' })).degraded).toBe(false);
    coedit.mockRejectedValue(new Error('git unavailable'));
    const response = await run({ qname: 'target', filePath: 'core.ts' });
    expect(response).toMatchObject({ degraded: true, degradedReason: 'coedit-unavailable' });
    expect(response.results).toHaveLength(2);
  });

  it('reports truncated source coverage', async () => {
    const response = await Effect.runPromise(buildRelated({ ...index, truncated: true }, {
      qname: 'target', filePath: 'core.ts', include: 'structural',
    }));
    expect(response).toMatchObject({ degraded: true, degradedReason: 'truncated' });
  });

  it('reads refreshed outgoing relations without an analysis invalidation step', async () => {
    await writeFile(join(cwd, 'core.ts'), 'export function leaf() {}\nexport function target() {}\n');
    index = await getCodeIndex(cwd);
    const response = await run({ qname: 'target', filePath: 'core.ts', include: 'structural' });
    expect(response.results.map((hit) => hit.name)).toEqual(['caller']);
  });
});
