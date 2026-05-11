/**
 * Server-only project graph builder.
 *
 * Pipeline:
 *   1. Walk the project tree → list of source files.
 *   2. For each file: parse with tree-sitter (per file extension), extract
 *      import specifiers from the AST.
 *   3. Resolve each specifier to a project-relative file path
 *      (handles `./`, `../`, `@/`, and tries common extensions / index files).
 *   4. Group files into modules — folder-fallback (parent dir capped at depth 3).
 *   5. Collapse file-level edges into module-level edges with weights.
 *
 * Why tree-sitter (not regex): keeps the extraction layer language-agnostic.
 * Adding Python / Go / Rust later means writing a per-grammar walker, not
 * maintaining a parallel regex set per language. Cost is modest — full
 * project parses still finish in well under a second for typical projects.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
// Imported from `registry` (not the barrel) to avoid a cycle with
// handler modules that import from this file. The barrel — which
// triggers handler registrations — is imported by codeIndex.ts at
// the top of its module; by the time `getExtensionSet` here actually
// runs, every handler has registered.
import { getAllExtensions } from '../handlers/registry';

const execAsync = promisify(exec);

// ============================================================================
// File listing
//
// Source-of-truth: the project's own `.gitignore`. We ask git for the list of
// non-ignored files (tracked + untracked-but-not-ignored) and trust the
// project to know what's noise — node_modules, build outputs, generated code
// are already excluded by every reasonable repo's .gitignore.
//
// This is also how ripgrep, sentrux, and most real code-analysis tools work.
// Maintaining our own SKIP_DIRS list is fragile: every project has its own
// generated/cached directories, and we'd be playing catch-up forever.
// ============================================================================

/** Minimal skip set used ONLY when the project isn't a git repo. We can't
 *  trust `.gitignore` there, so we hardcode the universally-bad dirs. */
const NON_GIT_FALLBACK_SKIP = new Set(['.git', 'node_modules']);

/** Hard cap on files per scan. Even with .gitignore filtering, a sufficiently
 *  large monorepo can blow past sensible limits. UI surfaces a `truncated`
 *  flag so users know the graph isn't complete.
 *
 *  Single source of truth — `codeIndex.ts` imports from here so
 *  `listFilesViaGit` / `walkSource` / the post-list `slice` all use the
 *  SAME limit. */
export const MAX_FILES = 8000;

// Tests, specs, and storybook files (`*.test.*` / `*.spec.*` /
// `*.stories.*`) are deliberately INDEXED — calls from a test into
// production code are real architectural edges, and surfacing
// "called from foo.test.ts" in a function's upstream list gives
// reviewers at-a-glance test-coverage signal. The chip view handles
// `describe(...)` / `it(...)` / `test(...)` idioms via
// `extractFromCallStatement` (string label + arrow body becomes a
// nested block), so test files render with proper structure without
// any special-casing in the picker.
//
// Source-file recognition derives from the union of every registered
// LanguageHandler's `extensions` field — adding Go / Rust / Java is a
// "register a handler" action, not "edit a regex here". We DON'T
// cache the extension set: the registry can be re-populated by
// Next.js HMR and a stale cache here would silently disagree with
// the runtime registry. Recomputing per call is cheap (a handful of
// handlers, each with a small extensions array) and it sidesteps
// the entire HMR-invalidation question.
function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const ext = lower.slice(dotIdx);
  for (const e of getAllExtensions()) {
    if (e.toLowerCase() === ext) return true;
  }
  return false;
}

/**
 * List source files via `git ls-files`, respecting `.gitignore` automatically.
 * Returns null if the directory isn't a git repo (caller falls back to fs walk).
 *
 * Flags used:
 *   --cached              tracked files
 *   --others              untracked files
 *   --exclude-standard    apply .gitignore + .git/info/exclude + global excludes
 *   -c core.quotePath=false   pass-through non-ASCII paths instead of escaping
 */
export async function listFilesViaGit(cwd: string): Promise<string[] | null> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd });
  } catch {
    return null; // not a git repo
  }
  // 50MB ceiling to handle very large monorepos without truncation surprises.
  const { stdout } = await execAsync(
    'git -c core.quotePath=false ls-files --cached --others --exclude-standard',
    { cwd, maxBuffer: 50 * 1024 * 1024 },
  );
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const baseName = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    if (isSourceFile(baseName)) {
      out.push(trimmed);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

/**
 * Filesystem walk fallback for non-git projects. Uses a minimal hardcoded
 * skip set since there's no `.gitignore` to consult.
 */
export async function walkSource(dir: string, root: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (NON_GIT_FALLBACK_SKIP.has(entry.name) || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSource(full, root, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(path.relative(root, full));
    }
  }
}

// ============================================================================
// Path resolution
// ============================================================================

const RESOLUTION_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Extensions we strip from import specifiers before resolving. Modern
 * TypeScript (moduleResolution: nodenext) REQUIRES writing `.js` in import
 * specifiers even when the source file is `.ts` — by stripping these we let
 * the candidate loop discover the real file regardless of which extension
 * the user wrote.
 */
const STRIPPABLE_EXT = ['.js', '.jsx', '.mjs', '.cjs'];

/**
 * Given a base path (project-absolute), try to find a matching source file
 * by stripping common extensions and trying `.ts/.tsx/.js/...` and `/index.*`.
 * Returns project-relative path on hit, null on miss. Pure Set lookups, no I/O.
 */
export function findFileForBase(baseAbs: string, cwd: string, fileSet: Set<string>): string | null {
  let baseRel = path.relative(cwd, baseAbs);
  if (baseRel.startsWith('..')) return null; // escapes project root

  // Strip TS-style explicit extensions (`./foo.js` for a real `./foo.ts`).
  for (const ext of STRIPPABLE_EXT) {
    if (baseRel.endsWith(ext)) {
      baseRel = baseRel.slice(0, -ext.length);
      break;
    }
  }

  if (fileSet.has(baseRel)) return baseRel;
  for (const ext of RESOLUTION_EXT) {
    const c = baseRel + ext;
    if (fileSet.has(c)) return c;
  }
  for (const ext of RESOLUTION_EXT) {
    const c = path.join(baseRel, 'index' + ext);
    if (fileSet.has(c)) return c;
  }
  return null;
}

/** True when `file` lives inside `scope`. Empty scope matches everything. */
export function fileInScope(file: string, scope: string): boolean {
  return scope === '' || file === scope || file.startsWith(scope + '/');
}

// ============================================================================
// Workspace package resolution (pnpm / npm / yarn workspaces)
//
// In a monorepo, internal package imports (`@repo/auth`) look like ordinary
// npm packages but actually resolve to sibling directories. Without
// workspace-awareness those imports get classified as external, hiding the
// real cross-package dependency edges that matter for architecture.
// ============================================================================

export interface Workspace {
  /** Package name from its `package.json` (e.g. `@repo/auth`). */
  name: string;
  /** Project-relative directory of the package (e.g. `packages/auth`). */
  dir: string;
  /** Resolved entry file (project-relative), or null if we couldn't find one. */
  entryFile: string | null;
}

/**
 * Discover workspace packages and resolve each one's entry file.
 * Returns a name → workspace map for `resolveImport` to consult.
 *
 * Detection order: pnpm-workspace.yaml (deliberately first — projects using
 * pnpm sometimes also have a misleading `workspaces` array in package.json
 * that's actually for tooling parity, not the source of truth) → package.json
 * `workspaces` field (npm / yarn).
 */
export async function loadWorkspaces(cwd: string, fileSet: Set<string>): Promise<Map<string, Workspace>> {
  const patterns = await readWorkspacePatterns(cwd);
  if (patterns.length === 0) return new Map();

  // Find every `*/package.json` that matches a workspace pattern. We intersect
  // with git ls-files so we only consider tracked / non-ignored package.jsons,
  // which automatically skips node_modules.
  let pkgJsonPaths: string[] = [];
  try {
    const { stdout } = await execAsync(
      'git -c core.quotePath=false ls-files --cached --others --exclude-standard',
      { cwd, maxBuffer: 50 * 1024 * 1024 },
    );
    pkgJsonPaths = stdout
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.endsWith('/package.json') && !p.includes('node_modules/'));
  } catch {
    return new Map();
  }

  const matched = pkgJsonPaths.filter((p) => {
    const dir = p.slice(0, -'/package.json'.length);
    return patterns.some((pat) => globMatchesDir(dir, pat));
  });

  const result = new Map<string, Workspace>();
  for (const rel of matched) {
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(path.join(cwd, rel), 'utf8'));
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string') continue;
    const dir = path.dirname(rel);
    const entryFile = resolveWorkspaceEntry(dir, pkg, fileSet);
    result.set(pkg.name, { name: pkg.name, dir, entryFile });
  }
  return result;
}

async function readWorkspacePatterns(cwd: string): Promise<string[]> {
  // pnpm-workspace.yaml: simple line parser. We don't pull in a YAML lib for
  // this — pnpm-workspace.yaml shape is shallow and stable enough for regex.
  try {
    const yaml = await fs.readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    return parsePnpmWorkspaces(yaml);
  } catch {
    // file missing — fall through
  }
  // npm / yarn: package.json `workspaces` field (string[] or {packages: string[]}).
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    const ws = pkg?.workspaces;
    if (Array.isArray(ws)) return ws.filter((s): s is string => typeof s === 'string');
    if (ws && Array.isArray(ws.packages)) {
      return ws.packages.filter((s: unknown): s is string => typeof s === 'string');
    }
  } catch {
    // no package.json or invalid — no workspaces
  }
  return [];
}

function parsePnpmWorkspaces(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/#.*$/, ''); // strip comments
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const itemMatch = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/);
    if (itemMatch) {
      out.push(itemMatch[1]);
    } else if (/^\S/.test(line)) {
      // top-level key encountered — packages section ended
      inPackages = false;
    }
  }
  return out;
}

/** Match a project-relative dir against a workspace glob like `apps/*` or `packages/**`. */
function globMatchesDir(dir: string, pattern: string): boolean {
  // Convert glob → regex. We only need to support `*` and `**`.
  const re = new RegExp(
    '^' +
      pattern
        .replace(/\\/g, '/')
        .replace(/[.+^${}()|[\]]/g, '\\$&')
        .replace(/\*\*/g, '___DOUBLESTAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/___DOUBLESTAR___/g, '.*') +
      '$',
  );
  return re.test(dir);
}

/**
 * Find a workspace's entry file. Tries (in order):
 *   1. `exports['.']` (handles modern ESM exports map; conditional fields → first match)
 *   2. `main`
 *   3. Conventional locations: `src/index.ts(x)`, `index.ts(x)`, `.js` variants
 *
 * We treat the entry file as project-relative. Subpath imports
 * (`@repo/auth/lib/foo`) are resolved separately by `resolveImport` —
 * the entry file is only used for the bare-package-name case.
 */
function resolveWorkspaceEntry(
  pkgDir: string,
  pkg: { exports?: unknown; main?: unknown },
  fileSet: Set<string>,
): string | null {
  const tryRelToPkg = (subpath: string): string | null => {
    const cleaned = subpath.replace(/^\.\//, '');
    return findFileRelativeToProject(path.posix.join(pkgDir, cleaned), fileSet);
  };

  // 1. exports['.'] (or top-level string)
  const exp = pkg.exports as
    | string
    | { '.'?: string | Record<string, string | { default?: string; import?: string; require?: string }>; }
    | undefined;
  let exportEntry: string | undefined;
  if (typeof exp === 'string') {
    exportEntry = exp;
  } else if (exp && typeof exp === 'object' && exp['.']) {
    const dot = exp['.'];
    if (typeof dot === 'string') exportEntry = dot;
    else if (dot && typeof dot === 'object') {
      // Pick the most TypeScript-friendly condition we can.
      exportEntry =
        (dot as Record<string, string>)['types'] ??
        (dot as Record<string, string>)['import'] ??
        (dot as Record<string, string>)['default'] ??
        (dot as Record<string, string>)['require'];
    }
  }
  if (typeof exportEntry === 'string') {
    const r = tryRelToPkg(exportEntry);
    if (r) return r;
  }

  // 2. main field
  if (typeof pkg.main === 'string') {
    const r = tryRelToPkg(pkg.main);
    if (r) return r;
  }

  // 3. Conventional defaults
  for (const conv of ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx', 'src/index.js', 'index.js']) {
    if (fileSet.has(path.posix.join(pkgDir, conv))) {
      return path.posix.join(pkgDir, conv);
    }
  }
  return null;
}

/** Light-weight version of `findFileForBase` that takes a project-relative
 *  base path directly (skips the absolute-path round-trip). Tries strippable
 *  extensions, real source extensions, and `/index.*` directory variants. */
export function findFileRelativeToProject(baseRel: string, fileSet: Set<string>): string | null {
  if (baseRel.startsWith('..') || baseRel.startsWith('/')) return null;
  for (const ext of STRIPPABLE_EXT) {
    if (baseRel.endsWith(ext)) {
      baseRel = baseRel.slice(0, -ext.length);
      break;
    }
  }
  if (fileSet.has(baseRel)) return baseRel;
  for (const ext of RESOLUTION_EXT) {
    const c = baseRel + ext;
    if (fileSet.has(c)) return c;
  }
  for (const ext of RESOLUTION_EXT) {
    const c = path.posix.join(baseRel, 'index' + ext);
    if (fileSet.has(c)) return c;
  }
  return null;
}

/**
 * A tsconfig and its scope. The scope is the project-relative directory the
 * tsconfig governs — files under it use these aliases, files outside don't.
 *
 * Empty scope (`""`) = root tsconfig.
 *
 * Sorted deepest-first by `loadTsconfigs` so per-file lookup picks the most
 * specific config first (apps/web/tsconfig.json beats root tsconfig.json
 * for files under apps/web/).
 */
export interface TsconfigScope {
  /** Project-relative directory containing this tsconfig (`""` for root). */
  scope: string;
  /** Alias prefix (e.g. `@`) → target directory, project-relative. */
  aliases: Map<string, string>;
  /** Same content as `aliases` but pre-sorted longest-prefix-first.
   *  resolveSpecifier matches against this so each per-spec call
   *  avoids re-running `[...aliases.entries()].sort(...)` on every
   *  import in the file. Computed once when this scope is built. */
  sortedAliases: ReadonlyArray<readonly [string, string]>;
}

/** Parse a single tsconfig's `compilerOptions.paths` into an alias map.
 *  Returns an empty map if the file is missing, unreadable, or has no paths.
 *
 *  We strip ONLY `//` line comments. Block-comment stripping is intentionally
 *  omitted — naively matching `/* ... *\/` collides with glob patterns like
 *  `"@/*"` or `"**\/*.ts"` that appear inside JSON string values, eating
 *  chunks of legitimate content. tsconfigs in practice almost never use
 *  block comments anyway. If a project does, JSON.parse will fail and we
 *  silently skip that tsconfig. */
async function parseTsconfigAliases(filePath: string, cwd: string): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  let json;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    // Strip line-comments only. Anchor at line-start-ish positions to avoid
    // wrecking `//` that appears inside strings (rare in tsconfig but happens
    // for URLs like "//cdn.example/...").
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
    json = JSON.parse(stripped);
  } catch {
    return aliases;
  }
  const baseUrl: string = json?.compilerOptions?.baseUrl ?? '.';
  const pathsMap: Record<string, string[]> = json?.compilerOptions?.paths ?? {};
  // baseUrl is relative to the tsconfig's directory; we need it relative to cwd.
  const absBase = path.resolve(path.dirname(filePath), baseUrl);
  const relBase = path.relative(cwd, absBase) || '.';
  for (const [key, vals] of Object.entries(pathsMap)) {
    if (!Array.isArray(vals) || vals.length === 0) continue;
    const cleanKey = key.replace(/\/\*$/, '');
    const cleanVal = vals[0].replace(/\/\*$/, '');
    aliases.set(cleanKey, path.join(relBase, cleanVal));
  }
  return aliases;
}

/**
 * Discover all tsconfig*.json across the project (respecting .gitignore) and
 * build per-scope alias maps. Returns scopes sorted deepest-first.
 *
 * Why per-scope (instead of one merged map): in a pnpm/turbo monorepo each
 * subpackage typically defines its own `@/*` mapping pointing to its own
 * directory. The same `@/foo` import resolves to different files depending
 * on which package the importing file lives in. A merged map would make this
 * ambiguous — only the file's scope can disambiguate.
 */
export async function loadTsconfigs(cwd: string): Promise<TsconfigScope[]> {
  const scopes: TsconfigScope[] = [];
  // List ALL tracked + non-ignored files and JS-filter for tsconfig variants.
  // We deliberately don't use a git pathspec (`*tsconfig*.json`) because
  // pathspec only matches the literal pattern in each segment — `*tsconfig*`
  // alone doesn't recurse into subdirectories. Filtering in JS is simpler and
  // correct.
  let tsconfigPaths: string[] = [];
  try {
    const { stdout } = await execAsync(
      'git -c core.quotePath=false ls-files --cached --others --exclude-standard',
      { cwd, maxBuffer: 50 * 1024 * 1024 },
    );
    tsconfigPaths = stdout
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => /(^|\/)tsconfig[^/]*\.json$/.test(p) && !p.includes('node_modules/'));
  } catch {
    // Non-git project: just check root.
    try {
      await fs.access(path.join(cwd, 'tsconfig.json'));
      tsconfigPaths = ['tsconfig.json'];
    } catch {
      // none
    }
  }

  for (const rel of tsconfigPaths) {
    const aliases = await parseTsconfigAliases(path.join(cwd, rel), cwd);
    if (aliases.size === 0) continue;
    const scope = path.dirname(rel);
    scopes.push({
      scope: scope === '.' ? '' : scope,
      aliases,
      sortedAliases: sortAliasesByLength(aliases),
    });
  }

  // Default fallback: ensure `@` → `./src` exists at root for projects that
  // use this convention without declaring it explicitly.
  let root = scopes.find((s) => s.scope === '');
  if (!root) {
    const aliases = new Map<string, string>();
    root = { scope: '', aliases, sortedAliases: [] };
    scopes.push(root);
  }
  if (!root.aliases.has('@')) {
    root.aliases.set('@', './src');
    // Mutating root.aliases invalidates root.sortedAliases — rebuild it.
    // (sortedAliases is typed as ReadonlyArray to discourage external
    // mutation; constructing a new array here is the supported path.)
    (root as { sortedAliases: ReadonlyArray<readonly [string, string]> })
      .sortedAliases = sortAliasesByLength(root.aliases);
  }

  // Deepest scope first so the resolver picks the most specific match.
  return scopes.sort((a, b) => b.scope.length - a.scope.length);
}

/** Pre-sort tsconfig alias entries longest-prefix-first so the
 *  resolver's per-spec lookup is a linear `find` rather than a sort
 *  + find on every call. */
function sortAliasesByLength(
  aliases: Map<string, string>,
): ReadonlyArray<readonly [string, string]> {
  return [...aliases.entries()].sort(([a], [b]) => b.length - a.length);
}

// ============================================================================
// Module assignment
// ============================================================================

/**
 * Folder-fallback rule: parent directory of the file, capped at depth 3.
 * Examples:
 *   src/components/foo.tsx              → src/components
 *   src/lib/codeMap/types.ts            → src/lib/codeMap
 *   src/lib/codeMap/projectGraph/x.ts   → src/lib/codeMap (capped at 3)
 *   package.json                        → (root)
 */
export function folderFallbackModule(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length === 1) return '(root)';
  const dirParts = parts.slice(0, parts.length - 1);
  return dirParts.slice(0, 3).join('/') || '(root)';
}
