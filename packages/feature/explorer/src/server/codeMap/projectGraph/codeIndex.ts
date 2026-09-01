/**
 * Project-wide code index — single source of truth for the Code Map.
 *
 * Builds once per cwd, caches in memory. The index holds:
 *   - Each source file's symbol tree (functions / classes / methods …),
 *     used by Code Map node rendering and by the function drawer.
 *   - Each file's resolved import set (file-level edges, kept for
 *     potential future use even though the current Code Map view
 *     doesn't render them).
 *   - Each file's call graph data:
 *       * `intraCalls` — local function-to-function calls (caller and
 *         callee are both qualified names within the same file).
 *       * `outgoingCalls` — calls leaving this file. The target is a
 *         (filePath, qualifiedName) address.
 *       * `incomingCalls` — calls entering this file. Inverted from
 *         every other file's outgoing edges in a post-pass.
 *
 * From the cached index, the route handlers project four views:
 *   - `fileFunctionsFromIndex`     → focal file's functions + intra-file
 *                                    call edges (Code Map's file mode).
 *   - `functionNeighborsFromIndex` → focal function + 1-hop callers and
 *                                    callees, both intra and cross-file
 *                                    (Code Map's function mode).
 *   - `fileDetailFromIndex`        → one file's symbol tree (drawer payload).
 *   - `searchIndex`                → categorized hits (Cmd+K palette).
 *
 * Why server-side: the file edge graph requires resolving every import
 * specifier to a project-relative path (depends on tsconfig path
 * aliases and workspace package layouts the client doesn't have). The
 * call graph then layers on top — resolving a call against import
 * bindings requires the same machinery. Doing both once on the server
 * lets every projection be a cheap lookup.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getServerParser, grammarForExtension } from './serverTreeSitter';
import { SUPPORTED_GRAMMARS } from '../languageMap';
import {
  listFilesViaGit,
  loadTsconfigs,
  loadWorkspaces,
  walkSource,
  MAX_FILES,
  type TsconfigScope,
  type Workspace,
} from './buildGraph';
import { emitBuildProgress } from './buildProgress';
import type {
  CrossFileCallEdge,
  ExternalCallEdge,
  FileDetailResponse,
  FileFunctionsResponse,
  FunctionNode,
  IntraCallEdge,
  LiteralHit,
  MethodCallEdge,
  SearchHit,
  SearchResponse,
} from './types';
import type { ImportBinding } from '../extractCalls';
import type { ExtractedSymbol, SymbolKind } from '../types';
import { isFunctionLike } from '../types';
// Importing the handlers barrel triggers per-language `registerHandler`
// side effects, so `getHandler(grammar)` below is guaranteed to find a
// handler for any grammar that `grammarForExtension` returns. (P1a:
// only file-level extraction goes through the handler; resolution
// still uses the legacy local helpers below — moves to handlers in P1b.)
import { getHandler } from '../handlers';
import { dedupeQualifiedNames } from '../extractSymbols';

// ============================================================================
// Index types
// ============================================================================

/** A symbol's address — uniquely identifies a symbol across the project. */
export interface SymbolAddr {
  filePath: string;
  qualifiedName: string;
}

/** An identifier-shaped string literal harvested from the source.
 *
 *  Why this exists: AST extraction only sees IDENTIFIERS (function /
 *  class / variable names). Tool names, event names, route paths,
 *  config keys and similar are commonly STRING LITERALS in source:
 *
 *    return { name: "user_profile", description: "...", ... }
 *
 *  Such strings are semantically equivalent to symbols for "where is
 *  X used / defined" queries — but `searchIndex` over `flatSymbols`
 *  alone misses them. `IndexedFile.literals` carries this second pool
 *  so `searchIndex({ includeLiterals: true })` can serve hits from it.
 *
 *  Filtered at extraction time to identifier-shaped strings (regex
 *  `^[A-Za-z][A-Za-z0-9_.-]{2,63}$`) so we don't index SQL fragments,
 *  JSX text, or human-readable error messages. */
export interface IndexedLiteral {
  /** Literal text (quotes already stripped). */
  value: string;
  /** 1-based line where the literal occurs in the file. */
  line: number;
  /** qname of the smallest enclosing function/class/method, if any.
   *  Undefined for top-level / module-scope literals. */
  enclosingQname?: string;
}

/** Flat record per symbol — used for the global byName lookup during call
 *  resolution and for fast single-symbol lookups inside one file. */
export interface IndexedSymbol extends SymbolAddr {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  /** Parameter names for callables — propagated through to FunctionNode
   *  so the chip header can render `(req, res, next)`. See
   *  `ExtractedSymbol.params` for semantics; we just pass it through. */
  params?: string[];
}

export interface IndexedFile {
  path: string;
  language: string;
  /** `fs.stat().mtimeMs` at the moment this file was last parsed.
   *  Read by `refreshFocalFile` to decide whether to re-parse: if the
   *  on-disk mtime differs, the focal file's symbolsTree / flatSymbols
   *  / intraCalls / outgoingCalls / etc. are rebuilt in place
   *  (incomingCalls + importedBy left as the previous full-build
   *  computed them — accepted stale, see `refreshFocalFile`). */
  mtime: number;
  /** Hierarchical symbol tree (functions, classes, methods …). */
  symbolsTree: ExtractedSymbol[];
  /** Flattened symbols, used by `findEnclosing` and the call resolver. */
  flatSymbols: IndexedSymbol[];
  /** Identifier-shaped string literals harvested from the source.
   *  Searched only when `searchIndex(..., { includeLiterals: true })`.
   *  See `IndexedLiteral` for the filtering contract. Empty array when
   *  no qualifying literals were found in the file. */
  literals: IndexedLiteral[];
  /** Resolved file → file edges (set of project-relative target paths). */
  importedFiles: Set<string>;
  /** Inverse of `importedFiles`. Filled in pass 2 of build. */
  importedBy: Set<string>;
  /** Local-name → (specifier, importedName) for call resolution.
   *  Includes both regular imports AND re-exports (the latter
   *  marked `isReexport: true`). Re-exports used to live in their
   *  own `reexports` field; folding into one array eliminated the
   *  duplicate "iterate barrel forwarding table" code path. */
  importBindings: ImportBinding[];
  /** Specifier → resolved file path. Same keys as importBindings.specifier. */
  resolvedImports: Map<string, string>;
  /** Calls within the file — both endpoints are local qualified names.
   *  `lines` collects every call-site line for the (from, to) pair so the
   *  client can position pins next to the actual call lines. Sorted asc. */
  intraCalls: Array<{ from: string; to: string; lines: number[] }>;
  /** Calls leaving this file. `to` is a remote symbol address. `lines`
   *  are call-site lines in THIS file (the caller side). */
  outgoingCalls: Array<{ from: string; to: SymbolAddr; lines: number[] }>;
  /** Calls entering this file. Filled in pass 2 by inverting outgoing.
   *  `lines` are call-site lines in the caller's file (NOT this file). */
  incomingCalls: Array<{ from: SymbolAddr; to: string; lines: number[] }>;
  /** Calls into modules that didn't resolve to any project file —
   *  npm packages, unresolved aliases, etc. Tracked here (rather than
   *  dropped on the floor) so chip view can surface them as "EXT"
   *  pins for visibility. `lines` are call-site lines in THIS file. */
  externalCalls: Array<{
    from: string;
    packageSpec: string;
    importedName: string;
    lines: number[];
  }>;
  /** "We saw a `obj.method()` call where `obj` is a project import,
   *  but couldn't locate `method` in `obj`'s home file" fallback.
   *  Visibility-only — chip view shows these as muted METHOD pins,
   *  not navigable. See `MethodCallEdge` in types.ts. */
  methodCalls: Array<{
    from: string;
    receiverName: string;
    methodName: string;
    receiverFilePath: string;
    lines: number[];
  }>;

  // === Precomputed lookup indexes ===
  // Each map below is built ONCE when this IndexedFile is constructed
  // (in `buildCodeIndex`). They turn what used to be linear
  // `flatSymbols.find / filter` and `importBindings.find` calls in
  // every handler.resolveCall invocation into O(1) lookups. With ~50
  // callsites × ~30 bindings per file × thousands of files, the linear
  // version was the dominant cost in the call-resolution pass.

  /** bare name → all flat symbols with that name. Used by bare-name
   *  call resolution (`foo()` → which local symbols match `foo`).
   *  Multiple matches are real — same-named function + class
   *  member is not unusual. */
  symbolsByName: Map<string, IndexedSymbol[]>;
  /** qualified name → flat symbol. Used by API projections
   *  (`fileFunctionsFromIndex`) to look up cross-file edge targets
   *  in O(1) instead of `targetFile.flatSymbols.find(...)` per edge. */
  symbolsByQname: Map<string, IndexedSymbol>;
  /** local name → import binding (regular imports only — no reexports).
   *  Used by handler.resolveCall for both receiver-based
   *  (`obj.method()` where `obj` is an import) and bare-name
   *  (`foo()` → import lookup) paths. Reexports go in the separate
   *  map below because they don't introduce a local name into this
   *  file's scope. */
  bindingsByLocalName: Map<string, ImportBinding>;
  /** local name → reexport binding (only `b.isReexport === true`).
   *  Used by barrel-chain followers (`findExportedSymbol` /
   *  `findReceiverMethod` in the TS handler) — each chain hop tests
   *  whether THIS file forwards a name to consumers. */
  reexportsByLocalName: Map<string, ImportBinding>;
}

export interface CodeIndex {
  cwd: string;
  files: Map<string, IndexedFile>;
  truncated: boolean;
  fileCountCap?: number;
  tsconfigs: TsconfigScope[];
  workspaces: Map<string, Workspace>;
  /** Per-grammar handler context (alias maps, workspace layout, etc.)
   *  stashed at build time so `refreshFocalFile` can re-resolve a
   *  single file's imports/calls without rebuilding contexts. The
   *  handler's `buildProjectContext` is the moderately expensive part
   *  of resolution (loads tsconfigs, workspaces, src-layout); reusing
   *  it keeps focal refresh in the ~10-50ms range instead of the
   *  hundreds of ms a full handler init would cost. Opaque payload —
   *  the orchestrator doesn't peek inside. */
  projectContexts: Map<string, unknown>;
  /** File set used during the LAST full build. `refreshFocalFile`
   *  passes this through to `handler.resolveSpecifier` so import
   *  resolution sees the same project shape the original build saw —
   *  newly-added sibling files won't appear until a full refresh,
   *  which is consistent with the "incomingCalls stays stale until
   *  forceRefresh" contract documented on `refreshFocalFile`. */
  fileSet: Set<string>;
  generatedAt: number;
  buildMs: number;
}

// ============================================================================
// Build
// ============================================================================

// MAX_FILES lives in buildGraph.ts (single source of truth) and is
// imported above. The hard cap there is enforced by listFilesViaGit /
// walkSource; the slice below is a belt-and-suspenders cap for any
// path that bypasses those.
const READ_CONCURRENCY = 50;

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Per-file parse result before any cross-file resolution. */
interface ParsedFile {
  path: string;
  language: string;
  /** `fs.stat().mtimeMs` captured at parse time. Stored on the
   *  IndexedFile so `refreshFocalFile` can compare against the on-
   *  disk mtime cheaply (one stat) before deciding to re-parse. */
  mtime: number;
  symbolsTree: ExtractedSymbol[];
  flatSymbols: IndexedSymbol[];
  /** All file-level bindings — regular imports AND re-exports. Re-
   *  exports are marked `isReexport: true`; barrel-chain followers
   *  filter on that flag instead of using a parallel collection. */
  importBindings: ImportBinding[];
  importSpecifiers: string[];
  rawCalls: Array<{ calleeName: string; line: number; receiverName?: string }>;
  /** Identifier-shaped string literals (post-filter). See
   *  `extractStringLiterals` for the regex / size contract. */
  literals: IndexedLiteral[];
}

function flattenSymbols(filePath: string, syms: ExtractedSymbol[]): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  function walk(arr: ExtractedSymbol[]) {
    for (const s of arr) {
      out.push({
        filePath,
        qualifiedName: s.qualifiedName,
        name: s.name,
        kind: s.kind,
        startLine: s.startLine,
        endLine: s.endLine,
        params: s.params,
      });
      walk(s.children);
    }
  }
  walk(syms);
  return out;
}

// ============================================================================
// String-literal harvest (for searchIndex { includeLiterals: true })
// ============================================================================

/** Matches a string literal whose body looks like an identifier / dotted
 *  key / kebab-or-snake-case name. Quote opens with `'`, `"`, or `` ` ``;
 *  body is 3–64 chars of `[A-Za-z0-9_.-]` starting with a letter; quote
 *  closes with the SAME character (no escapes / no interpolation tokens,
 *  since those wouldn't be identifier-shaped anyway).
 *
 *  Tuned to catch: tool names (`user_profile`), event names
 *  (`task.created`), config keys (`FEATURE_X_ENABLED`), route paths
 *  (`api.v1.users`), cron specs (`hello-world-cron`).
 *  Tuned to skip: SQL fragments (whitespace), JSX text (whitespace /
 *  punctuation), URLs (`/`), prose (whitespace / punctuation), tiny
 *  noise (1–2 chars), oversize prompts (> 64 chars). */
const IDENT_STRING_RE =
  /(['"`])([A-Za-z][A-Za-z0-9_.-]{2,63})\1/g;

/** Per-file cap. A 1 MB file already capped above; this guards the
 *  pathological case of a generated `enum` of thousands of names. */
const MAX_LITERALS_PER_FILE = 500;

/** Walk the raw source for identifier-shaped string literals. Returns
 *  hits with 1-based line numbers, attributed to the smallest enclosing
 *  flat symbol when possible. Deduplicated by `(value, line)` so two
 *  occurrences of `"foo"` on the same line collapse to one hit. */
function extractStringLiterals(
  source: string,
  flatSymbols: IndexedSymbol[],
): IndexedLiteral[] {
  const out: IndexedLiteral[] = [];
  const seen = new Set<string>();

  // Precompute line offsets once — `source.slice(0, idx).split("\n").length`
  // is O(n) per match and quickly becomes the dominant cost on big files.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
  }
  // Binary search: largest j with lineStarts[j] <= idx → line = j + 1.
  function lineOf(idx: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  IDENT_STRING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT_STRING_RE.exec(source)) !== null) {
    if (out.length >= MAX_LITERALS_PER_FILE) break;
    const value = m[2];
    const line = lineOf(m.index);
    const key = `${value}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const enclosing = findEnclosingFlat(flatSymbols, line);
    out.push({
      value,
      line,
      ...(enclosing ? { enclosingQname: enclosing.qualifiedName } : {}),
    });
  }
  return out;
}

async function parseOneFile(absPath: string, relPath: string): Promise<ParsedFile | null> {
  const grammar = grammarForExtension(relPath);
  if (!grammar) return null;
  let source: string;
  let mtime: number;
  try {
    // Read content + stat together — stat is cheap, and pairing them
    // captures the mtime that corresponds to THIS read of the file
    // (avoids a TOCTOU window where the file is rewritten between
    // readFile and a separate stat).
    [source, mtime] = await Promise.all([
      fs.readFile(absPath, 'utf8'),
      fs.stat(absPath).then((s) => s.mtimeMs),
    ]);
  } catch {
    return null;
  }
  if (source.length > 1_000_000) return null;
  const parser = await getServerParser(grammar);
  let tree;
  try {
    tree = parser.parse(source);
  } catch (err) {
    console.error('[codeIndex] parse failed for', relPath, err);
    return null;
  }
  if (!tree) return null;
  try {
    // Per-language extraction goes through the handler. The handler
    // emits a single combined `bindings` array (regular imports +
    // re-exports, the latter marked `isReexport: true`). codeIndex
    // stores that array directly on IndexedFile.importBindings; the
    // handler's resolveCall implementation reads back via
    // `b.isReexport` filtering when it needs to walk barrel chains.
    const handler = getHandler(grammar);
    const symbolsTree = handler.extractSymbols(tree.rootNode, source);
    // Every language funnels through here, so the qname-uniqueness invariant
    // gets enforced once for all of them — the Go / Rust handlers have their
    // own extraction paths and never see extractSymbolsFromTree.
    dedupeQualifiedNames(symbolsTree);
    const flatSymbols = flattenSymbols(relPath, symbolsTree);
    const { specs: importSpecifiers, bindings: importBindings } =
      handler.extractImports(tree.rootNode);
    const rawCalls = handler.extractCallSites(tree.rootNode, flatSymbols);
    // Literal harvest runs on the same source we just parsed — language-
    // agnostic regex, no extra IO. Skipped on minified bundles by the
    // 1 MB size cap above; sub-ms per typical source file.
    const literals = extractStringLiterals(source, flatSymbols);
    return {
      path: relPath,
      language: grammar,
      mtime,
      symbolsTree,
      flatSymbols,
      importBindings,
      importSpecifiers,
      rawCalls,
      literals,
    };
  } finally {
    tree.delete();
  }
}

/** Find the SMALLEST symbol whose range contains `line`. Innermost wins
 *  (a method inside a class wins over the class itself). Used to attach
 *  a call site to the function/method that contains it. */
function findEnclosingFlat(symbols: IndexedSymbol[], line: number): IndexedSymbol | null {
  let best: IndexedSymbol | null = null;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}

// `FUNCTION_LIKE_KINDS` and `isFunctionLike` moved to `../types.ts` so
// `'use client'` components (e.g. `FileTOCSection`) can share the
// single source of truth without webpack pulling this file's
// `node:fs/promises` import into the browser bundle.

export async function buildCodeIndex(cwd: string): Promise<CodeIndex> {
  const startedAt = Date.now();

  // 1. List source files (.gitignore-aware via `git ls-files`, fs walker fallback).
  emitBuildProgress(cwd, 'listing', 0, 0, undefined, true);
  let files: string[] | null = await listFilesViaGit(cwd);
  if (!files) {
    files = [];
    await walkSource(cwd, cwd, files);
  }

  const truncated = files.length > MAX_FILES;
  if (truncated) files = files.slice(0, MAX_FILES);
  const fileSet = new Set(files);

  // 2. tsconfigs (per-scope alias maps) + workspace packages (for monorepos).
  //    Kept here for `CodeIndex` shape compatibility (legacy consumers
  //    expect these on the index). The TS handler reads its own copies
  //    via `buildProjectContext` for its resolveSpecifier calls — we
  //    don't share the value because handler contexts are opaque to
  //    this orchestration layer.
  emitBuildProgress(cwd, 'contexts', 0, files.length, undefined, true);
  const tsconfigs = await loadTsconfigs(cwd);
  const workspaces = await loadWorkspaces(cwd, fileSet);

  // 3. Build per-grammar project contexts. Each handler reads
  //    whatever filesystem state it needs (tsconfigs / workspaces /
  //    src-layout detection / etc.) once per build. Stored opaquely
  //    so the resolution loop just looks up by grammar id.
  const projectContexts = new Map<string, unknown>();
  // Seed a context for every registered grammar — adding a new
  // language is "register a handler", and this loop picks it up
  // automatically. Cost is one filesystem-light read per language;
  // negligible relative to the per-file parse pass below.
  for (const grammar of SUPPORTED_GRAMMARS) {
    const handler = getHandler(grammar);
    projectContexts.set(grammar, await handler.buildProjectContext(cwd, fileSet));
  }

  // 4. Parse every file in parallel.
  //    This phase dominates wall-clock, and it's the only one with natural
  //    per-file granularity, so it's where the progress bar actually moves.
  //    The counter is incremented from `READ_CONCURRENCY` interleaved
  //    workers, but JS has no preemption inside a synchronous block, so
  //    `++` is atomic here — no lost updates.
  const totalToParse = files.length;
  let parsedCount = 0;
  emitBuildProgress(cwd, 'parsing', 0, totalToParse, undefined, true);
  const parsed = (
    await mapWithConcurrency(files, READ_CONCURRENCY, async (f) => {
      const result = await parseOneFile(path.join(cwd, f), f);
      parsedCount += 1;
      // Throttled inside emitBuildProgress — calling it once per file is
      // fine even at ~330 files/s.
      emitBuildProgress(cwd, 'parsing', parsedCount, totalToParse, f);
      return result;
    })
  ).filter((p): p is ParsedFile => p !== null);

  // 5. Resolve each import specifier → project file (or drop as external).
  //    Per-file: look up the language handler, get its project context,
  //    and delegate to handler.resolveSpecifier. The handler owns ALL
  //    language-specific resolution (TS aliases / workspaces, Python
  //    dotted-paths and relative dots) — codeIndex stays language-
  //    agnostic at this layer.
  emitBuildProgress(cwd, 'resolving', totalToParse, totalToParse, undefined, true);
  const indexedFiles = new Map<string, IndexedFile>();
  for (const f of parsed) {
    const handler = getHandler(f.language as Parameters<typeof getHandler>[0]);
    const ctx = projectContexts.get(f.language);

    const resolvedImports = new Map<string, string>();
    const importedFiles = new Set<string>();
    for (const spec of f.importSpecifiers) {
      if (resolvedImports.has(spec)) continue;
      const resolved = handler.resolveSpecifier(spec, f.path, ctx, fileSet);
      if (resolved && resolved !== f.path) {
        resolvedImports.set(spec, resolved);
        importedFiles.add(resolved);
      }
    }

    // Precomputed lookup maps — built once here so handler.resolveCall
    // and the API projections don't re-scan flatSymbols /
    // importBindings linearly per callsite. See IndexedFile jsdoc.
    const symbolsByName = new Map<string, IndexedSymbol[]>();
    const symbolsByQname = new Map<string, IndexedSymbol>();
    for (const s of f.flatSymbols) {
      symbolsByQname.set(s.qualifiedName, s);
      const list = symbolsByName.get(s.name);
      if (list) list.push(s);
      else symbolsByName.set(s.name, [s]);
    }
    const bindingsByLocalName = new Map<string, ImportBinding>();
    const reexportsByLocalName = new Map<string, ImportBinding>();
    for (const b of f.importBindings) {
      if (b.isReexport) reexportsByLocalName.set(b.localName, b);
      else bindingsByLocalName.set(b.localName, b);
    }

    indexedFiles.set(f.path, {
      path: f.path,
      language: f.language,
      mtime: f.mtime,
      symbolsTree: f.symbolsTree,
      flatSymbols: f.flatSymbols,
      literals: f.literals,
      importedFiles,
      importedBy: new Set(),
      importBindings: f.importBindings,
      resolvedImports,
      intraCalls: [],
      outgoingCalls: [],
      incomingCalls: [],
      externalCalls: [],
      methodCalls: [],
      symbolsByName,
      symbolsByQname,
      bindingsByLocalName,
      reexportsByLocalName,
    });
  }

  // 5. Invert file-level imports → importedBy.
  for (const f of indexedFiles.values()) {
    for (const target of f.importedFiles) {
      const t = indexedFiles.get(target);
      if (t) t.importedBy.add(f.path);
    }
  }

  emitBuildProgress(cwd, 'edges', totalToParse, totalToParse, undefined, true);

  // 6. Resolve calls per file via the per-language handler.
  //
  // The handler returns a list of `CallResolution` entries per call
  // site. Multiple entries support the JS/TS bare-name case where
  // `foo()` matches multiple local symbols (function + same-named
  // class method) — without type info we emit edges to all
  // candidates. codeIndex translates each resolution to a legacy
  // edge type:
  //
  //    'symbol' + addr.filePath === fromFile.path → intra
  //    'symbol' + addr.filePath !== fromFile.path → outgoing (cross)
  //    'external'                                  → externalCalls
  //    'method-unresolved'                         → methodCalls
  //
  // Dedup-by-key + line-list accumulation stays here at the
  // orchestration layer (handler doesn't see the file's edge state).
  for (const f of parsed) {
    const file = indexedFiles.get(f.path)!;
    const handler = getHandler(f.language as Parameters<typeof getHandler>[0]);
    const ctx = projectContexts.get(f.language);

    const intraByKey = new Map<
      string,
      { from: string; to: string; lines: number[] }
    >();
    const outByKey = new Map<
      string,
      { from: string; to: SymbolAddr; lines: number[] }
    >();
    const extByKey = new Map<
      string,
      { from: string; packageSpec: string; importedName: string; lines: number[] }
    >();
    const methodByKey = new Map<
      string,
      {
        from: string;
        receiverName: string;
        methodName: string;
        receiverFilePath: string;
        lines: number[];
      }
    >();

    for (const call of f.rawCalls) {
      const from = findEnclosingFlat(file.flatSymbols, call.line);
      // Caller can be ANY top-level symbol kind — `export const x =
      // createX()` is a real edge from `x` to `createX`. Skip when
      // the enclosing symbol can't be found at all (calls in
      // module-level statements outside any tracked symbol).
      if (!from) continue;

      const resolutions = handler.resolveCall(call, from, file, indexedFiles, ctx);
      for (const r of resolutions) {
        if (r.kind === 'symbol') {
          if (r.addr.filePath === file.path) {
            // Intra — local match within this file.
            const key = `${from.qualifiedName}${r.addr.qualifiedName}`;
            const existing = intraByKey.get(key);
            if (existing) {
              existing.lines.push(call.line);
            } else {
              const edge = {
                from: from.qualifiedName,
                to: r.addr.qualifiedName,
                lines: [call.line],
              };
              intraByKey.set(key, edge);
              file.intraCalls.push(edge);
            }
          } else {
            // Cross-file outgoing.
            const key = `${from.qualifiedName}${r.addr.filePath}${r.addr.qualifiedName}`;
            const existing = outByKey.get(key);
            if (existing) {
              existing.lines.push(call.line);
            } else {
              const edge = {
                from: from.qualifiedName,
                to: {
                  filePath: r.addr.filePath,
                  qualifiedName: r.addr.qualifiedName,
                },
                lines: [call.line],
              };
              outByKey.set(key, edge);
              file.outgoingCalls.push(edge);
            }
          }
        } else if (r.kind === 'external') {
          const key = `${from.qualifiedName}${r.packageSpec}${r.name}`;
          const existing = extByKey.get(key);
          if (existing) {
            existing.lines.push(call.line);
          } else {
            const edge = {
              from: from.qualifiedName,
              packageSpec: r.packageSpec,
              importedName: r.name,
              lines: [call.line],
            };
            extByKey.set(key, edge);
            file.externalCalls.push(edge);
          }
        } else if (r.kind === 'method-unresolved') {
          // Recover receiverFilePath from the file's import bindings —
          // the handler doesn't surface it, but it's cheap to look up
          // here (at most one local binding per receiver name per
          // file). Skip re-exports — they don't introduce a local
          // name, so they couldn't have been the receiver.
          const recvBinding = file.bindingsByLocalName.get(r.receiverName);
          const recvFilePath = recvBinding
            ? file.resolvedImports.get(recvBinding.specifier) ?? ''
            : '';
          const key = `${from.qualifiedName}${r.receiverName}${r.methodName}`;
          const existing = methodByKey.get(key);
          if (existing) {
            existing.lines.push(call.line);
          } else {
            const edge = {
              from: from.qualifiedName,
              receiverName: r.receiverName,
              methodName: r.methodName,
              receiverFilePath: recvFilePath,
              lines: [call.line],
            };
            methodByKey.set(key, edge);
            file.methodCalls.push(edge);
          }
        }
      }
    }
    // Sort each edge's lines ascending so clients pick lines[0] = first
    // call site in source order.
    for (const e of file.intraCalls) e.lines.sort((a, b) => a - b);
    for (const e of file.outgoingCalls) e.lines.sort((a, b) => a - b);
    for (const e of file.externalCalls) e.lines.sort((a, b) => a - b);
    for (const e of file.methodCalls) e.lines.sort((a, b) => a - b);
  }

  // 7. Invert outgoing → incoming. Lines flow through unchanged:
  // they refer to the CALLER's file ("where in the caller does this
  // call happen") in both directions, which is `file` here.
  //
  // Outgoing.lines is treated as read-only after this pass (the
  // earlier dedup loop already sorted them in place), so the
  // incoming view shares the SAME array reference. Saves N copies
  // worth of allocations + heap churn — for a kiowi-sized project
  // this is hundreds of MB of redundant arrays avoided.
  for (const file of indexedFiles.values()) {
    for (const out of file.outgoingCalls) {
      const target = indexedFiles.get(out.to.filePath);
      if (!target) continue;
      target.incomingCalls.push({
        from: { filePath: file.path, qualifiedName: out.from },
        to: out.to.qualifiedName,
        lines: out.lines,
      });
    }
  }

  // Terminal frame: tells the UI to drop the progress view. The failure
  // path is covered in `getCodeIndex` — a build that throws must not leave
  // a progress bar frozen at 60% forever.
  emitBuildProgress(cwd, 'done', totalToParse, totalToParse, undefined, true);

  return {
    cwd,
    files: indexedFiles,
    truncated,
    fileCountCap: truncated ? MAX_FILES : undefined,
    tsconfigs,
    workspaces,
    projectContexts,
    fileSet,
    generatedAt: Date.now(),
    buildMs: Date.now() - startedAt,
  };
}

// ============================================================================
// Cache (in-memory, per cwd)
// ============================================================================

const indexCache = new Map<string, CodeIndex>();
const inflight = new Map<string, Promise<CodeIndex>>();

// ────────────────────────────────────────────────────────────────────────────
// Watcher integration — lazy incremental sync on access.
//
// Design: the watcher pushes "this cwd has a changed file" events to us via
// `markIndexDirty`. We DON'T re-parse eagerly — we just remember the cwd is
// dirty, and the next `getCodeIndex` call drains the dirty flag by stat'ing
// every indexed file and re-parsing those whose mtime moved. That's what
// `refreshFocalFile` already does, but applied across the whole index in one
// pass instead of one focal file at a time.
//
// Subscription registration is inverted-of-control because codeIndex lives in
// @cockpit/feature-explorer (a package) and fileWatcher lives in /src/lib
// (the app). Boot code in /src/lib/codeIndexSync.ts calls
// `registerWatcherSubscriber` once at startup, wiring `fileWatcher.subscribe`
// → `markIndexDirty`. If nothing registers (tests, headless tooling), we
// silently skip subscribing and queries still work — they just won't auto-
// refresh on disk changes.
// ────────────────────────────────────────────────────────────────────────────

/** Cwds that need a sync pass before their next `getCodeIndex` return. */
const dirtyCwds = new Set<string>();
/** Cwds we've already wired up a watcher subscription for, so we don't
 *  double-subscribe across many getCodeIndex calls. */
const subscribedCwds = new Set<string>();

/** Subscriber factory: given a cwd and an `onDirty` callback, install a
 *  file-change subscription. Set once at boot by `src/lib/codeIndexSync.ts`. */
export type WatcherSubscriber = (cwd: string, onDirty: () => void) => void;
let watcherSubscriber: WatcherSubscriber | null = null;

/** Called once at server boot from `src/lib/codeIndexSync.ts`. Subsequent
 *  calls overwrite — last registration wins. */
export function registerWatcherSubscriber(fn: WatcherSubscriber | null): void {
  watcherSubscriber = fn;
  // Re-subscribe any cwds we'd already subscribed to under a previous
  // registration. Rare in practice (single boot wiring), but matters for HMR
  // where the module reloads and the old subscription is gone.
  if (fn) {
    for (const cwd of subscribedCwds) {
      fn(cwd, () => dirtyCwds.add(cwd));
    }
  }
}

/** Used by tests / boot code that wants to mark a cwd dirty by hand
 *  (e.g. on agent turn-end, post-bulk-edit). Idempotent. */
export function markIndexDirty(cwd: string): void {
  dirtyCwds.add(cwd);
}

/** Ensure we have a watcher subscription for this cwd. No-op when no
 *  subscriber is registered (headless / test contexts). */
function ensureSubscribed(cwd: string): void {
  if (subscribedCwds.has(cwd)) return;
  subscribedCwds.add(cwd);
  if (watcherSubscriber) {
    watcherSubscriber(cwd, () => dirtyCwds.add(cwd));
  }
}

/** Drain the dirty flag: stat every indexed file, re-parse the ones whose
 *  on-disk mtime no longer matches the cached one. Uses the existing
 *  `refreshFocalFile` for per-file work — that function already does the
 *  stat + early-return-on-match dance, so iterating it here is correct.
 *
 *  Cost: O(filesInIndex) stat calls. For a typical project (~hundreds of
 *  files), that's well under 50 ms. Re-parses are O(changed files) on top.
 *  This runs in the foreground of `getCodeIndex`, so the first query after a
 *  big edit pays the cost; subsequent queries are cache hits until the next
 *  watcher event.
 *
 *  Note on cross-file edge staleness: refreshFocalFile only updates each file's
 *  own outgoing/intra edges. Other files' `incomingCalls` that point AT
 *  refreshed files stay as the last full build computed them. This matches
 *  what cockpit's UI already accepts (see refreshFocalFile docstring) and
 *  what CodeGraph does too. Users who need 100% accuracy hit the "Rebuild
 *  project graph" button which fires `forceRefresh: true`. */
async function syncDirtyIndex(cwd: string, index: CodeIndex): Promise<void> {
  // Snapshot keys — refreshFocalFile mutates index.files in place, but the
  // file set itself shouldn't change here (added/deleted files aren't picked
  // up by this lightweight path; that needs a full rebuild).
  const paths = Array.from(index.files.keys());
  // Bound concurrency the same way buildCodeIndex does, so a 1000-file
  // project doesn't burst stat-and-read calls.
  let cursor = 0;
  const worker = async () => {
    while (cursor < paths.length) {
      const i = cursor++;
      try {
        await refreshFocalFile(cwd, paths[i], index);
      } catch {
        // Ignore per-file errors; the next access will retry. Don't let a
        // single unreadable file abort the whole sync.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, worker));
}

export interface GetIndexOptions {
  /** Force a fresh build, dropping any cached index for this cwd. */
  forceRefresh?: boolean;
}

export async function getCodeIndex(cwd: string, opts: GetIndexOptions = {}): Promise<CodeIndex> {
  // Register a watcher subscription on first access. Cheap (Set lookup +
  // optional callback) once-per-cwd-for-process-lifetime.
  ensureSubscribed(cwd);

  if (opts.forceRefresh) {
    indexCache.delete(cwd);
    dirtyCwds.delete(cwd); // forceRefresh subsumes any pending lazy sync
  }
  const cached = indexCache.get(cwd);
  if (cached) {
    // Lazy flush: drain dirty before returning. Sync runs in the foreground so
    // the caller sees fresh data. We delete the flag BEFORE the sync to make
    // overlapping reads see consistent state (no thundering herd of syncs).
    if (dirtyCwds.has(cwd)) {
      dirtyCwds.delete(cwd);
      try {
        await syncDirtyIndex(cwd, cached);
      } catch {
        // Even if sync fails wholesale, return the cached (possibly stale)
        // index — the next watcher event will re-mark dirty and retry.
      }
    }
    return cached;
  }
  const pending = inflight.get(cwd);
  if (pending) return pending;
  const p = buildCodeIndex(cwd).then((index) => {
    indexCache.set(cwd, index);
    inflight.delete(cwd);
    // Fresh build subsumes any dirty flag that arrived during the build.
    dirtyCwds.delete(cwd);
    // Kick off analytics precompute in the background. Lazy-require to
    // avoid a cycle: analytics/cache imports codeIndex types, but at
    // module-load time only — this dynamic import is evaluated after
    // both modules are fully initialised. Fire-and-forget; analytics
    // routes degrade gracefully if it hasn't completed yet.
    import('../analytics/cache')
      .then((m) => m.precomputeAnalytics(cwd, index))
      .catch((err) => {
        console.error('[codeIndex] analytics precompute failed:', err);
      });
    return index;
  }).catch((err) => {
    // Failure cleanup. Two things must happen that the success path does:
    //   1. Clear the terminal progress frame, or the Code Map sits on a
    //      frozen bar until the tab is closed.
    //   2. Drop the rejected promise from `inflight`. Without this it stays
    //      cached and EVERY later getCodeIndex(cwd) returns the same
    //      rejection — the cwd is poisoned until something calls
    //      invalidateIndex (which only two of the ten routes do).
    emitBuildProgress(cwd, 'done', 0, 0, undefined, true);
    inflight.delete(cwd);
    throw err;
  });
  inflight.set(cwd, p);
  return p;
}

export function invalidateIndex(cwd?: string): void {
  // Drop analytics cache in lockstep so a stale graph never outlives its
  // CodeIndex. Same lazy-require pattern to avoid the import cycle.
  import('../analytics/cache')
    .then((m) => m.invalidateAnalytics(cwd))
    .catch(() => {
      /* analytics module not loaded yet — nothing to invalidate */
    });
  if (!cwd) {
    indexCache.clear();
    inflight.clear();
    dirtyCwds.clear();
    return;
  }
  indexCache.delete(cwd);
  inflight.delete(cwd);
  dirtyCwds.delete(cwd);
}

// ============================================================================
// Single-file refresh — keeps focal projections fresh without paying the
// 5-10 s full-rebuild cost on every save.
// ============================================================================

/**
 * Re-parse + re-resolve ONE file in place when its on-disk mtime
 * differs from what the index has cached. Mutates `index.files`
 * directly; returns `true` if a refresh actually happened.
 *
 * What gets refreshed (for the focal file ONLY):
 *   - mtime, symbolsTree, flatSymbols
 *   - importBindings, resolvedImports, importedFiles
 *   - intraCalls, outgoingCalls, externalCalls, methodCalls
 *   - symbolsByName / symbolsByQname / bindingsByLocalName /
 *     reexportsByLocalName lookup tables
 *
 * What stays as the last full build computed it (accepted stale):
 *   - This file's `incomingCalls` (= other files' outgoing edges
 *     pointing at us; refreshing them needs re-parsing every other
 *     file)
 *   - This file's `importedBy` (= reverse of other files'
 *     `importedFiles`; same constraint)
 *   - Other files' `importedBy` / `outgoingCalls` / `incomingCalls`
 *     (we don't touch other files at all)
 *
 * Practical effect: the chip canvas + TOC + intra-file pins +
 * RIGHT-side pins (callees in other files, anchored at THIS file's
 * call site lines) are all fresh. The LEFT-side pins (callers from
 * other files) may show stale qnames when the caller's code
 * changed since the last full build — fixed by clicking
 * "Rebuild project graph" in the BlockViewer header.
 *
 * Returns `false` (no-op) when:
 *   - The file isn't in the index (unsupported language, beyond
 *     file cap, deleted file). Caller falls through to whatever
 *     it was going to do (typically the synthetic fallback path
 *     in route.ts).
 *   - The on-disk mtime matches the cached one (cache is fresh).
 *   - The file's grammar isn't recognised (parseOneFile returns
 *     null).
 *
 * Returns `true` after successfully replacing the focal entry.
 */
// ============================================================================
// Single-file upsert helpers
//
// Two callers feed buildIndexedFileEntry below:
//   - refreshFocalFile  → reparses an existing entry whose on-disk mtime
//                         moved
//   - addFocalFile      → adds a brand-new entry for a path that wasn't
//                         seen at the last `buildCodeIndex`. Covers the
//                         AI-paired workflow where new files appear after
//                         the initial index was built (Write tool / pull /
//                         checkout) and the lazy refresh path was
//                         silently dropping them.
//
// The watcher → syncDirtyIndex path still ignores additions (it iterates
// existing keys). That's by design — async-rebuild (separate work) covers
// high-churn scenarios. addFocalFile covers the low-churn "user just
// opened a brand-new file" case at query time.
// ============================================================================

const execAsync = promisify(exec);

/** Conservative shell-quoter for a path used as a git pathspec.
 *  We avoid shell-meta expansion by single-quoting and escaping any
 *  single quotes inside. Mirror of the helper in `coedit.ts`. */
function shellQuotePath(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * True when `relPath` belongs in this project's source fileset — same
 * truth source as `buildCodeIndex` uses at the initial build:
 *
 *   - Git project: `git ls-files --cached --others --exclude-standard`
 *     membership. `--error-unmatch` makes the command exit non-zero when
 *     the path isn't matched (so node_modules / dist / coverage / any
 *     .gitignored noise gets rejected).
 *   - Non-git project: mirror `walkSource`'s `NON_GIT_FALLBACK_SKIP`
 *     hardcoded list (.git, node_modules).
 *
 * The check is cheap (~10ms exec). We pay it only on cache miss inside
 * `addFocalFile` — not on the hot refresh path.
 */
async function isPathInProjectFileset(
  cwd: string,
  relPath: string,
): Promise<boolean> {
  // Quick non-git heuristic so dev/test environments without git still work.
  let isGit = true;
  try {
    await execAsync('git rev-parse --git-dir', { cwd });
  } catch {
    isGit = false;
  }
  if (!isGit) {
    // Mirror walkSource's NON_GIT_FALLBACK_SKIP set + a defensive cwd-relative check.
    if (relPath.startsWith('.git')) return false;
    if (relPath.startsWith('node_modules/') || relPath.includes('/node_modules/')) return false;
    return true;
  }
  try {
    await execAsync(
      `git -c core.quotePath=false ls-files --cached --others --exclude-standard --error-unmatch -- ${shellQuotePath(relPath)}`,
      { cwd },
    );
    return true;
  } catch {
    return false;
  }
}

/** Lazy-invalidate the analytics cache for a cwd. Fire-and-forget — the
 *  dynamic import avoids the circular module dependency between
 *  `codeIndex` and `analytics/cache` (analytics imports CodeIndex types
 *  at module load time; we need the inverse direction at runtime only).
 *  Errors are swallowed: if analytics hasn't been loaded yet, there's
 *  nothing to invalidate. */
function invalidateAnalyticsAsync(cwd: string): void {
  import('../analytics/cache')
    .then((m) => m.invalidateAnalytics(cwd))
    .catch(() => {
      /* analytics module not loaded — nothing to invalidate */
    });
}

/**
 * Add a brand-new file to `index.files`. Called from `refreshFocalFile`
 * when the focal path isn't already in the index.
 *
 * Guards (in order, cheap-first):
 *   0. `isPathInProjectFileset` — same truth source as buildCodeIndex.
 *      Rejects gitignored noise (node_modules / dist / coverage / etc).
 *   1. `grammarForExtension` — file's extension must map to a registered
 *      tree-sitter grammar. Rejects .css / .json / .md / .yaml / etc.
 *   2. `MAX_FILES` soft cap — protects against unbounded growth in
 *      long-lived sessions.
 *   3. `parseOneFile` returning non-null — covers file-too-large /
 *      tree-sitter parse failure.
 *
 * On success:
 *   - Adds `parsed.path` to `index.fileSet` so subsequent refresh of
 *     ALREADY-INDEXED files can correctly resolve imports pointing here.
 *   - Builds and inserts the IndexedFile via the shared
 *     `buildIndexedFileEntry`.
 *   - Lazy-invalidates the analytics cache so risk / related / context
 *     don't return stale rankings that pretend this file doesn't exist.
 *
 * Trade-off (documented, accepted):
 *   - Other files' `incomingCalls` / `importedBy` still don't point at us
 *     — they were computed by the last full build, and we don't re-walk
 *     them here. Their next `refreshFocalFile` will pick us up via
 *     `index.fileSet` membership.
 *   - To force consistency now, the user clicks "Rebuild project graph".
 */
async function addFocalFile(
  cwd: string,
  relPath: string,
  index: CodeIndex,
): Promise<boolean> {
  if (!grammarForExtension(relPath)) return false;
  if (index.files.size >= MAX_FILES) return false;
  if (!(await isPathInProjectFileset(cwd, relPath))) return false;
  const parsed = await parseOneFile(path.join(cwd, relPath), relPath);
  if (!parsed) return false;
  // Expose the new path to subsequent resolveSpecifier calls.
  index.fileSet.add(parsed.path);
  await buildIndexedFileEntry(parsed, null, index);
  invalidateAnalyticsAsync(cwd);
  return true;
}

/**
 * Build a fresh `IndexedFile` entry from a parsed file and (optionally) an
 * old entry. Shared between `refreshFocalFile` (oldEntry !== null) and
 * `addFocalFile` (oldEntry === null).
 *
 * Mutates `index.files` BEFORE call resolution — see the inline comment below
 * for why. Caller is responsible for `invalidateAnalyticsAsync(cwd)` after.
 *
 * Stale-tolerance contract:
 *   - `importedBy` and `incomingCalls`: when refreshing an existing entry we
 *     keep the old values (we're not re-parsing other files). On add we
 *     start empty — no other file currently knows about us, and they'll
 *     update on their next refresh. Both are made fresh by a full rebuild
 *     via `forceRefresh: true`.
 */
async function buildIndexedFileEntry(
  parsed: ParsedFile,
  oldEntry: IndexedFile | null,
  index: CodeIndex,
): Promise<IndexedFile> {
  const handler = getHandler(parsed.language as Parameters<typeof getHandler>[0]);
  const ctx = index.projectContexts.get(parsed.language);

  // Re-resolve THIS file's imports against the same fileSet the
  // last full build saw. Newly-added sibling files won't be visible
  // until forceRefresh, matching the "incomingCalls stays stale"
  // contract above (both depend on cross-file freshness; we choose
  // to reset both via the same trigger).
  const resolvedImports = new Map<string, string>();
  const importedFiles = new Set<string>();
  for (const spec of parsed.importSpecifiers) {
    if (resolvedImports.has(spec)) continue;
    const resolved = handler.resolveSpecifier(spec, parsed.path, ctx, index.fileSet);
    if (resolved && resolved !== parsed.path) {
      resolvedImports.set(spec, resolved);
      importedFiles.add(resolved);
    }
  }

  const symbolsByName = new Map<string, IndexedSymbol[]>();
  const symbolsByQname = new Map<string, IndexedSymbol>();
  for (const s of parsed.flatSymbols) {
    symbolsByQname.set(s.qualifiedName, s);
    const list = symbolsByName.get(s.name);
    if (list) list.push(s);
    else symbolsByName.set(s.name, [s]);
  }
  const bindingsByLocalName = new Map<string, ImportBinding>();
  const reexportsByLocalName = new Map<string, ImportBinding>();
  for (const b of parsed.importBindings) {
    if (b.isReexport) reexportsByLocalName.set(b.localName, b);
    else bindingsByLocalName.set(b.localName, b);
  }

  const newEntry: IndexedFile = {
    path: parsed.path,
    language: parsed.language,
    mtime: parsed.mtime,
    symbolsTree: parsed.symbolsTree,
    flatSymbols: parsed.flatSymbols,
    literals: parsed.literals,
    importedFiles,
    // Inverse of other files' `importedFiles`; we're not re-parsing
    // other files, so the previous build's view is still our best
    // shot. Stale tolerance documented above. On add (oldEntry===null),
    // no other file currently points at us — start empty.
    importedBy: oldEntry?.importedBy ?? new Set<string>(),
    importBindings: parsed.importBindings,
    resolvedImports,
    intraCalls: [],
    outgoingCalls: [],
    // Inverse of other files' `outgoingCalls`. Same trade-off as
    // `importedBy` — we're choosing the cheap path. The chip view
    // surfaces this as left-column caller pins; clicking
    // "Rebuild project graph" forces a full rebuild that fixes them.
    incomingCalls: oldEntry?.incomingCalls ?? [],
    externalCalls: [],
    methodCalls: [],
    symbolsByName,
    symbolsByQname,
    bindingsByLocalName,
    reexportsByLocalName,
  };

  // Resolve THIS file's calls against the rest of the (possibly
  // stale) index. Cross-file targets that no longer exist or were
  // renamed will silently drop here (handler.resolveCall returns
  // [] for unresolvable receivers); the chip view doesn't need
  // them to render correctly because the row anchored at our line
  // numbers is the side we own.
  const intraByKey = new Map<
    string,
    { from: string; to: string; lines: number[] }
  >();
  const outByKey = new Map<
    string,
    { from: string; to: SymbolAddr; lines: number[] }
  >();
  const extByKey = new Map<
    string,
    { from: string; packageSpec: string; importedName: string; lines: number[] }
  >();
  const methodByKey = new Map<
    string,
    {
      from: string;
      receiverName: string;
      methodName: string;
      receiverFilePath: string;
      lines: number[];
    }
  >();

  // Mutate the index BEFORE call resolution: handler.resolveCall
  // may walk barrel chains via `bindingsByLocalName` / `flatSymbols`
  // on `indexedFiles.get(thisFile)`. If the lookup hits the OLD
  // entry, resolution sees stale symbol shapes and may return
  // garbage targets. Replacing first ensures self-references read
  // the fresh data.
  index.files.set(parsed.path, newEntry);

  for (const call of parsed.rawCalls) {
    const from = findEnclosingFlat(newEntry.flatSymbols, call.line);
    if (!from) continue;

    const resolutions = handler.resolveCall(call, from, newEntry, index.files, ctx);
    for (const r of resolutions) {
      if (r.kind === 'symbol') {
        if (r.addr.filePath === newEntry.path) {
          const key = `${from.qualifiedName}${r.addr.qualifiedName}`;
          const existing = intraByKey.get(key);
          if (existing) {
            existing.lines.push(call.line);
          } else {
            const edge = {
              from: from.qualifiedName,
              to: r.addr.qualifiedName,
              lines: [call.line],
            };
            intraByKey.set(key, edge);
            newEntry.intraCalls.push(edge);
          }
        } else {
          const key = `${from.qualifiedName}${r.addr.filePath}${r.addr.qualifiedName}`;
          const existing = outByKey.get(key);
          if (existing) {
            existing.lines.push(call.line);
          } else {
            const edge = {
              from: from.qualifiedName,
              to: {
                filePath: r.addr.filePath,
                qualifiedName: r.addr.qualifiedName,
              },
              lines: [call.line],
            };
            outByKey.set(key, edge);
            newEntry.outgoingCalls.push(edge);
          }
        }
      } else if (r.kind === 'external') {
        const key = `${from.qualifiedName}${r.packageSpec}${r.name}`;
        const existing = extByKey.get(key);
        if (existing) {
          existing.lines.push(call.line);
        } else {
          const edge = {
            from: from.qualifiedName,
            packageSpec: r.packageSpec,
            importedName: r.name,
            lines: [call.line],
          };
          extByKey.set(key, edge);
          newEntry.externalCalls.push(edge);
        }
      } else if (r.kind === 'method-unresolved') {
        const recvBinding = newEntry.bindingsByLocalName.get(r.receiverName);
        const recvFilePath = recvBinding
          ? newEntry.resolvedImports.get(recvBinding.specifier) ?? ''
          : '';
        const key = `${from.qualifiedName}${r.receiverName}${r.methodName}`;
        const existing = methodByKey.get(key);
        if (existing) {
          existing.lines.push(call.line);
        } else {
          const edge = {
            from: from.qualifiedName,
            receiverName: r.receiverName,
            methodName: r.methodName,
            receiverFilePath: recvFilePath,
            lines: [call.line],
          };
          methodByKey.set(key, edge);
          newEntry.methodCalls.push(edge);
        }
      }
    }
  }
  for (const e of newEntry.intraCalls) e.lines.sort((a, b) => a - b);
  for (const e of newEntry.outgoingCalls) e.lines.sort((a, b) => a - b);
  for (const e of newEntry.externalCalls) e.lines.sort((a, b) => a - b);
  for (const e of newEntry.methodCalls) e.lines.sort((a, b) => a - b);

  return newEntry;
}

export async function refreshFocalFile(
  cwd: string,
  relPath: string,
  index: CodeIndex,
): Promise<boolean> {
  const oldEntry = index.files.get(relPath);
  if (!oldEntry) {
    // Upsert: the file isn't in the index yet (created after build, pulled
    // by a checkout/merge, etc). Delegate to addFocalFile, which has its
    // own guards (project-fileset membership, grammar, MAX_FILES).
    return addFocalFile(cwd, relPath, index);
  }

  // Stat first — cheap (~ µs) and avoids the readFile + parse cost
  // when the cache is already fresh. The mtime check here is the
  // hot path; almost every chip-view request that lands here in a
  // normal session will see a match and short-circuit.
  let onDiskMtime: number;
  try {
    const st = await fs.stat(path.join(cwd, relPath));
    onDiskMtime = st.mtimeMs;
  } catch {
    // File deleted / inaccessible — leave the cached entry alone;
    // the route handler will surface the 404 itself when it tries
    // to resolveSafePath / readFile downstream.
    return false;
  }
  if (onDiskMtime === oldEntry.mtime) return false;

  const parsed = await parseOneFile(path.join(cwd, relPath), relPath);
  if (!parsed) return false;

  await buildIndexedFileEntry(parsed, oldEntry, index);
  // B.y symmetry: analytics (PageRank / PPR / Louvain) computed off the
  // pre-refresh graph is now stale. Lazy-invalidate so the next
  // risk / related / context query triggers a rebuild — same lifecycle
  // we already use after `addFocalFile` and a full `buildCodeIndex`.
  invalidateAnalyticsAsync(cwd);
  return true;
}

// ============================================================================
// Projections
// ============================================================================

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function toFunctionNode(s: IndexedSymbol): FunctionNode {
  return {
    filePath: s.filePath,
    qualifiedName: s.qualifiedName,
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
    params: s.params,
  };
}

/** Roll a (possibly nested) qualifiedName up to its top-level container.
 *
 *  `qualifiedName` follows `parent>child>grandchild` shape, so the
 *  top-level is everything before the first `>`. Used to translate
 *  call-graph edges that target/originate from class methods (e.g.
 *  `ClassFoo>render`) onto the top-level block we actually render
 *  on the canvas (the class itself). */
function topLevelQname(qname: string): string {
  const i = qname.indexOf('>');
  return i >= 0 ? qname.slice(0, i) : qname;
}

/**
 * Drop consecutive duplicates from an ASCENDING-sorted array. Used to
 * collapse identical line numbers that arise when rolled-up siblings
 * happen to call the same callee on the same source line (rare but
 * possible — e.g. an expression-position call inside a chained
 * statement counted twice by the AST walker).
 */
function dedupAsc(sorted: number[]): number[] {
  if (sorted.length < 2) return sorted;
  const out: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1]) out.push(sorted[i]);
  }
  return out;
}

/** File-mode projection: every TOP-LEVEL symbol in the focal file
 *  (functions, classes, methods-without-class — wait, ALL top-level
 *  kinds: functions, classes, interfaces, types, enums, exported
 *  consts, etc.), plus three layers of edges for architecture review:
 *
 *    - `intraCalls`     — call relationships within the focal file.
 *    - `upstreamCalls`  — functions in OTHER files that call into the
 *                         focal file (left column on canvas).
 *    - `downstreamCalls`— functions in OTHER files that the focal
 *                         file's functions call (right column).
 *
 *  We render top-level only because a class's source range already
 *  contains its methods — emitting both would duplicate code on the
 *  canvas. Call edges that originate from / target a method are rolled
 *  up to the containing top-level (class) before being emitted, so the
 *  block on the canvas remains the right edge endpoint.
 *
 *  Each cross-file edge carries both endpoints (external function +
 *  the focal-file top-level qname it connects to) so the client can
 *  route edges precisely without a second look-up. */
export function fileFunctionsFromIndex(
  index: CodeIndex,
  filePath: string,
): FileFunctionsResponse | null {
  const file = index.files.get(filePath);
  if (!file) return null;

  // Top-level symbols: their qualifiedName has no `>` separator.
  // `flatSymbols` includes nested children too (class methods, etc.);
  // keeping only top-level avoids redundant blocks since the parent's
  // source range already contains them.
  const functions = file.flatSymbols
    .filter((s) => !s.qualifiedName.includes('>'))
    .map(toFunctionNode)
    .sort((a, b) => a.startLine - b.startLine);
  const fnQnames = new Set(functions.map((f) => f.qualifiedName));

  // Intra-file call edges: roll caller / callee qnames up to top-level
  // (so a method-to-method call inside the same class lands on the
  // class block on both ends and gets dropped as a self-loop, while a
  // method-to-helper call lands on the class → helper block).
  // Lines per (from, to) pair are merged across rolled-up siblings so
  // a class with three methods all calling the same helper still shows
  // every call site on the resulting class → helper edge.
  const intraByKey = new Map<string, IntraCallEdge>();
  const intraCalls: IntraCallEdge[] = [];
  for (const c of file.intraCalls) {
    const from = topLevelQname(c.from);
    const to = topLevelQname(c.to);
    if (from === to) continue;
    if (!fnQnames.has(from) || !fnQnames.has(to)) continue;
    const key = `${from}|${to}`;
    const existing = intraByKey.get(key);
    if (existing) {
      for (const line of c.lines) existing.lines.push(line);
    } else {
      const edge: IntraCallEdge = { from, to, lines: c.lines.slice() };
      intraByKey.set(key, edge);
      intraCalls.push(edge);
    }
  }
  // Re-sort merged lines and drop duplicates that may arise when two
  // rolled-up siblings hit the same line (rare, but possible with
  // expression-position calls).
  for (const e of intraCalls) {
    e.lines.sort((a, b) => a - b);
    e.lines = dedupAsc(e.lines);
  }

  // Walk every focal-file function's outgoing/incoming calls, partition
  // by source file. We dedupe by (externalFile, externalQname,
  // focalTopLevelQname) so multiple methods of the same class hitting
  // the same external all collapse onto one edge anchored at the class.
  // External endpoints are NOT rolled up — the pin label on the chip
  // edge should still say "render" rather than "MyClass" so users can
  // see exactly which member they're talking to.
  // Same Map-of-edges trick as the resolution step: if two rolled-up
  // sibling methods call the same external from different lines, we
  // collapse them onto a single chip-level edge but merge lines so the
  // client can render every call site (or at least anchor to the first).
  const downstream: CrossFileCallEdge[] = [];
  const downByKey = new Map<string, CrossFileCallEdge>();
  for (const c of file.outgoingCalls) {
    const focalQname = topLevelQname(c.from);
    if (!fnQnames.has(focalQname)) continue;
    if (c.to.filePath === file.path) continue; // not actually cross-file
    const targetFile = index.files.get(c.to.filePath);
    if (!targetFile) continue;
    const sym = targetFile.symbolsByQname.get(c.to.qualifiedName);
    if (!sym || !isFunctionLike(sym)) continue;
    const key = `${sym.filePath}|${sym.qualifiedName}|${focalQname}`;
    const existing = downByKey.get(key);
    if (existing) {
      for (const line of c.lines) existing.lines.push(line);
    } else {
      const edge: CrossFileCallEdge = {
        external: toFunctionNode(sym),
        focalQname,
        lines: c.lines.slice(),
      };
      downByKey.set(key, edge);
      downstream.push(edge);
    }
  }

  const upstream: CrossFileCallEdge[] = [];
  const upByKey = new Map<string, CrossFileCallEdge>();
  for (const c of file.incomingCalls) {
    const focalQname = topLevelQname(c.to);
    if (!fnQnames.has(focalQname)) continue;
    if (c.from.filePath === file.path) continue; // not actually cross-file
    const sourceFile = index.files.get(c.from.filePath);
    if (!sourceFile) continue;
    const sym = sourceFile.symbolsByQname.get(c.from.qualifiedName);
    if (!sym || !isFunctionLike(sym)) continue;
    const key = `${sym.filePath}|${sym.qualifiedName}|${focalQname}`;
    const existing = upByKey.get(key);
    if (existing) {
      for (const line of c.lines) existing.lines.push(line);
    } else {
      const edge: CrossFileCallEdge = {
        external: toFunctionNode(sym),
        focalQname,
        lines: c.lines.slice(),
      };
      upByKey.set(key, edge);
      upstream.push(edge);
    }
  }
  for (const e of downstream) {
    e.lines.sort((a, b) => a - b);
    e.lines = dedupAsc(e.lines);
  }
  for (const e of upstream) {
    e.lines.sort((a, b) => a - b);
    e.lines = dedupAsc(e.lines);
  }

  // External calls projection — same Map-of-edges roll-up as cross-file
  // edges. Dedup key is (focalTopLevel, packageSpec, importedName); the
  // file-level edge already has merged lines, but rolling up to the
  // top-level qname can collapse two methods of the same class onto
  // a single chip-level edge.
  const external: ExternalCallEdge[] = [];
  const extByKey = new Map<string, ExternalCallEdge>();
  for (const c of file.externalCalls) {
    const focalQname = topLevelQname(c.from);
    if (!fnQnames.has(focalQname)) continue;
    const key = `${focalQname}|${c.packageSpec}|${c.importedName}`;
    const existing = extByKey.get(key);
    if (existing) {
      for (const line of c.lines) existing.lines.push(line);
    } else {
      const edge: ExternalCallEdge = {
        external: { name: c.importedName, packageSpec: c.packageSpec },
        focalQname,
        lines: c.lines.slice(),
      };
      extByKey.set(key, edge);
      external.push(edge);
    }
  }
  for (const e of external) {
    e.lines.sort((a, b) => a - b);
    e.lines = dedupAsc(e.lines);
  }

  // Method-call fallback projection — same Map-of-edges roll-up as
  // the others. Dedup key is (focal, receiverName, methodName); it's
  // important to dedup at top-level focal here too because two
  // sibling methods of the same class might both call
  // `config.always_log_endpoints.includes(...)` — those collapse onto
  // a single chip-level METHOD pin anchored at the class.
  const methodCalls: MethodCallEdge[] = [];
  const mthByKey = new Map<string, MethodCallEdge>();
  for (const c of file.methodCalls) {
    const focalQname = topLevelQname(c.from);
    if (!fnQnames.has(focalQname)) continue;
    const key = `${focalQname}|${c.receiverName}|${c.methodName}`;
    const existing = mthByKey.get(key);
    if (existing) {
      for (const line of c.lines) existing.lines.push(line);
    } else {
      const edge: MethodCallEdge = {
        focalQname,
        receiverName: c.receiverName,
        methodName: c.methodName,
        receiverFilePath: c.receiverFilePath,
        lines: c.lines.slice(),
      };
      mthByKey.set(key, edge);
      methodCalls.push(edge);
    }
  }
  for (const e of methodCalls) {
    e.lines.sort((a, b) => a - b);
    e.lines = dedupAsc(e.lines);
  }

  // Stable order: by file path, then qualifiedName. Keeps the canvas
  // deterministic across refreshes / re-renders.
  const sortByPathQname = (a: CrossFileCallEdge, b: CrossFileCallEdge) =>
    a.external.filePath.localeCompare(b.external.filePath) ||
    a.external.qualifiedName.localeCompare(b.external.qualifiedName);
  upstream.sort(sortByPathQname);
  downstream.sort(sortByPathQname);
  external.sort(
    (a, b) =>
      a.external.packageSpec.localeCompare(b.external.packageSpec) ||
      a.external.name.localeCompare(b.external.name),
  );
  methodCalls.sort(
    (a, b) =>
      a.receiverName.localeCompare(b.receiverName) ||
      a.methodName.localeCompare(b.methodName),
  );

  return {
    filePath: file.path,
    language: file.language,
    fileCount: index.files.size,
    mtimeMs: file.mtime,
    functions,
    intraCalls,
    externalCalls: external,
    methodCalls,
    upstreamCalls: upstream,
    downstreamCalls: downstream,
  };
}


/** Drawer payload — one file's symbol tree. */
/** Recursively drop synthetic `kind: 'unknown'` nodes (filler blocks +
 *  imports header) from a symbol tree. These exist only for the chip-view
 *  UI's "every line lives in some block" promise; for API consumers (AI,
 *  Cmd+K palette, scripts) they're noise. The chip view uses
 *  `fileFunctionsFromIndex` which already filters via `isFunctionLike`, so
 *  trimming here doesn't affect the canvas. */
function stripSyntheticBlocks(syms: ExtractedSymbol[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (const s of syms) {
    if (s.kind === 'unknown') continue;
    out.push({ ...s, children: stripSyntheticBlocks(s.children) });
  }
  return out;
}

export function fileDetailFromIndex(
  index: CodeIndex,
  filePath: string,
): FileDetailResponse | null {
  const file = index.files.get(filePath);
  if (!file) return null;
  return {
    filePath: file.path,
    language: file.language,
    symbols: stripSyntheticBlocks(file.symbolsTree),
  };
}

// Walk a symbol tree, calling `visit` with each node. Bail early if visit returns true.
function walkSymbols(
  syms: ExtractedSymbol[],
  visit: (s: ExtractedSymbol) => boolean | void,
): boolean {
  for (const s of syms) {
    if (visit(s)) return true;
    if (walkSymbols(s.children, visit)) return true;
  }
  return false;
}

/**
 * Collapse case + word separators so naming-style variants of the same
 * concept all hash to one string:
 *
 *   user_profile   → userprofile
 *   userProfile    → userprofile
 *   user-profile   → userprofile
 *   USER_PROFILE   → userprofile
 *   User.Profile   → userprofile
 *
 * Why: the AI agent (and humans) freely mix snake / camel / kebab when
 * referring to the same concept — a snake_case name in the public API
 * surface (tool name, config key, event name) is commonly the camelCase
 * identifier in source. Without normalization, querying with the form
 * the user happens to remember returns zero hits, forcing trial-and-
 * error. Run on BOTH the query and the indexed name so any variant
 * collides on any other.
 *
 * Keeps `.` collapsed too so `task.created` matches `taskCreated` and
 * vice versa — same trade-off as the others. Digits pass through
 * untouched (`v2.api` → `v2api`).
 */
function normalizeForSearch(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Skip the four separators we treat as equivalent to camel-case
    // word boundaries: `_`, `-`, `.`, space.
    if (c === 0x5f || c === 0x2d || c === 0x2e || c === 0x20) continue;
    // ASCII upper → lower. Non-ASCII (CJK / Latin extended) passes
    // through; they don't have case-mixing styles that need folding.
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** Options for `searchIndex`. All optional, backward-compatible defaults. */
export interface SearchIndexOptions {
  /** When true, also walk `IndexedFile.literals` and surface matches in
   *  `SearchResponse.literals`. Off by default to keep responses small
   *  for the common case (Cmd+K palette, which only cares about
   *  identifiers). The AI-facing search route flips this to true when
   *  the caller passes `?includeLiterals=true`. */
  includeLiterals?: boolean;
}

/**
 * Cmd+K palette search (also the backbone of the AI-facing
 * `/api/projectGraph/search` endpoint). Substring match against a
 * separator/case-normalized form so `user_profile`, `userProfile`,
 * `user-profile` etc. all collide on the same query. Fast enough for
 * typical projects (<10k symbols) without needing a fuzzy scorer. Each
 * category capped at `limit`.
 *
 * When `opts.includeLiterals` is set, also matches against
 * `IndexedFile.literals` (identifier-shaped string literals harvested
 * at index time) — covers tool names / event names / config keys that
 * never appear as identifiers and would otherwise return zero hits.
 */
export function searchIndex(
  index: CodeIndex,
  query: string,
  limit: number,
  opts: SearchIndexOptions = {},
): SearchResponse {
  const qRaw = query.trim();
  if (!qRaw) {
    return opts.includeLiterals
      ? { files: [], symbols: [], literals: [] }
      : { files: [], symbols: [] };
  }
  const q = normalizeForSearch(qRaw);

  const files: SearchHit[] = [];
  for (const f of index.files.values()) {
    if (files.length >= limit) break;
    if (normalizeForSearch(f.path).includes(q)) {
      files.push({
        type: 'file',
        label: basename(f.path),
        hint: f.path,
        target: { kind: 'file', filePath: f.path },
      });
    }
  }

  const symbols: SearchHit[] = [];
  outer: for (const f of index.files.values()) {
    let bail = false;
    walkSymbols(f.symbolsTree, (s) => {
      if (symbols.length >= limit) {
        bail = true;
        return true;
      }
      // Skip synthetic chip-view blocks (filler `__code_x_y__` + `__imports__`).
      // Searching for 'code' / 'imports' would otherwise return dozens of these
      // useless hits per file — noise for both Cmd+K and AI consumers.
      if (s.kind === 'unknown') return false;
      if (normalizeForSearch(s.name).includes(q)) {
        symbols.push({
          type: 'symbol',
          label: s.name,
          hint: `${s.kind} · ${f.path}`,
          target: {
            kind: 'symbol',
            filePath: f.path,
            line: s.startLine,
            symbolName: s.name,
            symbolKind: s.kind,
            qualifiedName: s.qualifiedName,
          },
        });
      }
      return false;
    });
    if (bail) break outer;
  }

  if (!opts.includeLiterals) return { files, symbols };

  const literals: LiteralHit[] = [];
  litLoop: for (const f of index.files.values()) {
    for (const lit of f.literals) {
      if (literals.length >= limit) break litLoop;
      if (normalizeForSearch(lit.value).includes(q)) {
        literals.push({
          type: 'literal',
          value: lit.value,
          filePath: f.path,
          line: lit.line,
          ...(lit.enclosingQname
            ? { enclosingSymbol: lit.enclosingQname }
            : {}),
        });
      }
    }
  }

  return { files, symbols, literals };
}

// ============================================================================
// /cg projections — language-model facing endpoints (callers / callees / impact)
//
// These power the `/cg` slash command. They return COORDINATES ONLY (file +
// line range + qname + kind + params), never source text. The caller (AI in
// chat) uses Read with offset=startLine, limit=endLine-startLine to fetch
// source precisely. That separation of concerns is what keeps the chat
// session's context budget bounded — see slashCommands.ts:cg for the prompt
// that enforces this discipline on the AI side.
// ============================================================================

/** Caller entry — a symbol that calls the target, plus the call site lines. */
export interface CodeGraphCaller {
  /** The calling symbol (a function / method / class). */
  caller: FunctionNode;
  /** 1-based line numbers in the caller's file where the call occurs. */
  callLines: number[];
}

/** Callee entry — a symbol that the source calls, plus the call site lines. */
export interface CodeGraphCallee {
  /** The called symbol. */
  callee: FunctionNode;
  /** 1-based line numbers in the SOURCE's file where the call occurs. */
  callLines: number[];
}

export interface CodeGraphCallersResponse {
  qname: string;
  /** The target symbol's coordinates. Null when qname doesn't resolve.
   *  When qname matches multiple files, this is the first match and
   *  `ambiguousIn` lists the rest — caller can disambiguate with `filePath`. */
  target: FunctionNode | null;
  callers: CodeGraphCaller[];
  /** When qname matches symbols in multiple files, all matching file paths.
   *  Absent when there's only one match. */
  ambiguousIn?: string[];
}

export interface CodeGraphCalleesResponse {
  qname: string;
  source: FunctionNode | null;
  callees: CodeGraphCallee[];
  ambiguousIn?: string[];
}

/** One node in the impact tree. The graph is a transitive closure over the
 *  callers relation (who calls X, then who calls them, …). depth=0 is the
 *  target itself; deeper levels are callers-of-callers. */
export interface CodeGraphImpactNode {
  symbol: FunctionNode;
  /** Distance from the target. 0 = target itself; 1 = direct caller; etc. */
  depth: number;
}

export interface CodeGraphImpactResponse {
  qname: string;
  target: FunctionNode | null;
  /** Depth-limited BFS frontier. Empty when target doesn't resolve. */
  nodes: CodeGraphImpactNode[];
  /** True when the BFS hit the depth limit and there were more callers
   *  beyond. Caller can re-request with higher `depth` for full coverage. */
  truncated: boolean;
  ambiguousIn?: string[];
}

/** Locate all symbols that match `qname`, optionally restricted to `filePath`.
 *  qname is the source-stable id from extractSymbols (`Parent>Child` shape). */
function findTargetFiles(
  index: CodeIndex,
  qname: string,
  filePath?: string,
): IndexedFile[] {
  if (filePath) {
    const f = index.files.get(filePath);
    return f && f.symbolsByQname.has(qname) ? [f] : [];
  }
  const out: IndexedFile[] = [];
  for (const f of index.files.values()) {
    if (f.symbolsByQname.has(qname)) out.push(f);
  }
  return out;
}

/** Who calls this symbol — both intra-file (within the same file) and
 *  cross-file (via incomingCalls inverted from other files' outgoing). */
export function callersFromIndex(
  index: CodeIndex,
  qname: string,
  filePath?: string,
): CodeGraphCallersResponse {
  const targetFiles = findTargetFiles(index, qname, filePath);
  if (targetFiles.length === 0) {
    return { qname, target: null, callers: [] };
  }

  const callers: CodeGraphCaller[] = [];
  // Dedup key: (callerFile, callerQname) — same caller from multiple target
  // files (rare but possible when qname is ambiguous) collapses to one entry
  // with merged callLines.
  const byKey = new Map<string, CodeGraphCaller>();

  for (const tf of targetFiles) {
    // Intra-file: tf.intraCalls where to === qname
    for (const c of tf.intraCalls) {
      if (c.to !== qname) continue;
      const callerSym = tf.symbolsByQname.get(c.from);
      if (!callerSym) continue;
      const key = `${tf.path}|${c.from}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const ln of c.lines) existing.callLines.push(ln);
      } else {
        const entry: CodeGraphCaller = {
          caller: toFunctionNode(callerSym),
          callLines: c.lines.slice(),
        };
        byKey.set(key, entry);
        callers.push(entry);
      }
    }
    // Cross-file: tf.incomingCalls (inverted from other files' outgoing)
    for (const c of tf.incomingCalls) {
      if (c.to !== qname) continue;
      const callerFile = index.files.get(c.from.filePath);
      const callerSym = callerFile?.symbolsByQname.get(c.from.qualifiedName);
      if (!callerSym) continue;
      const key = `${c.from.filePath}|${c.from.qualifiedName}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const ln of c.lines) existing.callLines.push(ln);
      } else {
        const entry: CodeGraphCaller = {
          caller: toFunctionNode(callerSym),
          callLines: c.lines.slice(),
        };
        byKey.set(key, entry);
        callers.push(entry);
      }
    }
  }
  // Sort each entry's lines and the overall list for determinism.
  for (const e of callers) {
    e.callLines.sort((a, b) => a - b);
    e.callLines = dedupAsc(e.callLines);
  }
  callers.sort(
    (a, b) =>
      a.caller.filePath.localeCompare(b.caller.filePath) ||
      a.caller.qualifiedName.localeCompare(b.caller.qualifiedName),
  );

  const target = toFunctionNode(targetFiles[0].symbolsByQname.get(qname)!);
  const ambiguousIn =
    targetFiles.length > 1 ? targetFiles.map((f) => f.path) : undefined;
  return { qname, target, callers, ambiguousIn };
}

/** What this symbol calls — both intra-file and cross-file outgoing. */
export function calleesFromIndex(
  index: CodeIndex,
  qname: string,
  filePath?: string,
): CodeGraphCalleesResponse {
  const sourceFiles = findTargetFiles(index, qname, filePath);
  if (sourceFiles.length === 0) {
    return { qname, source: null, callees: [] };
  }

  const callees: CodeGraphCallee[] = [];
  const byKey = new Map<string, CodeGraphCallee>();

  for (const sf of sourceFiles) {
    // Intra-file: sf.intraCalls where from === qname
    for (const c of sf.intraCalls) {
      if (c.from !== qname) continue;
      const calleeSym = sf.symbolsByQname.get(c.to);
      if (!calleeSym) continue;
      const key = `${sf.path}|${c.to}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const ln of c.lines) existing.callLines.push(ln);
      } else {
        const entry: CodeGraphCallee = {
          callee: toFunctionNode(calleeSym),
          callLines: c.lines.slice(),
        };
        byKey.set(key, entry);
        callees.push(entry);
      }
    }
    // Cross-file: sf.outgoingCalls where from === qname
    for (const c of sf.outgoingCalls) {
      if (c.from !== qname) continue;
      const calleeFile = index.files.get(c.to.filePath);
      const calleeSym = calleeFile?.symbolsByQname.get(c.to.qualifiedName);
      if (!calleeSym) continue;
      const key = `${c.to.filePath}|${c.to.qualifiedName}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const ln of c.lines) existing.callLines.push(ln);
      } else {
        const entry: CodeGraphCallee = {
          callee: toFunctionNode(calleeSym),
          callLines: c.lines.slice(),
        };
        byKey.set(key, entry);
        callees.push(entry);
      }
    }
  }
  for (const e of callees) {
    e.callLines.sort((a, b) => a - b);
    e.callLines = dedupAsc(e.callLines);
  }
  callees.sort(
    (a, b) =>
      a.callee.filePath.localeCompare(b.callee.filePath) ||
      a.callee.qualifiedName.localeCompare(b.callee.qualifiedName),
  );

  const source = toFunctionNode(sourceFiles[0].symbolsByQname.get(qname)!);
  const ambiguousIn =
    sourceFiles.length > 1 ? sourceFiles.map((f) => f.path) : undefined;
  return { qname, source, callees, ambiguousIn };
}

/** Impact radius — BFS over the callers relation. Returns all symbols that
 *  transitively call the target, up to `depth` hops. Used for "if I change X,
 *  what should I re-test?" style queries. Soft node cap prevents runaway
 *  blow-ups on heavily-called utility symbols. */
const IMPACT_NODE_CAP = 500;

export function impactFromIndex(
  index: CodeIndex,
  qname: string,
  depth: number,
  filePath?: string,
): CodeGraphImpactResponse {
  const targetFiles = findTargetFiles(index, qname, filePath);
  if (targetFiles.length === 0) {
    return { qname, target: null, nodes: [], truncated: false };
  }

  const safeDepth = Math.min(Math.max(depth, 1), 5);
  const target = toFunctionNode(targetFiles[0].symbolsByQname.get(qname)!);
  const ambiguousIn =
    targetFiles.length > 1 ? targetFiles.map((f) => f.path) : undefined;

  // BFS frontier. Key = `${filePath}|${qname}` so same-named symbols in
  // different files stay distinct. Depth=0 entries are the seeds (target +
  // any ambiguous siblings) — we keep them in the result so the caller can
  // see what was matched, but they don't count against IMPACT_NODE_CAP.
  type Seed = { filePath: string; qname: string };
  const seeds: Seed[] = targetFiles.map((f) => ({
    filePath: f.path,
    qname,
  }));
  const visited = new Set<string>(seeds.map((s) => `${s.filePath}|${s.qname}`));
  const nodes: CodeGraphImpactNode[] = seeds.map((s) => {
    const sym = index.files.get(s.filePath)!.symbolsByQname.get(s.qname)!;
    return { symbol: toFunctionNode(sym), depth: 0 };
  });

  let frontier: Seed[] = seeds.slice();
  let truncated = false;

  for (let d = 1; d <= safeDepth; d++) {
    const next: Seed[] = [];
    for (const cur of frontier) {
      const curFile = index.files.get(cur.filePath);
      if (!curFile) continue;

      // Each caller of `cur.qname` becomes a candidate next-level node.
      // We reuse the single-symbol logic from callersFromIndex but flatten —
      // calling callersFromIndex per node would re-scan all targetFiles for
      // each, wasting work.
      for (const c of curFile.intraCalls) {
        if (c.to !== cur.qname) continue;
        const callerSym = curFile.symbolsByQname.get(c.from);
        if (!callerSym) continue;
        const key = `${curFile.path}|${c.from}`;
        if (visited.has(key)) continue;
        visited.add(key);
        nodes.push({ symbol: toFunctionNode(callerSym), depth: d });
        next.push({ filePath: curFile.path, qname: c.from });
        if (nodes.length >= IMPACT_NODE_CAP) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      for (const c of curFile.incomingCalls) {
        if (c.to !== cur.qname) continue;
        const callerFile = index.files.get(c.from.filePath);
        const callerSym = callerFile?.symbolsByQname.get(
          c.from.qualifiedName,
        );
        if (!callerSym) continue;
        const key = `${c.from.filePath}|${c.from.qualifiedName}`;
        if (visited.has(key)) continue;
        visited.add(key);
        nodes.push({ symbol: toFunctionNode(callerSym), depth: d });
        next.push({
          filePath: c.from.filePath,
          qname: c.from.qualifiedName,
        });
        if (nodes.length >= IMPACT_NODE_CAP) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated || next.length === 0) break;
    frontier = next;
  }

  // Stable order: depth ascending, then path/qname for determinism.
  nodes.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.symbol.filePath.localeCompare(b.symbol.filePath) ||
      a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName),
  );

  return { qname, target, nodes, truncated, ambiguousIn };
}
