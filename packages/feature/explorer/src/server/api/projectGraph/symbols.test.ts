import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GET } from './symbols';
import { GET as searchGET } from './search';
import { GET as callersGET } from './callers';
import { GET as calleesGET } from './callees';
import { GET as impactGET } from './impact';
import { GET as relatedGET } from './related';
import { invalidateIndex, peekCodeIndex } from '../../codeMap/projectGraph/codeIndex';
import { INDEX_SOURCE_LIMIT_BYTES } from '../../codeMap/projectGraph/indexFiles';

const exec = promisify(execFile);
const cli = path.resolve('bin/cock-codegraph.mjs');
let cwd: string;
let server: Server | undefined;
let port: number;
const invalidFilters: Record<string, string>[] = [
  { path: '../outside' }, { path: '/tmp' }, { path: 'C:\\outside' },
  { kind: 'invalid' }, { kind: '' }, { excludeTests: 'invalid' },
  { exclude: '' }, { exclude: '!src/**' }, { exclude: '../outside/**' },
  { includeSynthetic: 'invalid' }, { format: 'invalid' },
];
async function write(file: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await fs.writeFile(path.join(cwd, file), source);
}
function request(params: Record<string, string> = {}, excludes: string[] = []): Promise<Response> {
  const query = new URLSearchParams({ cwd, ...params });
  for (const pattern of excludes) query.append('exclude', pattern);
  return GET(new Request(`http://localhost/api/projectGraph/symbols?${query}`));
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cg-symbols-'));
  execFileSync('git', ['init', '-q'], { cwd });
  await write('src/core.ts', 'export function outer(a: string) { function inner() {} return a; }\nexport class Box { run(x: string) { return x; } }\nexport const answer = 42;\n');
  await write('src/nested/util.ts', 'export const helper = () => 1;\n');
  await write('src2/other.ts', 'export function outside() {}\n');
  await write('src/core.test.ts', 'export function testBody() {}\n');
  await write('src/__tests__/nested/example.ts', 'export function nestedTest() {}\n');
  await write('src/tests/helpers/sample.ts', 'export function testHelper() {}\n');
  await write('src/generated/schema.ts', 'export function generated() {}\n');
  await write('src/mock,fixtures/fake.ts', 'export function fake() {}\n');
});
afterEach(async () => {
  if (server) { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; }
  invalidateIndex();
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('symbols API', () => {
  it('returns flat function/method coordinates with consistent revision metadata', async () => {
    const response = await request();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.total).toBe(body.symbols.length);
    expect(body.incomplete).toBe(false);
    expect(body.excludedFiles).toEqual([]);
    expect(String(body.revision)).toBe(response.headers.get('X-Code-Index-Revision'));
    expect(response.headers.get('X-Code-Index-Incomplete')).toBe('0');
    expect(body.symbols).toContainEqual(expect.objectContaining({ filePath: 'src/core.ts', qualifiedName: 'Box>run', kind: 'method', params: ['x'] }));
    expect(body.symbols.every((s: { kind: string }) => ['function', 'method'].includes(s.kind))).toBe(true);
    expect(body.symbols.some((s: { name: string }) => s.name === 'testBody')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('export function');
  });

  it('combines directory boundaries, kind filters, test detection and repeated exclusion globs', async () => {
    const response = await request({ path: './src/', kind: 'function,method', excludeTests: 'true' }, ['**/generated/**', '**/mock,fixtures/**']);
    const body = await response.json();
    expect([...new Set(body.symbols.map((s: { filePath: string }) => s.filePath))]).toEqual(['src/core.ts', 'src/nested/util.ts']);
    const all = await (await request({ path: 'src', kind: 'all' })).json();
    expect(all.symbols).toContainEqual(expect.objectContaining({ name: 'Box', kind: 'class' }));
    expect(all.symbols).toContainEqual(expect.objectContaining({ name: 'answer', kind: 'const' }));
    expect((await (await request({ kind: 'class' })).json()).symbols).toEqual([expect.objectContaining({ name: 'Box', kind: 'class' })]);
    expect(await (await request({ path: 'missing' })).json()).toMatchObject({ total: 0, symbols: [], incomplete: false });
    const braces = await (await request({}, ['**/*.{test,spec}.ts'])).json();
    expect(braces.symbols.some((s: { name: string }) => s.name === 'testBody')).toBe(false);
  });

  it.each(invalidFilters)('rejects invalid filters without building an index: %j', async params => {
    const response = await request(params);
    expect(response.status).toBe(400);
    expect((await response.json()).tag).toBe('ValidationError');
    expect(peekCodeIndex(cwd)).toBeNull();
  });

  it('separates real symbols from display blocks without hiding real underscore names', async () => {
    await write('src/blocks.ts', "import './core';\nconsole.log('top-level');\nexport function __real() {}\n");
    const real = await (await request({ kind: 'all' })).json();
    expect(real.symbols.some((s: { kind: string }) => s.kind === 'unknown')).toBe(false);
    expect(real.symbols).toContainEqual(expect.objectContaining({ name: '__real', kind: 'function' }));
    const raw = await (await request({ kind: 'all', includeSynthetic: 'true' })).json();
    expect(raw.symbols.some((s: { kind: string }) => s.kind === 'unknown')).toBe(true);
    expect(raw.total).toBeGreaterThan(real.total);
    expect((await (await request({ kind: 'unknown', includeSynthetic: 'true' })).json()).symbols.every((s: { kind: string }) => s.kind === 'unknown')).toBe(true);
  });

  it('summarizes the same filtered revision without returning symbol coordinates', async () => {
    const filters = { path: 'src', excludeTests: 'true', kind: 'all' };
    const excludes = ['**/generated/**', '**/mock,fixtures/**'];
    const full = await (await request(filters, excludes)).json();
    const summary = await (await request({ ...filters, format: 'summary' }, excludes)).json();
    expect(summary).not.toHaveProperty('symbols');
    expect(summary).toMatchObject({ revision: full.revision, incomplete: full.incomplete, total: full.total, files: 2,
      byKind: { function: 2, method: 1, class: 1, const: 1 }, excludedFiles: [],
      byDirectory: [
        { path: 'src', total: 4, files: 1, byKind: { function: 1, method: 1, class: 1, const: 1 } },
        { path: 'src/nested', total: 1, files: 1, byKind: { function: 1 } },
      ],
    });
    expect(await (await request({ format: 'summary', path: 'missing' })).json()).toMatchObject({ total: 0, files: 0, byKind: {}, byDirectory: [] });
    await write('huge.ts', ' '.repeat(INDEX_SOURCE_LIMIT_BYTES + 1));
    expect(await (await request({ ...filters, format: 'summary' }, excludes)).json()).toMatchObject({ incomplete: true, excludedFiles: [expect.objectContaining({ filePath: 'huge.ts' })] });
  });

  it('reports source-index incompleteness even when filtering out the oversized file', async () => {
    await write('huge.ts', ' '.repeat(INDEX_SOURCE_LIMIT_BYTES + 1));
    const response = await request({ path: 'src' });
    expect(response.headers.get('X-Code-Index-Incomplete')).toBe('1');
    expect(await response.json()).toMatchObject({ incomplete: true, excludedFiles: [{
      filePath: 'huge.ts', reason: 'source-too-large', sizeBytes: INDEX_SOURCE_LIMIT_BYTES + 1, limitBytes: INDEX_SOURCE_LIMIT_BYTES,
    }] });
  });

  it('admits exactly 2 MiB and reports UTF-8 byte exclusions, then clears resolved exclusions', async () => {
    const header = 'export function boundary() {}\n';
    const exact = header + ' '.repeat(INDEX_SOURCE_LIMIT_BYTES - Buffer.byteLength(header));
    const unicode = '//' + '汉'.repeat(Math.ceil(INDEX_SOURCE_LIMIT_BYTES / 3));
    expect(unicode.length).toBeLessThan(INDEX_SOURCE_LIMIT_BYTES);
    await write('boundary.ts', exact);
    await write('above.ts', exact + ' ');
    await write('unicode.ts', unicode);
    const first = await (await request()).json();
    expect(first.symbols).toContainEqual(expect.objectContaining({ filePath: 'boundary.ts', name: 'boundary' }));
    expect(first.excludedFiles).toEqual([
      { filePath: 'above.ts', reason: 'source-too-large', sizeBytes: INDEX_SOURCE_LIMIT_BYTES + 1, limitBytes: INDEX_SOURCE_LIMIT_BYTES },
      { filePath: 'unicode.ts', reason: 'source-too-large', sizeBytes: Buffer.byteLength(unicode), limitBytes: INDEX_SOURCE_LIMIT_BYTES },
    ]);
    const old = peekCodeIndex(cwd)!;
    await write('above.ts', header);
    await fs.unlink(path.join(cwd, 'unicode.ts'));
    const restored = await (await request()).json();
    expect(restored).toMatchObject({ incomplete: false, excludedFiles: [] });
    expect(restored.symbols).toContainEqual(expect.objectContaining({ filePath: 'above.ts', name: 'boundary' }));
    expect(old.excludedFiles).toHaveLength(2);
  });

  it('returns more than 500 symbols while search defaults to 50 and caps at 500', async () => {
    await write('bulk.ts', Array.from({ length: 550 }, (_, i) => `export function bulk${i}() {}`).join('\n'));
    const body = await (await request()).json();
    expect(body.symbols.filter((s: { filePath: string }) => s.filePath === 'bulk.ts')).toHaveLength(550);
    for (const [limit, count] of [[undefined, 50], ['250', 250], ['999', 500]] as const) {
      const params = new URLSearchParams({ cwd, q: 'bulk' });
      if (limit) params.set('limit', limit);
      const response = await searchGET(new Request(`http://localhost/api/projectGraph/search?${params}`));
      expect((await response.json()).symbols).toHaveLength(count);
    }
  });

  it('refreshes additions, edits and deletions on demand and retains old snapshots', async () => {
    const first = await (await request()).json();
    const old = peekCodeIndex(cwd)!;
    await write('src/core.ts', 'export function replacement() {}\n');
    await fs.unlink(path.join(cwd, 'src/nested/util.ts'));
    await write('src/new.ts', 'export function added() {}\n');
    const next = await (await request()).json();
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(next.symbols).toContainEqual(expect.objectContaining({ name: 'added' }));
    expect(next.symbols).toContainEqual(expect.objectContaining({ name: 'replacement' }));
    expect(next.symbols.some((s: { name: string }) => ['helper', 'outer', 'run'].includes(s.name))).toBe(false);
    expect(old.files.get('src/core.ts')!.flatSymbols.some(s => s.name === 'outer')).toBe(true);
  });

  it('preserves unsupported Git-project errors', async () => {
    await fs.rm(path.join(cwd, '.git'), { recursive: true });
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ tag: 'ValidationError', error: expect.stringContaining('Non-Git') });
  });
});

describe('symbols CLI over the real API', () => {
  async function start(): Promise<void> {
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      const route = routes[url.pathname.split('/').pop()!] ?? GET;
      const result = await route(new Request(url));
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(await result.text());
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  }
  function run(args: string[]) {
    return exec(process.execPath, [cli, ...args], { cwd, env: { ...process.env, COCKPIT_PORT: String(port) } });
  }

  it('exports JSON and plain coordinates with repeated exclusions, and diagnoses incompleteness', async () => {
    await start();
    const args = ['symbols', '--path', 'src', '--exclude-tests', '--exclude', '**/generated/**', '--exclude', '**/mock,fixtures/**'];
    const json = await run([...args, '--json']);
    const body = JSON.parse(json.stdout);
    expect(body.total).toBeGreaterThan(0);
    expect([...new Set(body.symbols.map((s: { filePath: string }) => s.filePath))]).toEqual(['src/core.ts', 'src/nested/util.ts']);
    const plain = await run(args);
    expect(plain.stdout).toContain('\tmethod\tBox>run\n');
    expect(plain.stdout).not.toContain('.test.ts');
    expect((await run(['symbols', '--kind', 'class', '--json'])).stdout).toContain('"Box"');
    await write('huge.ts', ' '.repeat(INDEX_SOURCE_LIMIT_BYTES + 1));
    const incomplete = await run([...args, '--json']);
    expect(JSON.parse(incomplete.stdout).incomplete).toBe(true);
    expect(incomplete.stderr).toContain('# incomplete:');
  });

  it('handles empty output, malformed arguments and server validation', async () => {
    await start();
    expect(JSON.parse((await run(['symbols', '--path', 'missing', '--json'])).stdout)).toMatchObject({ total: 0, symbols: [] });
    await expect(run(['symbols', '--path', 'missing'])).rejects.toMatchObject({ code: 1, stdout: '' });
    await expect(run(['symbols', '--path'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('requires a value') });
    await expect(run(['symbols', '--unknown'])).rejects.toMatchObject({ code: 2 });
    await expect(run(['symbols', '--kind', 'invalid'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('400') });
  });

  it('uses the same search default and cap as HTTP', async () => {
    await start();
    // Exceed pipe buffering in both JSON and plain mode to catch exit-time truncation.
    await write('bulk.ts', Array.from({ length: 510 }, (_, i) => `export function bulk${i}_${'x'.repeat(120)}() {}`).join('\n'));
    expect(JSON.parse((await run(['search', 'bulk', '--json'])).stdout).symbols).toHaveLength(50);
    expect(JSON.parse((await run(['search', 'bulk', '--limit', '999', '--json'])).stdout).symbols).toHaveLength(500);
    const exported = JSON.parse((await run(['symbols', '--json'])).stdout);
    expect(exported.symbols.filter((s: { filePath: string }) => s.filePath === 'bulk.ts')).toHaveLength(510);
    expect((await run(['symbols'])).stdout.split('\n').filter(line => line.startsWith('bulk.ts:'))).toHaveLength(510);
  });

  it('prints compact summaries and forwards the synthetic opt-in', async () => {
    await start();
    await write('src/blocks.ts', "import './core';\nconsole.log('top-level');\n");
    const args = ['symbols', '--path', 'src', '--exclude-tests', '--kind', 'all', '--summary'];
    const summary = JSON.parse((await run([...args, '--json'])).stdout);
    expect(summary).not.toHaveProperty('symbols');
    expect(summary.byKind).not.toHaveProperty('unknown');
    const plain = await run(args);
    expect(plain.stdout).toContain(`total\t${summary.total}\tfiles\t${summary.files}\n`);
    expect(plain.stdout).toContain('src/nested\t1\t1\tfunction=1\n');
    expect(JSON.parse((await run([...args, '--include-synthetic', '--json'])).stdout).byKind.unknown).toBeGreaterThan(0);
  });

  it.each(['callers', 'callees', 'impact', 'related'])('requires disambiguation in %s over HTTP and CLI', async endpoint => {
    await write('a.ts', 'export function leafA() {}\nexport function shared() { leafA(); }\nexport function callerA() { shared(); }');
    await write('b.ts', 'export function leafB() {}\nexport function shared() { leafB(); }\nexport function callerB() { shared(); }');
    const route = routes[endpoint];
    const query = new URLSearchParams({ cwd, qname: 'shared', include: 'structural' });
    const ambiguous = await route(new Request(`http://localhost/api/projectGraph/${endpoint}?${query}`));
    const body = await ambiguous.json();
    expect(ambiguous.status).toBe(200);
    expect(body).toMatchObject({ target: null, ambiguousIn: ['a.ts', 'b.ts'] });
    expect(body[endpoint === 'impact' ? 'nodes' : endpoint === 'related' ? 'results' : endpoint]).toEqual([]);
    if (endpoint === 'related') expect(body.coedit).toEqual([]);
    await start();
    await expect(run([endpoint, 'shared'])).rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('--file') });
    await expect(run([endpoint, 'shared', '--json'])).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('"target": null') });
    const resolved = JSON.parse((await run([endpoint, 'shared', '--file', 'a.ts', '--json'])).stdout);
    expect(resolved.target.filePath).toBe('a.ts');
    expect(resolved.ambiguousIn).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain('b.ts');
    query.set('filePath', 'missing.ts');
    expect(await (await route(new Request(`http://localhost/api/projectGraph/${endpoint}?${query}`))).json()).toMatchObject({ target: null });
  });
});

const routes: Record<string, (request: Request) => Promise<Response>> = {
  symbols: GET, search: searchGET, callers: callersGET, callees: calleesGET, impact: impactGET, related: relatedGET,
};
