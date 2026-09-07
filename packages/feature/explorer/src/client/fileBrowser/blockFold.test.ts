import { describe, expect, it } from 'vitest';
import { buildBlockFold } from './blockFold';

const never = () => false;

describe('buildBlockFold', () => {
  it('returns null when every line is within context of a change', () => {
    // 7-line block, change at 4 → context 3 covers the whole range, so no
    // gap survives and the caller renders the body exactly as before.
    expect(buildBlockFold(1, 7, new Set([4]), never)).toBeNull();
  });

  it('collapses a block with no changed lines to a single bar', () => {
    // Only reachable when the block filter is off (a language with no qname
    // projection — `changedQnames` undefined but `addedLines` present).
    // Collapsing beats rendering 500 untouched lines: the chip header still
    // names the function, and one click brings the body back.
    const fold = buildBlockFold(1, 500, new Set([900]), never)!;
    expect(fold.segments).toEqual([{ kind: 'gap', startLine: 1, endLine: 500 }]);
    expect(fold.visibleRuns).toEqual([]);
    expect(fold.rowOf(1)).toBe(0);
    expect(fold.rowOf(500)).toBe(0);
  });

  it('keeps changed lines ± 3 and folds the rest', () => {
    const fold = buildBlockFold(1, 100, new Set([50]), never);
    expect(fold).not.toBeNull();
    expect(fold!.segments).toEqual([
      { kind: 'gap', startLine: 1, endLine: 46 },
      { kind: 'lines', startLine: 47, endLine: 53 },
      { kind: 'gap', startLine: 54, endLine: 100 },
    ]);
    expect(fold!.hiddenCount).toBe(46 + 47);
    expect(fold!.visibleRuns).toEqual([{ startLine: 47, endLine: 53 }]);
  });

  it('merges context windows that touch, so no zero-value bar is emitted', () => {
    // 20 and 27: windows 17..23 and 24..30 are adjacent, not overlapping.
    const fold = buildBlockFold(1, 100, new Set([20, 27]), never);
    expect(fold!.segments).toEqual([
      { kind: 'gap', startLine: 1, endLine: 16 },
      { kind: 'lines', startLine: 17, endLine: 30 },
      { kind: 'gap', startLine: 31, endLine: 100 },
    ]);
  });

  it('does not fold a single-line run — a bar costs a row too', () => {
    // Changes at 10 and 18 leave exactly line 14 between the two windows.
    const fold = buildBlockFold(1, 100, new Set([10, 18]), never);
    expect(fold!.segments).toEqual([
      { kind: 'gap', startLine: 1, endLine: 6 },
      { kind: 'lines', startLine: 7, endLine: 21 },
      { kind: 'gap', startLine: 22, endLine: 100 },
    ]);
  });

  it('maps lines to visual rows, parking hidden lines on their bar', () => {
    const fold = buildBlockFold(1, 100, new Set([50]), never)!;
    // Row 0 is the leading bar; every line it swallowed resolves to it.
    expect(fold.rowOf(1)).toBe(0);
    expect(fold.rowOf(46)).toBe(0);
    // Then the seven visible lines, rows 1..7.
    expect(fold.rowOf(47)).toBe(1);
    expect(fold.rowOf(50)).toBe(4);
    expect(fold.rowOf(53)).toBe(7);
    // Trailing bar is row 8 for every line it swallowed.
    expect(fold.rowOf(54)).toBe(8);
    expect(fold.rowOf(100)).toBe(8);
  });

  it('reveals one whole gap when expanded, leaving the others folded', () => {
    const fold = buildBlockFold(1, 100, new Set([50]), (start) => start === 1)!;
    expect(fold.segments).toEqual([
      { kind: 'lines', startLine: 1, endLine: 53 },
      { kind: 'gap', startLine: 54, endLine: 100 },
    ]);
    expect(fold.rowOf(1)).toBe(0);
    expect(fold.rowOf(53)).toBe(52);
    expect(fold.rowOf(54)).toBe(53);
  });

  it('returns null once every gap has been expanded', () => {
    expect(buildBlockFold(1, 100, new Set([50]), () => true)).toBeNull();
  });

  it('clamps out-of-range lines instead of throwing', () => {
    const fold = buildBlockFold(10, 100, new Set([50]), never)!;
    expect(fold.rowOf(1)).toBe(0);
    expect(fold.rowOf(999)).toBe(fold.rowOf(100));
  });
});
