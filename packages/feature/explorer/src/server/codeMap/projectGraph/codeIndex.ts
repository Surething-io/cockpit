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

import { getHeapStatistics } from 'node:v8';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Effect, Schedule } from 'effect';
import { AppError } from '@cockpit/effect-core';
import { scanIndexFiles, readIndexSource, readGitIndexState, requireGitProject, diffIndexFiles, INDEX_SOURCE_LIMIT_BYTES, type ExcludedIndexFile, type IndexScan, type SourceContent } from './indexFiles';
import { getServerParser, grammarForExtension } from './serverTreeSitter';
import { SUPPORTED_GRAMMARS } from '../languageMap';
import {
  loadTsconfigs,
  loadWorkspaces,
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
// handler for any grammar that `grammarForExtension` returns — which is a
// strict SUBSET of `SUPPORTED_GRAMMARS` (see the seeding loop). (P1a:
// only file-level extraction goes through the handler; resolution
// still uses the legacy local helpers below — moves to handlers in P1b.)
import { getHandler, tryGetHandler } from '../handlers';
import { dedupeQualifiedNames } from '../extractSymbols';
import { IndexSharing, type SharedParse } from './indexSharing';
import { isTestFile } from './testFiles';
import { SearchTopK } from './searchRanking';

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
  /** Declaration line; see `FunctionNode.declLine`. */
  declLine: number;
  /** Parameter names for callables — propagated through to FunctionNode
   *  so the chip header can render `(req, res, next)`. See
   *  `ExtractedSymbol.params` for semantics; we just pass it through. */
  params?: string[];
}

export interface IndexedFile {
  path: string;
  language: string;
  /** Display freshness metadata; content hashes determine index reuse. */
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
  /** Exported name → export binding (only `b.isReexport === true`).
   *  Includes JS/TS local exports with an empty specifier. All wildcard
   *  sources remain in importBindings; the '*' map entry is not exhaustive.
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
  excludedFiles?: ExcludedIndexFile[];
  tsconfigs: TsconfigScope[];
  workspaces: Map<string, Workspace>;
  /** Contexts and file membership belong to this published revision. */
  projectContexts: Map<string, unknown>;
  fileSet: Set<string>;
  revision?: number;
  update?: { mode: 'initial' | 'incremental' | 'rebuild'; changedFiles: number; parsedFiles: number };
  generatedAt: number;
  buildMs: number;
}

// ============================================================================
// Build
// ============================================================================

// File admission is bounded by scanIndexFiles before parser work starts.
const READ_CONCURRENCY = 50;

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let batchStarted = performance.now();
  let yielding: Promise<void> | undefined;
  async function worker() {
    while (!failed && cursor < items.length) {
      // Cached parser promises only yield microtasks. Share a real event-loop
      // break across workers so timers, requests and progress frames can run.
      if (!yielding && performance.now() - batchStarted >= 8) {
        yielding = Effect.runPromise(Effect.promise(() => yieldToEventLoop())).then(() => {
          batchStarted = performance.now();
          yielding = undefined;
        });
      }
      if (yielding) await yielding;
      if (failed || cursor >= items.length) break;
      const i = cursor++;
      results[i] = await fn(items[i]).catch((cause: unknown) => { failed = true; throw cause; });
    }
  }
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const failure = outcomes.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}

/** Per-file parse result before any cross-file resolution. */
export interface ParsedFile {
  path: string;
  language: string;
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
        declLine: s.declLine,
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

/** Per-file cap. Source input is already capped at 2 MiB; this guards the
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

async function parseOneFile(relPath: string, input: SourceContent): Promise<ParsedFile | null> {
  const grammar = grammarForExtension(relPath);
  if (!grammar) return null;
  const { source } = input;
  if (input.sizeBytes > INDEX_SOURCE_LIMIT_BYTES) return null;
  const parser = await getServerParser(grammar);
  const tree = parser.parse(source);
  if (!tree) throw new AppError({ message: `Unable to parse ${relPath}` });
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
    // 2 MiB size cap above; sub-ms per typical source file.
    const literals = extractStringLiterals(source, flatSymbols);
    return {
      path: relPath,
      language: grammar,
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

interface IndexBaseline {
  hashes: Map<string, string>;
  configHash: string;
  scanTruncated: boolean;
  git: IndexScan['git'];
  facts: Map<string, ParsedFile | null>;
}
const baselines = new WeakMap<CodeIndex, IndexBaseline>();

export async function buildCodeIndex(cwd: string): Promise<CodeIndex> {
  return buildIndexSnapshot(cwd, await scanIndexFiles(cwd), undefined, false);
}

async function buildIndexSnapshot(cwd: string, scan: IndexScan, previous?: CodeIndex, force = false): Promise<CodeIndex> {
  const startedAt = Date.now();
  const prior = previous && baselines.get(previous);
  const delta = diffIndexFiles(prior?.hashes ?? new Map(), scan.hashes);
  const rebuild = force || delta.rebuild || prior?.configHash !== scan.configHash || prior?.git.head !== scan.git.head
    || prior?.git.busy !== scan.git.busy || prior?.git.commonDir !== scan.git.commonDir;
  const files = [...scan.sources.keys()].sort();
  const truncated = scan.truncated;
  const fileSet = new Set(files);

  // 2. tsconfigs (per-scope alias maps) + workspace packages (for monorepos).
  //    Kept here for `CodeIndex` shape compatibility (legacy consumers
  //    expect these on the index). The TS handler reads its own copies
  //    via `buildProjectContext` for its resolveSpecifier calls — we
  //    don't share the value because handler contexts are opaque to
  //    this orchestration layer.
  emitBuildProgress(cwd, 'contexts', 0, files.length, undefined, true);
  const tsconfigs = await loadTsconfigs(cwd, scan.contextFiles);
  const workspaces = await loadWorkspaces(cwd, fileSet, scan.contextFiles);

  // 3. Build per-grammar project contexts. Each handler reads
  //    whatever filesystem state it needs (tsconfigs / workspaces /
  //    src-layout detection / etc.) once per build. Stored opaquely
  //    so the resolution loop just looks up by grammar id.
  const projectContexts = new Map<string, unknown>();
  // Seed a context for every registered grammar — adding a new
  // language is "register a handler", and this loop picks it up
  // automatically. Cost is one filesystem-light read per language;
  // negligible relative to the per-file parse pass below.
  //
  // `tryGetHandler`, not `getHandler`: `SUPPORTED_GRAMMARS` means "grammars
  // whose .wasm we bundle", which is NOT the same set as "grammars with a
  // handler". A grammar may legitimately be bundled for the block-level diff
  // (a browser-side, parse-on-demand path) without ever being indexed. Every
  // bundled grammar happens to have a handler today, but this loop runs on
  // EVERY index build for EVERY project, so `getHandler`'s throw-on-missing
  // would turn "someone bundled a grammar" into "the project graph is dead
  // everywhere". `grammarForExtension` is the real gate on what gets indexed,
  // so skipping here cannot strand a later phase without its context.
  for (const grammar of SUPPORTED_GRAMMARS) {
    const handler = tryGetHandler(grammar);
    if (!handler) continue;
    projectContexts.set(grammar, await handler.buildProjectContext(cwd, fileSet, scan.contextFiles));
  }

  // Reuse immutable parse facts, then resolve every relation against the new file set.
  const totalToParse = files.length;
  let parsedCount = 0;
  let reparsed = 0;
  emitBuildProgress(cwd, 'parsing', 0, totalToParse, undefined, true);
  const facts = new Map<string, ParsedFile | null>();
  const sharedParses = new Map<string, SharedParse>();
  const parsed = (
    await mapWithConcurrency(files, READ_CONCURRENCY, async (f) => {
      const unchanged = !force && prior?.git.commonDir === scan.git.commonDir && prior?.hashes.get(f) === scan.hashes.get(f);
      const reuse = unchanged && prior?.facts.has(f);
      const grammar = grammarForExtension(f);
      const shared = !force && !reuse && grammar
        ? sharing.findParse(scan.git.commonDir, f, grammar, scan.hashes.get(f)!) : undefined;
      if (shared) sharedParses.set(f, shared);
      const result = reuse ? prior!.facts.get(f)! : shared?.facts ?? await parseOneFile(f, scan.sources.get(f)!);
      if (!reuse && !shared) reparsed++;
      facts.set(f, result);
      parsedCount++;
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
    const reused = (prior?.facts.get(f.path) === f ? previous?.files.get(f.path) : undefined)
      ?? sharedParses.get(f.path)?.lookups;
    const symbolsByName = reused?.symbolsByName ?? new Map<string, IndexedSymbol[]>();
    const symbolsByQname = reused?.symbolsByQname ?? new Map<string, IndexedSymbol>();
    for (const s of reused ? [] : f.flatSymbols) {
      symbolsByQname.set(s.qualifiedName, s);
      const list = symbolsByName.get(s.name);
      if (list) list.push(s);
      else symbolsByName.set(s.name, [s]);
    }
    const bindingsByLocalName = reused?.bindingsByLocalName ?? new Map<string, ImportBinding>();
    const reexportsByLocalName = reused?.reexportsByLocalName ?? new Map<string, ImportBinding>();
    for (const b of reused ? [] : f.importBindings) {
      if (b.isReexport) reexportsByLocalName.set(b.localName, b);
      else bindingsByLocalName.set(b.localName, b);
    }

    indexedFiles.set(f.path, {
      path: f.path,
      language: f.language,
      mtime: scan.sources.get(f.path)!.mtime,
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

  const index: CodeIndex = {
    cwd, files: indexedFiles, truncated,
    fileCountCap: truncated ? MAX_FILES : undefined,
    excludedFiles: files.flatMap(filePath => {
      const source = scan.sources.get(filePath)!;
      return source.sizeBytes > INDEX_SOURCE_LIMIT_BYTES
        ? [{ filePath, reason: 'source-too-large' as const, sizeBytes: source.sizeBytes, limitBytes: INDEX_SOURCE_LIMIT_BYTES }]
        : [];
    }),
    tsconfigs, workspaces, projectContexts, fileSet,
    generatedAt: Date.now(), buildMs: Date.now() - startedAt,
    revision: (previous?.revision ?? 0) + 1,
    update: { mode: !previous ? 'initial' : rebuild ? 'rebuild' : 'incremental', changedFiles: delta.count, parsedFiles: reparsed },
  };
  // Too-large supported sources are deliberate exclusions, never silent success.
  index.truncated ||= parsed.length < files.length;
  baselines.set(index, { hashes: scan.hashes, configHash: scan.configHash, scanTruncated: scan.truncated, git: scan.git, facts });
  return index;
}

// ============================================================================
// Cache (in-memory, per cwd)
// ============================================================================

const indexCache = new Map<string, CodeIndex>();
const sharing = new IndexSharing();
/** ms epoch of the last read of each cached index — what the idle sweep
 *  (`evictIdleCodeIndexes`) measures. Entries outlive their index harmlessly
 *  and are pruned by the sweep. */
const indexLastUsed = new Map<string, number>();
const inflight = new Map<string, Promise<CodeIndex>>();

/** Total flattened symbols in one index. Used for diagnostics and legacy estimates. */
export function countIndexSymbols(index: CodeIndex): number {
  let n = 0;
  for (const f of index.files.values()) n += f.flatSymbols.length;
  return n;
}

/** A best-effort heap budget: unique parse/relation blocks plus per-worktree
 * roots. Sharing must not charge the same payload once per worktree. Keep the
 * existing 2 GiB ceiling and 1 GiB reserve for the rest of the application. */
export function codeMapBudgetForHeap(heapLimitBytes: number): number {
  return Math.max(MIN_BUDGET_BYTES, Math.min(heapLimitBytes - HEAP_RESERVED_BYTES, MAX_BUDGET_BYTES));
}
const BYTES_PER_SYMBOL = 4_000;
const HEAP_RESERVED_BYTES = 1024 ** 3;
const MIN_BUDGET_BYTES = 250_000 * BYTES_PER_SYMBOL;
const MAX_BUDGET_BYTES = 2 * 1024 ** 3;
export const MAX_CACHED_BYTES = codeMapBudgetForHeap(getHeapStatistics().heap_size_limit);

/**
 * Recency and `keep` rules shared by `enforceCodeMapBudget` (below).
 *
 * `Map` preserves insertion order and `getCodeIndex` re-inserts on every
 * cache hit, so iteration order IS least-recently-used order — no separate
 * access-time bookkeeping.
 *
 * `keep` is never evicted: it is the entry the caller just built and is
 * about to return, and dropping it would both waste the build and hand back
 * an index that is no longer cached (so the next call rebuilds it, forever).
 * That means the budget can legitimately be exceeded by a single oversized
 * project — the budget cannot shrink a single oversized index.
 */
/**
 * Test-only handle on the module-private cache. NEVER call from production
 * code — the cache is a process-wide singleton and these bypass every
 * lifecycle guarantee `getCodeIndex` provides.
 *
 * It exists because the eviction path cannot be driven any other way:
 * `getCodeIndex` calls `buildCodeIndex` through a direct local binding, so
 * an ESM spy on the module export does not intercept it (an earlier version
 * of the eviction tests "passed" for exactly that reason — the stub never
 * ran and every assertion was vacuously true), and a real fixture cannot
 * practically exhaust the process-wide heap budget.
 */
export const __indexCacheTesting = {
  seed(cwd: string, index: CodeIndex, lastUsedAt = Date.now()): void {
    sharing.release(cwd);
    indexCache.set(cwd, index);
    indexLastUsed.set(cwd, lastUsedAt);
  },
  has(cwd: string): boolean {
    return indexCache.has(cwd);
  },
  keys(): string[] {
    return [...indexCache.keys()];
  },
  clear(): void {
    invalidateIndex();
    indexLastUsed.clear();
  },
  evict(keep: string, reserveBytes = 0): void {
    enforceCodeMapBudget(keep, reserveBytes);
  },
  sharingStats: () => sharing.stats(),
  estimatedBytes: () => cachedIndexBytes(),
};

function cachedIndexBytes(): number {
  let bytes = sharing.estimatedBytes();
  // Legacy/test indexes without a published sharing lease retain the old estimate.
  for (const [cwd, index] of indexCache) if (!sharing.has(cwd)) bytes += countIndexSymbols(index) * BYTES_PER_SYMBOL;
  return bytes;
}

/** Evict least-recently-used indexes; keep the index being returned. */
export function enforceCodeMapBudget(keep: string, reserveBytes = 0): void {
  for (const cwd of indexCache.keys()) {
    if (cachedIndexBytes() + reserveBytes <= MAX_CACHED_BYTES) break;
    if (cwd === keep) continue;
    releaseIndex(cwd);
    console.log(`[codeIndex] evicted ${cwd} — cache over estimated byte budget`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Idle eviction — release projects nobody is using, budget or not.
//
// The size budget only evicts when a NEW project needs room, so indexes built
// once and never read again stayed resident for the life of the server. An
// index unread for INDEX_IDLE_MS is dropped; the next
// code-graph request rebuilds it.
// ────────────────────────────────────────────────────────────────────────────

/** An index unread for this long is released. */
export const INDEX_IDLE_MS = 15 * 60_000;
const IDLE_SWEEP_EVERY = '5 minutes';

/** Drop every cached index unread since
 *  `now - INDEX_IDLE_MS`. In-flight builds are
 *  never touched. Returns the evicted cwds. */
export function evictIdleCodeIndexes(now = Date.now()): string[] {
  const cutoff = now - INDEX_IDLE_MS;
  const evicted: string[] = [];
  for (const [cwd, idx] of [...indexCache]) {
    if (inflight.has(cwd)) continue;
    const lastUsed = indexLastUsed.get(cwd) ?? 0;
    if (lastUsed >= cutoff) continue;
    releaseIndex(cwd);
    evicted.push(cwd);
    console.log(
      `[codeIndex] released idle ${cwd} (${countIndexSymbols(idx)} symbols, unread for ` +
        `${Math.round((now - lastUsed) / 60_000)} min)`,
    );
  }
  for (const cwd of indexLastUsed.keys()) {
    if (!indexCache.has(cwd)) indexLastUsed.delete(cwd);
  }
  return evicted;
}

let idleSweeperStarted = false;

/** Start the periodic idle sweep. Idempotent; called once at server boot
 *  (src/lib/codeIndexSync.ts), not on import, so tests stay timer-free. */
export function startCodeIndexIdleSweeper(): void {
  if (idleSweeperStarted) return;
  idleSweeperStarted = true;
  Effect.runFork(
    Effect.sync(() => {
      evictIdleCodeIndexes();
    }).pipe(
      Effect.delay(IDLE_SWEEP_EVERY),
      Effect.repeat(Schedule.spaced(IDLE_SWEEP_EVERY)),
    ),
  );
}

// One owner per project serializes scans/builds and owns its subscription.
interface ProjectUpdates {
  version: number;
  publishedVersion: number;
  generation: number;
  force: boolean;
  retired?: boolean;
  runningGeneration?: number;
  unsubscribe?: () => void;
}
const updates = new Map<string, ProjectUpdates>();
const buildFailures = new Map<string, unknown>();
export type WatcherSubscriber = (cwd: string, onDirty: () => void) => (() => void);
let watcherSubscriber: WatcherSubscriber | null = null;

export function registerWatcherSubscriber(fn: WatcherSubscriber | null): void {
  watcherSubscriber = fn;
  for (const [cwd, state] of updates) {
    state.unsubscribe?.();
    state.unsubscribe = fn?.(cwd, () => markIndexDirty(cwd));
  }
}

export function markIndexDirty(cwd: string): void {
  const state = updates.get(cwd);
  if (state) state.version++;
}

function ownerFor(cwd: string): ProjectUpdates {
  let state = updates.get(cwd);
  if (!state) {
    state = { version: 0, publishedVersion: -1, generation: 0, force: false };
    updates.set(cwd, state);
    state.unsubscribe = watcherSubscriber?.(cwd, () => markIndexDirty(cwd));
  } else if (state.retired) {
    state.retired = false;
    state.unsubscribe = watcherSubscriber?.(cwd, () => markIndexDirty(cwd));
  }
  return state;
}

function touchIndex(cwd: string, index: CodeIndex): void {
  indexCache.delete(cwd);
  indexCache.set(cwd, index);
  indexLastUsed.set(cwd, Date.now());
}

function releaseIndex(cwd: string): void {
  sharing.release(cwd);
  indexCache.delete(cwd);
  indexLastUsed.delete(cwd);
  buildFailures.delete(cwd);
  const state = updates.get(cwd);
  if (!state) return;
  state.generation++;
  state.retired = true;
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  if (!inflight.has(cwd)) updates.delete(cwd);
}

export interface GetIndexOptions { forceRefresh?: boolean }

/** Every project query verifies membership and content, even without events. */
export async function getCodeIndex(cwd: string, opts: GetIndexOptions = {}): Promise<CodeIndex> {
  const state = ownerFor(cwd);
  if (opts.forceRefresh) {
    state.generation++;
    state.version++;
    state.force = true;
    buildFailures.delete(cwd);
  }
  const requiredVersion = state.version;
  for (let attempt = 0; attempt < 3; attempt++) {
    const running = inflight.get(cwd);
    if (running) {
      const generation = state.runningGeneration;
      // A forced request may supersede a task already reading the old workspace.
      const result = await running.then(
        (index) => ({ index, error: undefined }),
        (error: unknown) => ({ index: undefined, error }),
      );
      if (state.force || generation !== state.generation) continue;
      if (result.error) throw result.error;
      if (!opts.forceRefresh && result.index && baselines.get(result.index)?.git.busy) {
        throw new AppError({ message: 'Workspace is changing: finish the Git operation or explicitly rebuild the index' });
      }
      if (state.publishedVersion >= requiredVersion && result.index && indexCache.get(cwd) === result.index) {
        touchIndex(cwd, result.index);
        return result.index;
      }
      continue;
    }
    const generation = state.generation;
    const version = state.version;
    const force = state.force;
    state.force = false;
    state.runningGeneration = generation;
    const task = (async () => {
      const scan = await scanIndexFiles(cwd, force);
      const cached = indexCache.get(cwd);
      const prior = cached && baselines.get(cached);
      const delta = diffIndexFiles(prior?.hashes ?? new Map(), scan.hashes);
      const unchanged = !force && cached && prior && !delta.count && prior.configHash === scan.configHash
        && prior.git.busy === scan.git.busy && prior.git.commonDir === scan.git.commonDir && prior.scanTruncated === scan.truncated;
      const next = unchanged ? cached : await buildIndexSnapshot(cwd, scan, cached, force);
      const end = await readGitIndexState(cwd);
      if (end.commonDir !== scan.git.commonDir || (!force && (end.busy || end.head !== scan.git.head))) {
        throw new AppError({ message: 'Workspace changed during indexing; retry after the Git operation finishes' });
      }
      if (state.generation !== generation || updates.get(cwd) !== state) {
        throw new AppError({ message: 'Index update was superseded; retry the query' });
      }
      // HEAD can advance on an ordinary commit with identical workspace content.
      if (unchanged && prior) baselines.set(next, { ...prior, git: scan.git });
      if (!unchanged) {
        const baseline = baselines.get(next)!;
        sharing.publish(next, scan.git.commonDir, baseline.hashes, baseline.facts);
      }
      state.publishedVersion = version;
      touchIndex(cwd, next);
      buildFailures.delete(cwd);
      enforceCodeMapBudget(cwd);
      return next;
    })();
    // Retain the task until completion even when invalidated: never run two builds.
    const tracked = task.catch((error: unknown) => {
      // Only the current build owner can publish diagnostics. A superseded
      // task must not overwrite a rebuild's state or resurrect an evicted cwd.
      if (updates.get(cwd) === state && state.generation === generation && !state.force) {
        buildFailures.set(cwd, error);
      }
      throw error;
    }).finally(() => {
      if (inflight.get(cwd) === tracked) inflight.delete(cwd);
      if (state.retired && !state.force && updates.get(cwd) === state) {
        state.unsubscribe?.();
        updates.delete(cwd);
      }
      emitBuildProgress(cwd, 'done', 0, 0, undefined, true);
    });
    inflight.set(cwd, tracked);
    const result = await tracked;
    // This caller may have started work on behalf of a queued explicit rebuild.
    if (!opts.forceRefresh && baselines.get(result)?.git.busy) {
      throw new AppError({ message: 'Workspace is changing: finish the Git operation or explicitly rebuild the index' });
    }
    return result;
  }
  throw new AppError({ message: 'Workspace is changing; retry the index query' });
}

export function invalidateIndex(cwd?: string): void {
  const paths = cwd ? [cwd] : [...new Set([...indexCache.keys(), ...updates.keys()])];
  for (const p of paths) releaseIndex(p);
}

/** A read of the last complete revision, with no IO or implicit update. */
export function peekCodeIndex(cwd: string): CodeIndex | null {
  const cached = indexCache.get(cwd);
  if (cached) touchIndex(cwd, cached);
  return cached ?? null;
}

/** Only explicit rebuild UI calls this; a failure must not create a refetch loop. */
export function ensureCodeIndex(cwd: string, opts: GetIndexOptions = {}): void {
  if (!opts.forceRefresh && buildFailures.has(cwd)) return;
  // getCodeIndex records failures before emitting completion for every caller.
  getCodeIndex(cwd, opts).catch(() => {});
}

export function codeIndexBuilding(cwd: string): boolean { return inflight.has(cwd); }
export function codeIndexBuildFailed(cwd: string): boolean { return buildFailures.has(cwd); }

// ============================================================================
// File-local projection — one file, no project index.
// ============================================================================

/** Verify only the focal content; cross-file data remains tied to a published revision. */
export async function fileFunctionsForBrowse(cwd: string, relPath: string): Promise<FileFunctionsResponse | null> {
  await requireGitProject(cwd);
  const content = await readIndexSource(cwd, relPath);
  if (!content) return null;
  // The project may publish while the focal read is awaiting disk IO.
  const index = peekCodeIndex(cwd);
  const baseline = index && baselines.get(index);
  const state = updates.get(cwd);
  const failure = buildFailures.get(cwd) as { message?: string; cause?: unknown } | undefined;
  const indexUpdateError = failure?.cause instanceof Error ? failure.cause.message : failure?.message;
  const crossFilePending = codeIndexBuilding(cwd);
  if (index && baseline?.hashes.get(relPath) === content.hash && (!state || state.version === state.publishedVersion)) {
    const payload = fileFunctionsFromIndex(index, relPath);
    if (payload) return { ...payload, mtimeMs: content.mtime, crossFileRevision: index.revision,
      crossFilePending, crossFileStale: crossFilePending || !!failure, indexUpdateError };
  }
  const local = await fileFunctionsLocal(cwd, relPath, content);
  return local ? { ...local, fileCount: index?.files.size ?? 0, crossFileStale: !!index,
    crossFileRevision: index?.revision, crossFilePending: codeIndexBuilding(cwd), indexUpdateError } : null;
}

/**
 * `fileFunctionsFromIndex`'s file-local layer — symbols and intra-file calls
 * — computed from the focal file alone, in the time it takes to parse it.
 *
 * Imports are deliberately dropped before call resolution. Resolving them
 * needs the project fileset; resolving against a one-file set would turn
 * every project import (`./b`, `@/lib/x`) into a phantom npm package. So
 * everything import-dependent — `externalCalls`, `methodCalls` and both
 * cross-file edge lists — comes back empty and belongs to the full index.
 *
 * Returns null when the file has no supported grammar or fails to parse.
 */
export async function fileFunctionsLocal(
  cwd: string,
  relPath: string,
  content?: SourceContent,
): Promise<FileFunctionsResponse | null> {
  await requireGitProject(cwd);
  const input = content ?? await readIndexSource(cwd, relPath);
  if (!input) return null;
  const parsed = await parseOneFile(relPath, input);
  if (!parsed) return null;
  const local: CodeIndex = {
    cwd,
    files: new Map(),
    truncated: false,
    tsconfigs: [],
    workspaces: new Map(),
    projectContexts: new Map([[parsed.language, parsed.language === 'go'
      ? await getHandler('go').buildProjectContext(cwd, new Set([parsed.path])) : undefined]]),
    fileSet: new Set([parsed.path]),
    generatedAt: Date.now(),
    buildMs: 0,
  };
  await buildIndexedFileEntry({ ...parsed, importBindings: [], importSpecifiers: [] }, local, input.mtime);
  return fileFunctionsFromIndex(local, parsed.path);
}

/** Build one isolated file-local projection; never publishes into the shared index. */
async function buildIndexedFileEntry(
  parsed: ParsedFile,
  index: CodeIndex,
  mtime: number,
): Promise<IndexedFile> {
  const handler = getHandler(parsed.language as Parameters<typeof getHandler>[0]);
  const ctx = index.projectContexts.get(parsed.language);

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
    mtime,
    symbolsTree: parsed.symbolsTree,
    flatSymbols: parsed.flatSymbols,
    literals: parsed.literals,
    importedFiles,
    importedBy: new Set<string>(),
    importBindings: parsed.importBindings,
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
  };

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
    declLine: s.declLine,
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
  /** Normalized project-relative directory, including descendants. */
  directory?: string;
  excludeTests?: boolean;
  /** When true, also walk `IndexedFile.literals` and surface matches in
   *  `SearchResponse.literals`. Off by default to keep responses small
   *  for the common case (Cmd+K palette, which only cares about
   *  identifiers). The AI-facing search route flips this to true when
   *  the caller passes `?includeLiterals=true`. */
  includeLiterals?: boolean;
}

interface RankedSearchCandidate<T> {
  rank: number;
  filePath: string;
  qname: string;
  line: number;
  value: T;
}

const compareSearchCandidates = (a: RankedSearchCandidate<unknown>, b: RankedSearchCandidate<unknown>) =>
  a.rank - b.rank || a.filePath.localeCompare(b.filePath) || a.qname.localeCompare(b.qname) || a.line - b.line;

/** Raw exact, normalized exact, normalized prefix, then normalized substring. */
function searchRank(name: string, query: string, normalizedQuery: string): number {
  if (name === query) return 0;
  const normalized = normalizeForSearch(name);
  if (normalized === normalizedQuery) return 1;
  if (normalized.startsWith(normalizedQuery)) return 2;
  return normalized.includes(normalizedQuery) ? 3 : -1;
}

/**
 * Cmd+K palette search (also the backbone of the AI-facing
 * `/api/projectGraph/search` endpoint). Substring match against a
 * separator/case-normalized form so `user_profile`, `userProfile`,
 * `user-profile` etc. all collide on the same query. Every eligible file
 * is examined; bounded heaps retain only the best `limit` per category.
 * Exact matches cannot be displaced by earlier substring matches.
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
  if (!q) return opts.includeLiterals ? { files: [], symbols: [], literals: [] } : { files: [], symbols: [] };
  const cap = Math.min(500, Math.max(0, Math.floor(limit) || 0));
  const fileMatches = new SearchTopK<RankedSearchCandidate<IndexedFile>>(cap, compareSearchCandidates);
  const symbolMatches = new SearchTopK<RankedSearchCandidate<IndexedSymbol>>(cap, compareSearchCandidates);
  const literalMatches = new SearchTopK<RankedSearchCandidate<IndexedLiteral>>(cap, compareSearchCandidates);

  for (const f of index.files.values()) {
    if (opts.directory && !f.path.startsWith(`${opts.directory}/`)) continue;
    if (opts.excludeTests && isTestFile(f.path)) continue;
    const pathRank = searchRank(f.path, qRaw, q);
    if (pathRank >= 0) {
      const nameRank = searchRank(basename(f.path), qRaw, q);
      fileMatches.add({ rank: nameRank >= 0 ? Math.min(nameRank, pathRank) : pathRank,
        filePath: f.path, qname: '', line: 0, value: f });
    }
    for (const s of f.flatSymbols) {
      // Synthetic blocks exist only to cover source lines in the chip view.
      if (s.kind === 'unknown') continue;
      const rank = searchRank(s.name, qRaw, q);
      if (rank >= 0) symbolMatches.add({ rank, filePath: f.path, qname: s.qualifiedName, line: s.declLine, value: s });
    }
    if (!opts.includeLiterals) continue;
    for (const lit of f.literals) {
      const rank = searchRank(lit.value, qRaw, q);
      if (rank >= 0) literalMatches.add({ rank, filePath: f.path, qname: lit.value, line: lit.line, value: lit });
    }
  }
  const files: SearchHit[] = fileMatches.sorted().map(({ value: f }) => ({
    type: 'file', label: basename(f.path), hint: f.path, target: { filePath: f.path },
  }));
  const symbols: SearchHit[] = symbolMatches.sorted().map(({ value: s }) => ({
    type: 'symbol', label: s.name, hint: `${s.kind} · ${s.filePath}`,
    target: toFunctionNode(s),
  }));
  if (!opts.includeLiterals) return { files, symbols };
  const literals: LiteralHit[] = literalMatches.sorted().map(({ filePath, value: lit }) => ({
    type: 'literal', value: lit.value, filePath, line: lit.line,
    ...(lit.enclosingQname ? { enclosingSymbol: lit.enclosingQname } : {}),
  }));
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
  /** Null when missing or ambiguous. Ambiguity requires an explicit filePath. */
  target: FunctionNode | null;
  callers: CodeGraphCaller[];
  /** When qname matches symbols in multiple files, all matching file paths.
   *  Absent when there's only one match. */
  ambiguousIn?: string[];
}

export interface CodeGraphCalleesResponse {
  qname: string;
  /** The symbol the callees belong to. Named `target` — like every other
   *  endpoint — rather than the old `source`: the direction of the edge is
   *  already carried by the endpoint name, so a second vocabulary for the
   *  same slot only cost consumers a special case. */
  target: FunctionNode | null;
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
export function findTargetFiles(
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
  if (targetFiles.length > 1) {
    return { qname, target: null, callers: [], ambiguousIn: targetFiles.map(f => f.path).sort() };
  }
  if (targetFiles.length === 0) {
    return { qname, target: null, callers: [] };
  }

  const callers: CodeGraphCaller[] = [];
  // Dedup key: (callerFile, callerQname), with merged callLines.
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
  return { qname, target, callers };
}

/** What this symbol calls — both intra-file and cross-file outgoing. */
export function calleesFromIndex(
  index: CodeIndex,
  qname: string,
  filePath?: string,
): CodeGraphCalleesResponse {
  const sourceFiles = findTargetFiles(index, qname, filePath);
  if (sourceFiles.length > 1) {
    return { qname, target: null, callees: [], ambiguousIn: sourceFiles.map(f => f.path).sort() };
  }
  if (sourceFiles.length === 0) {
    return { qname, target: null, callees: [] };
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
  return { qname, target: source, callees };
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
  if (targetFiles.length > 1) {
    return { qname, target: null, nodes: [], truncated: false, ambiguousIn: targetFiles.map(f => f.path).sort() };
  }
  if (targetFiles.length === 0) {
    return { qname, target: null, nodes: [], truncated: false };
  }

  const safeDepth = Math.min(Math.max(depth, 1), 5);
  const target = toFunctionNode(targetFiles[0].symbolsByQname.get(qname)!);

  // BFS frontier. Key = `${filePath}|${qname}` so same-named symbols in
  // different files stay distinct. The depth=0 seed identifies the target
  // and does not count against IMPACT_NODE_CAP.
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

  return { qname, target, nodes, truncated };
}
