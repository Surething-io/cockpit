/**
 * Lean 4 symbol extraction.
 *
 * Uses the real vendored grammar, not a stub AST. The whole reason this path
 * exists separately from `extractFromNode` is WHICH nodes tree-sitter hands
 * back as root-level siblings — specifically that `namespace` / `section` /
 * `end` are flat siblings rather than nesting nodes — and a hand-rolled stub
 * would just assert that shape into existence instead of verifying it.
 *
 * The grammar is unversioned upstream and pinned by SHA in
 * `scripts/build-lean-grammar.mjs`; these tests are the tripwire for a node
 * rename after a deliberate re-pin.
 */

import { describe, it, expect } from 'vitest';
import { getServerParser } from './projectGraph/serverTreeSitter';
import { extractSymbolsFromTree } from './extractSymbols';
import type { ExtractedSymbol } from './types';

async function symbolsOf(source: string): Promise<ExtractedSymbol[]> {
  const parser = await getServerParser('lean');
  const tree = parser.parse(source);
  if (!tree) throw new Error('parse failed');
  try {
    return extractSymbolsFromTree(tree.rootNode, 'lean').sort(
      (a, b) => a.startLine - b.startLine,
    );
  } finally {
    tree.delete();
  }
}

const real = (syms: ExtractedSymbol[]) =>
  syms.filter((s) => !s.qualifiedName.startsWith('__'));
const qnames = (syms: ExtractedSymbol[]) => real(syms).map((s) => s.qualifiedName);

describe('Lean declaration extraction', () => {
  it('extracts a theorem with its full name and span', async () => {
    const syms = await symbolsOf(
      [
        'import Mathlib',
        '',
        'theorem foo_bar {K : Type*} [Field K] (v : K) :',
        '    v = v := by',
        '  rfl',
        '',
      ].join('\n'),
    );
    const t = real(syms).find((s) => s.name === 'foo_bar')!;
    expect(t).toBeDefined();
    expect(t.kind).toBe('function');
    expect(t.startLine).toBe(3);
    // 5, not 6: the `by` block's node ends at the next token, so the raw
    // endPosition would spill onto the trailing blank line. See contentEndLine.
    expect(t.endLine).toBe(5);
  });

  it('never lets adjacent declarations overlap', async () => {
    // A `by` block is whitespace-delimited; without clamping, `a` would end on
    // `b`'s first line and the block-diff projection would own line 3 twice.
    for (const src of [
      'theorem a : True := by\n  trivial\ntheorem b : True := trivial\n',
      'theorem a : True := by\n  trivial\n\ntheorem b : True := trivial\n',
    ]) {
      const syms = real(await symbolsOf(src));
      for (let i = 1; i < syms.length; i++) {
        expect(syms[i].startLine).toBeGreaterThan(syms[i - 1].endLine);
      }
    }
  });

  it('treats `lemma` as a theorem — the grammar folds them into one node', async () => {
    const syms = await symbolsOf('lemma my_lemma : True := trivial\n');
    expect(qnames(syms)).toContain('my_lemma');
  });

  it('maps each declaration keyword to a kind', async () => {
    const syms = await symbolsOf(
      [
        'def d : Nat := 0',
        'abbrev a : Nat := 0',
        'structure S where',
        '  x : Nat',
        'inductive I where',
        '  | mk : I',
        'axiom ax : True',
        '',
      ].join('\n'),
    );
    const byName = Object.fromEntries(real(syms).map((s) => [s.name, s.kind]));
    expect(byName).toMatchObject({
      d: 'function',
      a: 'function',
      S: 'class',
      I: 'type',
      ax: 'const',
    });
  });

  it('collects the import block into one header symbol', async () => {
    const syms = await symbolsOf(
      ['import Mathlib', 'import P2M.Util', '', 'theorem t : True := trivial', ''].join('\n'),
    );
    const header = syms.find((s) => s.qualifiedName === '__imports__')!;
    expect(header).toBeDefined();
    expect(header.startLine).toBe(1);
    expect(header.endLine).toBe(2);
  });
});

describe('Lean namespace stack', () => {
  it('qualifies a declaration with its enclosing namespace', async () => {
    const syms = await symbolsOf(
      ['namespace Foo', '', 'theorem t : True := trivial', '', 'end Foo', ''].join('\n'),
    );
    expect(qnames(syms)).toContain('Foo.t');
    // The bare name stays as written — only qualifiedName carries the prefix.
    expect(real(syms).find((s) => s.qualifiedName === 'Foo.t')!.name).toBe('t');
  });

  it('nests namespaces and pops them on end', async () => {
    const syms = await symbolsOf(
      [
        'namespace A',
        'namespace B',
        'theorem inner : True := trivial',
        'end B',
        'theorem outer : True := trivial',
        'end A',
        'theorem top : True := trivial',
        '',
      ].join('\n'),
    );
    expect(qnames(syms)).toEqual(['A.B.inner', 'A.outer', 'top']);
  });

  it('treats `namespace A.B` as one scope, closed by one `end`', async () => {
    const syms = await symbolsOf(
      ['namespace A.B', 'theorem t : True := trivial', 'end A.B', 'theorem after : True := trivial', ''].join(
        '\n',
      ),
    );
    expect(qnames(syms)).toEqual(['A.B.t', 'after']);
  });

  it('opens a scope for `section` without adding a name component', async () => {
    const syms = await symbolsOf(
      [
        'namespace N',
        'section S',
        'theorem t : True := trivial',
        'end S',
        'theorem u : True := trivial',
        'end N',
        '',
      ].join('\n'),
    );
    expect(qnames(syms)).toEqual(['N.t', 'N.u']);
  });

  it('tolerates a namespace left unclosed at EOF (Mathlib does this)', async () => {
    const syms = await symbolsOf(['namespace Unclosed', 'theorem t : True := trivial', ''].join('\n'));
    expect(qnames(syms)).toContain('Unclosed.t');
  });
});

describe('Lean anonymous declarations', () => {
  it('names `example` after its keyword instead of emitting a null name', async () => {
    const syms = await symbolsOf(['example : True := trivial', ''].join('\n'));
    const names = real(syms).map((s) => s.name);
    expect(names).toContain('example');
    expect(names.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  });

  it('keeps repeated anonymous declarations distinguishable', async () => {
    const syms = await symbolsOf(
      ['example : True := trivial', 'example : True := trivial', ''].join('\n'),
    );
    const qs = qnames(syms);
    expect(qs).toHaveLength(2);
    // dedupeQualifiedNames must have made them unique — a duplicate key would
    // make the block diff match the wrong one.
    expect(new Set(qs).size).toBe(2);
  });
});

describe('Lean graceful degradation', () => {
  it('does not lose surrounding declarations when one region fails to parse', async () => {
    // `attribute [-instance] …` before a declaration is a real shape from the
    // FLT corpus that the grammar cannot parse; the declaration after it
    // collapses into an ERROR sibling. Neighbours must survive.
    const syms = await symbolsOf(
      [
        'theorem before : True := trivial',
        'attribute [-instance] Foo.bar Baz.qux',
        'theorem after : True := trivial',
        '',
      ].join('\n'),
    );
    expect(qnames(syms)).toContain('before');
  });

  it('covers unparsed lines with filler blocks rather than dropping them', async () => {
    const syms = await symbolsOf(
      ['theorem t : True := trivial', '@[!!!bogus syntax that cannot parse', ''].join('\n'),
    );
    const covered = new Set<number>();
    for (const s of syms) {
      for (let l = s.startLine; l <= s.endLine; l++) covered.add(l);
    }
    expect(covered.has(1)).toBe(true);
    expect(covered.has(2)).toBe(true);
  });
});
