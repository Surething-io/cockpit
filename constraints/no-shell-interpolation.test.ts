/**
 * Constraint: NoShellInterpolation (architecture rule, L4).
 *
 * Server code under packages/ and src/ must not hand a string with
 * interpolated values to a shell (`exec` / `execSync` / a promisified
 * `execAsync`). Values such as file names, paths and project directories can
 * come from a cloned repository or a request body, and quoting them by hand
 * is not enough for a shell. Pass arguments as an array to `execFile` /
 * `spawn` instead, or keep the shell command constant and pass data through
 * `cwd` / env.
 *
 * Why: git discard built `git restore -- "<file>"` by escaping only `"`, so a
 * tracked file whose name contained shell syntax was evaluated by the shell.
 *
 * The rule: the first argument of `exec` / `execSync` / `execAsync` must be a
 * constant string — a plain quoted literal or a template with no `${…}`, not
 * concatenated, not a variable. The only exceptions are the entry points whose
 * whole purpose is to run a shell command the user or agent typed (ALLOWED).
 *
 * Out of scope: bin/ and server.mjs (CLI and boot code that only interpolates
 * PIDs and internal paths).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_ROOTS = ['src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-prod', 'dist']);
const SOURCE = /\.(m?[jt]sx?)$/;
const TEST = /\.test\.[jt]sx?$/;

// Entry points that exist to run a user- / agent-typed shell command.
const ALLOWED = new Set([
  'packages/feature/console/src/server/api/bash.ts', // POST /api/bash — window.cockpit.bash
  'packages/feature/agent/src/server/engines/builtinAgent/tools.ts', // built-in agent Bash tool
]);

// A call to exec / execSync / execAsync (not `re.exec(…)`), capturing what follows `(`.
const SHELL_CALL = /(?<![.\w])(exec|execSync|execAsync)\(\s*/g;

/** True when the first argument starting at `i` is a constant string literal. */
function isConstantLiteral(text: string, i: number): boolean {
  const quote = text[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return false;
  let j = i + 1;
  for (; j < text.length && text[j] !== quote; j++) {
    if (text[j] === '\\') j++;
    else if (quote === '`' && text[j] === '$' && text[j + 1] === '{') return false;
  }
  const rest = text.slice(j + 1).match(/^\s*(\S)/);
  return !!rest && rest[1] !== '+';
}

function* walk(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(path, name));
  }
}

describe('NoShellInterpolation', () => {
  it('every shell command string in server code is a constant', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const rel = relative(ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(SHELL_CALL)) {
          const lineStart = text.lastIndexOf('\n', m.index) + 1;
          if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue; // comment
          if (isConstantLiteral(text, m.index + m[0].length)) continue;
          hits.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
