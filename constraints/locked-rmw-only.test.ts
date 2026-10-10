/**
 * Constraint: LockedRMWOnly (architecture rule, L4).
 *
 * Every write to a state file happens while holding that file's lock, so two
 * read → modify → write cycles on the same file can never interleave and lose
 * one of the updates. Concretely, each of these calls must sit lexically inside
 * the callback of `withFileLock(…)` or `mutateJsonFile(…)`:
 *
 * - `writeJsonFile(…)` anywhere under packages/ and src/
 * - any file mutation (`writeFile` / `appendFile` / `unlink` / `rm` / `rename`)
 *   of the terminal history JSONL, which is kept by hand: the target is
 *   `getTerminalHistoryPath(…)` itself, or a variable initialised from it.
 *   Per-command output sidecars are separate files and are not covered.
 *
 * Why: terminal history had five unlocked read-modify-write paths; a fast
 * command's fire-and-forget placeholder write could land after finalize and
 * leave the bubble "running" until restart. Earlier fixes added locks one file
 * at a time and kept missing some.
 *
 * Limits: the lock is per process; two Cockpit processes on one data dir are
 * not covered. (A crash mid-write is AtomicStateWrites' job, not this one's.)
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_ROOTS = ['src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-prod', 'dist']);
const SOURCE = /\.tsx?$/;
const TEST = /\.test\.tsx?$/;

const LOCKS = new Set(['withFileLock', 'mutateJsonFile']);
const FILE_MUTATIONS = new Set(['writeFile', 'appendFile', 'unlink', 'rm', 'rename']);

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

/** Name of the called function: `f(…)` → f, `a.b.f(…)` → f. */
function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** True when `node` sits inside a function passed as an argument to a lock helper. */
function insideLock(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    const fn = n.parent;
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      fn && ts.isCallExpression(fn) &&
      fn.arguments.includes(n as ts.Expression) &&
      LOCKS.has(calleeName(fn) ?? '')
    ) {
      return true;
    }
  }
  return false;
}

const isHistoryPathCall = (e: ts.Node): boolean =>
  ts.isCallExpression(e) && calleeName(e) === 'getTerminalHistoryPath';

/** Names of variables initialised from getTerminalHistoryPath(…) in this file. */
function historyPathVars(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isHistoryPathCall(node.initializer)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function isGuardedWrite(call: ts.CallExpression, historyVars: Set<string>): boolean {
  const name = calleeName(call) ?? '';
  if (name === 'writeJsonFile') return true;
  if (!FILE_MUTATIONS.has(name)) return false;
  const target = call.arguments[0];
  return !!target && ((ts.isIdentifier(target) && historyVars.has(target.text)) || isHistoryPathCall(target));
}

describe('LockedRMWOnly', () => {
  it('every state-file write holds the file lock', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const rel = relative(ROOT, file);
        const text = readFileSync(file, 'utf8');
        if (!text.includes('getTerminalHistoryPath') && !text.includes('writeJsonFile')) continue;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const historyVars = historyPathVars(sf);
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && isGuardedWrite(node, historyVars) && !insideLock(node)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            hits.push(`${rel}:${line + 1}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
    expect(hits).toEqual([]);
  });
});
