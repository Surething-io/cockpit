/**
 * Go language handler — covers `.go` files.
 *
 * Phase status:
 *   T1 (chip render): IMPLEMENTED — function / method / type / const
 *                     symbols extract; methods re-parented under their
 *                     receiver type; filler + imports synthetic blocks
 *                     generated; chip view renders Go files end-to-end.
 *   T2 (params):      IMPLEMENTED — Go's multi-name `func(a, b int)`
 *                     handled; variadic `...args` preserved with sigil.
 *   T3 (call graph):  STUBBED — buildProjectContext / resolveSpecifier /
 *                     resolveCall return safe defaults so caller pins
 *                     are empty. Go's "directory = package" model and
 *                     receiver-method dispatch land in a follow-up.
 *
 * Go-specific design notes:
 *
 *   - Methods declared OUTSIDE their type (`func (f *Foo) Bar() {}`)
 *     are re-parented at extraction time so the chip view groups them
 *     under `Foo`. Methods whose receiver type isn't a top-level type
 *     in this file (e.g. methods on builtin or imported types — rare
 *     in idiomatic Go) stay at the top level with qname `Bar`.
 *
 *   - Anonymous parameters (`func(int, string)`) are common in Go
 *     interface definitions. We render them as `_` placeholders so
 *     the chip header shows positional context (`fn(_, _)`) rather
 *     than collapsing to `fn()` and looking like a no-arg function.
 *
 *   - Same-package implicit visibility (every `.go` file in a
 *     directory shares the package namespace) is a T3 concern. T1+T2
 *     don't need it because chip view doesn't render call edges.
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
// Symbol-construction helpers (Go-flavoured analogues of the JS/TS ones in
// extractSymbols.ts; we don't share because Go's qname / params / receiver
// rules are different enough that the unification would obscure both)
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
// Go parameters live in a `parameter_list` node containing one or more
// `parameter_declaration` (or `variadic_parameter_declaration`) entries.
// Multi-name shape — `func(a, b int)` — packs multiple identifiers into
// ONE declaration node's `name` field (which is an `identifier_list`).
// We flatten so the chip header shows `(a, b)` rather than `(a, b int)`
// or `(a)`.
// ============================================================================

function extractGoParams(fnNode: Node): string[] | undefined {
  const params = fnNode.childForFieldName('parameters');
  if (!params) return undefined;
  const out: string[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (!p) continue;
    if (p.type === 'parameter_declaration') {
      const nameNode = p.childForFieldName('name');
      if (!nameNode) {
        // Anonymous param (`func(int)`) — common in interface decls.
        // Use `_` placeholder so positional context is visible in the
        // chip header.
        out.push('_');
        continue;
      }
      if (nameNode.type === 'identifier') {
        out.push(nameNode.text);
      } else if (nameNode.type === 'identifier_list') {
        // Multi-name shape `func(a, b int)` — flatten.
        for (let j = 0; j < nameNode.namedChildCount; j++) {
          const id = nameNode.namedChild(j);
          if (id?.type === 'identifier') out.push(id.text);
        }
      } else {
        out.push(nameNode.text);
      }
    } else if (p.type === 'variadic_parameter_declaration') {
      // `func(args ...int)` — preserve the spread sigil so the
      // signature shape is recognisable in the chip header.
      const nameNode = p.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        out.push(`...${nameNode.text}`);
      } else {
        out.push('...');
      }
    }
  }
  return out;
}

// ============================================================================
// Method receiver — extract the type name a method attaches to.
//
//   func (f Foo) Bar() {}     →  receiver type = "Foo"
//   func (f *Foo) Bar() {}    →  receiver type = "Foo"  (deref pointer)
//   func (Foo) Bar() {}       →  receiver type = "Foo"  (anonymous receiver var)
//   func (Foo[T]) Bar() {}    →  receiver type = "Foo"  (generic — strip type params)
// ============================================================================

function extractReceiverTypeName(method: Node): string | null {
  const receiver = method.childForFieldName('receiver');
  if (!receiver) return null;
  for (let i = 0; i < receiver.namedChildCount; i++) {
    const p = receiver.namedChild(i);
    if (p?.type !== 'parameter_declaration') continue;
    const t = p.childForFieldName('type');
    if (!t) return null;
    return readReceiverTypeIdentifier(t);
  }
  return null;
}

function readReceiverTypeIdentifier(t: Node): string | null {
  if (t.type === 'type_identifier') return t.text;
  if (t.type === 'pointer_type') {
    // Walk into the pointed-to type.
    for (let i = 0; i < t.namedChildCount; i++) {
      const inner = t.namedChild(i);
      if (inner) {
        const r = readReceiverTypeIdentifier(inner);
        if (r) return r;
      }
    }
    return null;
  }
  if (t.type === 'generic_type') {
    // `Foo[T]` — base name lives in the `type` field or first child.
    const base = t.childForFieldName('type');
    if (base) return readReceiverTypeIdentifier(base);
  }
  return null;
}

// ============================================================================
// Type-declaration helpers — surface struct / interface / alias as
// `class` / `interface` symbols so the chip view renders them.
// ============================================================================

function extractTypeDeclaration(
  decl: Node,
  parentQname: string | undefined,
): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < decl.namedChildCount; i++) {
    const spec = decl.namedChild(i);
    if (!spec) continue;
    if (spec.type === 'type_spec' || spec.type === 'type_alias') {
      const nameNode = spec.childForFieldName('name');
      const typeNode = spec.childForFieldName('type');
      if (!nameNode) continue;
      const name = nameNode.text;
      const kind = typeNode?.type === 'interface_type' ? 'interface' : 'class';
      out.push(makeSymbol(spec, name, kind, parentQname));
    }
  }
  return out;
}

function extractValueDeclaration(
  decl: Node,
  parentQname: string | undefined,
): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < decl.namedChildCount; i++) {
    const spec = decl.namedChild(i);
    if (!spec) continue;
    if (spec.type === 'var_spec' || spec.type === 'const_spec') {
      const nameNode = spec.childForFieldName('name');
      if (!nameNode) continue;
      // var_spec / const_spec name field is typically an identifier_list
      // (`var x, y = 1, 2`). Emit one symbol per name.
      if (nameNode.type === 'identifier_list') {
        for (let j = 0; j < nameNode.namedChildCount; j++) {
          const id = nameNode.namedChild(j);
          if (id?.type === 'identifier') {
            out.push(makeSymbol(spec, id.text, 'const', parentQname));
          }
        }
      } else if (nameNode.type === 'identifier') {
        out.push(makeSymbol(spec, nameNode.text, 'const', parentQname));
      }
    }
  }
  return out;
}

// ============================================================================
// Imports header — synthesise a single block covering contiguous
// `import_declaration` statements at the top of the file. Mirrors the
// JS/TS / Python equivalents in extractSymbols.ts so the chip view's
// "1:1 file coverage" guarantee holds.
// ============================================================================

function extractGoImportHeader(rootNode: Node): ExtractedSymbol | null {
  const headerNodes: Node[] = [];
  let firstLine = -1;
  let lastLine = -1;
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const c = rootNode.namedChild(i);
    if (!c) continue;
    if (c.type === 'import_declaration') {
      headerNodes.push(c);
      if (firstLine < 0) firstLine = c.startPosition.row + 1;
      lastLine = c.endPosition.row + 1;
    } else if (c.type === 'package_clause') {
      // Package clause comes BEFORE imports in valid Go. Don't include
      // it in the import block, but also don't terminate the header on it.
      continue;
    } else if (firstLine >= 0) {
      // First non-import / non-package statement closes the header.
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
// Top-level dispatcher — walk children of the file's root node and
// emit one or more ExtractedSymbol per recognised statement kind.
// ============================================================================

interface PendingMethod {
  receiverType: string;
  symbol: ExtractedSymbol;
}

function extractTopLevel(rootNode: Node): {
  symbols: ExtractedSymbol[];
  pendingMethods: PendingMethod[];
} {
  const symbols: ExtractedSymbol[] = [];
  const pendingMethods: PendingMethod[] = [];
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const node = rootNode.namedChild(i);
    if (!node) continue;
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        symbols.push(
          makeSymbol(
            node,
            nameNode.text,
            'function',
            undefined,
            [],
            extractGoParams(node),
          ),
        );
        break;
      }
      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) break;
        const recvType = extractReceiverTypeName(node);
        const sym = makeSymbol(
          node,
          nameNode.text,
          'method',
          recvType ?? undefined,
          [],
          extractGoParams(node),
        );
        if (recvType) {
          // Re-parented in second pass when we know whether the
          // receiver type's symbol exists in this file.
          pendingMethods.push({ receiverType: recvType, symbol: sym });
        } else {
          // Receiver type wasn't extractable — surface the method at
          // top level rather than dropping it.
          symbols.push(sym);
        }
        break;
      }
      case 'type_declaration':
        symbols.push(...extractTypeDeclaration(node, undefined));
        break;
      case 'var_declaration':
      case 'const_declaration':
        symbols.push(...extractValueDeclaration(node, undefined));
        break;
      // package_clause / import_declaration / comment — handled
      // elsewhere or ignored.
    }
  }
  return { symbols, pendingMethods };
}

/** Second pass: attach methods to their receiver type's symbol when
 *  that type lives in this file. Methods whose receiver type isn't a
 *  top-level type here (e.g. methods on imported types — uncommon)
 *  fall through to top-level emission. */
function attachMethods(
  symbols: ExtractedSymbol[],
  pending: PendingMethod[],
): ExtractedSymbol[] {
  if (pending.length === 0) return symbols;
  const byName = new Map<string, ExtractedSymbol>();
  for (const s of symbols) {
    if (s.kind === 'class' || s.kind === 'interface') byName.set(s.name, s);
  }
  const orphans: ExtractedSymbol[] = [];
  for (const m of pending) {
    const host = byName.get(m.receiverType);
    if (host) {
      host.children = [...host.children, m.symbol];
    } else {
      orphans.push(m.symbol);
    }
  }
  return [...symbols, ...orphans];
}

// ============================================================================
// Imports + call sites
// ============================================================================

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    (s[0] === '"' || s[0] === "'" || s[0] === '`') &&
    s[s.length - 1] === s[0]
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Walk every `import_declaration` and emit one ImportBinding per
 *  import_spec. Local name is the alias (`x` in `import x "github.com/foo"`)
 *  or the last path segment (Go's default — `path/to/foo` binds `foo`).
 *  Anonymous imports (`import _ "spec"`) and dot-imports (`import . "spec"`)
 *  produce a binding too — they DO depend on the spec, even if no local
 *  name is added to scope (`_` is a sentinel; `.` brings everything in). */
function extractGoImports(rootNode: Node): ImportExtraction {
  const specs: string[] = [];
  const bindings: ImportBinding[] = [];
  function visit(node: Node) {
    if (node.type === 'import_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        if (c.type === 'import_spec') {
          processSpec(c);
        } else if (c.type === 'import_spec_list') {
          // `import ( "a"; "b" )` — grouped form.
          for (let j = 0; j < c.namedChildCount; j++) {
            const sp = c.namedChild(j);
            if (sp?.type === 'import_spec') processSpec(sp);
          }
        }
      }
      return;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) visit(child);
    }
  }
  function processSpec(spec: Node): void {
    const pathNode = spec.childForFieldName('path');
    if (!pathNode) return;
    const specifier = stripQuotes(pathNode.text);
    if (!specifier) return;
    specs.push(specifier);
    const nameNode = spec.childForFieldName('name');
    let localName: string;
    if (nameNode) {
      localName = nameNode.text; // alias, `_`, or `.`
    } else {
      // Default binding: last path segment.
      const segs = specifier.split('/');
      localName = segs[segs.length - 1] || specifier;
    }
    bindings.push({
      specifier,
      importedName: '*', // Go imports a whole package, not specific names
      localName,
    });
  }
  visit(rootNode);
  return { specs, bindings };
}

/** Walk the AST collecting `call_expression` nodes. For each, record
 *  the callee leaf name and (when the callee is a `selector_expression`)
 *  the receiver root identifier. Mirrors the JS/TS extractor in
 *  extractCalls.ts; just dispatched on Go's node-type names. */
function extractGoCallSites(rootNode: Node): RawCall[] {
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
    }
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
  if (node.type === 'selector_expression') {
    const field = node.childForFieldName('field');
    return field?.text ?? null;
  }
  if (node.type === 'call_expression') {
    return calleeLeafName(node.childForFieldName('function'));
  }
  return null;
}

function receiverRootName(node: Node | null): string | undefined {
  if (!node || node.type !== 'selector_expression') return undefined;
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === 'identifier') return cur.text;
    if (cur.type === 'selector_expression') {
      cur = cur.childForFieldName('operand');
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ============================================================================
// T3: project context, specifier resolution, call resolution
// ============================================================================

/** Internal shape of Go handler's ProjectContext. Cast inside this
 *  module only. */
interface GoProjectContext {
  cwd: string;
  /** Module path from `go.mod`'s `module` directive, or null if no
   *  go.mod. Used to detect same-module imports vs external. */
  modulePath: string | null;
  /** Directory (project-relative) → list of `.go` files in that
   *  directory. Drives both same-package call resolution AND
   *  cross-package specifier resolution (every Go file in a directory
   *  shares a package, so picking any one as the "target" file for
   *  resolveSpecifier suffices — symbols from siblings get found via
   *  the same-directory walk in resolveCall). */
  dirToGoFiles: Map<string, string[]>;
}

/** Read the `module` line from `go.mod` if present. Cheap regex
 *  rather than parsing the full Go-mod grammar — `module <path>` is
 *  always the first/early non-comment line. */
async function readModulePath(cwd: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(cwd, 'go.mod'), 'utf8');
    const m = /^\s*module\s+(\S+)/m.exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null; // no go.mod or unreadable — module-less project
  }
}

/** Bucket `.go` files by their containing directory so resolveCall can
 *  scan same-package siblings without re-iterating the full file set
 *  on every callsite. */
function bucketGoFilesByDir(
  fileSet: ReadonlySet<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of fileSet) {
    if (!f.endsWith('.go')) continue;
    const dir = path.dirname(f);
    const list = out.get(dir);
    if (list) list.push(f);
    else out.set(dir, [f]);
  }
  return out;
}

// ============================================================================
// Public handler
// ============================================================================

export const goHandler: LanguageHandler = {
  grammarId: 'go',
  extensions: ['.go'],

  extractSymbols(rootNode: Node, _source: string): ExtractedSymbol[] {
    const out: ExtractedSymbol[] = [];
    const header = extractGoImportHeader(rootNode);
    if (header) out.push(header);
    const { symbols, pendingMethods } = extractTopLevel(rootNode);
    out.push(...attachMethods(symbols, pendingMethods));
    out.push(...computeFillerBlocks(rootNode, out));
    return out;
  },

  extractImports(rootNode: Node): ImportExtraction {
    return extractGoImports(rootNode);
  },

  extractCallSites(rootNode: Node, _symbols: IndexedSymbol[]): RawCall[] {
    return extractGoCallSites(rootNode);
  },

  // -------- T3: call graph --------

  async buildProjectContext(
    cwd: string,
    fileSet: ReadonlySet<string>,
  ): Promise<ProjectContext> {
    const modulePath = await readModulePath(cwd);
    const dirToGoFiles = bucketGoFilesByDir(fileSet);
    const ctx: GoProjectContext = { cwd, modulePath, dirToGoFiles };
    return ctx;
  },

  resolveSpecifier(
    spec: string,
    _fromFilePath: string,
    ctx: ProjectContext,
    _fileSet: ReadonlySet<string>,
  ): string | null {
    const c = ctx as GoProjectContext;
    if (!c.modulePath) return null;
    // Same-module imports start with the module path. Strip it to get
    // a project-relative directory.
    if (spec === c.modulePath) {
      // `import "<modulePath>"` — root package directory.
      const files = c.dirToGoFiles.get('.');
      return files?.[0] ?? null;
    }
    if (spec.startsWith(c.modulePath + '/')) {
      const relDir = spec.slice(c.modulePath.length + 1);
      const files = c.dirToGoFiles.get(relDir);
      // Pick any file in the dir — the resolver only uses this to
      // anchor lookups; same-directory siblings get scanned via
      // dirToGoFiles in resolveCall, so any anchor works.
      return files?.[0] ?? null;
    }
    // External (stdlib `fmt`, third-party `github.com/x/y`, etc.).
    return null;
  },

  resolveCall(
    call: RawCall,
    from: IndexedSymbol,
    fromFile: IndexedFile,
    allFiles: ReadonlyMap<string, IndexedFile>,
    ctx: ProjectContext,
  ): CallResolution[] {
    const c = ctx as GoProjectContext;
    const fromDir = path.dirname(fromFile.path);
    const samePackageFiles = c.dirToGoFiles.get(fromDir) ?? [fromFile.path];

    // Receiver-based path: `pkg.Func()` or `obj.Method()`.
    if (call.receiverName) {
      // Case A: receiver is an import binding → cross-package or external.
      const recvBinding = fromFile.bindingsByLocalName.get(call.receiverName);
      if (recvBinding) {
        const recvFilePath = fromFile.resolvedImports.get(recvBinding.specifier);
        if (!recvFilePath) {
          // External package — `fmt.Println()`, etc.
          return [
            {
              kind: 'external',
              name: call.calleeName,
              packageSpec: recvBinding.specifier,
            },
          ];
        }
        // Cross-package: scan EVERY .go file in the target directory
        // for a top-level symbol with the right name. Go's package
        // model means the symbol could live in any sibling file.
        const targetDir = path.dirname(recvFilePath);
        const dirFiles = c.dirToGoFiles.get(targetDir) ?? [];
        for (const fp of dirFiles) {
          const tf = allFiles.get(fp);
          if (!tf) continue;
          const candidates = tf.symbolsByName.get(call.calleeName);
          if (!candidates) continue;
          let sym: IndexedSymbol | undefined;
          for (const s of candidates) {
            if (s.qualifiedName.includes('>')) continue;
            if (!isCallableKind(s.kind)) continue;
            sym = s;
            break;
          }
          if (sym) {
            return [
              {
                kind: 'symbol',
                addr: {
                  filePath: sym.filePath,
                  qualifiedName: sym.qualifiedName,
                },
              },
            ];
          }
        }
        // Package found but symbol unresolved → external (Go usually
        // means we missed an exported symbol; better than dropping).
        return [
          {
            kind: 'external',
            name: call.calleeName,
            packageSpec: recvBinding.specifier,
          },
        ];
      }

      // Case B: receiver isn't an import → likely a local var of a
      // same-package struct type. Look for `<receiverType>>method`
      // qname across same-package files. Without type info we can't
      // know the receiver's type from `obj` alone, so we settle for:
      //   - `<receiverName>.method()` matches `<receiverName>>method`
      //     when receiverName IS itself a struct type (rare but
      //     happens for static calls / type-named instances).
      // Otherwise emit method-unresolved so chip view at least shows
      // the call exists.
      const methodQname = `${call.receiverName}>${call.calleeName}`;
      for (const fp of samePackageFiles) {
        const tf = allFiles.get(fp);
        if (!tf) continue;
        const sym = tf.symbolsByQname.get(methodQname);
        if (sym && isCallableKind(sym.kind)) {
          return [
            {
              kind: 'symbol',
              addr: {
                filePath: sym.filePath,
                qualifiedName: sym.qualifiedName,
              },
            },
          ];
        }
      }
      return [
        {
          kind: 'method-unresolved',
          receiverName: call.receiverName,
          methodName: call.calleeName,
        },
      ];
    }

    // Bare-name path: `foo()`. Go has no dot-imports, so this MUST be
    // a same-package call (or a builtin like `len`/`make` we silently
    // drop). Scan all .go files in the same directory.
    const out: CallResolution[] = [];
    for (const fp of samePackageFiles) {
      const tf = allFiles.get(fp);
      if (!tf) continue;
      const candidates = tf.symbolsByName.get(call.calleeName);
      if (!candidates) continue;
      for (const s of candidates) {
        if (s.qualifiedName === from.qualifiedName) continue;
        if (s.qualifiedName.includes('>')) continue; // top-level only for bare names
        if (!isCallableKind(s.kind)) continue;
        out.push({
          kind: 'symbol',
          addr: { filePath: s.filePath, qualifiedName: s.qualifiedName },
        });
      }
    }
    return out;
  },

  moduleForFile(filePath: string, ctx: ProjectContext): string {
    // Use module path + relative dir if we have a go.mod; falls back
    // to bare directory when not in a Go module.
    const c = ctx as GoProjectContext | undefined;
    const dir = path.dirname(filePath);
    if (!c?.modulePath) return dir;
    return dir === '.' ? c.modulePath : `${c.modulePath}/${dir}`;
  },
};

function isCallableKind(k: IndexedSymbol['kind']): boolean {
  return k === 'function' || k === 'class' || k === 'method';
}
