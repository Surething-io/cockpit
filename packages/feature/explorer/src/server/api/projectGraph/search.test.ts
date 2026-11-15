import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from './search';
import { getCodeIndex, invalidateIndex, searchIndex } from '../../codeMap/projectGraph/codeIndex';
import { SearchTopK } from '../../codeMap/projectGraph/searchRanking';

const exec = promisify(execFile);
const cli = path.resolve('bin/cock-codegraph.mjs');
let cwd: string;
let server: Server;
let port: number;
const invalidFilters: Record<string, string>[] = [
  { path: '../outside' }, { path: '/tmp' }, { path: 'C:\\outside' }, { excludeTests: 'maybe' },
];

async function write(file: string, source: string) {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), source);
}
function request(params: Record<string, string> = {}) {
  return GET(new Request(`http://localhost/api/projectGraph/search?${new URLSearchParams({ cwd, q: 'runConductor', ...params })}`));
}
const run = (args: string[]) => exec(process.execPath, [cli, 'search', ...args], {
  cwd, env: { ...process.env, COCKPIT_PORT: String(port) },
});

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cg-search-'));
  execFileSync('git', ['init', '-q'], { cwd });
  await write('aaa/mock-runConductor.test.ts', Array.from({ length: 620 }, (_, i) =>
    `export function mockRunConductor${String(i).padStart(3, '0')}() { return 'mock_run_conductor_${i}'; }`).join('\n'));
  await write('aaa/prefix.ts', 'export function runConductorExtra() {}\nexport const prefixKey = "runConductorExtra";');
  await write('aaa/normalized.ts', 'export function run_conductor() {}\nexport const key = "run_conductor";');
  await write('src/runConductor.ts', 'export function runConductor(signal: string) { return "runConductor"; }\nexport class Runner { runConductor() {} }\nexport const eventKey = "literal.event";');
  await write('src/nested/other.ts', 'export function runConductor() {}');
  await write('src2/other.ts', 'export function runConductor() {}');
  await write('src/__tests__/other.ts', 'export function runConductorTest() {}');
  await write('src/tests/helper.ts', 'export function runConductorTestHelper() {}');
  server = createServer(async (req, res) => {
    const response = await GET(new Request(new URL(req.url!, 'http://localhost')));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  invalidateIndex(cwd);
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('search across the complete index', () => {
  it('finds exact definitions beyond 500 earlier matches, even with limit=1', async () => {
    const body = await (await request({ limit: '1' })).json();
    expect(body.symbols).toHaveLength(1);
    expect(body.symbols[0].target).toMatchObject({ filePath: 'src/nested/other.ts', name: 'runConductor', kind: 'function' });
    expect(body.symbols[0].target.startLine).toBeGreaterThan(0);
  });

  it('ranks exact, normalized exact, prefix, then substring with stable ties', async () => {
    const body = await (await request({ limit: '8' })).json();
    expect(body.symbols.map((s: { target: { name: string } }) => s.target.name)).toEqual([
      'runConductor', 'runConductor', 'runConductor', 'runConductor',
      'run_conductor', 'runConductorExtra', 'runConductorTest', 'runConductorTestHelper',
    ]);
    const index = await getCodeIndex(cwd);
    const reversed = { ...index, files: new Map([...index.files].reverse()) };
    expect(searchIndex(reversed, 'runConductor', 500, { includeLiterals: true }))
      .toEqual(searchIndex(index, 'runConductor', 500, { includeLiterals: true }));
    expect((await (await request({ q: 'run-conductor', limit: '5' })).json()).symbols).toHaveLength(5);
  });

  it('keeps tests by default, applies directory boundaries and test filters to every category', async () => {
    const all = await (await request({ limit: '500' })).json();
    expect(all.symbols.some((s: { target: { filePath: string } }) => s.target.filePath.endsWith('.test.ts'))).toBe(true);
    const body = await (await request({ path: './src/', excludeTests: 'true', includeLiterals: 'true' })).json();
    for (const entry of [...body.files, ...body.symbols]) {
      expect(entry.target.filePath.startsWith('src/')).toBe(true);
      expect(entry.target.filePath).not.toMatch(/__tests__|\/tests\//);
    }
    expect(body.symbols).toHaveLength(3);
    expect(body.literals).toEqual([expect.objectContaining({ value: 'runConductor', filePath: 'src/runConductor.ts' })]);
    expect(await (await request({ path: 'missing', includeLiterals: 'true' })).json()).toEqual({ files: [], symbols: [], literals: [] });
    expect((await (await request({ excludeTests: 'true', limit: '500' })).json()).symbols)
      .toHaveLength(6);
  });

  it('ranks all literal candidates and preserves per-category defaults and caps', async () => {
    const body = await (await request({ includeLiterals: 'true', limit: '1' })).json();
    expect(body.literals).toEqual([expect.objectContaining({ value: 'runConductor', filePath: 'src/runConductor.ts' })]);
    expect(body.files).toHaveLength(1);
    expect((await (await request()).json()).symbols).toHaveLength(50);
    const capped = await (await request({ limit: '999', includeLiterals: 'true' })).json();
    expect(capped.symbols).toHaveLength(500);
    expect(capped.literals).toHaveLength(500);
    expect(await (await request({ q: '__--', includeLiterals: 'true' })).json()).toEqual({ files: [], symbols: [], literals: [] });
    expect(await (await request({ q: '' })).json()).toEqual({ files: [], symbols: [] });
  });

  it.each(invalidFilters)('rejects invalid filters: %j', async filters => {
    const response = await request(filters);
    expect(response.status).toBe(400);
    expect((await response.json()).tag).toBe('ValidationError');
  });

  it('uses the same ranking and filters in CLI JSON and prints actual coordinates', async () => {
    const args = ['--path', 'src', 'runConductor', '--exclude-tests', '--limit', '1'];
    const body = JSON.parse((await run([...args, '--json'])).stdout);
    const target = body.symbols[0].target;
    const plain = (await run(args)).stdout;
    expect(plain).toContain(`sym \t${target.filePath}:${target.startLine}\t${target.kind}\t${target.qualifiedName}\n`);
    expect(plain).not.toContain('undefined');
    const literal = await run(['runConductor', '--include-literals', '--path', 'src', '--exclude-tests']);
    expect(literal.stdout).toContain('literal\tsrc/runConductor.ts:1\trunConductor\n');
    expect((await run(['literalEvent', '--include-literals'])).stdout).toBe('literal\tsrc/runConductor.ts:3\tliteral.event\n');
    await expect(run(['runConductor', '--path'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('requires a value') });
  });
});

it('bounded selection equals full sorting across insertion orders and limits', () => {
  const compare = (a: number, b: number) => a - b;
  const values = Array.from({ length: 1600 }, (_, i) => (i * 997) % 1601);
  for (const input of [values, [...values].reverse()]) {
    for (const limit of [0, 1, 5, 50, 500]) {
      const selection = new SearchTopK<number>(limit, compare);
      for (const value of input) selection.add(value);
      expect(selection.sorted()).toEqual([...input].sort(compare).slice(0, limit));
    }
  }
});
