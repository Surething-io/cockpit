/**
 * Invariant: every symbol node any /cg endpoint returns carries a
 * `declLine`, and that line is the declaration itself — never the doc
 * comment, decorator or attribute that `startLine` may have been widened
 * over.
 *
 * Deliberately implementation-agnostic. It does not know which extractor
 * widens what; it drives the real routes over fixtures dense with the
 * things that push a range above its declaration, and checks the source
 * text at each reported line. A new language, a new widening rule or a
 * new endpoint that forgets `declLine` fails here without anyone having
 * to remember this test exists.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as calleesGET } from './callees';
import { GET as callersGET } from './callers';
import { GET as fileGET } from './file';
import { GET as impactGET } from './impact';
import { GET as relatedGET } from './related';
import { GET as searchGET } from './search';
import { GET as symbolsGET } from './symbols';
import { invalidateIndex } from '../../codeMap/projectGraph/codeIndex';

const FIXTURES: Record<string, string> = {
  'ts/main.ts': [
    '/**',
    ' * Documented function.',
    ' */',
    'export function documented(a: string) {',
    '  return helper(a);',
    '}',
    '',
    '// Line comment glued to a const.',
    'export const helper = (a: string) => a;',
    '',
    '/** Decorated class. */',
    '@sealed',
    'export class Widget {',
    '  /** Method docs. */',
    '  @logged',
    '  render() {',
    '    return documented("x");',
    '  }',
    '}',
    '',
    '@sealed',
    'class Bare {}',
    '',
    '@sealed',
    '// Comment between decorator and class.',
    'class Annotated {}',
    '',
    'function sealed(_c: unknown) {}',
    'function logged(_t: unknown, _k: string) {}',
    '',
  ].join('\n'),
  'py/main.py': [
    '# Comment above a decorator.',
    '@cache',
    'def cached():',
    '    return helper()',
    '',
    '',
    '@route("/")',
    '@login_required',
    'def index():',
    '    return cached()',
    '',
    '',
    'class Service:',
    '    @staticmethod',
    '    def build():',
    '        return index()',
    '',
    '    @dataclass',
    '    class Config:',
    '        x: int = 0',
    '',
    '',
    'def helper():',
    '    return 1',
    '',
  ].join('\n'),
  'go/main.go': [
    'package main',
    '',
    '// Server serves.',
    'type Server struct{}',
    '',
    '// Start starts.',
    '// Second line.',
    'func (s *Server) Start() {',
    '\thelper()',
    '}',
    '',
    '// helper helps.',
    'func helper() {}',
    '',
  ].join('\n'),
  'rs/main.rs': [
    '/// A documented struct.',
    '#[derive(Debug)]',
    'pub struct Engine;',
    '',
    'impl Engine {',
    '    /// Method docs.',
    '    #[inline]',
    '    pub fn run(&self) {',
    '        helper();',
    '    }',
    '}',
    '',
    '/// Two-line',
    '/// doc comment.',
    'fn helper() {}',
    '',
    '// plain comment',
    'fn other() {',
    '    helper();',
    '}',
    '',
  ].join('\n'),
  'lean/Main.lean': [
    '/-- Doc for foo. -/',
    '@[simp]',
    'theorem foo : 1 = 1 := rfl',
    '',
    '-- plain',
    'def bar := 1',
    '',
    '/-- d -/',
    'def baz := bar',
    '',
  ].join('\n'),
};

/** What a declaration line must NOT start with: comment, decorator and
 *  attribute openers across the fixture languages. */
const NOT_A_DECLARATION = /^(\/\/|\/\*|\*|#|@|--|\/-)/;

interface Node {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  declLine?: number;
  children?: Node[];
}

let cwd: string;
const sources = new Map<string, string[]>();

async function get(route: (req: Request) => Promise<Response>, endpoint: string, params: Record<string, string>) {
  const res = await route(new Request(`http://localhost/api/projectGraph/${endpoint}?${new URLSearchParams({ cwd, ...params })}`));
  expect(res.status, `${endpoint} ${JSON.stringify(params)}`).toBe(200);
  return res.json();
}

/** Every node an endpoint returned, tagged with where it came from. */
async function collectNodes(): Promise<{ via: string; node: Node }[]> {
  const out: { via: string; node: Node }[] = [];
  const add = (via: string, node: Node | null | undefined) => { if (node) out.push({ via, node }); };

  const all = await get(symbolsGET, 'symbols', { kind: 'all' });
  const symbols = all.symbols as Node[];
  expect(symbols.length).toBeGreaterThan(15);
  for (const s of symbols) add('symbols', s);

  for (const file of Object.keys(FIXTURES)) {
    const detail = await get(fileGET, 'file', { path: file });
    const walk = (arr: Node[]) => arr.forEach((s) => {
      add(`file ${file}`, { ...s, filePath: file });
      walk(s.children ?? []);
    });
    walk(detail.symbols);
  }

  // The index is built once above; the per-symbol queries are independent
  // reads of it, so issue them together.
  await Effect.runPromise(Effect.all(symbols.map((s) => Effect.promise(async () => {
    const target = { qname: s.qualifiedName, filePath: s.filePath };
    const [search, callers, callees, impact, related] = await Effect.runPromise(Effect.all([
      Effect.promise(() => get(searchGET, 'search', { q: s.name, path: path.posix.dirname(s.filePath) })),
      Effect.promise(() => get(callersGET, 'callers', target)),
      Effect.promise(() => get(calleesGET, 'callees', target)),
      Effect.promise(() => get(impactGET, 'impact', { ...target, depth: '3' })),
      Effect.promise(() => get(relatedGET, 'related', { ...target, include: 'structural' })),
    ], { concurrency: 'unbounded' }));
    for (const hit of search.symbols) add(`search ${s.name}`, hit.target);
    add(`callers ${s.qualifiedName}`, callers.target);
    for (const c of callers.callers) add(`callers ${s.qualifiedName}`, c.caller);
    for (const c of callees.callees) add(`callees ${s.qualifiedName}`, c.callee);
    for (const n of impact.nodes) add(`impact ${s.qualifiedName}`, n.symbol);
    for (const r of related.results) add(`related ${s.qualifiedName}`, r);
  })), { concurrency: 'unbounded' }));
  return out;
}

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cg-declline-'));
  execFileSync('git', ['init', '-q'], { cwd });
  for (const [file, source] of Object.entries(FIXTURES)) {
    await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await fs.writeFile(path.join(cwd, file), source);
    sources.set(file, source.split('\n'));
  }
});
afterAll(async () => {
  invalidateIndex(cwd);
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('declLine invariant across every /cg endpoint', () => {
  it('points every returned node at its declaration line', async () => {
    const nodes = await collectNodes();
    const violations: string[] = [];
    for (const { via, node } of nodes) {
      const where = `[${via}] ${node.filePath} ${node.qualifiedName}`;
      if (typeof node.declLine !== 'number') {
        violations.push(`${where}: declLine missing`);
        continue;
      }
      if (node.declLine < node.startLine || node.declLine > node.endLine) {
        violations.push(`${where}: declLine ${node.declLine} outside ${node.startLine}-${node.endLine}`);
        continue;
      }
      const text = (sources.get(node.filePath)?.[node.declLine - 1] ?? '').trim();
      if (NOT_A_DECLARATION.test(text) || !text.includes(node.name)) {
        violations.push(`${where}: declLine ${node.declLine} is ${JSON.stringify(text)}`);
      }
    }
    // De-duplicate: the same node surfaces through many endpoints.
    expect([...new Set(violations)]).toEqual([]);
  }, 60_000);
});
