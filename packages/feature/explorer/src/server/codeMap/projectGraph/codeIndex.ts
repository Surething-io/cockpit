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
import type {
  CrossFileCallEdge,
  ExternalCallEdge,
  FileDetailResponse,
  FileFunctionsResponse,
  FunctionNode,
  IntraCallEdge,
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

// ============================================================================
// Index types
// ============================================================================

/** A symbol's address — uniquely identifies a symbol across the project. */
export interface SymbolAddr {
  filePath: string;
  qualifiedName: string;
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
    const flatSymbols = flattenSymbols(relPath, symbolsTree);
    const { specs: importSpecifiers, bindings: importBindings } =
      handler.extractImports(tree.rootNode);
    const rawCalls = handler.extractCallSites(tree.rootNode, flatSymbols);
    return {
      path: relPath,
      language: grammar,
      mtime,
      symbolsTree,
      flatSymbols,
      importBindings,
      importSpecifiers,
      rawCalls,
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
  const parsed = (
    await mapWithConcurrency(files, READ_CONCURRENCY, (f) =>
      parseOneFile(path.join(cwd, f), f),
    )
  ).filter((p): p is ParsedFile => p !== null);

  // 5. Resolve each import specifier → project file (or drop as external).
  //    Per-file: look up the language handler, get its project context,
  //    and delegate to handler.resolveSpecifier. The handler owns ALL
  //    language-specific resolution (TS aliases / workspaces, Python
  //    dotted-paths and relative dots) — codeIndex stays language-
  //    agnostic at this layer.
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

export interface GetIndexOptions {
  /** Force a fresh build, dropping any cached index for this cwd. */
  forceRefresh?: boolean;
}

export async function getCodeIndex(cwd: string, opts: GetIndexOptions = {}): Promise<CodeIndex> {
  if (opts.forceRefresh) indexCache.delete(cwd);
  const cached = indexCache.get(cwd);
  if (cached) return cached;
  const pending = inflight.get(cwd);
  if (pending) return pending;
  const p = buildCodeIndex(cwd).then((index) => {
    indexCache.set(cwd, index);
    inflight.delete(cwd);
    return index;
  });
  inflight.set(cwd, p);
  return p;
}

export function invalidateIndex(cwd?: string): void {
  if (!cwd) {
    indexCache.clear();
    inflight.clear();
    return;
  }
  indexCache.delete(cwd);
  inflight.delete(cwd);
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
export async function refreshFocalFile(
  cwd: string,
  relPath: string,
  index: CodeIndex,
): Promise<boolean> {
  const oldEntry = index.files.get(relPath);
  if (!oldEntry) return false;

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
    importedFiles,
    // Inverse of other files' `importedFiles`; we're not re-parsing
    // other files, so the previous build's view is still our best
    // shot. Stale tolerance documented above.
    importedBy: oldEntry.importedBy,
    importBindings: parsed.importBindings,
    resolvedImports,
    intraCalls: [],
    outgoingCalls: [],
    // Inverse of other files' `outgoingCalls`. Same trade-off as
    // `importedBy` — we're choosing the cheap path. The chip view
    // surfaces this as left-column caller pins; clicking
    // "Rebuild project graph" forces a full rebuild that fixes them.
    incomingCalls: oldEntry.incomingCalls,
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
export function fileDetailFromIndex(
  index: CodeIndex,
  filePath: string,
): FileDetailResponse | null {
  const file = index.files.get(filePath);
  if (!file) return null;
  return {
    filePath: file.path,
    language: file.language,
    symbols: file.symbolsTree,
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
 * Cmd+K palette search. Substring (case-insensitive) match — fast enough for
 * typical projects (<10k symbols) without needing a fancy fuzzy scorer. Each
 * category capped at `limit`.
 */
export function searchIndex(index: CodeIndex, query: string, limit: number): SearchResponse {
  const q = query.trim().toLowerCase();
  if (!q) return { files: [], symbols: [] };

  const files: SearchHit[] = [];
  for (const f of index.files.values()) {
    if (files.length >= limit) break;
    if (f.path.toLowerCase().includes(q)) {
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
      if (s.name.toLowerCase().includes(q)) {
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

  return { files, symbols };
}
