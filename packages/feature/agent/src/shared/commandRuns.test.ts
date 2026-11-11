import { describe, expect, it } from 'vitest';
import { commandText, isShellTool, resolveExit, type CommandToolCall } from './commandRuns';

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

describe('shell tool helpers', () => {
  it('recognises shell tools across engines and reads their command', () => {
    expect(['Bash', 'bash', 'exec_command'].every(isShellTool)).toBe(true);
    expect(isShellTool('Edit')).toBe(false);
    expect(commandText(bash({ input: { command: 'npm test' } }))).toBe('npm test');
    expect(commandText(bash({ input: { cmd: ['go', 'test'] } }))).toBe('go test');
    expect(commandText(bash({ input: {} }))).toBe('');
  });
});
