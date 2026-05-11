/**
 * Code Map types — single-file "chip" view.
 *
 * The Code Map renders the focal file as one rectangular IC package.
 * Inside the package every function-like symbol is shown as a small
 * code window (full syntax-highlighted source), with intra-file calls
 * drawn as wires between them. External callers and callees become
 * pin labels on the package's left and right edges respectively, so
 * the file's "interface to the world" is visible at a glance.
 *
 * All data needed for the view is computed server-side once per cwd
 * and cached in `CodeIndex`. The client just lays out the chip from
 * the projection — no second round trip per focal change.
 */
import type { ExtractedSymbol, SymbolKind } from '../types';

// ============================================================================
// Function-level building blocks
// ============================================================================

/** A function-like symbol — what the Code Map renders as a call-graph
 *  node. Function / class / method only; types/interfaces/consts are
 *  filtered out at the projection layer because they have no call
 *  semantics worth visualising. */
export interface FunctionNode {
  /** Project-relative path of the file this symbol lives in. */
  filePath: string;
  /** Stable in-file id: parent symbols joined by `>` (`MyClass>render`). */
  qualifiedName: string;
  /** Bare name (`render`). */
  name: string;
  /** `function | class | method`. */
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  /** Parameter names for callables (function | method). Surfaced in
   *  the chip header as `name(p1, p2, …)` so reviewers can read a
   *  function's shape without scrolling into the body. Names only —
   *  type annotations and default values stripped at extraction time;
   *  destructured patterns kept verbatim (`{a, b}`).
   *
   *  Undefined for non-callable kinds (class | interface | type | enum
   *  | const) and for languages our extractor doesn't grok. Empty
   *  array means "0 params" (chip header still renders `()`). See
   *  `ExtractedSymbol.params` for the source-of-truth definition. */
  params?: string[];
}

// ============================================================================
// File mode (the only mode — chip view)
// ============================================================================

/**
 * A cross-file call edge between an external function and one of the
 * focal file's functions. Direction is implied by which list it appears
 * in (`upstreamCalls` = `external → focal`, `downstreamCalls` = `focal
 * → external`). The `external` neighbour carries everything the canvas
 * needs to render its node; `focalQname` ties it back to a specific
 * member of `functions[]` for edge routing.
 */
export interface CrossFileCallEdge {
  /** Function in another file participating in this edge. */
  external: FunctionNode;
  /** qualifiedName of the focal-file function on the other end. */
  focalQname: string;
  /** 1-based call-site lines.
   *  - downstream: lines in the focal file (where focal calls external).
   *  - upstream:   lines in the external file (where external calls focal).
   *  Multiple entries when the same edge is exercised from multiple sites
   *  (we dedupe edges, but keep every call site so the client can render
   *  one pin per edge anchored to the first line, and surface the rest
   *  via tooltip). Sorted ascending. Always at least one entry. */
  lines: number[];
}

/**
 * A call into an EXTERNAL module — anything whose import specifier
 * doesn't resolve to a project file. Typically npm packages
 * (`'react'`, `'ai'`, `'@anthropic/sdk'`), but also unresolved aliases
 * or workspace packages we couldn't find. Surfaced separately because
 * we have no FunctionNode for the target — no filePath, no startLine,
 * no neighbours of our own — just a name and a package spec.
 *
 * Renders as a muted "EXT" pin in chip view: visibility-only, no
 * navigation (the function lives outside our index). Click flashes
 * the focal file's `__imports__` block so the user can see where the
 * binding entered the file.
 */
export interface ExternalCallEdge {
  external: {
    /** Function name as imported (the `importedName` of the binding). */
    name: string;
    /** Module specifier — e.g. `'ai'`, `'@anthropic/sdk'`, or any
     *  unresolved alias / spec the resolver couldn't map to a file. */
    packageSpec: string;
  };
  /** qualifiedName of the focal-file function making the calls. Same
   *  rolled-up-to-top-level treatment as CrossFileCallEdge. */
  focalQname: string;
  /** 1-based call-site lines IN THE FOCAL FILE. Right-column pins
   *  align to `lines[0]` like cross-file out pins do. */
  lines: number[];
}

/**
 * "We saw a call but couldn't pin it to a definition" — receiver-based
 * fallback edge.
 *
 * Emitted when ALL of these hold:
 *   - The callsite is a member-expression call: `obj.method()` shape.
 *   - `obj` (the receiver root) is an import binding to a PROJECT file
 *     (not external, not a local var, not a built-in like `console`).
 *   - We could not find a function-like symbol named `method` (or
 *     `<importedName>>method`) inside that project file's symbol tree
 *     — typical reasons: object literal whose Tier 2 extraction
 *     missed it, instance method on a typed property, dynamic dispatch.
 *
 * Surfaced as a muted "METHOD" pin in chip view: visibility-only, no
 * navigation target — we know the receiver's home file but not the
 * specific definition. Click flashes the focal file's `__imports__`
 * block so the user can see where `obj` entered scope.
 *
 * Calls whose receiver root is external / built-in / unknown-local are
 * silently dropped — no pin emitted (would just be noise).
 */
export interface MethodCallEdge {
  /** qualifiedName of the focal-file function making the call. */
  focalQname: string;
  /** Local name of the receiver as written in the source — e.g. `obj`,
   *  `config`, `Logger`. Display label uses this. */
  receiverName: string;
  /** Method name (the leaf of the member chain). Together with
   *  `receiverName` forms the chip label `receiverName.methodName`. */
  methodName: string;
  /** Project file the receiver was imported from. Surfaced only as
   *  context (tooltip / debug); navigation flashes the focal file's
   *  imports block, NOT this file. */
  receiverFilePath: string;
  /** 1-based call-site lines IN THE FOCAL FILE. Right-column pins
   *  align to `lines[0]`. */
  lines: number[];
}

/**
 * Same-file call edge between two top-level functions in the focal file.
 * Surfaced separately from `CrossFileCallEdge` so the client can decide
 * whether (and how) to render intra-file pins — historically these were
 * dropped on the floor, but they're useful for "what does this function
 * call locally?" navigation.
 */
export interface IntraCallEdge {
  /** qualifiedName of the caller (top-level) in the focal file. */
  from: string;
  /** qualifiedName of the callee (top-level) in the focal file. */
  to: string;
  /** 1-based call-site lines in the focal file (inside the caller's body).
   *  Sorted ascending. Always at least one entry. */
  lines: number[];
}

export interface FileFunctionsResponse {
  filePath: string;
  language: string;
  fileCount: number;
  /** Modification time of the focal file at the moment the projection
   *  was computed (`fs.stat().mtimeMs`, ms since epoch). Lets the
   *  client cross-check against `/api/files/text`'s mtime — if the
   *  fileSource is newer than the data here, the client triggers a
   *  refresh. Server itself uses this to gate per-file re-parse via
   *  `refreshFocalFile`. May be 0 for synthetic responses (markdown
   *  chunked / unsupported-language fallback) where there's no
   *  IndexedFile entry to read mtime from — in those cases the
   *  client's freshness check is a no-op. */
  mtimeMs: number;
  /** All function-like symbols in the focal file, ordered by source line. */
  functions: FunctionNode[];
  /** Calls within the focal file. Both endpoints are qualifiedName
   *  references into `functions[]` (anything non-function-like is
   *  filtered out server-side). */
  intraCalls: IntraCallEdge[];
  /** External callees — calls into npm / unresolved packages. Drawn
   *  on the RIGHT next to (or interleaved with) cross-file callees,
   *  visually distinguished as "EXT" pins. Visibility-only. */
  externalCalls: ExternalCallEdge[];
  /** Method-call fallback edges — `obj.method()` whose receiver root
   *  resolves to a project file but whose method couldn't be located.
   *  Surfaced as muted "METHOD" pins, visibility-only. */
  methodCalls: MethodCallEdge[];
  /** Cross-file callers — functions in OTHER files that call into
   *  the focal file. Drawn on the LEFT of the focal column. */
  upstreamCalls: CrossFileCallEdge[];
  /** Cross-file callees — functions in OTHER files that the focal
   *  file's functions call. Drawn on the RIGHT of the focal column. */
  downstreamCalls: CrossFileCallEdge[];
}

// ============================================================================
// File detail (drawer payload)
// ============================================================================

/**
 * Symbol-tree response for a single file. Powers the function drawer
 * (which renders symbol bodies) when the user expands a function node.
 */
export interface FileDetailResponse {
  filePath: string;
  language: string;
  /** Hierarchical symbol tree (functions, classes, methods …). */
  symbols: ExtractedSymbol[];
}

// ============================================================================
// Search
// ============================================================================

/**
 * Cmd+K palette result.
 *
 *   - File hits switch to file-mode at that file.
 *   - Symbol hits switch to function-mode at that (file, qname).
 *     `qualifiedName` is needed because the line alone doesn't uniquely
 *     identify the symbol (think methods that share a name with the
 *     class's surrounding initialiser line).
 */
export interface SearchHit {
  type: 'file' | 'symbol';
  /** Display label. */
  label: string;
  /** Secondary line for the result. */
  hint?: string;
  target:
    | { kind: 'file'; filePath: string }
    | {
        kind: 'symbol';
        filePath: string;
        line: number;
        symbolName: string;
        symbolKind: SymbolKind;
        qualifiedName: string;
      };
}

export interface SearchResponse {
  files: SearchHit[];
  symbols: SearchHit[];
}
