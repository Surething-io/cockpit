/**
 * Extract reviewable symbols from a tree-sitter AST.
 *
 * "Reviewable" symbols are the units a human reads code at:
 * functions, classes (with their methods nested), interfaces, types,
 * enums, and exported top-level consts. Random expressions and
 * private internals are intentionally NOT extracted — they show up
 * via line-level diff inside their parent symbol.
 *
 * The extractor is intentionally tolerant of grammar variations across
 * TypeScript / TSX / JavaScript — it dispatches on `node.type` strings
 * shared across these grammars, and silently ignores nodes it doesn't
 * understand. tree-sitter's error-recovery means partially-broken code
 * still produces useful symbol structure.
 */

import type { Node } from 'web-tree-sitter';
import type { ExtractedSymbol, SymbolKind } from './types';

// ============================================================================
// Hash — cyrb53, a fast non-crypto hash. Used to detect "modified" symbols by
// comparing the trimmed text of before/after. Hex string for readability.
// ============================================================================

export function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((4294967296 * (2097151 & h2) + (h1 >>> 0)) >>> 0).toString(16);
}

/** Normalize whitespace so cosmetic reformatting doesn't trigger "modified". */
export function normalizeForHash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Helpers
// ============================================================================

function qualify(parent: string | undefined, name: string): string {
  return parent ? `${parent}>${name}` : name;
}

function nameOf(node: Node): string {
  const named = node.childForFieldName('name');
  if (named) return named.text;
  // Fallback: scan children for an `identifier` / `type_identifier`.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier')) {
      return c.text;
    }
  }
  return '<anonymous>';
}

function makeSymbol(
  node: Node,
  name: string,
  kind: SymbolKind,
  parentQname: string | undefined,
  children: ExtractedSymbol[] = [],
  params?: string[],
): ExtractedSymbol {
  return {
    qualifiedName: qualify(parentQname, name),
    name,
    kind,
    // tree-sitter rows are 0-based; we expose 1-based for UI alignment.
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    contentHash: hashText(normalizeForHash(node.text)),
    children,
    params,
  };
}

// ============================================================================
// Parameter extraction
// ============================================================================

/**
 * Reduce one parameter AST node to its bare name (or pattern, for
 * destructuring). Type annotations, default values, and TS modifiers
 * are stripped — we only want what the chip header should show.
 *
 * Cases:
 *   - `identifier`                          → name as-is
 *   - `rest_pattern`                        → `...rest` text as-is
 *   - `object_pattern` / `array_pattern`    → full pattern text (e.g. `{a, b}`)
 *   - TS `required_parameter` / `optional_parameter`
 *                                           → recurse into `pattern` field
 *                                             (drops type annotation)
 *   - JS `assignment_pattern` (`x = 5`)     → recurse into `left` field
 *                                             (drops default value)
 *   - Python `default_parameter` (`x=5`)    → `name` field
 *   - Python `typed_parameter` (`x: int`)   → first identifier child
 *   - Python `typed_default_parameter`      → `name` field
 *   - Python `list_splat_pattern` (`*args`) / `dictionary_splat_pattern` (`**kw`)
 *                                           → text as-is (preserves splat sigils)
 *   - anything else                         → text as-is (best-effort)
 */
function paramText(p: Node): string {
  switch (p.type) {
    case 'required_parameter':
    case 'optional_parameter': {
      // TypeScript: name binding lives in the `pattern` field; the
      // `type` field carries the annotation we want to drop.
      const pat = p.childForFieldName('pattern');
      return pat ? paramText(pat) : p.text;
    }
    case 'assignment_pattern': {
      // JS/TS: `(x = 5)` → strip the default expression.
      const left = p.childForFieldName('left');
      return left ? paramText(left) : p.text;
    }
    case 'default_parameter':
    case 'typed_default_parameter': {
      // Python: `x=5` / `x: int = 5` — drop both annotation and default.
      const name = p.childForFieldName('name');
      return name ? name.text : p.text;
    }
    case 'typed_parameter': {
      // Python: `x: int` — first identifier child is the name.
      for (let i = 0; i < p.namedChildCount; i++) {
        const c = p.namedChild(i);
        if (c?.type === 'identifier') return c.text;
      }
      return p.text;
    }
    // Identifiers, splat patterns, destructuring patterns — text as-is.
    default:
      return p.text;
  }
}

/**
 * Pull the parameter-name list off any callable AST node. Returns
 * `undefined` when there's no `parameters` field at all (filler
 * blocks, languages our extractor doesn't grok, weird AST shapes).
 * Returns `[]` for genuine zero-param callables — the UI uses this to
 * render `()` and distinguish "0 params" from "unknown".
 *
 * Handles two arrow-function shapes:
 *   - `(x, y) => …` — full `parameters` field with formal_parameters
 *   - `x => …`     — `parameter` field (singular) with a bare identifier
 */
function extractParams(fnNode: Node): string[] | undefined {
  // Single-parameter arrow shorthand: `x => …` has no formal_parameters
  // wrapper — tree-sitter exposes the bare identifier via the singular
  // `parameter` field.
  const single = fnNode.childForFieldName('parameter');
  if (single) return [single.text];

  const params = fnNode.childForFieldName('parameters');
  if (!params) return undefined;

  const out: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (!p) continue;
    out.push(paramText(p));
  }
  return out;
}

// ============================================================================
// Per-kind extraction
// ============================================================================

/**
 * Extract methods from a class body. Class body is the `class_body` node.
 * We support `method_definition`, and `public_field_definition` whose value
 * is an arrow/function (the "() => {}" field method pattern).
 */
function extractClassMembers(body: Node | null, parentQname: string): ExtractedSymbol[] {
  if (!body) return [];
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const m = body.namedChild(i);
    if (!m) continue;
    if (m.type === 'method_definition') {
      out.push(
        makeSymbol(m, nameOf(m), 'method', parentQname, [], extractParams(m)),
      );
    } else if (m.type === 'public_field_definition') {
      const value = m.childForFieldName('value');
      if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
        // Arrow-as-field methods carry params on the value node, not
        // the field-definition wrapper.
        out.push(
          makeSymbol(m, nameOf(m), 'method', parentQname, [], extractParams(value)),
        );
      }
    }
  }
  return out;
}

/**
 * Handle `const foo = () => {}` (function-valued) and `const x = expr`
 * (any other top-level variable declaration). Every declarator yields a
 * symbol — the Code Map's chip view treats every module-level binding
 * as its own architectural block, whether it's exported or not. The
 * `isExported` flag is preserved on the call site for future use but
 * no longer gates symbol emission.
 *
 * Non-function consts (`const VERSION = '1.0'`, `const router =
 * Router()`, `let counter = 0`, …) become their own blocks below the
 * imports block. Calls inside their initialisers attribute to them —
 * `const router = createRouter()` records a `router → createRouter`
 * edge.
 */
function extractFromLexical(
  decl: Node,
  parentQname: string | undefined,
  // Kept for symmetry with extractFromNode's signature; currently unused
  // but a future "public API only" filter could re-introduce gating.
  _isExported: boolean,
): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < decl.namedChildCount; i++) {
    const declarator = decl.namedChild(i);
    if (!declarator || declarator.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode) continue;

    const name = nameNode.text;
    const isFn =
      valueNode &&
      (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression');

    // Params come off the value node (the arrow / function-expression),
    // never the wrapper `decl` — multiple declarators in one
    // `const a = …, b = …` would otherwise share the first one's params.
    const params = isFn && valueNode ? extractParams(valueNode) : undefined;
    out.push(
      makeSymbol(
        decl,
        name,
        isFn ? 'function' : 'const',
        parentQname,
        [],
        params,
      ),
    );

    // Tier 2: object-literal property-method flattening.
    //
    // Pattern: `const api = { fetchUser: () => {...}, save: function () {...} }`
    // We emit a method symbol per function-valued property under qname
    // `<parent.>api>fetchUser`. The chip view doesn't render `>` symbols
    // as their own blocks (they roll up to the parent for display) —
    // these symbols exist for the call resolver only, so a callsite
    // `api.fetchUser()` can find a real definition rather than dying as
    // an unresolvable METHOD pin.
    //
    // Shorthand methods (`{ foo() {} }`) and arrow / function-expression
    // pair values (`{ foo: () => {} }`) are both handled. Computed keys
    // and spread elements are skipped — they have no stable name.
    if (valueNode && valueNode.type === 'object' && !isFn) {
      const childParent = parentQname ? `${parentQname}>${name}` : name;
      for (let j = 0; j < valueNode.namedChildCount; j++) {
        const prop = valueNode.namedChild(j);
        if (!prop) continue;
        if (prop.type === 'pair') {
          const keyNode = prop.childForFieldName('key');
          const valNode = prop.childForFieldName('value');
          if (!keyNode || !valNode) continue;
          if (
            keyNode.type !== 'property_identifier' &&
            keyNode.type !== 'identifier'
          ) {
            continue;
          }
          if (
            valNode.type !== 'arrow_function' &&
            valNode.type !== 'function_expression'
          ) {
            continue;
          }
          out.push(
            makeSymbol(
              prop,
              keyNode.text,
              'method',
              childParent,
              [],
              extractParams(valNode),
            ),
          );
        } else if (prop.type === 'method_definition') {
          // `{ foo() {} }` shorthand
          const propName = nameOf(prop);
          if (propName) {
            out.push(
              makeSymbol(prop, propName, 'method', childParent, [], extractParams(prop)),
            );
          }
        }
      }
    }
  }
  return out;
}

// ============================================================================
// Top-level dispatcher
// ============================================================================

/**
 * Extract symbols from one node. Dispatches on node.type.
 * `parentQname` is undefined for top-level. `isExported` is true if the
 * caller is an export_statement unwrapping its inner declaration.
 */
function extractFromNode(
  node: Node,
  parentQname: string | undefined,
  isExported = false,
): ExtractedSymbol[] {
  switch (node.type) {
    case 'export_statement':
    case 'export_default_declaration': {
      // Unwrap. The inner declaration is the first named child in practice.
      const out: ExtractedSymbol[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const inner = node.namedChild(i);
        if (inner) out.push(...extractFromNode(inner, parentQname, true));
      }
      return out;
    }

    case 'function_declaration':
    case 'generator_function_declaration': {
      return [
        makeSymbol(node, nameOf(node), 'function', parentQname, [], extractParams(node)),
      ];
    }

    case 'class_declaration':
    case 'abstract_class_declaration': {
      const className = nameOf(node);
      const qname = qualify(parentQname, className);
      const body = node.childForFieldName('body');
      const members = extractClassMembers(body, qname);
      return [makeSymbol(node, className, 'class', parentQname, members)];
    }

    case 'interface_declaration': {
      return [makeSymbol(node, nameOf(node), 'interface', parentQname)];
    }

    case 'type_alias_declaration': {
      return [makeSymbol(node, nameOf(node), 'type', parentQname)];
    }

    case 'enum_declaration': {
      return [makeSymbol(node, nameOf(node), 'enum', parentQname)];
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      return extractFromLexical(node, parentQname, isExported);
    }

    // ---- Python ------------------------------------------------------------
    case 'function_definition': {
      // `def foo(): ...`. parentQname is undefined at module level; for
      // class members we recurse from `extractClassMembers`-equivalent
      // (nested calls below).
      return [
        makeSymbol(node, nameOf(node), 'function', parentQname, [], extractParams(node)),
      ];
    }

    case 'class_definition': {
      const className = nameOf(node);
      const qname = qualify(parentQname, className);
      const body = node.childForFieldName('body');
      const members = extractPythonClassMembers(body, qname);
      return [makeSymbol(node, className, 'class', parentQname, members)];
    }

    case 'decorated_definition': {
      // `@decorator\ndef foo(): ...` or `@decorator\nclass Foo: ...`.
      // The inner `definition` field carries the actual function/class
      // node; we extract from that but use the OUTER node's line range
      // (so the block visually includes the decorator lines).
      const inner = node.childForFieldName('definition');
      if (!inner) return [];
      const innerSymbols = extractFromNode(inner, parentQname, false);
      // Re-project line range to span the decorator(s) too. We only ever
      // produce a single symbol here, but iterate for safety.
      return innerSymbols.map((s) => ({
        ...s,
        startLine: node.startPosition.row + 1,
        // Re-hash from the decorated text so contentHash captures the
        // decorator change too. The simplest form: hash the outer node.
        contentHash: hashText(normalizeForHash(node.text)),
      }));
    }

    case 'expression_statement': {
      // Two roles for `expression_statement`:
      //   (1) JS/TS: labelled call statements with anonymous function
      //       arguments (route handlers, event listeners). Handled by
      //       `extractFromCallStatement`.
      //   (2) Python: top-level assignments live INSIDE expression_statement
      //       wrappers (`expression_statement → assignment`). We surface the
      //       assigned name as a `const` block, mirroring TS `const` extraction.
      const out: ExtractedSymbol[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c?.type === 'assignment') {
          const sym = extractPythonAssignment(node, c, parentQname);
          if (sym) out.push(sym);
        }
      }
      // Fall back to the JS/TS handler so `router.post("/x", () => {})`
      // still produces a route-handler symbol on .ts files.
      out.push(...extractFromCallStatement(node, parentQname));
      return out;
    }

    default:
      return [];
  }
}

/**
 * Extract anonymous-function arguments from a top-level call expression.
 *
 * Triggers on patterns like:
 *   - `router.post("/path", async (req, res) => { … })`
 *   - `app.get("/path", handler, (req, res) => { … })`
 *   - `el.addEventListener("click", e => { … })`
 *   - `bus.on("event:name", () => { … })`
 *
 * We require a string-literal first argument to act as the symbol's name —
 * without it the call could be `arr.map(x => x.foo)` / `Promise.then(...)`
 * etc. and we'd flood the symbol list with low-value anonymous nodes. The
 * string label gives the handler a meaningful name (`post /send-by-email`,
 * `addEventListener click`) that's stable across reads.
 *
 * Multiple function arguments to the same call (rare but possible — middleware
 * arrays inline) are emitted as separate symbols suffixed `#1`, `#2`, … so
 * qualifiedNames stay unique within the file.
 */
function extractFromCallStatement(
  node: Node,
  parentQname: string | undefined,
): ExtractedSymbol[] {
  // expression_statement → [await_expression →]? call_expression
  let call: Node | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'call_expression') {
      call = c;
      break;
    }
    if (c.type === 'await_expression') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const inner = c.namedChild(j);
        if (inner?.type === 'call_expression') {
          call = inner;
          break;
        }
      }
      break;
    }
  }
  if (!call) return [];

  const callee = call.childForFieldName('function');
  const args = call.childForFieldName('arguments');
  if (!callee || !args) return [];

  let label: string | null = null;
  const fnArgs: Node[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg) continue;
    if (label === null && (arg.type === 'string' || arg.type === 'template_string')) {
      const t = arg.text;
      // Strip surrounding quotes/backticks if present.
      label = t.length >= 2 && /^["'`]/.test(t) ? t.slice(1, -1) : t;
    }
    if (arg.type === 'arrow_function' || arg.type === 'function_expression') {
      fnArgs.push(arg);
    }
  }

  // Skip when there's no labelling string — too noisy otherwise.
  if (fnArgs.length === 0 || !label) return [];

  const calleeName = leafCalleeName(callee);
  const baseName = calleeName ? `${calleeName} ${label}` : label;
  return fnArgs.map((fnArg, i) =>
    makeSymbol(
      fnArg,
      fnArgs.length > 1 ? `${baseName} #${i + 1}` : baseName,
      'function',
      parentQname,
      [],
      extractParams(fnArg),
    ),
  );
}

/**
 * Extract methods (and nested classes) from a Python `class_definition`'s
 * body. The body is a `block` node whose children are statements: each
 * `function_definition` / `decorated_definition` becomes a method symbol.
 * Plain `expression_statement` (e.g. class-level docstrings or attribute
 * assignments) is skipped — we want callable members only, mirroring how
 * `extractClassMembers` handles TS classes.
 */
function extractPythonClassMembers(body: Node | null, parentQname: string): ExtractedSymbol[] {
  if (!body) return [];
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const m = body.namedChild(i);
    if (!m) continue;
    if (m.type === 'function_definition') {
      out.push(
        makeSymbol(m, nameOf(m), 'method', parentQname, [], extractParams(m)),
      );
    } else if (m.type === 'decorated_definition') {
      const inner = m.childForFieldName('definition');
      if (inner?.type === 'function_definition') {
        // Use outer (decorated) range for line span; standard makeSymbol
        // hashing then captures any decorator change. Params come off
        // the inner function node — decorators don't reshape them.
        out.push({
          ...makeSymbol(inner, nameOf(inner), 'method', parentQname, [], extractParams(inner)),
          startLine: m.startPosition.row + 1,
          contentHash: hashText(normalizeForHash(m.text)),
        });
      } else if (inner?.type === 'class_definition') {
        // Nested class — extract recursively. Use a synthetic class
        // member entry for symmetry with class_definition handling.
        const innerName = nameOf(inner);
        const innerQname = qualify(parentQname, innerName);
        const innerBody = inner.childForFieldName('body');
        const nested = extractPythonClassMembers(innerBody, innerQname);
        out.push({
          ...makeSymbol(inner, innerName, 'class', parentQname, nested),
          startLine: m.startPosition.row + 1,
          contentHash: hashText(normalizeForHash(m.text)),
        });
      }
    } else if (m.type === 'class_definition') {
      // Inner class without decorator.
      const innerName = nameOf(m);
      const innerQname = qualify(parentQname, innerName);
      const innerBody = m.childForFieldName('body');
      const nested = extractPythonClassMembers(innerBody, innerQname);
      out.push(makeSymbol(m, innerName, 'class', parentQname, nested));
    }
  }
  return out;
}

/**
 * Surface a top-level Python assignment as a `const` block.
 *
 * Python assignments live inside `expression_statement` wrappers:
 *   `expression_statement → assignment`. We only handle the trivial
 *   `IDENTIFIER = expr` form — `tuple_pattern`, `attribute`, `subscript`
 *   left-hand sides aren't name bindings in our sense, so they fall
 *   through to filler-block coverage.
 *
 * The block range is taken from the OUTER `expression_statement` so the
 * trailing newline / semicolon (rare in Python) is included.
 */
function extractPythonAssignment(
  outer: Node,
  assignment: Node,
  parentQname: string | undefined,
): ExtractedSymbol | null {
  const lhs = assignment.childForFieldName('left');
  if (!lhs || lhs.type !== 'identifier') return null;
  const name = lhs.text;
  return {
    qualifiedName: qualify(parentQname, name),
    name,
    kind: 'const',
    startLine: outer.startPosition.row + 1,
    endLine: outer.endPosition.row + 1,
    contentHash: hashText(normalizeForHash(outer.text)),
    children: [],
  };
}

/** The "rightmost" identifier in a call-expression callee. For `foo()` it's
 *  `foo`; for `router.post()` it's `post`; for chained calls we keep walking
 *  inward. Returns empty string if we can't find a usable name. */
function leafCalleeName(node: Node): string {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property');
    return prop?.text ?? '';
  }
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    return fn ? leafCalleeName(fn) : '';
  }
  return '';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Synthesise a block representing the file's import / re-export header.
 *
 * The Code Map's chip view shows top-level symbols as code blocks; the
 * import section at the top of a file isn't a "symbol" in any normal
 * sense, but it IS architecturally important (the file's external
 * surface area), so we emit a synthetic ExtractedSymbol covering it.
 *
 * Boundary detection: scan top-level statements in source order; collect
 * contiguous `import_statement` nodes plus `export_statement` nodes that
 * have a `source` field (those are re-exports — `export { x } from
 * './y'` / `export * from './y'`). Stop at the first non-header statement.
 *
 * Range: from the FIRST header statement's start line to the LAST one's
 * end line. Anything before the first import (file-level docstrings,
 * `'use client'` directives) lands in a filler block instead — that
 * keeps the imports block from overlapping random pre-import code.
 */
function extractImportHeader(rootNode: Node): ExtractedSymbol | null {
  const headerNodes: Node[] = [];
  let firstLine = -1;
  let lastLine = -1;
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const c = rootNode.namedChild(i);
    if (!c) continue;
    const isHeader =
      // JS/TS: `import X from 'y'`, `import 'y'`
      c.type === 'import_statement' ||
      // JS/TS: `export { x } from './y'` (re-export with `source` field)
      (c.type === 'export_statement' && c.childForFieldName('source') !== null) ||
      // Python: `from x import y` / `from .x import y`
      c.type === 'import_from_statement' ||
      // Python: `import x` / `import x.y as z`
      c.type === 'future_import_statement';
    if (isHeader) {
      headerNodes.push(c);
      if (firstLine < 0) firstLine = c.startPosition.row + 1;
      lastLine = c.endPosition.row + 1;
    } else if (firstLine >= 0) {
      // We've entered the header block; the first non-header statement
      // closes it. Anything afterwards is regular extraction territory.
      break;
    }
    // Pre-header non-imports (directives, leading comments, etc.) are
    // skipped here and picked up by the filler-block pass.
  }
  if (firstLine < 0) return null;
  // Hash the concatenated text of header statements so before/after
  // snapshots register a real change when imports rotate.
  const text = headerNodes.map((n) => n.text).join('\n');
  return {
    qualifiedName: '__imports__',
    name: 'imports',
    kind: 'unknown',
    startLine: firstLine,
    endLine: lastLine,
    contentHash: hashText(normalizeForHash(text)),
    children: [],
  };
}

/**
 * Synthesise "filler" blocks covering any module-level lines NOT already
 * captured by an extracted symbol or by the imports block.
 *
 * Why: the chip view promises 1:1 visibility with what an editor would
 * show — every line of code lands in exactly one block. Top-level
 * expression statements (Express middleware setup, `dotenv.config()`,
 * `app.listen(3000)`, `if (DEV) { … }`), pre-import docstrings, and
 * trailing module code don't fit into any AST-extractor's "symbol"
 * shape, so they'd otherwise vanish from the chip. Filler blocks scoop
 * them up.
 *
 * Algorithm:
 *   1. Mark every line in [1, fileLineCount] as covered iff at least
 *      one extracted symbol (incl. the imports block) spans it.
 *   2. Walk the file in line order; each contiguous run of UNCOVERED
 *      lines becomes a candidate filler block.
 *   3. Skip pure-whitespace runs (blank gaps between functions don't
 *      need their own empty block).
 *   4. Emit each remaining run as a synthetic symbol with kind=`unknown`,
 *      name=`code`, and a content hash from the actual source text so
 *      the symbol-diff feature still detects changes.
 */
export function computeFillerBlocks(
  rootNode: Node,
  existing: readonly ExtractedSymbol[],
): ExtractedSymbol[] {
  const source = rootNode.text;
  const lines = source.split('\n');
  const fileLineCount = lines.length;
  if (fileLineCount === 0) return [];

  // 1-based covered map. +1 for sentinel safety.
  const covered = new Uint8Array(fileLineCount + 2);
  for (const s of existing) {
    const lo = Math.max(1, s.startLine);
    const hi = Math.min(fileLineCount, s.endLine);
    for (let i = lo; i <= hi; i++) covered[i] = 1;
  }

  const fillers: ExtractedSymbol[] = [];
  const flush = (start: number, end: number) => {
    // Skip ranges that contain only blank / whitespace lines — they're
    // implicit visual gaps between blocks, not content.
    let hasContent = false;
    for (let i = start; i <= end; i++) {
      const ln = lines[i - 1];
      if (ln && ln.trim().length > 0) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) return;
    const text = lines.slice(start - 1, end).join('\n');
    fillers.push({
      qualifiedName: `__code_${start}_${end}__`,
      name: 'code',
      kind: 'unknown',
      startLine: start,
      endLine: end,
      contentHash: hashText(normalizeForHash(text)),
      children: [],
    });
  };

  let runStart = -1;
  for (let i = 1; i <= fileLineCount; i++) {
    if (!covered[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      flush(runStart, i - 1);
      runStart = -1;
    }
  }
  if (runStart >= 0) flush(runStart, fileLineCount);
  return fillers;
}

/**
 * Walk the tree's root and return top-level symbols.
 * Designed to be called once per (file, snapshot) — caller pairs results from
 * before/after snapshots and pairs them by qualifiedName for diffing.
 *
 * Three layers contribute symbols:
 *   1. The synthetic "imports" block (if any imports / re-exports exist).
 *   2. Regular AST extraction (functions, classes, types, consts, …).
 *   3. Filler blocks for any lines not yet covered — the chip view
 *      mirrors the file 1:1 so nothing disappears.
 *
 * Output isn't sorted: callers (`fileFunctionsFromIndex`) sort by
 * startLine for the chip render.
 */
export function extractSymbolsFromTree(rootNode: Node): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const header = extractImportHeader(rootNode);
  if (header) out.push(header);
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i);
    if (child) out.push(...extractFromNode(child, undefined, false));
  }
  out.push(...computeFillerBlocks(rootNode, out));
  return out;
}
