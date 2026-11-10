import { describe, expect, it } from 'vitest';
import { extractRuns, looksLikeNoTestsRan, resolveExit, type CommandToolCall } from './commandRuns';

const bash = (over: Partial<CommandToolCall>): CommandToolCall => ({ id: 'x', name: 'Bash', input: { command: 'npm test' }, ...over });

describe('resolveExit', () => {
  it('uses a structural exit code first (Codex / Grok)', () => {
    expect(resolveExit(bash({ exitCode: 2, isError: false }))).toEqual({ kind: 'exit', code: 2 });
  });
  it('success flag means exit 0', () => {
    expect(resolveExit(bash({ isError: false, result: 'ok' }))).toEqual({ kind: 'exit', code: 0 });
  });
  it('reads the Claude prefix and the Pi suffix markers', () => {
    expect(resolveExit(bash({ isError: true, result: 'Exit code 1\nFAIL a.test.ts' }))).toEqual({ kind: 'exit', code: 1 });
    expect(resolveExit(bash({ isError: true, result: 'Traceback…\n\n\nCommand exited with code 3' }))).toEqual({ kind: 'exit', code: 3 });
  });
  it('a failure without a marker (timeout, interrupt, denied) is unknown, not failed', () => {
    expect(resolveExit(bash({ isError: true, result: 'Command timed out after 2m' }))).toEqual({ kind: 'unknown' });
    expect(resolveExit(bash({ isError: true, result: 'tests failed, Exit code 1 somewhere' }))).toEqual({ kind: 'unknown' });
  });
  it('no signal at all is unknown; in-flight and backgrounded runs are running', () => {
    expect(resolveExit(bash({ result: 'whatever' }))).toEqual({ kind: 'unknown' });
    expect(resolveExit(bash({ isLoading: true }))).toEqual({ kind: 'running' });
    expect(resolveExit(bash({ isError: false, task: { status: 'running' } }))).toEqual({ kind: 'running' });
  });
});

describe('looksLikeNoTestsRan', () => {
  it.each([
    'No test files found, exiting with code 0',
    'Ran 0 tests in 0.000s',
    'collected 0 items',
    'testing: warning: no tests to run',
    'Tests:       0 total',
    'running 0 tests',
  ])('%s', (s) => expect(looksLikeNoTestsRan(s)).toBe(true));
  it('a real run is not flagged', () => {
    expect(looksLikeNoTestsRan('Test Files  3 passed (3)\n      Tests  21 passed (21)')).toBe(false);
    expect(looksLikeNoTestsRan('Ran 10 tests in 1.2s\n\nOK')).toBe(false);
  });
});

describe('extractRuns', () => {
  it('keeps shell calls only, ordered among all calls', () => {
    const runs = extractRuns([
      { call: { id: 'e', name: 'Edit', input: { file_path: 'a' } } },
      { call: bash({ id: 'r1', isError: false, result: 'ok' }), at: '2026-11-10T00:00:00Z' },
      { call: { id: 'p', name: 'bash', input: { command: 'pytest' }, isError: true, result: 'x\nCommand exited with code 1' } },
      { call: bash({ id: 'empty', input: {} }) },
    ]);
    expect(runs.map((r) => [r.toolId, r.order, r.outcome])).toEqual([
      ['r1', 1, { kind: 'exit', code: 0 }],
      ['p', 2, { kind: 'exit', code: 1 }],
    ]);
    expect(runs[0].at).toBe('2026-11-10T00:00:00Z');
  });
});
