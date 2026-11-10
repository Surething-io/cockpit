import { describe, expect, it } from 'vitest';
import { classifyCommand, type VerificationRunInput } from '@cockpit/feature-decisions/server';
import { computeVerification, type VerificationInputs } from './verification';

const scripts = { test: 'vitest run', lint: 'eslint', typecheck: 'tsc --noEmit' };
const run = (toolId: string, command: string, order: number, outcome: VerificationRunInput['outcome'], extra: Partial<VerificationRunInput> = {}): VerificationRunInput => ({
  toolId, command, order, outcome, noTestsRan: false, tail: '', ...extra,
});
const base = (over: Partial<VerificationInputs>): VerificationInputs => ({
  runs: [],
  orderedToolIds: ['e1', 'r1', 'e2', 'r2', 'r3'],
  ownCommits: [{ toolId: 'e1', files: ['src/a.ts'] }],
  foreignCommits: [],
  taskFiles: new Set(['src/a.ts', 'src/b.ts']),
  classify: (c) => classifyCommand(c, scripts, { include: [], exclude: [] }),
  expected: ['test', 'typecheck', 'lint'],
  claimedPass: false,
  affects: () => false,
  ...over,
});
const ok0 = { kind: 'exit', code: 0 } as const;

describe('computeVerification', () => {
  it('verified when nothing relevant changed after a passing run; unrun kinds are unverified', () => {
    const r = computeVerification(base({ runs: [run('r1', 'npm test', 1, ok0)] }));
    expect(r.runs[0]).toMatchObject({ state: 'verified', exitCode: 0, changedAfter: [] });
    expect(r.kinds).toEqual([
      { kind: 'test', state: 'verified', toolId: 'r1' },
      { kind: 'typecheck', state: 'unverified' },
      { kind: 'lint', state: 'unverified' },
    ]);
  });

  it('a task edit after the run means rerun; the latest run decides the kind', () => {
    const r = computeVerification(base({
      ownCommits: [{ toolId: 'e1', files: ['src/a.ts'] }, { toolId: 'e2', files: ['src/b.ts'] }],
      runs: [run('r1', 'npm test', 1, { kind: 'exit', code: 1 })],
    }));
    expect(r.runs[0]).toMatchObject({ state: 'needs-rerun', changedAfter: ['src/b.ts'] });

    const r2 = computeVerification(base({
      ownCommits: [{ toolId: 'e2', files: ['src/b.ts'] }],
      runs: [run('r1', 'npm test', 1, ok0), run('r3', 'npm test', 4, ok0)],
    }));
    expect(r2.kinds[0]).toEqual({ kind: 'test', state: 'verified', toolId: 'r3' });
  });

  it('failed, unknown, running and no-tests', () => {
    const r = computeVerification(base({
      runs: [
        run('r1', 'npm run lint', 1, { kind: 'exit', code: 2 }),
        run('r2', 'npx tsc --noEmit', 3, { kind: 'unknown' }),
        run('r3', 'npx vitest run nope', 4, ok0, { noTestsRan: true }),
      ],
    }));
    expect(r.runs.map((x) => x.state)).toEqual(['failed', 'unknown', 'no-tests']);
    const bg = computeVerification(base({ runs: [run('r1', 'npm test', 1, { kind: 'running' })] }));
    expect(bg.runs[0].state).toBe('running');
  });

  it('a filtered run only needs a rerun when the change reaches its targets', () => {
    const inputs = base({
      ownCommits: [{ toolId: 'e2', files: ['src/b.ts'] }],
      runs: [run('r1', 'npx vitest run src/a.test.ts', 1, ok0)],
    });
    expect(computeVerification({ ...inputs, affects: () => false }).runs[0].state).toBe('verified');
    expect(computeVerification({ ...inputs, affects: () => true }).runs[0].state).toBe('needs-rerun');
    const noIndex = computeVerification({ ...inputs, affects: () => null }).runs[0];
    expect(noIndex).toMatchObject({ state: 'needs-rerun', approximate: true });
  });

  it('other sessions changing task files after the run count too; files outside the task do not', () => {
    const r = computeVerification(base({
      runs: [run('r1', 'npm test', 1, ok0, { at: '2026-11-10T00:00:00Z' })],
      foreignCommits: [
        { timestamp: Date.parse('2026-11-10T00:00:05Z') / 1000, files: ['src/b.ts'] },
        { timestamp: Date.parse('2026-11-10T00:00:06Z') / 1000, files: ['unrelated.ts'] },
        { timestamp: Date.parse('2026-11-09T23:59:00Z') / 1000, files: ['src/a.ts'] },
      ],
    }));
    expect(r.runs[0]).toMatchObject({ state: 'needs-rerun', changedAfter: ['src/b.ts'] });
  });

  it('non-check commands are listed separately; a claim without a test run is surfaced', () => {
    const r = computeVerification(base({ claimedPass: true, expected: [], runs: [run('r1', 'git status', 1, ok0)] }));
    expect(r.otherCommands).toEqual([{ toolId: 'r1', command: 'git status' }]);
    expect(r.runs).toEqual([]);
    expect(r.kinds).toEqual([{ kind: 'test', state: 'claimed' }]);
  });
});
