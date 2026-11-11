/**
 * The outcome of a shell command tool call, across engines. Pure.
 *
 * Every engine reports a command's outcome, in one of three forms:
 *   - a numeric exit code (Codex, Grok) → `exitCode`
 *   - Claude: `is_error` + the result text STARTS with `Exit code N`
 *   - Pi:     `is_error` + the result text ENDS with `Command exited with code N`
 * The two text forms are fixed markers the runtimes write themselves, not a
 * guess from command output. Anything else that failed (timeout, interrupt,
 * permission denied) carries no marker and stays `unknown` — never "failed".
 */

export interface CommandToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  exitCode?: number;
  task?: { status?: string };
}

export type RunOutcome =
  | { kind: 'exit'; code: number }
  | { kind: 'running' }
  | { kind: 'unknown' };

/** Shell-like tools across engines (Claude / Codex map to `Bash`; Pi and Grok use lowercase). */
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'run_terminal_cmd', 'execute_command']);

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase());
}

export function commandText(tc: CommandToolCall): string {
  const c = tc.input.command ?? tc.input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return '';
}

const CLAUDE_EXIT = /^Exit code (\d+)/;
const PI_EXIT = /Command exited with code (\d+)\s*$/;

export function resolveExit(tc: CommandToolCall): RunOutcome {
  if (tc.isLoading) return { kind: 'running' };
  const bg = tc.task?.status;
  if (bg === 'running' || bg === 'pending') return { kind: 'running' };
  if (typeof tc.exitCode === 'number') return { kind: 'exit', code: tc.exitCode };
  if (tc.isError === false) return { kind: 'exit', code: 0 };
  if (tc.isError === true) {
    const text = tc.result ?? '';
    const m = CLAUDE_EXIT.exec(text) ?? PI_EXIT.exec(text);
    return m ? { kind: 'exit', code: Number(m[1]) } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}
