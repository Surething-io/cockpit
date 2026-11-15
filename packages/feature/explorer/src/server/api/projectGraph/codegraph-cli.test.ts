import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = path.resolve('bin/cock-codegraph.mjs');
const paths = Array.from({ length: 8000 }, (_, i) => `test/long_${'x'.repeat(100)}_${i}.test.ts`);
const symbols = paths.map((filePath, i) => ({ filePath, startLine: i + 1, endLine: i + 2, qualifiedName: `target${i}`, kind: 'function' }));
let server: Server;
let port: number;
let data: unknown;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const plain = req.method === 'POST' && JSON.parse(body).format === 'plain';
    res.setHeader('Content-Type', plain ? 'text/plain' : 'application/json');
    res.end(plain ? paths.join('\n') + '\n' : JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function run(args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, COCKPIT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  // Pause after the first chunk so queued writes exceed the OS pipe capacity.
  // Keep a consumer attached: Node drains small child output automatically on exit.
  let stdout = '';
  let first = true;
  let resuming: Promise<void> | undefined;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    if (first) {
      first = false;
      child.stdout.pause();
      resuming = delay(50).then(() => { child.stdout.resume(); });
    }
  });
  const code = await done;
  await resuming;
  return { code, stdout, stderr };
}

const cases = [
  { sub: 'callers', args: ['target'], data: { callers: symbols.map(caller => ({ caller, callLines: [1, 2] })) }, text: symbols.map(s => `${s.filePath}:${s.startLine}\t${s.qualifiedName}\t[1,2]\n`).join('') },
  { sub: 'callees', args: ['target'], data: { callees: symbols.map(callee => ({ callee, callLines: [1, 2] })) }, text: symbols.map(s => `${s.filePath}:${s.startLine}\t${s.qualifiedName}\t[1,2]\n`).join('') },
  { sub: 'impact', args: ['target'], data: { nodes: symbols.map(symbol => ({ depth: 1, symbol })) }, text: symbols.map(s => `d=1\t${s.filePath}:${s.startLine}\t${s.qualifiedName}\n`).join('') },
  { sub: 'file', args: ['core.ts'], data: { symbols: symbols.map(s => ({ ...s, qualifiedName: s.filePath })) }, text: symbols.map(s => `${s.kind}\t${s.startLine}-${s.endLine}\t${s.filePath}\n`).join('') },
  { sub: 'coedit', args: ['core.ts'], data: { totalCommits: 0, history: [], uncommitted: paths }, text: '# uncommitted (working tree)\n' + paths.map(p => `-\t${p}\n`).join('') },
  { sub: 'related', args: ['target'], data: { results: symbols.map(s => ({ ...s, score: 0.4, relations: [{ type: 'caller' }] })) }, text: symbols.map(s => `0.40\t${s.filePath}:${s.startLine}\t${s.qualifiedName}\t<caller>\n`).join('') },
  { sub: 'affected', args: ['core.ts'], data: { testFiles: paths }, text: paths.join('\n') + '\n' },
  { sub: 'affected', args: ['core.ts', '--as-cmd', 'vitest run'], data: { testFiles: paths }, text: `vitest run ${paths.map(p => JSON.stringify(p)).join(' ')}\n` },
];

describe('CLI output through slow OS pipes', () => {
  it.each(cases)('flushes all plain $sub output: $args', async (fixture) => {
    data = fixture.data;
    const result = await run([fixture.sub, ...fixture.args]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    expect(result.stdout).toBe(fixture.text);
  });
  it('flushes affected JSON and preserves its nonempty/empty exit codes', async () => {
    data = { testFiles: paths };
    const result = await run(['affected', 'core.ts', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(data);
    data = { testFiles: [] };
    const empty = await run(['affected', 'core.ts', '--json']);
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.stdout)).toEqual(data);
  });
});
