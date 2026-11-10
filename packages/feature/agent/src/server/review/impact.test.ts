import { describe, expect, it } from 'vitest';
import type { VerificationResult } from '@cockpit/feature-decisions/server';
import { diffSymbols, parseShapes, testCoverage } from './impact';

describe('symbol diff', () => {
  it('separates interface changes from body-only changes (real TS parse)', async () => {
    const before = `export function greet(name: string) {\n  return 'hi ' + name;\n}\nexport function count() {\n  return 1;\n}\nexport function gone() {}\n`;
    const after = `export function greet(name: string, loud: boolean) {\n  return 'hi ' + name;\n}\nexport function count() {\n  return 2;\n}\nexport function fresh() {}\n`;
    const [b, a] = await Promise.all([parseShapes('src/lib.ts', before), parseShapes('src/lib.ts', after)]);
    const d = Object.fromEntries(diffSymbols(b!, a!).map((x) => [x.qname, x.change]));
    expect(d).toEqual({ greet: 'interface', count: 'body', fresh: 'added', gone: 'removed' });
  });

  it('no grammar → null (reported as a blind spot by the caller)', async () => {
    expect(await parseShapes('Main.java', 'class A {}')).toBeNull();
    expect(await parseShapes('src/x.ts', null)).toEqual([]);
  });
});

describe('testCoverage', () => {
  const v = (runs: Array<Partial<VerificationResult['runs'][number]>>): VerificationResult => ({
    kinds: [],
    otherCommands: [],
    runs: runs.map((r, i) => ({ toolId: `r${i}`, command: '', kind: 'test', filtered: false, targets: [], state: 'verified', changedAfter: [], approximate: false, tail: '', ...r })),
  });
  it('the latest covering run decides; filtered runs cover only their targets', () => {
    const cov = testCoverage(['src/a.test.ts', 'src/sub/b.test.ts', 'c.test.ts'], v([
      { filtered: true, targets: ['src/a.test.ts'], state: 'failed' },
      { filtered: true, targets: ['src/sub/'], state: 'verified' },
    ]));
    expect(cov.map((c) => c.state)).toEqual(['failed', 'verified', 'not-run']);
    expect(testCoverage(['x.test.ts'], v([{ state: 'needs-rerun' }]))[0]).toEqual({ test: 'x.test.ts', state: 'needs-rerun', toolId: 'r0' });
  });
});
