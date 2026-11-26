/**
 * Covers the leading-comment absorption pass, i.e. the reason a doc
 * comment above a symbol used to render as its own nameless `code`
 * filler block in the Code Map.
 *
 * Uses the real tree-sitter grammar rather than a fake AST: the whole
 * point of the pass is which nodes tree-sitter hands us as root-level
 * siblings, which a hand-rolled stub would just assert into existence.
 */

import { describe, it, expect } from 'vitest';
import { getServerParser } from './projectGraph/serverTreeSitter';
import { extractSymbolsFromTree } from './extractSymbols';
import { getHandler } from './handlers';
import type { ExtractedSymbol } from './types';

async function symbolsOf(source: string): Promise<ExtractedSymbol[]> {
  const parser = await getServerParser('typescript');
  const tree = parser.parse(source);
  if (!tree) throw new Error('parse failed');
  return extractSymbolsFromTree(tree.rootNode).sort((a, b) => a.startLine - b.startLine);
}

const find = (syms: ExtractedSymbol[], name: string) => syms.find((s) => s.name === name)!;
const fillers = (syms: ExtractedSymbol[]) =>
  syms.filter((s) => s.qualifiedName.startsWith('__code_'));

describe('absorbLeadingComments', () => {
  it('pulls an adjacent doc comment into the symbol it documents', async () => {
    const syms = await symbolsOf(
      ['/**', ' * Docs.', ' */', 'export function foo() {', '  return 1;', '}', ''].join('\n'),
    );
    expect(find(syms, 'foo').startLine).toBe(1);
    // The declaration line survives the widening, so /cg can cite it.
    expect(find(syms, 'foo').declLine).toBe(4);
    expect(fillers(syms)).toHaveLength(0);
  });

  it('leaves a comment separated by a blank line as its own block', async () => {
    const syms = await symbolsOf(
      ['// ---- section ----', '', 'export function foo() {', '  return 1;', '}', ''].join('\n'),
    );
    expect(find(syms, 'foo').startLine).toBe(3);
    expect(find(syms, 'foo').declLine).toBe(3);
    expect(fillers(syms)).toHaveLength(1);
    expect(fillers(syms)[0]!.startLine).toBe(1);
  });

  it('absorbs a run of consecutive line comments', async () => {
    const syms = await symbolsOf(
      ['// one', '// two', 'export const A = 1;', ''].join('\n'),
    );
    expect(find(syms, 'A').startLine).toBe(1);
    expect(fillers(syms)).toHaveLength(0);
  });

  it('does not let a symbol claim a comment inside its predecessor', async () => {
    const syms = await symbolsOf(
      [
        'export function foo() {',
        '  // trailing comment inside foo',
        '}',
        'export const A = 1;',
        '',
      ].join('\n'),
    );
    expect(find(syms, 'foo').startLine).toBe(1);
    expect(find(syms, 'A').startLine).toBe(4);
  });

  it('keeps contentHash tied to the code, not the comment', async () => {
    const [a] = await symbolsOf(['// v1', 'export const A = 1;', ''].join('\n'));
    const [b] = await symbolsOf(['// v2 reworded', 'export const A = 1;', ''].join('\n'));
    expect(a!.contentHash).toBe(b!.contentHash);
  });

  it('still emits filler blocks for real top-level statements', async () => {
    const syms = await symbolsOf(
      ['export const A = 1;', '', 'console.log(A);', ''].join('\n'),
    );
    expect(fillers(syms)).toHaveLength(1);
    // The run spans the whole uncovered tail (blank line 2 → EOF):
    // `computeFillerBlocks` only drops runs that are ENTIRELY whitespace,
    // it does not trim blank edges off a run that has content.
    const f = fillers(syms)[0]!;
    expect(f.startLine).toBeLessThanOrEqual(3);
    expect(f.endLine).toBeGreaterThanOrEqual(3);
  });
});

/** Runs the production per-language handler, children flattened. */
async function handlerSymbolsOf(lang: 'python' | 'rust' | 'typescript', source: string): Promise<ExtractedSymbol[]> {
  const tree = (await getServerParser(lang)).parse(source);
  if (!tree) throw new Error('parse failed');
  const flat: ExtractedSymbol[] = [];
  const walk = (arr: ExtractedSymbol[]) => arr.forEach((s) => { flat.push(s); walk(s.children); });
  walk(getHandler(lang).extractSymbols(tree.rootNode, source));
  return flat;
}

describe('declLine past Python decorators', () => {
  it('points at the def / class line while the range keeps the decorators', async () => {
    const syms = await handlerSymbolsOf('python', [
      '@app.route("/")',         // 1
      '@login_required',         // 2
      'def index():',            // 3
      '    pass',                // 4
      '',                        // 5
      'class C:',                // 6
      '    @staticmethod',       // 7
      '    def s():',            // 8
      '        pass',            // 9
      '',                        // 10
      '    @dataclass',          // 11
      '    class Inner:',        // 12
      '        x: int = 0',      // 13
      '',
    ].join('\n'));
    expect(find(syms, 'index')).toMatchObject({ startLine: 1, declLine: 3 });
    expect(find(syms, 's')).toMatchObject({ startLine: 7, declLine: 8 });
    expect(find(syms, 'Inner')).toMatchObject({ startLine: 11, declLine: 12 });
    expect(find(syms, 'C')).toMatchObject({ startLine: 6, declLine: 6 });
  });

  it('keeps the def line when a comment is also absorbed above the decorator', async () => {
    const syms = await handlerSymbolsOf('python',
      ['# docs', '@cache', 'def f():', '    pass', ''].join('\n'));
    expect(find(syms, 'f')).toMatchObject({ startLine: 1, declLine: 3 });
  });
});

describe('Rust doc comments', () => {
  it('absorbs /// doc comments, which tree-sitter ends at column 0 of the next row', async () => {
    const syms = await handlerSymbolsOf('rust', [
      '/// One.',          // 1
      'struct A;',         // 2
      '',                  // 3
      '/// Two',           // 4
      '/// lines.',        // 5
      'fn b() {}',         // 6
      '',                  // 7
      '// plain',          // 8
      'struct C;',         // 9
      '',
    ].join('\n'));
    expect(find(syms, 'A')).toMatchObject({ startLine: 1, declLine: 2 });
    expect(find(syms, 'b')).toMatchObject({ startLine: 4, declLine: 6 });
    expect(find(syms, 'C')).toMatchObject({ startLine: 8, declLine: 9 });
    expect(fillers(syms)).toHaveLength(0);
  });
});

describe('decorators and attributes stay in the symbol card', () => {
  it('pulls a decorated TS export, and the JSDoc above it, into one block', async () => {
    const syms = await handlerSymbolsOf('typescript', [
      '/** Doc. */',          // 1
      '@Component({',         // 2
      '  selector: "x",',     // 3
      '})',                   // 4
      'export class Foo {}',  // 5
      '',                     // 6
      '@sealed',              // 7
      'class Bar {}',         // 8
      '',                     // 9
      '@sealed',              // 10
      '// Why it is sealed.', // 11
      'class Baz {}',         // 12
      '',
    ].join('\n'));
    expect(find(syms, 'Foo')).toMatchObject({ startLine: 1, declLine: 5 });
    // Decorators inside a bare class_declaration were already in range;
    // only declLine needed to skip them.
    expect(find(syms, 'Bar')).toMatchObject({ startLine: 7, declLine: 8 });
    // A comment between the decorator and `class` is not the declaration.
    expect(find(syms, 'Baz')).toMatchObject({ startLine: 10, declLine: 12 });
    expect(fillers(syms)).toHaveLength(0);
  });

  it('chains Rust doc comments through outer attributes, in either order', async () => {
    const syms = await handlerSymbolsOf('rust', [
      '/// Doc.',                       // 1
      '#[derive(Debug)]',               // 2
      '#[serde(rename_all = "x")]',     // 3
      'pub struct X;',                  // 4
      '',                               // 5
      '#[cfg(test)]',                   // 6
      '/// Attribute first.',           // 7
      'fn y() {}',                      // 8
      '',
    ].join('\n'));
    expect(find(syms, 'X')).toMatchObject({ startLine: 1, declLine: 4 });
    expect(find(syms, 'y')).toMatchObject({ startLine: 6, declLine: 8 });
    expect(fillers(syms)).toHaveLength(0);
  });

  it('leaves Rust inner doc comments and inner attributes to the module', async () => {
    const syms = await handlerSymbolsOf('rust', [
      '//! Crate docs.',          // 1
      'struct A;',                // 2
      '',                         // 3
      '#![allow(dead_code)]',     // 4
      'struct B;',                // 5
      '',
    ].join('\n'));
    expect(find(syms, 'A')).toMatchObject({ startLine: 2, declLine: 2 });
    expect(find(syms, 'B')).toMatchObject({ startLine: 5, declLine: 5 });
    // Filler runs keep their blank leading line (see the filler test above).
    expect(fillers(syms).map((f) => [f.startLine, f.endLine])).toEqual([[1, 1], [3, 4]]);
  });
});
