import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCodeIndex, invalidateIndex, callersFromIndex, peekCodeIndex } from './codeIndex';
import { getHandler } from '../handlers';
import { getServerParser } from './serverTreeSitter';
import { GET as functionsGET } from '../../api/projectGraph/file-functions';
import { GET as symbolsGET } from '../../api/projectGraph/symbols';

let cwd: string;
async function write(file: string, content: string) {
  const target = path.join(cwd, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cg-ts-relations-'));
  execFileSync('git', ['init', '-q'], { cwd });
});
afterEach(async () => { invalidateIndex(cwd); await fs.rm(cwd, { recursive: true, force: true }); });

async function symbolsOf(source: string, grammar: 'typescript' | 'tsx' | 'javascript' = 'typescript') {
  const tree = (await getServerParser(grammar)).parse(source)!;
  try { return getHandler(grammar).extractSymbols(tree.rootNode, source).filter(s => s.kind !== 'unknown'); }
  finally { tree.delete(); }
}
const outgoing = (index: Awaited<ReturnType<typeof getCodeIndex>>, file = 'caller.ts') => index.files.get(file)!.outgoingCalls.map(edge => `${edge.to.filePath}:${edge.to.qualifiedName}`).sort();

describe('function-valued wrappers', () => {
  it.each(['typescript', 'tsx', 'javascript'] as const)('recognizes imported wrappers and callback parameters in %s', async (grammar) => {
    const symbols = await symbolsOf(`
import { handler as route, dynamicHandler } from '@cockpit/effect-runtime/server';
import React, { memo as remember, forwardRef, useCallback } from 'react';
export const GET = route((req) => req);
export const POST = dynamicHandler((req, params) => params);
export const Component = remember(forwardRef((props, ref) => props));
export const Other = React.memo((props) => props);
export const callback = useCallback((value) => value, []);
export const data = [1].map((x) => x * 2);
export const cached = unknownFactory((value) => value);
`, grammar);
    expect(symbols.map(s => [s.name, s.kind, s.params])).toEqual([
      ['GET', 'function', ['req']], ['POST', 'function', ['req', 'params']],
      ['Component', 'function', ['props', 'ref']], ['Other', 'function', ['props']],
      ['callback', 'function', ['value']], ['data', 'const', undefined], ['cached', 'const', undefined],
    ]);
  });

  it('keeps unrelated handler names as consts and unwraps TS function assertions', async () => {
    const symbols = await symbolsOf(`
import { handler } from './unrelated';
import * as runtime from '@cockpit/effect-runtime/server';
export const data = handler(() => 42);
export const GET = runtime.handler(((req: Request) => req) as (req: Request) => Request);
`);
    expect(symbols.map(s => [s.name, s.kind, s.params])).toEqual([
      ['data', 'const', undefined], ['GET', 'function', ['req']],
    ]);
  });
});

describe('public export traversal', () => {
  it('follows wildcard chains and cycles, while preserving private/default boundaries and explicit aliases', async () => {
    await write('leaf.ts', 'function privateHelper() {}\nexport function target() {}\nexport default function defaultTarget() {}');
    await write('cycle.ts', "export * from './barrel';");
    await write('barrel.ts', "export * from './cycle';\nexport * from './leaf';\nexport { default as selected } from './leaf';");
    await write('caller.ts', "import fallback, {target, privateHelper, selected} from './barrel';\nexport function caller() { target(); privateHelper(); selected(); fallback(); }");
    const index = await getCodeIndex(cwd);
    expect(outgoing(index)).toEqual(['leaf.ts:defaultTarget', 'leaf.ts:target']);
    expect(callersFromIndex(index, 'target', 'leaf.ts').callers).toHaveLength(1);
  });

  it('handles local export aliases, forwarded imports and revisiting a file under another name', async () => {
    await write('leaf.ts', 'function local() {}\nexport { local as target };');
    await write('middle.ts', "import { target as own } from './leaf';\nexport { own as forwarded };");
    await write('a.ts', "export { forwarded as target } from './middle';\nexport { renamed as alias } from './b';");
    await write('b.ts', "export { target as renamed } from './a';");
    await write('caller.ts', "import {alias} from './a';\nexport function caller() { alias(); }");
    expect(outgoing(await getCodeIndex(cwd))).toEqual(['leaf.ts:local']);
  });

  it('rejects wildcard conflicts, permits diamonds, and lets explicit exports override stars', async () => {
    await write('a.ts', 'export function target() {}');
    await write('b.ts', 'export function target() {}');
    await write('diamond.ts', "export * from './a';");
    await write('barrel.ts', "export * from './a';\nexport * from './diamond';");
    await write('caller.ts', "import {target} from './barrel';\nexport function caller() { target(); }");
    const first = await getCodeIndex(cwd);
    expect(outgoing(first)).toEqual(['a.ts:target']);
    await write('conflict.ts', "export * from './a';\nexport * from './b';");
    await write('barrel.ts', "export * from './conflict';\nexport * from './a';");
    const ambiguous = await getCodeIndex(cwd);
    expect(outgoing(ambiguous)).toEqual([]);
    expect(ambiguous.files.get('a.ts')!.incomingCalls).toEqual([]);
    expect(outgoing(first)).toEqual(['a.ts:target']);
    await write('barrel.ts', "export * from './conflict';\nexport {target} from './b';");
    expect(outgoing(await getCodeIndex(cwd))).toEqual(['b.ts:target']);
    await write('barrel.ts', "export * from './a';\nexport const target = 42;");
    expect(outgoing(await getCodeIndex(cwd))).toEqual([]);
  });

  it('resolves namespace calls and exported object/class members through wildcard barrels', async () => {
    await write('leaf.ts', 'export function target() {}\nexport const api = { run() {} };\nexport class Box { static run() {} }');
    await write('barrel.ts', "export * from './leaf';");
    await write('caller.ts', "import * as ns from './barrel';\nimport {api, Box} from './barrel';\nexport function caller() { ns.target(); api.run(); Box.run(); }");
    expect(outgoing(await getCodeIndex(cwd))).toEqual(['leaf.ts:Box>run', 'leaf.ts:api>run', 'leaf.ts:target']);
  });

  it('follows namespace reexports without confusing them with plain stars', async () => {
    await write('leaf.ts', 'export function target() {}');
    await write('barrel.ts', "export * as ns from './leaf';");
    await write('caller.ts', "import {ns} from './barrel';\nexport function caller() { ns.target(); }");
    expect(outgoing(await getCodeIndex(cwd))).toEqual(['leaf.ts:target']);
  });

  it('ignores private and type-only names when checking wildcard conflicts', async () => {
    await write('leaf.ts', 'export function target() {}');
    await write('private.ts', 'function target() {}');
    await write('types.ts', "export interface target {}\nexport type {target as alias} from './leaf';\nexport type * from './leaf';");
    await write('barrel.ts', "export * from './private';\nexport * from './types';\nexport * from './leaf';");
    await write('caller.ts', "import {target, alias} from './barrel';\nexport function caller() { target(); alias(); }");
    expect(outgoing(await getCodeIndex(cwd))).toEqual(['leaf.ts:target']);
  });
});

describe('expanded.ts consumer regression', () => {
  it('exposes GET/POST as functions and resolves their real source calls through package barrels', async () => {
    const source = await fs.readFile(path.resolve('packages/feature/explorer/src/server/api/files/expanded.ts'), 'utf8');
    await write('expanded.ts', source);
    await write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    await write('packages/utils/package.json', JSON.stringify({ name: '@cockpit/shared-utils', main: './src/index.ts' }));
    await write('packages/utils/src/index.ts', "export * from './paths';");
    await write('packages/utils/src/paths.ts', 'export function getExpandedPathsPath(cwd: string) { return cwd; }\nexport function readJsonFile() {}\nexport function writeJsonFile() {}\nexport function withFileLock() {}');
    await write('packages/runtime/package.json', JSON.stringify({ name: '@cockpit/effect-runtime', main: './src/server/index.ts' }));
    await write('packages/runtime/src/server/index.ts', "export * from '../next';");
    await write('packages/runtime/src/next.ts', 'export function handler(fn: unknown) { return fn; }\nexport function ok(value: unknown) { return value; }\nexport function parseJsonRaw() {}');
    await write('caller.ts', "import { GET } from './expanded';\nexport function invoke() { GET(); }");
    const url = `http://localhost/api/projectGraph/file-functions?cwd=${encodeURIComponent(cwd)}&path=expanded.ts`;
    const local = await (await functionsGET(new Request(url))).json();
    expect(local.downstreamCalls).toEqual([]);
    expect(peekCodeIndex(cwd)).toBeNull();
    // Match the graph view's very first request, with no prior project query.
    const projection = await functionsGET(new Request(`${url}&relations=1`));
    const index = peekCodeIndex(cwd)!;
    expect(index).not.toBeNull();
    expect(projection.status).toBe(200);
    const body = await projection.json();
    expect(body.functions.filter((s: { kind: string }) => s.kind === 'function').map((s: { name: string }) => s.name)).toEqual(['GET', 'POST']);
    expect(body.downstreamCalls.map((edge: { focalQname: string; external: { qualifiedName: string } }) => `${edge.focalQname}:${edge.external.qualifiedName}`)).toEqual(expect.arrayContaining([
      'GET:handler', 'GET:getExpandedPathsPath', 'GET:readJsonFile', 'GET:ok',
      'POST:handler', 'POST:parseJsonRaw', 'POST:withFileLock', 'POST:writeJsonFile',
    ]));
    expect(body.upstreamCalls).toHaveLength(1);
    expect(body.crossFileRevision).toBe(index.revision);
    expect(body.crossFilePending).toBe(false);
    expect(callersFromIndex(index, 'GET', 'expanded.ts').callers).toHaveLength(1);
    const exported = await symbolsGET(new Request(`http://localhost/api/projectGraph/symbols?cwd=${encodeURIComponent(cwd)}`));
    expect((await exported.json()).symbols.filter((s: { filePath: string }) => s.filePath === 'expanded.ts').map((s: { name: string }) => s.name)).toEqual(['GET', 'POST']);
  });
});
