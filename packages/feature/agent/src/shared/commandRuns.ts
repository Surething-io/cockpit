/**
 * Shell command runs as verification evidence (docs/DECISION_MODE.md §5, §12.1). Pure.
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

/**
 * Output that shows no test actually ran — the most common "green but nothing
 * was tested" (a filter that matched nothing, an empty suite, --passWithNoTests).
 */
const NO_TESTS = [
  /\bNo tests? (?:files? )?found\b/i,
  /\bno test files? found\b/i,
  /\bRan 0 tests?\b/,
  /\bcollected 0 items\b/,
  /\bno tests to run\b/i,
  /\bTests?:?\s+0 (?:passed|total)\b/i,
  /\b0 tests? (?:passed|run|ran)\b/i,
  /\brunning 0 tests\b/,
];

export function looksLikeNoTestsRan(output: string): boolean {
  return NO_TESTS.some((re) => re.test(output));
}

/** One command run, in conversation order, as sent to the verification endpoint. */
export interface CommandRun {
  toolId: string;
  command: string;
  outcome: RunOutcome;
  /** Position among ALL tool calls of the range (orders runs against edits). */
  order: number;
  /** ISO timestamp of the assistant message that issued it, when known. */
  at?: string;
  noTestsRan: boolean;
  /** Last lines of output, for the review row. */
  tail: string;
}

const TAIL_CHARS = 2000;

/**
 * Command runs of a sequence of assistant tool calls. `orderedToolIds` is every
 * tool call of the range in order; `calls` resolves each id to its call.
 */
export function extractRuns(
  ordered: ReadonlyArray<{ call: CommandToolCall; at?: string }>,
): CommandRun[] {
  const runs: CommandRun[] = [];
  ordered.forEach(({ call, at }, order) => {
    if (!isShellTool(call.name)) return;
    const command = commandText(call);
    if (!command) return;
    const out = call.result ?? '';
    runs.push({
      toolId: call.id,
      command,
      outcome: resolveExit(call),
      order,
      ...(at ? { at } : {}),
      noTestsRan: looksLikeNoTestsRan(out),
      tail: out.length > TAIL_CHARS ? out.slice(-TAIL_CHARS) : out,
    });
  });
  return runs;
}
