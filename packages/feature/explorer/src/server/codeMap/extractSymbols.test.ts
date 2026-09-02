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
    expect(fillers(syms)).toHaveLength(0);
  });

  it('leaves a comment separated by a blank line as its own block', async () => {
    const syms = await symbolsOf(
      ['// ---- section ----', '', 'export function foo() {', '  return 1;', '}', ''].join('\n'),
    );
    expect(find(syms, 'foo').startLine).toBe(3);
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
