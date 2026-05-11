/**
 * Rust language handler — covers `.rs` files.
 *
 * Phase status:
 *   T1 (chip render): IMPLEMENTED — function / method / struct / enum
 *                     / trait / const symbols extract; impl-block
 *                     methods re-parented under their target type;
 *                     filler + imports synthetic blocks generated.
 *   T2 (params):      IMPLEMENTED — `&self` / `&mut self` preserved
 *                     verbatim; destructured params kept as text.
 *   T3 (call graph):  STUBBED — buildProjectContext / resolveSpecifier /
 *                     resolveCall return safe defaults. Rust's mod tree
 *                     + use-alias resolution + trait dispatch land in
 *                     a follow-up.
 *
 * Rust-specific design notes:
 *
 *   - `impl Foo { fn bar() }` and `impl Trait for Foo { fn bar() }`
 *     both attach `bar` under `Foo`. Trait-vs-inherent distinction
 *     is irrelevant for chip rendering (both render under Foo);
 *     T3 will track the trait separately for dispatch resolution.
 *
 *   - `self_parameter` displays AS WRITTEN (`self`, `&self`, `&mut
 *     self`) — Rust readers treat the reference flavour as part of
 *     the function's "shape" so we preserve it in the chip header.
 *
 *   - Generic parameters on impl targets (`impl<T> Foo<T>`) collapse
 *     to the base type `Foo` for re-parenting purposes — chip view
 *     groups all generic instantiations under one type symbol.
 *
 *   - Macros (`println!()`, `vec![]`, `derive(...)`) are NOT counted
 *     as call sites. Tree-sitter exposes them as `macro_invocation`
 *     nodes; the call-site walker only picks up `call_expression` /
 *     `method_call_expression`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type {
  CallResolution,
  ImportExtraction,
  LanguageHandler,
  ProjectContext,
} from './types';
import {
  hashText,
  normalizeForHash,
  computeFillerBlocks,
} from '../extractSymbols';
import type { ExtractedSymbol } from '../types';
import type { ImportBinding, RawCall } from '../extractCalls';
import type {
  IndexedFile,
  IndexedSymbol,
} from '../projectGraph/codeIndex';

// ============================================================================
// Symbol-construction helpers (Rust-flavoured, parallel to go.ts /
// extractSymbols.ts; not unified because Rust's qname / params /
// impl-block rules diverge enough that sharing would obscure both.)
// ============================================================================

function qualify(parent: string | undefined, name: string): string {
  return parent ? `${parent}>${name}` : name;
}

function makeSymbol(
  node: Node,
  name: string,
  kind: ExtractedSymbol['kind'],
  parentQname: string | undefined,
  children: ExtractedSymbol[] = [],
  params?: string[],
): ExtractedSymbol {
  return {
    qualifiedName: qualify(parentQname, name),
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    contentHash: hashText(normalizeForHash(node.text)),
    children,
    params,
  };
}

// ============================================================================
// Parameter extraction
//
// Rust `parameters` field children:
//   - `self_parameter` — `self`, `&self`, `&mut self`. Preserved verbatim.
//   - `parameter`      — `pattern: Type` shape; we read the pattern's text
//                        (handles `mut name`, `_`, destructured patterns).
//   - `variadic_parameter` — extern fn variadic; rare, surface as `...`.
// ============================================================================

function extractRustParams(fnNode: Node): string[] | undefined {
  const params = fnNode.childForFieldName('parameters');
  if (!params) return undefined;
  const out: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (!p) continue;
    if (p.type === 'self_parameter') {
      // Preserve full text — `self`, `&self`, `&mut self` all
      // distinguish receiver semantics worth showing in the header.
      out.push(p.text);
    } else if (p.type === 'parameter') {
      const pat = p.childForFieldName('pattern');
      if (pat) {
        out.push(pat.text);
      } else {
        // Could be `_: T` (anonymous discard) or unusual shape.
        out.push('_');
      }
    } else if (p.type === 'variadic_parameter') {
      out.push('...');
    }
  }
  return out;
}

// ============================================================================
// Type-name reader for `impl` targets — strips lifetimes / generics /
// references to land on the base type identifier.
//
//   impl Foo                     →  "Foo"
//   impl<T> Foo<T>               →  "Foo"
//   impl Trait for Foo           →  "Foo"   (read 'type' field, not 'trait')
//   impl Foo<'a>                 →  "Foo"   (lifetime stripped)
//   impl<'a> &'a Foo             →  "Foo"   (reference stripped)
// ============================================================================

function readImplTargetType(implNode: Node): string | null {
  const t = implNode.childForFieldName('type');
  if (!t) return null;
  return readRustTypeName(t);
}

function readRustTypeName(t: Node): string | null {
  if (t.type === 'type_identifier') return t.text;
  if (t.type === 'generic_type') {
    const base = t.childForFieldName('type');
    if (base) return readRustTypeName(base);
  }
  if (t.type === 'reference_type') {
    for (let i = 0; i < t.namedChildCount; i++) {
      const inner = t.namedChild(i);
      if (inner) {
        const r = readRustTypeName(inner);
        if (r) return r;
      }
    }
  }
  if (t.type === 'scoped_type_identifier') {
    // `path::to::Foo` — leaf identifier wins.
    const name = t.childForFieldName('name');
    if (name?.type === 'type_identifier') return name.text;
  }
  return null;
}

// ============================================================================
// impl body — emits methods (no nested types; nested impls are
// extremely rare and wouldn't render usefully in chip view anyway).
// ============================================================================

function extractImplMembers(
  impl: Node,
  parentQname: string,
): ExtractedSymbol[] {
  const body = impl.childForFieldName('body');
  if (!body) return [];
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const m = body.namedChild(i);
    if (!m) continue;
    if (m.type === 'function_item') {
      const nameNode = m.childForFieldName('name');
      if (!nameNode) continue;
      out.push(
        makeSymbol(
          m,
          nameNode.text,
          'method',
          parentQname,
          [],
          extractRustParams(m),
        ),
      );
    } else if (m.type === 'function_signature_item') {
      // Trait-impl shape with body in the trait — surface as method anyway.
      const nameNode = m.childForFieldName('name');
      if (!nameNode) continue;
      out.push(
        makeSymbol(
          m,
          nameNode.text,
          'method',
          parentQname,
          [],
          extractRustParams(m),
        ),
      );
    }
  }
  return out;
}

// ============================================================================
// Trait body — methods declared inside a `trait Foo { ... }` block,
// usually as `function_signature_item` (no body) or `function_item`
// (default impl). Both render as methods of the trait.
// ============================================================================

function extractTraitMembers(
  trait: Node,
  parentQname: string,
): ExtractedSymbol[] {
  const body = trait.childForFieldName('body');
  if (!body) return [];
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const m = body.namedChild(i);
    if (!m) continue;
    if (m.type === 'function_item' || m.type === 'function_signature_item') {
      const nameNode = m.childForFieldName('name');
      if (!nameNode) continue;
      out.push(
        makeSymbol(
          m,
          nameNode.text,
          'method',
          parentQname,
          [],
          extractRustParams(m),
        ),
      );
    }
  }
  return out;
}

// ============================================================================
// Imports header — synthesise one block over contiguous `use`
// declarations + `extern crate` at the top of the file.
// ============================================================================

function extractRustImportHeader(rootNode: Node): ExtractedSymbol | null {
  const headerNodes: Node[] = [];
  let firstLine = -1;
  let lastLine = -1;
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const c = rootNode.namedChild(i);
    if (!c) continue;
    if (c.type === 'use_declaration' || c.type === 'extern_crate_declaration') {
      headerNodes.push(c);
      if (firstLine < 0) firstLine = c.startPosition.row + 1;
      lastLine = c.endPosition.row + 1;
    } else if (firstLine >= 0) {
      break;
    }
  }
  if (firstLine < 0) return null;
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

// ============================================================================
// Top-level walk
// ============================================================================

interface PendingImpl {
  /** Base type the impl targets (after stripping generics / lifetimes). */
  targetType: string;
  /** Extracted method symbols, qname-prefixed by `targetType`. */
  methods: ExtractedSymbol[];
}

function extractTopLevel(rootNode: Node): {
  symbols: ExtractedSymbol[];
  pendingImpls: PendingImpl[];
} {
  const symbols: ExtractedSymbol[] = [];
  const pendingImpls: PendingImpl[] = [];
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const node = rootNode.namedChild(i);
    if (!node) continue;
    switch (node.type) {
      case 'function_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        symbols.push(
          makeSymbol(
            node,
            nameNode.text,
            'function',
            undefined,
            [],
            extractRustParams(node),
          ),
        );
        break;
      }
      case 'struct_item':
      case 'union_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        symbols.push(makeSymbol(node, nameNode.text, 'class', undefined));
        break;
      }
      case 'enum_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        symbols.push(makeSymbol(node, nameNode.text, 'enum', undefined));
        break;
      }
      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        const qname = nameNode.text;
        const members = extractTraitMembers(node, qname);
        symbols.push(
          makeSymbol(node, nameNode.text, 'interface', undefined, members),
        );
        break;
      }
      case 'impl_item': {
        const target = readImplTargetType(node);
        if (!target) break;
        const methods = extractImplMembers(node, target);
        if (methods.length > 0) {
          pendingImpls.push({ targetType: target, methods });
        }
        break;
      }
      case 'const_item':
      case 'static_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        symbols.push(makeSymbol(node, nameNode.text, 'const', undefined));
        break;
      }
      case 'type_item': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        symbols.push(makeSymbol(node, nameNode.text, 'type', undefined));
        break;
      }
      case 'mod_item': {
        // Inline `mod foo { ... }` — a real declaration. We surface it
        // as a `class`-flavoured block with the mod's items as
        // children. File-based `mod foo;` (no body) lands in the
        // imports header instead.
        const nameNode = node.childForFieldName('name');
        const body = node.childForFieldName('body');
        if (!nameNode || !body) {
          // `mod foo;` — handled by import header pass.
          break;
        }
        symbols.push(makeSymbol(node, nameNode.text, 'class', undefined));
        break;
      }
    }
  }
  return { symbols, pendingImpls };
}

/** Second pass: attach impl-block methods to their target type. Methods
 *  whose target isn't a top-level struct/enum/union in this file fall
 *  through to top-level emission so they're still visible. */
function attachImplMethods(
  symbols: ExtractedSymbol[],
  pending: PendingImpl[],
): ExtractedSymbol[] {
  if (pending.length === 0) return symbols;
  const byName = new Map<string, ExtractedSymbol>();
  for (const s of symbols) {
    if (s.kind === 'class' || s.kind === 'enum' || s.kind === 'interface') {
      byName.set(s.name, s);
    }
  }
  const orphans: ExtractedSymbol[] = [];
  for (const impl of pending) {
    const host = byName.get(impl.targetType);
    if (host) {
      host.children = [...host.children, ...impl.methods];
    } else {
      orphans.push(...impl.methods);
    }
  }
  return [...symbols, ...orphans];
}

// ============================================================================
// Imports + call sites
// ============================================================================

function extractRustImports(rootNode: Node): ImportExtraction {
  const specs: string[] = [];
  const bindings: ImportBinding[] = [];

  function walkUse(useNode: Node) {
    // `use_declaration` wraps a single `path` / `scoped_use_list` /
    // `use_as_clause` / `scoped_identifier`. The path string is the
    // module being imported; bindings are the names brought into
    // local scope.
    for (let i = 0; i < useNode.namedChildCount; i++) {
      const c = useNode.namedChild(i);
      if (c) processUseTree(c, '');
    }
  }

  function processUseTree(node: Node, prefix: string): void {
    switch (node.type) {
      case 'use_as_clause': {
        // `path as alias`
        const pathNode = node.childForFieldName('path');
        const aliasNode = node.childForFieldName('alias');
        if (pathNode && aliasNode) {
          const fullPath = joinPath(prefix, pathToString(pathNode));
          specs.push(fullPath);
          bindings.push({
            specifier: fullPath,
            importedName: leafOf(fullPath),
            localName: aliasNode.text,
          });
        }
        break;
      }
      case 'use_list': {
        // `prefix::{a, b, c}` — recurse with extended prefix.
        for (let i = 0; i < node.namedChildCount; i++) {
          const inner = node.namedChild(i);
          if (inner) processUseTree(inner, prefix);
        }
        break;
      }
      case 'scoped_use_list': {
        // `path::{a, b}` — read path, then process the list with extended prefix.
        const pathNode = node.childForFieldName('path');
        const listNode = node.childForFieldName('list');
        const newPrefix = pathNode
          ? joinPath(prefix, pathToString(pathNode))
          : prefix;
        if (listNode) {
          for (let i = 0; i < listNode.namedChildCount; i++) {
            const inner = listNode.namedChild(i);
            if (inner) processUseTree(inner, newPrefix);
          }
        }
        break;
      }
      case 'use_wildcard': {
        // `prefix::*`
        const pathNode = node.childForFieldName('path');
        const fullPath = pathNode
          ? joinPath(prefix, pathToString(pathNode))
          : prefix;
        if (fullPath) {
          specs.push(fullPath);
          bindings.push({
            specifier: fullPath,
            importedName: '*',
            localName: '*',
          });
        }
        break;
      }
      case 'identifier':
      case 'self':
      case 'super':
      case 'crate':
      case 'scoped_identifier': {
        const leaf = pathToString(node);
        const fullPath = joinPath(prefix, leaf);
        if (fullPath) {
          specs.push(fullPath);
          bindings.push({
            specifier: fullPath,
            importedName: leafOf(fullPath),
            localName: leafOf(fullPath),
          });
        }
        break;
      }
    }
  }

  function pathToString(node: Node): string {
    if (node.type === 'identifier' || node.type === 'crate' ||
        node.type === 'self' || node.type === 'super') {
      return node.text;
    }
    if (node.type === 'scoped_identifier') {
      const path = node.childForFieldName('path');
      const name = node.childForFieldName('name');
      const left = path ? pathToString(path) : '';
      const right = name?.text ?? '';
      return left ? `${left}::${right}` : right;
    }
    return node.text;
  }

  function joinPath(prefix: string, suffix: string): string {
    if (!prefix) return suffix;
    if (!suffix) return prefix;
    return `${prefix}::${suffix}`;
  }

  function leafOf(p: string): string {
    const parts = p.split('::');
    return parts[parts.length - 1] ?? p;
  }

  function visit(node: Node) {
    if (node.type === 'use_declaration') {
      walkUse(node);
      return;
    }
    if (node.type === 'extern_crate_declaration') {
      // `extern crate foo;` — file-graph dep on crate `foo`.
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        specs.push(nameNode.text);
        bindings.push({
          specifier: nameNode.text,
          importedName: '*',
          localName: nameNode.text,
        });
      }
      return;
    }
    if (node.type === 'mod_item') {
      // `mod foo;` (no body) — file-based module dep. Inline mods
      // don't contribute to file-graph; they're internal scopes.
      const body = node.childForFieldName('body');
      const nameNode = node.childForFieldName('name');
      if (!body && nameNode) {
        specs.push(nameNode.text);
      }
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) visit(c);
    }
  }
  visit(rootNode);
  return { specs, bindings };
}

function extractRustCallSites(rootNode: Node): RawCall[] {
  const out: RawCall[] = [];
  function visit(node: Node) {
    if (node.type === 'call_expression') {
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
    } else if (node.type === 'method_call_expression') {
      const methodNode = node.childForFieldName('method');
      const receiverNode = node.childForFieldName('value');
      if (methodNode) {
        const receiverName = receiverNode?.type === 'identifier'
          ? receiverNode.text
          : undefined;
        out.push({
          calleeName: methodNode.text,
          line: node.startPosition.row + 1,
          ...(receiverName ? { receiverName } : {}),
        });
      }
    }
    // Note: macro_invocation deliberately skipped — macros generate
    // calls but the static layer can't see what they expand to.
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }
  visit(rootNode);
  return out;
}

function calleeLeafName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'scoped_identifier') {
    const name = node.childForFieldName('name');
    return name?.text ?? null;
  }
  if (node.type === 'field_expression') {
    const field = node.childForFieldName('field');
    return field?.text ?? null;
  }
  return null;
}

function receiverRootName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node.type === 'scoped_identifier') {
    // `path::to::fn` — leftmost identifier is the receiver in our model.
    let cur: Node | null = node;
    while (cur) {
      if (cur.type === 'identifier') return cur.text;
      if (cur.type === 'scoped_identifier') {
        cur = cur.childForFieldName('path');
        continue;
      }
      break;
    }
  }
  if (node.type === 'field_expression') {
    const value = node.childForFieldName('value');
    if (value?.type === 'identifier') return value.text;
  }
  return undefined;
}

// ============================================================================
// T3: project context (mod tree), specifier resolution, call resolution
// ============================================================================

/** Internal shape of Rust handler's ProjectContext. */
interface RustProjectContext {
  cwd: string;
  /** modPath ("crate" | "crate::foo" | "crate::foo::bar" | …) →
   *  project-relative file path. Built by walking entry files
   *  (src/lib.rs / src/main.rs / workspace member roots) and
   *  recursively following each `mod foo;` declaration to its file. */
  modTree: Map<string, string>;
  /** Reverse: filePath → modPath. Lets us know what mod a given file
   *  corresponds to (used to resolve `crate::` paths from the file's
   *  perspective, and to assign moduleForFile output). */
  fileToMod: Map<string, string>;
}

/** Find Rust mod-tree entry files. We support the conventional
 *  layouts:
 *
 *    src/lib.rs                — library crate root
 *    src/main.rs               — binary crate root
 *    <member>/src/lib.rs       — workspace lib member
 *    <member>/src/main.rs      — workspace bin member
 *    src/bin/<name>.rs         — additional binaries
 *
 *  We don't parse Cargo.toml — the convention coverage above hits
 *  ~99% of real Rust projects without the YAML/TOML dependency. */
function findRustEntryFiles(fileSet: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of fileSet) {
    if (
      f === 'src/lib.rs' ||
      f === 'src/main.rs' ||
      f.endsWith('/src/lib.rs') ||
      f.endsWith('/src/main.rs') ||
      /^src\/bin\/[^/]+\.rs$/.test(f) ||
      /\/src\/bin\/[^/]+\.rs$/.test(f)
    ) {
      out.push(f);
    }
  }
  return out;
}

/** Strip line and block comments so a regex scan for `mod foo;`
 *  doesn't false-match on commented-out declarations or string
 *  literals containing the word `mod`. Approximation — we don't
 *  handle every edge case (e.g. raw strings `r#"...mod foo;..."#`)
 *  but it's good enough for the chip-view use case. */
function stripRustCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    // Plain double-quoted strings (escape-aware, single-line).
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** Find `mod foo;` (file-based) and `mod foo { ... }` (inline)
 *  declarations in source text. Returns only the file-based
 *  declarations — inline mods don't introduce a file dependency. */
function findFileModDeclarations(source: string): string[] {
  const cleaned = stripRustCommentsAndStrings(source);
  const out: string[] = [];
  // `mod foo;` — semicolon terminator, no body. Optional visibility.
  const re = /\b(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/** Walk the Rust mod tree starting from each entry file. Returns the
 *  modPath ↔ filePath maps. */
async function buildModTree(
  cwd: string,
  fileSet: ReadonlySet<string>,
): Promise<{
  modTree: Map<string, string>;
  fileToMod: Map<string, string>;
}> {
  const modTree = new Map<string, string>();
  const fileToMod = new Map<string, string>();
  const visited = new Set<string>();

  async function walk(modPath: string, filePath: string): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    modTree.set(modPath, filePath);
    fileToMod.set(filePath, modPath);

    // Read file source. Handle errors gracefully — a missing /
    // unreadable file just means we skip its sub-mods.
    let source: string;
    try {
      source = await fs.readFile(path.join(cwd, filePath), 'utf8');
    } catch {
      return;
    }
    const childMods = findFileModDeclarations(source);
    if (childMods.length === 0) return;

    const dir = path.dirname(filePath);
    // For mod.rs / lib.rs / main.rs, sub-mods live alongside in the
    // same directory. For other files (`foo.rs`), sub-mods live
    // under `foo/` (Rust 2018 edition) — but we cover both layouts.
    const baseName = path.basename(filePath, '.rs');
    const possibleSubdirs =
      baseName === 'mod' || baseName === 'lib' || baseName === 'main'
        ? [dir]
        : [dir, path.join(dir, baseName)];

    for (const childMod of childMods) {
      const childModPath = `${modPath}::${childMod}`;
      // Try each layout: <subdir>/<child>.rs, then <subdir>/<child>/mod.rs.
      let childFile: string | null = null;
      for (const subdir of possibleSubdirs) {
        const candidates = [
          path.join(subdir, `${childMod}.rs`),
          path.join(subdir, childMod, 'mod.rs'),
        ];
        for (const c of candidates) {
          // Normalise leading "./" since dirname returns "." for root files.
          const normalised = c.startsWith('./') ? c.slice(2) : c;
          if (fileSet.has(normalised)) {
            childFile = normalised;
            break;
          }
        }
        if (childFile) break;
      }
      if (childFile) {
        await walk(childModPath, childFile);
      }
    }
  }

  for (const entry of findRustEntryFiles(fileSet)) {
    // Crate root naming: `src/lib.rs` and `src/main.rs` both anchor
    // the `crate` modPath. For workspace members, use the package
    // directory as the mod root prefix (best-effort — without
    // Cargo.toml parse we can't know the actual crate name, so we
    // use the dir name as a stand-in).
    if (entry === 'src/lib.rs' || entry === 'src/main.rs') {
      await walk('crate', entry);
    } else if (entry.startsWith('src/bin/')) {
      await walk('crate', entry);
    } else {
      // Workspace member — use parent dir name as crate prefix.
      const parts = entry.split('/');
      const memberIdx = parts.indexOf('src');
      if (memberIdx > 0) {
        const memberName = parts[memberIdx - 1];
        await walk(memberName, entry);
      }
    }
  }

  return { modTree, fileToMod };
}

/** Resolve a Rust path string (`crate::foo::bar`, `super::baz`,
 *  `self::qux`) against the caller's modPath. Returns the resolved
 *  modPath as a string, or null if the path leaves the resolved
 *  tree (external crate, std, etc.). */
function resolveModPath(
  spec: string,
  fromModPath: string,
): string | null {
  if (spec.startsWith('crate::')) return spec;
  if (spec === 'crate') return 'crate';
  if (spec.startsWith('self::')) {
    return `${fromModPath}::${spec.slice('self::'.length)}`;
  }
  if (spec === 'self') return fromModPath;
  if (spec.startsWith('super::')) {
    let parent = fromModPath;
    let rest = spec;
    while (rest.startsWith('super::')) {
      const lastSep = parent.lastIndexOf('::');
      if (lastSep < 0) return null; // can't go above crate root
      parent = parent.slice(0, lastSep);
      rest = rest.slice('super::'.length);
    }
    if (rest === 'super') {
      const lastSep = parent.lastIndexOf('::');
      return lastSep < 0 ? null : parent.slice(0, lastSep);
    }
    return rest ? `${parent}::${rest}` : parent;
  }
  // External crate path (e.g. `std::collections::HashMap`,
  // `serde::Deserialize`). Not in our mod tree.
  return null;
}

// ============================================================================
// Public handler
// ============================================================================

export const rustHandler: LanguageHandler = {
  grammarId: 'rust',
  extensions: ['.rs'],

  extractSymbols(rootNode: Node, _source: string): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = [];
    const header = extractRustImportHeader(rootNode);
    if (header) out.push(header);
    const { symbols, pendingImpls } = extractTopLevel(rootNode);
    out.push(...attachImplMethods(symbols, pendingImpls));
    out.push(...computeFillerBlocks(rootNode, out));
    return out;
  },

  extractImports(rootNode: Node): ImportExtraction {
    return extractRustImports(rootNode);
  },

  extractCallSites(rootNode: Node, _symbols: IndexedSymbol[]): RawCall[] {
    return extractRustCallSites(rootNode);
  },

  // -------- T3: call graph --------

  async buildProjectContext(
    cwd: string,
    fileSet: ReadonlySet<string>,
  ): Promise<ProjectContext> {
    const { modTree, fileToMod } = await buildModTree(cwd, fileSet);
    const ctx: RustProjectContext = { cwd, modTree, fileToMod };
    return ctx;
  },

  resolveSpecifier(
    spec: string,
    fromFilePath: string,
    ctx: ProjectContext,
    _fileSet: ReadonlySet<string>,
  ): string | null {
    const c = ctx as RustProjectContext;
    const fromMod = c.fileToMod.get(fromFilePath);
    if (!fromMod) return null;

    // The spec may be a full path (`crate::foo::bar::baz`) or just a
    // path-prefix (`crate::foo::bar`). The resolver tries the full
    // spec first, then progressively trims trailing segments —
    // typically the LAST segment is a SYMBOL (like `baz`) inside the
    // module file rather than a sub-module of its own. We want to
    // anchor to the file containing the symbol.
    const resolved = resolveModPath(spec, fromMod);
    if (!resolved) return null;
    if (c.modTree.has(resolved)) return c.modTree.get(resolved)!;
    // Trim segments until we hit a known mod. The trimmed-off tail is
    // the symbol name(s) inside that file's mod.
    const segs = resolved.split('::');
    while (segs.length > 1) {
      segs.pop();
      const candidate = segs.join('::');
      const file = c.modTree.get(candidate);
      if (file) return file;
    }
    return null;
  },

  resolveCall(
    call: RawCall,
    from: IndexedSymbol,
    fromFile: IndexedFile,
    allFiles: ReadonlyMap<string, IndexedFile>,
    _ctx: ProjectContext,
  ): CallResolution[] {
    // Receiver-based path: `obj.method()` or `Type::function()`.
    if (call.receiverName) {
      const recvBinding = fromFile.bindingsByLocalName.get(call.receiverName);
      if (recvBinding) {
        const recvFilePath = fromFile.resolvedImports.get(recvBinding.specifier);
        if (!recvFilePath) {
          // External crate (`std`, `serde`, etc.) — emit ext pin.
          return [
            {
              kind: 'external',
              name: call.calleeName,
              packageSpec: recvBinding.specifier,
            },
          ];
        }
        // Cross-mod: look in the target file for either:
        //   - a direct top-level symbol (functions, statics)
        //   - a method `<receiverImportedName>>methodName` (when the
        //     binding's importedName matches a struct/enum/trait)
        const targetFile = allFiles.get(recvFilePath);
        if (!targetFile) return [];
        const candidates = targetFile.symbolsByName.get(call.calleeName);
        if (candidates) {
          for (const s of candidates) {
            if (s.qualifiedName.includes('>')) continue;
            if (!isCallableKind(s.kind)) continue;
            return [
              {
                kind: 'symbol',
                addr: {
                  filePath: s.filePath,
                  qualifiedName: s.qualifiedName,
                },
              },
            ];
          }
        }
        // Nested member match (`Type::method` or trait method).
        const nestedQname = `${recvBinding.importedName}>${call.calleeName}`;
        const nested = targetFile.symbolsByQname.get(nestedQname);
        if (nested && isCallableKind(nested.kind)) {
          return [
            {
              kind: 'symbol',
              addr: {
                filePath: nested.filePath,
                qualifiedName: nested.qualifiedName,
              },
            },
          ];
        }
        return [
          {
            kind: 'method-unresolved',
            receiverName: call.receiverName,
            methodName: call.calleeName,
          },
        ];
      }

      // Receiver isn't an import. Two common patterns:
      //   - `Foo::new(...)` where Foo is defined in this file → look
      //     for `Foo>new` in flatSymbols (covers both inherent impls
      //     and `Foo::new()` constructor pattern)
      //   - `obj.method()` where `obj` is a local var of an in-file
      //     type → without type info we can't infer. Best-effort:
      //     check if any in-file struct/enum has a method named
      //     `methodName` (will over-match if multiple types share
      //     the method name; chip view tolerates).
      const directMethod = `${call.receiverName}>${call.calleeName}`;
      const directHit = fromFile.symbolsByQname.get(directMethod);
      if (directHit) {
        return [
          {
            kind: 'symbol',
            addr: {
              filePath: directHit.filePath,
              qualifiedName: directHit.qualifiedName,
            },
          },
        ];
      }
      // Fall back to "any in-file method with this name" — emits all
      // candidates (chip view shows them as separate edges).
      const out: CallResolution[] = [];
      const allSameName = fromFile.symbolsByName.get(call.calleeName);
      if (allSameName) {
        for (const s of allSameName) {
          if (s.kind !== 'method') continue;
          out.push({
            kind: 'symbol',
            addr: { filePath: s.filePath, qualifiedName: s.qualifiedName },
          });
        }
      }
      if (out.length > 0) return out;
      return [
        {
          kind: 'method-unresolved',
          receiverName: call.receiverName,
          methodName: call.calleeName,
        },
      ];
    }

    // Bare-name path: `foo()`. Three sources to check, in order:
    //   1. Local symbol (same file, top-level): `fn foo()` declared here
    //   2. Imported binding: `use crate::foo::bar` → `bar()` matches
    //   3. None → drop (or external if binding is external)
    const local: CallResolution[] = [];
    const localCandidates = fromFile.symbolsByName.get(call.calleeName);
    if (localCandidates) {
      for (const s of localCandidates) {
        if (s.qualifiedName === from.qualifiedName) continue;
        if (s.qualifiedName.includes('>')) continue;
        if (!isCallableKind(s.kind)) continue;
        local.push({
          kind: 'symbol',
          addr: { filePath: s.filePath, qualifiedName: s.qualifiedName },
        });
      }
    }
    if (local.length > 0) return local;

    const binding = fromFile.bindingsByLocalName.get(call.calleeName);
    if (!binding) return [];
    const targetFile = fromFile.resolvedImports.get(binding.specifier);
    if (!targetFile) {
      return [
        {
          kind: 'external',
          name: binding.importedName,
          packageSpec: binding.specifier,
        },
      ];
    }
    const target = allFiles.get(targetFile);
    if (!target) return [];
    const targetCandidates = target.symbolsByName.get(binding.importedName);
    let sym: IndexedSymbol | undefined;
    if (targetCandidates) {
      for (const s of targetCandidates) {
        if (s.qualifiedName.includes('>')) continue;
        if (!isCallableKind(s.kind)) continue;
        sym = s;
        break;
      }
    }
    if (!sym) return [];
    return [
      {
        kind: 'symbol',
        addr: { filePath: sym.filePath, qualifiedName: sym.qualifiedName },
      },
    ];
  },

  moduleForFile(filePath: string, ctx: ProjectContext): string {
    const c = ctx as RustProjectContext | undefined;
    return c?.fileToMod.get(filePath) ?? path.dirname(filePath);
  },
};

function isCallableKind(k: IndexedSymbol['kind']): boolean {
  return k === 'function' || k === 'class' || k === 'method';
}
