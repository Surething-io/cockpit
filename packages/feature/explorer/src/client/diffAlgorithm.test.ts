import { describe, expect, it } from 'vitest';
import { computeLineDiff, type DiffLine } from './diffAlgorithm';

/** Reference LCS length via the classic DP table (small inputs only). */
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Every line accounted for, in order, with correct line numbers. */
function assertConsistent(oldStr: string, newStr: string, diff: DiffLine[]) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  let i = 0;
  let j = 0;
  for (const line of diff) {
    if (line.type !== 'added') {
      expect(line.oldLineNum).toBe(i + 1);
      expect(line.content).toBe(oldLines[i++]);
    }
    if (line.type !== 'removed') {
      expect(line.newLineNum).toBe(j + 1);
      expect(line.content).toBe(newLines[j++]);
    }
  }
  expect(i).toBe(oldLines.length);
  expect(j).toBe(newLines.length);
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe('computeLineDiff', () => {
  it('produces a consistent, minimal diff on random inputs', () => {
    const rand = seeded(42);
    for (let round = 0; round < 500; round++) {
      const gen = () =>
        Array.from({ length: Math.floor(rand() * 15) }, () => String.fromCharCode(97 + Math.floor(rand() * 4)));
      const a = gen();
      const b = gen();
      const diff = computeLineDiff(a.join('\n'), b.join('\n'));
      assertConsistent(a.join('\n'), b.join('\n'), diff);
      const kept = diff.filter((l) => l.type === 'unchanged').length;
      expect(kept).toBe(lcsLength(a.join('\n').split('\n'), b.join('\n').split('\n')));
    }
  });

  it('orders removals before additions within a hunk', () => {
    expect(computeLineDiff('a\nold\nc', 'a\nnew\nc').map((l) => l.type)).toEqual([
      'unchanged', 'removed', 'added', 'unchanged',
    ]);
  });

  it('handles a large file with a small change quickly', () => {
    const lines = Array.from({ length: 8000 }, (_, k) => `line ${k} ${'x'.repeat(60)}`);
    const changed = [...lines];
    changed.splice(4000, 1, 'edited a', 'edited b');
    changed.splice(100, 0, 'inserted');
    const t0 = performance.now();
    const diff = computeLineDiff(lines.join('\n'), changed.join('\n'));
    expect(performance.now() - t0).toBeLessThan(500);
    assertConsistent(lines.join('\n'), changed.join('\n'), diff);
    expect(diff.filter((l) => l.type !== 'unchanged')).toHaveLength(4);
  });

  it('falls back to a block replace when the files share almost nothing', () => {
    const a = Array.from({ length: 5000 }, (_, k) => `a${k}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, k) => `b${k}`).join('\n');
    const diff = computeLineDiff(a, b);
    assertConsistent(a, b, diff);
    expect(diff).toHaveLength(10000);
  });
});
