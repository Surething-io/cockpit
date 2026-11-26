/**
 * Chip-diff must surface edits confined to the lines a symbol absorbed
 * above its declaration (doc comment, TS decorators).
 * Those lines are inside the symbol's range but deliberately outside its
 * `contentHash`, so hash pairing alone reports the symbol as unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { getServerParser } from '../../server/codeMap/projectGraph/serverTreeSitter';
import { buildImpactProjection } from './blockDiffProjection';

// The browser loader fetches WASM over HTTP; the server loader reads the
// same grammars from disk.
vi.mock('@cockpit/feature-explorer/server/codeMap/treeSitter', () => ({
  getParserFor: (id: string) => getServerParser(id as never),
}));

const ts = (decorator: string, doc = '/** Doc. */') =>
  [doc, `@Component({ selector: "${decorator}" })`, 'export class Foo {', '  run() {}', '}', ''].join('\n');

async function changed(before: string, after: string, file = 'a.ts') {
  const p = await buildImpactProjection(before, after, file, false, false);
  return [...(p.changedQnames ?? [])].sort();
}

describe('buildImpactProjection — absorbed leading lines', () => {
  it('surfaces a decorator-only edit on an exported class', async () => {
    expect(await changed(ts('a'), ts('b'))).toEqual(['Foo']);
  });

  it('surfaces a doc-comment-only edit', async () => {
    expect(await changed(ts('a', '/** Old. */'), ts('a', '/** New. */'))).toEqual(['Foo']);
  });

  it('surfaces removing an absorbed line, which adds no line on the after side', async () => {
    const before = ['/** Doc. */', '@sealed', '@frozen', 'export class Foo {}', ''].join('\n');
    const after = ['/** Doc. */', '@sealed', 'export class Foo {}', ''].join('\n');
    expect(await changed(before, after)).toEqual(['Foo']);
  });

  it('still ignores symbols whose absorbed lines and body are untouched', async () => {
    const before = [ts('a'), 'export function other() {}', ''].join('\n');
    const after = [ts('a'), 'export function other() { return 1; }', ''].join('\n');
    expect(await changed(before, after)).toEqual(['other']);
  });
});
