/**
 * Code Map types — symbol-level change representation for review.
 *
 * A "Symbol" here is a meaningful named unit a human reviews:
 * functions, classes, methods, exported consts. NOT every AST node.
 *
 * The diff layer compares before/after symbols by (qualified name) and
 * marks each as added / deleted / modified / unchanged based on content hash.
 */

export type SymbolKind =
  | 'function'   // function foo() {} | const foo = () => {} | export default function
  | 'class'      // class Foo {}
  | 'method'     // foo() {} inside class
  | 'interface'  // TypeScript interface
  | 'type'       // TypeScript type alias
  | 'enum'       // TypeScript enum
  | 'const'      // exported top-level const (non-function)
  | 'unknown';

/**
 * The kinds the Code Map treats as call-graph nodes — i.e. symbols
 * that can have callers / callees and that the chip pin layout
 * actually wires up. Deliberately excludes `interface | type | enum |
 * const` (compile-time only, no runtime behaviour) and `unknown`
 * (synthetic chunks like `__imports__` / `__code_*__` that the chip
 * canvas needs but the call graph doesn't).
 *
 * Single source of truth — read by:
 *   - `isFunctionLike` in `projectGraph/codeIndex.ts` (cross-file
 *     edge resolution: skip non-function-like targets)
 *   - `FileTOCSection` (TOC filter so the file index lists only
 *     traceable units, matching what the call-graph itself thinks)
 *
 * Keep this in `types.ts` rather than `codeIndex.ts` so the constant
 * stays importable from `'use client'` components — `codeIndex.ts`
 * pulls in `node:fs/promises`, which webpack would otherwise bundle
 * into the browser.
 */
export const FUNCTION_LIKE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'function',
  'class',
  'method',
]);

export function isFunctionLike(s: { kind: SymbolKind }): boolean {
  return FUNCTION_LIKE_KINDS.has(s.kind);
}

/** A symbol extracted from one snapshot of a file. */
export interface ExtractedSymbol {
  /** Unique within a file: parent path joined by `>`, e.g. `MyClass>render`. Used as match key for diffing. */
  qualifiedName: string;
  /** Bare name without parent path, e.g. `render`. */
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive — line where the symbol starts in this snapshot. */
  startLine: number;
  /** 1-based, inclusive — line where the symbol ends. */
  endLine: number;
  /** Hash of the symbol's normalized text. Used to detect modification. */
  contentHash: string;
  /** Children (e.g. methods inside a class). Empty for leaves. */
  children: ExtractedSymbol[];
  /** Parameter names for callable symbols (kind = function | method).
   *  Surfaced in the chip header so the reviewer sees a function's
   *  shape at a glance — `loginHandler(req, res, next)` — without
   *  having to scroll into the body for the signature.
   *
   *  Names ONLY: type annotations and default values are stripped at
   *  extraction time. Destructured patterns are kept verbatim
   *  (`{a, b}`, `[x, y]`) so the displayed list matches source order
   *  and the reviewer can still recognise destructuring.
   *
   *  Undefined when:
   *    - the symbol isn't a callable (class | interface | type | enum
   *      | const | unknown filler / imports block)
   *    - the language doesn't have a tree-sitter grammar in our
   *      extractor (we silently skip rather than guess)
   *    - the function has no `parameters` field on its AST node
   *
   *  Empty array means "0 params" — chip header still renders `()`,
   *  which distinguishes "no params" from "unknown / unsupported". */
  params?: string[];
}

/* Note: the legacy `SymbolChange` / `FileSymbolDiff` / `SymbolChangeKind`
 * types lived here to support the deprecated ChangesView (status →
 * symbol-level diff). The chip's Block diff mode (DiffView ↔ BlockDiffViewer)
 * has its own narrower diff data that lives in its own component file —
 * keeping a separate type made these ones dead weight. Removed. */
