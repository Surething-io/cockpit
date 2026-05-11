/**
 * Tree-sitter based import extractor.
 *
 * Replaces the previous regex approach so adding new languages later is a
 * matter of registering a per-grammar walker, not maintaining a regex set
 * per language. Currently supports TS / TSX / JS — all share the same node
 * shape for imports.
 *
 * What we extract:
 *   - `import ... from '<spec>'`            → spec
 *   - `import '<spec>'`                     → spec
 *   - `import('<spec>')` (dynamic)          → spec
 *   - `require('<spec>')`                   → spec
 *   - `export { ... } from '<spec>'`        → spec
 *   - `export * from '<spec>'`              → spec
 *
 * What we ignore:
 *   - String literals that are NOT in an import context (they look like specs
 *     but aren't ones we care about).
 *   - Computed specifiers (e.g. `import(someVar)`) — there's no static answer.
 */

import type { Node } from 'web-tree-sitter';
import type { ServerGrammarId } from './serverTreeSitter';

/**
 * Walk the AST and collect import specifiers.
 *
 * For TS/TSX/JS the relevant node types are:
 *   - `import_statement`        — has `source` field of type `string`
 *   - `export_statement`        — also has `source` field when re-exporting
 *   - `call_expression`         — for `import(...)` / `require(...)`
 *
 * The walker is depth-first over named children only. Skipping anonymous
 * tokens trims work substantially. Dynamic imports inside function bodies
 * are caught because we walk the whole tree, not just top-level.
 */
function walkForJsTsImports(root: Node): string[] {
  const out: string[] = [];

  // String node has a `string_fragment` named child whose `.text` is the literal value.
  function readStringNode(stringNode: Node | null): string | null {
    if (!stringNode || stringNode.type !== 'string') return null;
    for (let i = 0; i < stringNode.namedChildCount; i++) {
      const c = stringNode.namedChild(i);
      if (c && c.type === 'string_fragment') return c.text;
    }
    // Empty string literal `""` has no fragment child — return empty to be safe.
    return '';
  }

  function visit(node: Node) {
    switch (node.type) {
      case 'import_statement':
      case 'export_statement': {
        const source = node.childForFieldName('source');
        const spec = readStringNode(source);
        if (spec) out.push(spec);
        // Don't recurse into import/export — no further imports nested inside.
        return;
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          // Dynamic import: `import(...)`. The grammar represents bare `import`
          // here as a node with type `import` (an anonymous keyword token used
          // as expression).
          const isDynamicImport = fn.type === 'import';
          const isRequire = fn.type === 'identifier' && fn.text === 'require';
          if (isDynamicImport || isRequire) {
            const args = node.childForFieldName('arguments');
            if (args && args.namedChildCount > 0) {
              const firstArg = args.namedChild(0);
              const spec = readStringNode(firstArg);
              if (spec) out.push(spec);
            }
          }
        }
        // Continue walking — could be a require nested in nested function etc.
        break;
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  }

  visit(root);
  return out;
}

/**
 * Walk a Python tree and collect imports as dotted-path specifiers.
 *
 *   `import a.b.c`               → "a.b.c"
 *   `import a.b as alias`        → "a.b"
 *   `from a.b import c`          → "a.b"          (single edge to module)
 *   `from . import x`            → "."            (relative — caller resolves)
 *   `from ..pkg import y`        → "..pkg"
 *
 * We emit ONE spec per import statement (not per imported name) — the
 * downstream resolver only needs to know which module is depended on;
 * which specific names came from it is recovered from import bindings.
 */
function walkForPythonImports(root: Node): string[] {
  const out: string[] = [];

  function visit(node: Node) {
    switch (node.type) {
      case 'import_statement': {
        // `import a, b.c, d as alias` — children with field `name` are
        // either `dotted_name` (the module path) or `aliased_import`
        // (path + alias). Emit each module path once.
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i);
          if (!c || node.fieldNameForChild(i) !== 'name') continue;
          if (c.type === 'dotted_name') {
            out.push(c.text);
          } else if (c.type === 'aliased_import') {
            const name = c.childForFieldName('name');
            if (name?.type === 'dotted_name') out.push(name.text);
          }
        }
        return;
      }
      case 'import_from_statement': {
        const spec = readPythonModuleSpec(node);
        if (spec) out.push(spec);
        return;
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  }

  visit(root);
  return out;
}

/**
 * Read the module specifier from an `import_from_statement`.
 *
 * The `module_name` field is either a plain `dotted_name` (absolute,
 * e.g. `from a.b import x`) or a `relative_import` wrapper containing
 * an `import_prefix` (the dots) and an optional `dotted_name`:
 *
 *   `from .` / `from . import x`        → relative_import { import_prefix=".", no dotted_name }
 *   `from .pkg import x`                → relative_import { import_prefix=".", dotted_name="pkg" }
 *   `from ..pkg.sub import x`           → relative_import { import_prefix="..", dotted_name="pkg.sub" }
 *   `from absolute.pkg import x`        → dotted_name="absolute.pkg"
 *
 * We reconstruct `<dots><path>` so the downstream resolver can decide
 * whether it's relative (starts with a dot) and how many levels to
 * ascend by counting them.
 */
export function readPythonModuleSpec(node: Node): string {
  const moduleNode = node.childForFieldName('module_name');
  if (!moduleNode) return '';
  if (moduleNode.type === 'dotted_name') return moduleNode.text;
  if (moduleNode.type === 'relative_import') {
    let dots = '';
    let modulePath = '';
    for (let i = 0; i < moduleNode.namedChildCount; i++) {
      const c = moduleNode.namedChild(i);
      if (!c) continue;
      if (c.type === 'import_prefix') dots = c.text;
      else if (c.type === 'dotted_name') modulePath = c.text;
    }
    return dots + modulePath;
  }
  return '';
}

// ============================================================================
// Per-grammar dispatch — add a walker entry alongside the WASM bundle.
// ============================================================================

// Partial: grammars without an entry (Go / Rust / future languages)
// fall through to the `if (!walker) return []` guard below — those
// languages have their own handler-internal walkers and don't go
// through this dispatcher.
const WALKERS: Partial<Record<ServerGrammarId, (root: Node) => string[]>> = {
  typescript: walkForJsTsImports,
  tsx: walkForJsTsImports,
  javascript: walkForJsTsImports,
  python: walkForPythonImports,
};

export function extractImportsFromTree(root: Node, grammar: ServerGrammarId): string[] {
  const walker = WALKERS[grammar];
  if (!walker) return [];
  return walker(root);
}
