/**
 * LanguageHandler — pluggable per-language interface for the codeMap module.
 *
 * Background: codeMap historically had hardcoded TS/Python branches
 * scattered across `extractSymbols.ts`, `extractCalls.ts`,
 * `extractImports.ts`, `codeIndex.ts`, and `buildGraph.ts`. As we
 * grow to support Go and Rust, those branches multiply. The handler
 * abstraction collects every language-specific operation behind one
 * interface so that "adding a new language" becomes "implement a
 * handler + register it" — the rest of the pipeline stays generic.
 *
 * This file is types-only. The runtime registry and the per-language
 * handler implementations live in sibling files:
 *   - `registry.ts`      — register / lookup
 *   - `index.ts`         — barrel that imports each handler module so
 *                          their top-level `registerHandler(...)` side
 *                          effects fire on first import
 *   - `typescript.ts`    — TS/TSX/JS handler (P1)
 *   - `python.ts`        — Python handler (P2)
 *   - `go.ts`, `rust.ts` — later phases
 *
 * Interface design notes:
 *
 *   - **7 methods + 2 readonly fields**, all required (no optional
 *     hooks). Languages that don't use a feature return an empty value
 *     (e.g. Python's `extractImports().bindings` has `isReexport`
 *     never set; Python's `buildProjectContext` returns `undefined`
 *     wrapped as `unknown`).
 *
 *   - **`ProjectContext` is `unknown`**. Each handler casts to its own
 *     internal shape. Reason: the contexts are too different across
 *     languages to type uniformly (TS has tsconfig + workspace data,
 *     Go has package directories, Rust has a mod tree). A generic
 *     `<T>` would require every consumer to thread the type
 *     parameter; `unknown` is honest about the opacity.
 *
 *   - **`resolveCall` returns a discriminated `CallResolution`**, not
 *     `SymbolAddr | null`. Chip view has 4 pin kinds (cross / ext /
 *     method-unresolved / nothing) and the resolver is the only place
 *     with enough information to differentiate them — collapsing
 *     ext/method into `null` would force the caller to redo work the
 *     handler already did.
 *
 *   - **`extractImports` returns BOTH `specs` and `bindings`** in one
 *     call. They both come from the same import statements in the
 *     AST; splitting them into two methods forces a double walk and
 *     leaks the implementation's "I want to share traversal state"
 *     into the interface. The `specs` list also captures
 *     side-effect / dynamic imports (`import './polyfill'`,
 *     `await import('./x')`, `require('./y')`) that have no name
 *     binding but DO contribute to the file dependency graph.
 */

import type { Node } from 'web-tree-sitter';
import type { GrammarId } from '../languageMap';
import type { ExtractedSymbol } from '../types';
import type { ImportBinding, RawCall } from '../extractCalls';
import type { IndexedFile, IndexedSymbol, SymbolAddr } from '../projectGraph/codeIndex';

// ============================================================================
// Project context
// ============================================================================

/** Handler-private project-level state, built once per index after all
 *  files are parsed. Each handler casts this to its own internal shape:
 *
 *    TS:     { tsconfigAliases: Map<string, string>; workspaceEntries: Map<string, string> }
 *    Python: undefined  (no project-level state needed)
 *    Go:     { dirToPackage: Map<string, string>; packageToFiles: Map<string, string[]>; modulePath: string }
 *    Rust:   { modTree: ModNode; cratePath: string; useAliases: Map<string, string> }
 *
 *  Typed as `unknown` rather than a generic `<T>` so consumers don't
 *  need to thread the type parameter through every call. The handler
 *  is the only code that touches the internals; a one-line cast at
 *  the top of each handler method keeps the tax minimal. */
export type ProjectContext = unknown;

// ============================================================================
// Import extraction (one method, two consumer-shaped outputs)
// ============================================================================

/** Combined output of `extractImports` — covers two distinct downstream
 *  uses in one walk:
 *
 *    `specs`    : populates `IndexedFile.importedFiles` (via
 *                 `resolveSpecifier` per spec). Coarse-grained — this
 *                 file depends on these other files. Includes side-
 *                 effect (`import './x'`), dynamic (`await import('./x')`),
 *                 and CJS (`require('./x')`) — anything that can pull
 *                 a file in at runtime.
 *
 *    `bindings` : populates `IndexedFile.importBindings`. Fine-grained
 *                 — for each named import, the local name -> source
 *                 spec/name mapping the call resolver needs to map a
 *                 callsite identifier to the right cross-file target.
 *                 Empty for side-effect / dynamic / CJS imports (no
 *                 name to bind). */
export interface ImportExtraction {
  specs: string[];
  bindings: ImportBinding[];
}

// ============================================================================
// Call resolution outcome (4-way: see chip-view pin types)
// ============================================================================

/** Where a callsite ended up. The handler that owns the resolution is
 *  the only place with enough information to differentiate "this is an
 *  npm package" from "this is a typo / dead reference"; surfacing that
 *  distinction here lets the caller render the right pin without
 *  re-running spec resolution.
 *
 *  Maps directly to chip-view pin kinds:
 *
 *    `symbol`            → `cross` / `self` pin (project function on
 *                          the other end; we know its file + qname)
 *    `external`          → `ext` pin (npm / crate / pip module function)
 *    `method-unresolved` → `method` pin (receiver resolved to a
 *                          project type but the method itself isn't
 *                          findable — e.g. inherited from outside or
 *                          dynamically dispatched)
 *    `null` (returned from resolveCall) → no pin (dead reference)  */
export type CallResolution =
  | { kind: 'symbol'; addr: SymbolAddr }
  | { kind: 'external'; name: string; packageSpec: string }
  | { kind: 'method-unresolved'; receiverName: string; methodName: string };

// ============================================================================
// LanguageHandler — the contract
// ============================================================================

export interface LanguageHandler {
  /** The tree-sitter grammar this handler covers. ONE handler instance
   *  may register itself under multiple grammar ids (TS / TSX / JS all
   *  share the same handler) — the registry keys by `grammarId`, so
   *  call `registerHandler` once per id with the same instance. */
  readonly grammarId: GrammarId;

  /** File extensions (with leading dot, lowercase) this handler claims.
   *  Used by `walkSource` to decide whether a file is a source file at
   *  all (separate from the grammar map, which is the next-level
   *  decision once we've decided to parse). Languages that share a
   *  handler instance contribute different `extensions` arrays via
   *  multiple registrations.
   *
   *  Example: TS handler registered as
   *    grammarId='typescript', extensions=['.ts']
   *    grammarId='tsx',        extensions=['.tsx', '.jsx']
   *    grammarId='javascript', extensions=['.js', '.mjs', '.cjs']  */
  readonly extensions: readonly string[];

  // --------------------------------------------------------------------
  // File-level extraction (one file's AST → one file's worth of data)
  // --------------------------------------------------------------------

  /** Reviewable symbols (functions, classes, methods, exported consts,
   *  synthetic imports/filler blocks) for one file. The handler is
   *  responsible for emitting both AST-derived symbols AND any
   *  synthetic blocks (imports header, filler over uncovered lines)
   *  that the chip view's "1:1 file coverage" guarantee relies on.
   *
   *  May do multi-pass internally — Go re-parents method_declaration
   *  to its receiver's type_declaration, Rust attaches `impl` block
   *  methods to their host struct/enum. The interface doesn't expose
   *  a separate post-process hook; it's the handler's private business. */
  extractSymbols(root: Node, source: string): ExtractedSymbol[];

  /** Both shapes of file-level import data, in one walk. See
   *  `ImportExtraction` jsdoc for what each output covers and which
   *  downstream consumer it feeds. */
  extractImports(root: Node): ImportExtraction;

  /** Every callsite in the file, attributed to its enclosing symbol.
   *  The `symbols` argument is the already-flattened symbol list for
   *  this file — needed because attribution requires the line-range
   *  index to map each callsite back to its caller function. Resolving
   *  the callee to a target is `resolveCall`'s job, not this one. */
  extractCallSites(root: Node, symbols: IndexedSymbol[]): RawCall[];

  // --------------------------------------------------------------------
  // Project-level (called once per index after all files parsed)
  // --------------------------------------------------------------------

  /** Build handler-private project state. Called once per `buildIndex`
   *  invocation, AFTER every file has been listed but BEFORE per-file
   *  resolution starts (so that per-file `resolveSpecifier` /
   *  `resolveCall` calls can rely on this context being ready).
   *
   *  Output is opaque to the rest of the pipeline
   *  (`ProjectContext = unknown`); the same value is threaded back
   *  into every subsequent `resolveSpecifier` / `resolveCall` /
   *  `moduleForFile` call. Most handlers stash `cwd` inside the
   *  context too, so the resolution methods don't need it as a
   *  separate argument.
   *
   *  May be async — TS reads tsconfigs and workspace package.jsons,
   *  Rust will read Cargo.toml and walk lib.rs/main.rs.
   *
   *  Languages that don't need project-level state return `undefined`
   *  (Python returns a small struct for `pythonRoots`, but a no-op
   *  language could just return `undefined`). */
  buildProjectContext(
    cwd: string,
    fileSet: ReadonlySet<string>,
  ): Promise<ProjectContext> | ProjectContext;

  // --------------------------------------------------------------------
  // Resolution (called many times during graph build)
  // --------------------------------------------------------------------

  /** Resolve an import spec string to a project-relative file path.
   *  Returns `null` if the spec references something outside the
   *  project (npm package, system include, vendored crate, …) — the
   *  caller treats null as "external" and downstream `resolveCall`
   *  returns a `'external'` CallResolution.
   *
   *  Each language's path semantics are completely different:
   *    JS/TS:  relative paths + tsconfig aliases + workspace exports +
   *            extension fallback (.ts / .tsx / index.ts / .js)
   *    Python: dotted names + relative dots + __init__.py
   *    Go:     module path prefix vs std lib / external
   *    Rust:   mod tree path vs use alias vs external crate
   *
   *  `fileSet` is the set of project files (post-walkSource filter) —
   *  the handler validates its computed path is in the set before
   *  returning. */
  resolveSpecifier(
    spec: string,
    fromFilePath: string,
    ctx: ProjectContext,
    fileSet: ReadonlySet<string>,
  ): string | null;

  /** Resolve one callsite to its target(s) — the central per-language
   *  decision point. Combines all the language's resolution rules
   *  (local-shadows-import, member chain dispatch, reexport chain
   *  following, trait dispatch) behind a single returns-a-tagged-union
   *  facade.
   *
   *  Returns an ARRAY of resolutions because some languages emit
   *  multiple edges for one call site:
   *    - JS/TS: ambiguous bare name `foo()` may match multiple local
   *      symbols (one bare function + a same-named method on a class)
   *      — without type info we emit edges to both candidates.
   *    - Rust: `obj.method()` may match multiple `impl` blocks for the
   *      same trait — best-effort lists all candidates.
   *
   *  Empty array = total resolution failure (no pin rendered). Most
   *  call sites resolve to exactly one entry. */
  resolveCall(
    call: RawCall,
    from: IndexedSymbol,
    fromFile: IndexedFile,
    allFiles: ReadonlyMap<string, IndexedFile>,
    ctx: ProjectContext,
  ): CallResolution[];

  // --------------------------------------------------------------------
  // Module assignment (high-level module-graph view, not call graph)
  // --------------------------------------------------------------------

  /** Logical module name for a file — used by the higher-level
   *  module-graph visualization (one node per logical module, edges
   *  aggregated from per-file `importedFiles` after passing through
   *  `moduleForFile`). The exact form is up to the handler:
   *
   *    JS/TS:  folder fallback (depth ≤ 3) or workspace package name
   *    Python: dotted package path (`a.b.c`)
   *    Go:     full package import path
   *    Rust:   `crate::foo::bar` or crate name */
  moduleForFile(filePath: string, ctx: ProjectContext): string;
}
