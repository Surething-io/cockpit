/**
 * Which shell commands count as checks (docs/DECISION_MODE.md §5). Pure rules,
 * no model: manifest script names + well-known tools, with a per-project user
 * correction on top.
 */

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'custom';

export interface CheckInfo {
  kind: CheckKind;
  /** A subset was selected (file args or a name filter) — coverage is partial. */
  filtered: boolean;
  /** Test file / path arguments, when the filter names them. */
  targets: string[];
}

export interface CheckOverrides {
  include: string[];
  exclude: string[];
}

export type ProjectScripts = Record<string, string>;

/** Collapse whitespace so the same command typed twice keys the same override. */
export const normalizeCommand = (cmd: string): string => cmd.trim().replace(/\s+/g, ' ');

/** Shell-ish word split: whitespace, honoring simple single / double quotes. */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `a && b; c | d` → each command; the left side of a pipe is the one that ran the check. */
function segments(cmd: string): string[][] {
  return cmd
    .split(/&&|\|\||;|\n/)
    .map((s) => s.split('|')[0])
    .map(words)
    .filter((w) => w.length > 0);
}

const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'env', 'time', 'nice', 'command', 'sudo']);

/** Drop `FOO=1`, `cd`, wrappers like `npx` / `timeout 60` / `pnpm exec` / `python -m`. */
function stripPrefix(w: string[]): string[] {
  let i = 0;
  for (;;) {
    const t = w[i];
    if (t === undefined) return [];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
    else if (WRAPPERS.has(t)) i++;
    else if (t === 'timeout' || t === 'gtimeout') i += 2;
    else if ((t === 'pnpm' || t === 'yarn' || t === 'bun') && w[i + 1] === 'exec') i += 2;
    else if (/^python[0-9.]*$/.test(t) && w[i + 1] === '-m') i += 2;
    else if (t.startsWith('-') && i > 0) i++;
    else break;
  }
  return w.slice(i).map((t, j) => (j === 0 ? t.replace(/^.*\/(?=[^/]+$)/, '') : t)); // ./node_modules/.bin/vitest → vitest
}

const TEST_FILE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go)|[^/]+\.(test|spec)\.[cm]?[jt]sx?)$/;
const NAME_FILTERS = new Set(['-t', '--testNamePattern', '-k', '-run', '--grep', '-g', '--filter']);

function filterOf(args: string[]): Pick<CheckInfo, 'filtered' | 'targets'> {
  const targets = args.filter((a) => !a.startsWith('-') && (a.includes('/') || TEST_FILE.test(a) || /\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$/.test(a)));
  const named = args.some((a) => NAME_FILTERS.has(a) || [...NAME_FILTERS].some((f) => a.startsWith(`${f}=`)));
  return { filtered: targets.length > 0 || named, targets };
}

/** A tool invocation (wrappers already stripped) → check, or null. */
function classifyTool(w: string[]): CheckInfo | null {
  const [tool, sub, ...rest] = w;
  const args = w.slice(1);
  const test = (a: string[]): CheckInfo => ({ kind: 'test', ...filterOf(a) });
  switch (tool) {
    case 'vitest':
      return sub === 'watch' || args.includes('--watch') ? null : test(args.filter((a) => a !== 'run'));
    case 'jest': case 'mocha': case 'ava': case 'pytest': case 'phpunit': case 'rspec': case 'jasmine':
      return test(args);
    case 'unittest':
      return test(args);
    case 'playwright':
      return sub === 'test' ? test(rest) : null;
    case 'cypress':
      return sub === 'run' ? test(rest) : null;
    case 'go':
      if (sub === 'test') return test(rest.filter((a) => a !== './...'));
      if (sub === 'vet') return { kind: 'typecheck', filtered: false, targets: [] };
      return null;
    case 'cargo':
      if (sub === 'test' || sub === 'nextest') return test(rest);
      if (sub === 'check') return { kind: 'typecheck', filtered: false, targets: [] };
      if (sub === 'clippy') return { kind: 'lint', filtered: false, targets: [] };
      return null;
    case 'deno':
      return sub === 'test' ? test(rest) : sub === 'check' ? { kind: 'typecheck', filtered: false, targets: [] } : sub === 'lint' ? { kind: 'lint', filtered: false, targets: [] } : null;
    case 'node':
      return args.includes('--test') ? test(args.filter((a) => a !== '--test')) : null;
    case 'tsc': case 'vue-tsc': case 'mypy': case 'pyright': case 'tsgo':
      return args.includes('--watch') || args.includes('-w') ? null : { kind: 'typecheck', filtered: false, targets: [] };
    case 'eslint': case 'flake8': case 'pylint': case 'golangci-lint': case 'stylelint': case 'oxlint':
      return { kind: 'lint', filtered: false, targets: [] };
    case 'ruff':
      return sub === 'check' || sub === undefined ? { kind: 'lint', filtered: false, targets: [] } : null;
    case 'biome':
      return sub === 'check' || sub === 'lint' || sub === 'ci' ? { kind: 'lint', filtered: false, targets: [] } : null;
    case 'prettier':
      return args.includes('--check') ? { kind: 'lint', filtered: false, targets: [] } : null;
    default:
      return null;
  }
}

/** Script names that are checks by convention, whatever runs inside. */
const SCRIPT_KIND: Array<[RegExp, CheckKind]> = [
  [/^(test|tests|unit|e2e|spec)([:-].*)?$/, 'test'],
  [/^(typecheck|type-check|types|tsc|check-types)([:-].*)?$/, 'typecheck'],
  [/^(lint|eslint)([:-].*)?$/, 'lint'],
];

function classifyScript(name: string, extra: string[], scripts: ProjectScripts, depth: number): CheckInfo | null {
  const byName = SCRIPT_KIND.find(([re]) => re.test(name))?.[1];
  const body = scripts[name];
  if (body !== undefined && depth < 3) {
    const inner = classifyCommandRules(`${body} ${extra.join(' ')}`, scripts, depth + 1);
    if (inner) return byName ? { ...inner, kind: byName } : inner;
  }
  return byName ? { kind: byName, ...filterOf(extra) } : null;
}

/** `npm test`, `pnpm run lint -- --fix`, `yarn typecheck`, `make check`, or a direct tool. */
function classifySegment(raw: string[], scripts: ProjectScripts, depth: number): CheckInfo | null {
  const w = stripPrefix(raw);
  const [head, a1, ...more] = w;
  if (!head) return null;
  if (head === 'cd' || head === 'echo' || head === 'cat') return null;
  if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') {
    if (a1 === undefined) return null;
    if (head === 'bun' && a1 === 'test') return { kind: 'test', ...filterOf(more) };
    const [name, rest] = a1 === 'run' || a1 === 'run-script' ? [more[0], more.slice(1)] : a1 === 't' ? ['test', more] : [a1, more];
    if (!name) return null;
    const extra = rest.filter((x) => x !== '--');
    // A defined script wins; otherwise `yarn vitest` / `pnpm eslint` run the binary itself.
    if (name in scripts) return classifyScript(name, extra, scripts, depth);
    return classifyTool([name, ...extra]) ?? classifyScript(name, extra, scripts, depth);
  }
  if (head === 'make' || head === 'just' || head === 'task') {
    const target = a1 ?? '';
    const kind = SCRIPT_KIND.find(([re]) => re.test(target))?.[1] ?? (target === 'check' ? 'test' : undefined);
    return kind ? { kind, filtered: false, targets: [] } : null;
  }
  return classifyTool(w);
}

function classifyCommandRules(cmd: string, scripts: ProjectScripts, depth: number): CheckInfo | null {
  for (const seg of segments(cmd)) {
    const info = classifySegment(seg, scripts, depth);
    if (info) return info;
  }
  return null;
}

/** Final answer: user correction first, then the rules. */
export function classifyCommand(cmd: string, scripts: ProjectScripts, overrides: CheckOverrides): CheckInfo | null {
  const key = normalizeCommand(cmd);
  if (overrides.exclude.includes(key)) return null;
  const info = classifyCommandRules(cmd, scripts, 0);
  if (info) return info;
  return overrides.include.includes(key) ? { kind: 'custom', filtered: false, targets: [] } : null;
}

/** Check kinds the project defines, so a range with none of them run shows "unverified". */
export function expectedKinds(scripts: ProjectScripts, markers: { pytest?: boolean; goMod?: boolean; cargo?: boolean }): CheckKind[] {
  const kinds = new Set<CheckKind>();
  for (const name of Object.keys(scripts)) {
    const k = SCRIPT_KIND.find(([re]) => re.test(name))?.[1];
    if (k && !name.includes(':watch') && !/watch/.test(scripts[name] ?? '')) kinds.add(k);
  }
  if (markers.pytest || markers.goMod || markers.cargo) kinds.add('test');
  return (['test', 'typecheck', 'lint'] as CheckKind[]).filter((k) => kinds.has(k));
}
