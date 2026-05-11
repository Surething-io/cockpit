/**
 * Tree-sitter extraction of call sites and import bindings.
 *
 * Two pieces feed the function-level call graph in `codeIndex`:
 *
 *   1. `extractRawCalls` — every `call_expression` in the file, reduced
 *      to a (calleeName, line) pair. We deliberately keep this lossy:
 *      the resolution step in `codeIndex` decides whether a callee name
 *      refers to a local symbol or an imported one, so we don't try to
 *      be clever here.
 *
 *   2. `extractImportBindings` — for each import statement, the local
 *      name → (specifier, imported name) mapping. Used to resolve
 *      `foo()` against `import { foo } from '@/lib'`.
 *
 * Scope: TypeScript / JavaScript family (ts / tsx / js / jsx). Other
 * grammars (Python, Go …) would need their own extractors — adding them
 * later is a per-grammar visitor, not a parallel rewrite.
 */

import type { Node } from 'web-tree-sitter';

export interface ImportBinding {
  /** Module specifier — e.g. `react`, `@/lib/foo`, `./bar`. */
  specifier: string;
  /** Name as exported from the module: `useState`, the symbol name from
   *  named imports, `default` for default imports, `*` for namespace. */
  importedName: string;
  /** Local alias used inside this file. Defaults to `importedName`
   *  unless `import { foo as bar }`. */
  localName: string;
  /** When true, this binding ALSO forwards the name to consumers of
   *  THIS file (i.e. `export { foo } from '...'` in JS/TS, `pub use
   *  foo::Bar;` in Rust). The resolver follows the chain when looking
   *  up `foo` against this file: a local symbol takes precedence,
   *  then we check `bindings.find(b => b.localName === foo &&
   *  b.isReexport)` and recurse to its `specifier`. Default `false`
   *  for plain `import { foo } from '...'` — those are local-scope
   *  only and never visible to upstream consumers.
   *
   *  Languages without a reexport concept (Python / Go) always emit
   *  `false` (or omit). Folding reexports into the binding shape is
   *  what lets us drop the separate `Reexport` type and
   *  `IndexedFile.reexports` field once handlers own extraction
   *  end-to-end (P1+). */
  isReexport?: boolean;
}

export interface RawCall {
  /** The leaf identifier of the call expression's `function` field —
   *  for `foo()` it's `foo`, for `foo.bar()` it's `bar`. The resolver
   *  in `codeIndex` shadow-checks against local symbols and import
   *  bindings using this name alone, then falls back to receiver-based
   *  resolution (see `receiverName`) if those miss. */
  calleeName: string;
  /** 1-based line number of the call site, used to find the enclosing
   *  symbol (caller function/method). */
  line: number;
  /** Leftmost identifier of the member chain when the callee is a
   *  member expression. For `foo()` undefined, for `obj.bar()` it's
   *  `obj`, for `a.b.c()` it's `a`. The resolver uses this to handle
   *  three patterns the leaf-only lookup misses:
   *    - namespace imports:    `import * as ns from './x'; ns.foo()`
   *    - static class methods: `import { Cls } from './y'; Cls.warn()`
   *    - imported object props (Tier 2): `import { api } from './z'; api.fetchUser()`
   *  Skipped for `this.foo()` and `super.foo()` (already handled by
   *  the leaf path matching class members) and for chains whose root
   *  isn't a plain identifier (`getThing().foo()` etc — unresolvable
   *  without type info). */
  receiverName?: string;
}

// Re-exports are now modelled as ImportBindings with `isReexport: true`
// (see the type above). The legacy `Reexport` interface used to live
// here as a separate shape; it was folded into ImportBinding once the
// LanguageHandler abstraction landed, so reexports flow through the
// same per-file array as regular imports — distinguished only by the
// flag — and the IndexedFile schema dropped its parallel `reexports`
// field.
//
// Forms covered (JS/TS):
//   `export { foo } from '<spec>'`            → localName='foo', importedName='foo', isReexport=true
//   `export { foo as bar } from '<spec>'`     → localName='bar', importedName='foo', isReexport=true
//   `export { default as foo } from '<spec>'` → localName='foo', importedName='default', isReexport=true
//
// NOT covered (yet):
//   - `export * from '<spec>'`     — needs transitive name expansion;
//                                    deferred (rarer than named re-exports).
//   - `export { foo }` (no `from`) — re-publishes a LOCAL symbol, already
//                                    discoverable via flatSymbols.

/**
 * Walk the tree and collect every `call_expression`. For each, record
 * the callee's leaf identifier and the call site's line number.
 *
 * Member-expression callees (`a.b.c()`) collapse to the deepest
 * property name (`c`). This is intentional: it matches how a reader
 * scans the code, and the cross-file resolver downstream looks up
 * names — not chains — against import bindings.
 *
 * `new X()` is NOT counted (those are `new_expression`, not
 * `call_expression`) — for the architecture map this is fine; we'd
 * pick up `factory()` calls but not constructor invocations. The
 * majority of cross-file collaboration in modern TS goes through
 * function imports anyway.
 *
 * JSX usage IS counted: `<Foo />` and `<Foo>...</Foo>` are tagged as
 * call sites against the component's name. React's compile model is
 * literally `Foo()`; treating the JSX form as an equivalent call lets
 * the architecture map answer "where is component X used?" the same
 * way it answers "where is function X called?" — invaluable on React
 * codebases where almost all cross-file dependency goes through JSX.
 * Lowercase tags (`<div>`, `<span>`, …) and namespaced tags
 * (`<svg:rect>`) are filtered out — those are HTML / SVG, not user
 * components.
 */
export function extractRawCalls(root: Node): RawCall[] {
  const out: RawCall[] = [];
  function visit(node: Node) {
    // JS/TS: `foo()` / `obj.bar()` — node type is `call_expression`.
    // Python: same concept, different node type (`call`). Both expose
    // the callee under the `function` field, so the leaf-name extractor
    // doesn't care which language produced it.
    if (node.type === 'call_expression' || node.type === 'call') {
      const fn = node.childForFieldName('function');
      const name = calleeLeafName(fn);
      if (name) {
        const receiverName = receiverRootName(fn);
        out.push({
          calleeName: name,
          line: node.startPosition.row + 1,
          ...(receiverName ? { receiverName } : {}),
        });
      }
    } else if (
      node.type === 'jsx_opening_element' ||
      node.type === 'jsx_self_closing_element'
    ) {
      const nameNode = node.childForFieldName('name');
      const name = jsxComponentName(nameNode);
      if (name) out.push({ calleeName: name, line: node.startPosition.row + 1 });
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }
  visit(root);
  return out;
}

/**
 * Walk a member-expression callee leftward to the leftmost identifier —
 * the "receiver root" of an `obj.foo.bar()` chain.
 *
 *   foo()                  → undefined  (not a member expression)
 *   obj.foo()              → "obj"
 *   a.b.c.d()              → "a"
 *   this.foo() / super.x() → undefined  (intentional: these are
 *                                       resolved via the leaf path's
 *                                       local-symbol lookup against
 *                                       class members)
 *   getThing().foo()       → undefined  (root is a call, not an
 *                                       identifier — without type info
 *                                       we can't resolve)
 *
 * Returning `undefined` means "no receiver-based resolution available".
 * The resolver still tries the leaf-name path; if both fail the call
 * is dropped (or surfaced as an unresolvable METHOD pin when the
 * receiver IS resolvable but the leaf isn't found in the target file).
 */
function receiverRootName(node: Node | null): string | undefined {
  if (!node) return undefined;
  // Only member expressions have a meaningful receiver chain.
  if (node.type !== 'member_expression' && node.type !== 'attribute') {
    return undefined;
  }
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === 'identifier') return cur.text;
    // `this` / `super` are handled by the existing local-symbol path
    // (class methods are flattened into flatSymbols); receiver-based
    // lookup would just duplicate that path with worse precision.
    if (cur.type === 'this' || cur.type === 'super') return undefined;
    if (cur.type === 'member_expression' || cur.type === 'attribute') {
      cur = cur.childForFieldName('object');
      continue;
    }
    // Anything else at the leftmost position (call_expression,
    // parenthesized_expression, etc.) is unresolvable without type info.
    return undefined;
  }
  return undefined;
}

function calleeLeafName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
    return node.text;
  }
  // JS/TS: `obj.foo()` exposes a `member_expression` callee.
  // Python:  `obj.foo()` exposes an `attribute` callee. Both have the
  // accessed property under the `property` / `attribute` field name.
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property');
    return prop?.text ?? null;
  }
  if (node.type === 'attribute') {
    const prop = node.childForFieldName('attribute');
    return prop?.text ?? null;
  }
  // call_expression(call_expression(...)) — chained / curried calls. Fall
  // through to the inner expression's name if recursive but shallow.
  if (node.type === 'call_expression' || node.type === 'call') {
    return calleeLeafName(node.childForFieldName('function'));
  }
  return null;
}

/**
 * Resolve a JSX element's `name` field to the binding that needs to be
 * import-resolved. Returns null for HTML/SVG tags (lowercase first
 * letter, by React convention) and for namespaced tags.
 *
 * `<Foo />`        → "Foo"
 * `<Foo.Bar />`    → "Foo"   (Foo is the imported binding; Bar is a
 *                              property accessed at runtime)
 * `<Foo.Bar.Baz/>` → "Foo"   (recursive walk to the leftmost identifier)
 * `<div />`        → null    (lowercase = HTML)
 * `<svg:rect />`   → null    (XML namespace, never a user component)
 */
function jsxComponentName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier') {
    return /^[A-Z]/.test(node.text) ? node.text : null;
  }
  // tree-sitter typescript exposes both `member_expression` and
  // `jsx_member_expression` depending on grammar version; handle both.
  if (node.type === 'member_expression' || node.type === 'jsx_member_expression') {
    const obj = node.childForFieldName('object') ?? node.namedChild(0);
    return jsxComponentName(obj);
  }
  return null;
}

/**
 * Extract every import statement in the file and yield one binding per
 * local name introduced. Side-effect-only imports (`import 'x'`) yield
 * zero bindings. Both JS/TS and Python import shapes are handled.
 *
 * JS/TS forms:
 *   - `import Foo from 'x'`            → default
 *   - `import * as ns from 'x'`        → namespace
 *   - `import { a, b as c } from 'x'`  → named (with alias)
 *   - mixed: `import Foo, { a } from 'x'`
 *
 * Python forms:
 *   - `import a.b`                     → namespace, localName = `a` (the
 *                                          first segment, since that's the
 *                                          name introduced into scope)
 *   - `import a.b as c`                → namespace, localName = `c`
 *   - `from a.b import x`              → named  (`x`)
 *   - `from a.b import x as y`         → named  (`y` aliasing `x`)
 *   - `from . import x` / `from ..pkg import x` → relative; specifier
 *     keeps the dots so the resolver can walk up from the caller.
 *
 * Star imports (`from a import *`) yield a single namespace binding
 * keyed under `'*'` so the resolver can attach call edges against the
 * whole module on demand.
 */
export function extractImportBindings(root: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const n = root.namedChild(i);
    if (!n) continue;
    if (n.type === 'import_statement') {
      // JS/TS form first; Python's `import x.y` also lands here but has
      // a different shape (no `source` field, no import_clause).
      const src = n.childForFieldName('source');
      if (src) {
        extractJsTsBindings(n, src, out);
      } else {
        extractPythonImportBindings(n, out);
      }
    } else if (n.type === 'import_from_statement') {
      extractPythonFromBindings(n, out);
    }
  }
  return out;
}

/** JS/TS `import ... from '<spec>'` (and side-effect imports). */
function extractJsTsBindings(n: Node, src: Node, out: ImportBinding[]): void {
  const specifier = stripQuotes(src.text);
  let clause: Node | null = null;
  for (let j = 0; j < n.namedChildCount; j++) {
    const c = n.namedChild(j);
    if (c?.type === 'import_clause') {
      clause = c;
      break;
    }
  }
  if (!clause) return;
  for (let j = 0; j < clause.namedChildCount; j++) {
    const c = clause.namedChild(j);
    if (!c) continue;
    if (c.type === 'identifier') {
      out.push({ specifier, importedName: 'default', localName: c.text });
    } else if (c.type === 'namespace_import') {
      const id = firstNamedChildOfType(c, 'identifier');
      if (id) out.push({ specifier, importedName: '*', localName: id.text });
    } else if (c.type === 'named_imports') {
      for (let k = 0; k < c.namedChildCount; k++) {
        const spec = c.namedChild(k);
        if (!spec || spec.type !== 'import_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        if (nameNode) {
          out.push({
            specifier,
            importedName: nameNode.text,
            localName: aliasNode?.text ?? nameNode.text,
          });
        }
      }
    }
  }
}

/** Python `import a.b` / `import a.b as c`. The specifier is the dotted
 *  module path; the local name is either the FIRST segment (no alias —
 *  Python binds the top-level package) or the alias when present.
 *
 *  Names live under field `name`, not as positional namedChildren —
 *  multi-name forms like `import a.b, c.d` produce several `name` fields
 *  on the same statement node. */
function extractPythonImportBindings(n: Node, out: ImportBinding[]): void {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c || n.fieldNameForChild(i) !== 'name') continue;
    if (c.type === 'dotted_name') {
      const spec = c.text;
      const local = spec.split('.')[0];
      out.push({ specifier: spec, importedName: '*', localName: local });
    } else if (c.type === 'aliased_import') {
      const name = c.childForFieldName('name');
      const alias = c.childForFieldName('alias');
      if (name?.type === 'dotted_name' && alias) {
        out.push({ specifier: name.text, importedName: '*', localName: alias.text });
      }
    }
  }
}

/** Python `from <module> import x [as y], ...` and `from . import x`.
 *
 *  - The module reference lives in field `module_name` and is either a
 *    plain `dotted_name` (absolute) or a `relative_import` wrapper
 *    (containing an `import_prefix` with the dots and an optional
 *    `dotted_name`). We reconstruct `<dots><path>` so the resolver can
 *    detect relative imports by leading-dot inspection.
 *  - Imported names live under field `name`. Each is either a
 *    `dotted_name` (`x`), an `aliased_import` (`x as y`), or the
 *    anonymous wildcard token for `from x import *`.
 */
function extractPythonFromBindings(n: Node, out: ImportBinding[]): void {
  const moduleNode = n.childForFieldName('module_name');
  let specifier = '';
  if (moduleNode) {
    if (moduleNode.type === 'dotted_name') {
      specifier = moduleNode.text;
    } else if (moduleNode.type === 'relative_import') {
      let dots = '';
      let modulePath = '';
      for (let i = 0; i < moduleNode.namedChildCount; i++) {
        const c = moduleNode.namedChild(i);
        if (!c) continue;
        if (c.type === 'import_prefix') dots = c.text;
        else if (c.type === 'dotted_name') modulePath = c.text;
      }
      specifier = dots + modulePath;
    }
  }
  if (!specifier) return;

  let sawWildcard = false;
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    const field = n.fieldNameForChild(i);
    // Wildcard imports register as a top-level `wildcard_import` named
    // child without the `name` field (depending on the grammar version).
    if (c.type === 'wildcard_import') {
      sawWildcard = true;
      continue;
    }
    if (field !== 'name') continue;
    if (c.type === 'dotted_name') {
      const name = c.text;
      out.push({ specifier, importedName: name, localName: name });
    } else if (c.type === 'aliased_import') {
      const name = c.childForFieldName('name');
      const alias = c.childForFieldName('alias');
      if (name?.type === 'dotted_name' && alias) {
        out.push({
          specifier,
          importedName: name.text,
          localName: alias.text,
        });
      }
    }
  }
  if (sawWildcard) {
    // `from x import *` makes every public name available without a
    // local alias. We can't enumerate them statically, but emit a
    // sentinel binding so the resolver sees there's a wildcard channel.
    out.push({ specifier, importedName: '*', localName: '*' });
  }
}

/**
 * Walk a JS/TS tree and collect every `export { ... } from '<spec>'`
 * named re-export. Each `export_specifier` becomes a single `Reexport`
 * row; the resolver in `codeIndex` builds a per-file lookup from these.
 *
 * Local re-exports without a `from` (`export { foo }`) are skipped —
 * they only re-publish symbols that already exist in this file's
 * `flatSymbols`, so the resolver finds them through the regular path.
 *
 * `export * from '<spec>'` is also skipped here. Wildcard re-export
 * is rarer in practice and would require transitive name expansion
 * (resolve the source's exports first, then re-publish them all)
 * which is more invasive. Adding it is a follow-up if real codebases
 * need it.
 */
export function extractReexports(root: Node): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const n = root.namedChild(i);
    if (!n || n.type !== 'export_statement') continue;
    const src = n.childForFieldName('source');
    if (!src) continue; // local re-export, skipped (see docstring)
    const specifier = stripQuotes(src.text);
    // Find the `export_clause` child holding the named specifiers.
    // `export * from 'spec'` doesn't have one — we silently skip it.
    let clause: Node | null = null;
    for (let j = 0; j < n.namedChildCount; j++) {
      const c = n.namedChild(j);
      if (c?.type === 'export_clause') {
        clause = c;
        break;
      }
    }
    if (!clause) continue;
    for (let k = 0; k < clause.namedChildCount; k++) {
      const spec = clause.namedChild(k);
      if (!spec || spec.type !== 'export_specifier') continue;
      const nameNode = spec.childForFieldName('name');
      const aliasNode = spec.childForFieldName('alias');
      if (!nameNode) continue;
      const originalName = nameNode.text;
      const exportedName = aliasNode?.text ?? originalName;
      // Project re-export into the unified ImportBinding shape with
      // isReexport=true. `localName` here is the name as visible to
      // consumers of THIS file (was `exportedName` in the legacy
      // Reexport type); `importedName` is the name in the source
      // file (was `originalName`).
      out.push({
        localName: exportedName,
        specifier,
        importedName: originalName,
        isReexport: true,
      });
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function firstNamedChildOfType(node: Node, type: string): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c?.type === type) return c;
  }
  return null;
}
