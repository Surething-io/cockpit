/**
 * Constraint: NoThrowingParseInEffectCallbacks (architecture rule, ratchet).
 *
 * `JSON.parse` must not run directly in a callback that Effect executes without
 * catching — `Effect.map / flatMap / tap / andThen / gen / sync / suspend / forEach`.
 * A throw there is a defect, not a failure: `orElseSucceed` / `catchAll` never see
 * it, and the request dies as a 500. Parse inside `Effect.try` / `Either.try`, or
 * use `readJsonOr` from `@cockpit/effect-runtime/server/fs`.
 *
 * Why: the session-list handlers read session.json / sessions-index.json with
 * `Effect.map((raw) => JSON.parse(raw))` behind an `orElseSucceed`. One
 * half-written file turned the whole project list into an HTTP 500.
 *
 * A JSON.parse is judged by its NEAREST enclosing function, so the correct form
 * `Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw)))` passes: the parse
 * belongs to the `Effect.try` thunk, not to the flatMap callback.
 *
 * Ratchet: BASELINE lists the call sites that predate the rule; it may only shrink.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_ROOTS = ['src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-prod', 'dist', 'client', 'components']);
const SOURCE = /\.tsx?$/;
const TEST = /\.test\.tsx?$/;
const UNGUARDED = new Set(['map', 'flatMap', 'tap', 'andThen', 'gen', 'sync', 'suspend', 'forEach']);

/** file:line of call sites that predate the rule. */
const BASELINE = new Set<string>([]);

function* walk(path: string): Generator<string> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(path, name));
  }
}

const isJsonParse = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'JSON' &&
  node.expression.name.text === 'parse';

/** `Effect.<name>(…, fn, …)` with `fn` an unguarded callback. */
const isUnguardedEffectCallback = (fn: ts.Node): boolean => {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn as ts.Expression)) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Effect' &&
    UNGUARDED.has(callee.name.text)
  );
};

function offenders(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('JSON.parse')) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (isJsonParse(node)) {
          let fn: ts.Node | undefined = node.parent;
          while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
          if (fn && isUnguardedEffectCallback(fn)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            out.push(`${relative(ROOT, file).split(sep).join('/')}:${line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return out.sort();
}

describe('NoThrowingParseInEffectCallbacks', () => {
  const found = offenders();

  it('no JSON.parse runs directly in an unguarded Effect callback', () => {
    expect(found.filter((f) => !BASELINE.has(f))).toEqual([]);
  });

  it('the baseline only shrinks: every listed call site still matches', () => {
    expect([...BASELINE].filter((f) => !found.includes(f))).toEqual([]);
  });
});
