import type { ProjectContextFiles } from './types';
/**
 * TypeScript family handler — covers TS, TSX, JS, JSX, MJS, CJS.
 *
 * One handler instance, registered three times under three grammar
 * ids (TS / TSX / JS) — see `index.ts` for the registrations. Each
 * registration contributes its own `extensions` set; the handler
 * itself is grammar-agnostic at the method level because:
 *
 *   - `extractSymbols`, `extractImports`, `extractCallSites` all
 *     dispatch on tree-sitter NODE TYPES, not grammar id. The
 *     parser-bound rootNode already encodes which grammar parsed
 *     it, so a TS-shape AST and a JSX-shape AST flow through the
 *     same code without conditionals.
 *
 *   - The TS / TSX / JSX grammars share enough node-type vocabulary
 *     (`function_declaration`, `class_declaration`, `import_statement`,
 *     `call_expression`) that the existing implementation in
 *     `extractSymbols.ts` / `extractCalls.ts` / `extractImports.ts`
 *     handles all three with one code path. We delegate to those
 *     existing modules for now; P1b will inline them here.
 *
 * P1a status: this handler delegates to the legacy module-level
 * functions. The abstraction is structurally in place — codeIndex's
 * extraction step now goes through the handler — but the per-method
 * code still lives in the legacy files. P1b will move the bodies
 * into this file and slim the legacy files down to shared helpers.
 *
 * Resolution methods (`resolveSpecifier`, `resolveCall`,
 * `moduleForFile`, `buildProjectContext`) are STUBS in P1a — the
 * codeIndex resolveCallSites pipeline still invokes the legacy
 * resolution logic directly. P1b moves that into the handler too.
 */

import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type {
  CallResolution,
  ImportExtraction,
  LanguageHandler,
  ProjectContext,
} from './types';
import type { GrammarId } from '../languageMap';
import { extractSymbolsFromTree } from '../extractSymbols';
import {
  extractImportBindings,
  extractRawCalls,
  extractReexports,
  type RawCall,
  type ImportBinding,
} from '../extractCalls';
import { extractImportsFromTree } from '../projectGraph/extractImports';
import type { ExtractedSymbol } from '../types';
import type {
  IndexedFile,
  IndexedSymbol,
} from '../projectGraph/codeIndex';
import {
  fileInScope,
  findFileForBase,
  findFileRelativeToProject,
  loadTsconfigs,
  loadWorkspaces,
  type TsconfigScope,
  type Workspace,
} from '../projectGraph/buildGraph';

/** Internal shape of TS handler's ProjectContext — accessed via cast
 *  inside this module only; opaque to callers. */
interface TsProjectContext {
  cwd: string;
  tsconfigs: TsconfigScope[];
  workspaces: Map<string, Workspace>;
  /** Workspace names sorted longest-first so `@org/foo/bar` matches
   *  `@org/foo` before `@org`. Cached here so resolveSpecifier doesn't
   *  re-sort on every call. */
  sortedWsNames: string[];
  /** Per-file lazy cache of `tsconfigs.filter(t => fileInScope(...))`
   *  — same file usually has many imports, all of which would
   *  otherwise re-run the same filter. Keyed by `fromFilePath`,
   *  filled on first lookup and reused for subsequent specs. */
  owningScopesCache: Map<string, TsconfigScope[]>;
}

// === Resolution helpers (used by resolveCall below) ===

/** Function-like kinds — what the call graph treats as nodes. */
function isFunctionLikeKind(k: IndexedSymbol['kind']): boolean {
  return k === 'function' || k === 'class' || k === 'method';
}

/** Bound on reexport / receiver chain depth — guards against cycles
 *  AND limits cost on pathological barrel structures. 5 hops is
 *  generous for real codebases. */
const REEXPORT_MAX_DEPTH = 5;

/** A wildcard conflict must propagate through outer barrels. Returning null
 * would let a later branch incorrectly turn that conflict into one valid edge. */
type ExportLookup = IndexedSymbol | 'ambiguous' | null;

/** Resolve only public names. Explicit exports override stars, default never
 * flows through a star, and duplicate paths to the same definition are harmless.
 * Keep traversal state per branch so a cycle cannot hide a sibling's export. */
function findExportedSymbol(
  file: IndexedFile,
  name: string,
  depth: number,
  visited: ReadonlySet<string>,
  allFiles: ReadonlyMap<string, IndexedFile>,
): ExportLookup {
  const key = JSON.stringify([file.path, name]);
  if (depth > REEXPORT_MAX_DEPTH || visited.has(key)) return null;
  const branch = new Set(visited).add(key);
  const follow = (binding: ImportBinding, importedName: string): ExportLookup => {
    const nextPath = file.resolvedImports.get(binding.specifier);
    const nextFile = nextPath && allFiles.get(nextPath);
    return nextFile ? findExportedSymbol(nextFile, importedName, depth + 1, branch, allFiles) : null;
  };

  const explicit = file.reexportsByLocalName.get(name);
  if (explicit && name !== '*') {
    if (explicit.specifier) return follow(explicit, explicit.importedName);
    const candidates = file.symbolsByName.get(explicit.importedName);
    let best: IndexedSymbol | null = null;
    for (const symbol of candidates ?? []) {
      if (symbol.qualifiedName.includes('>')) continue;
      if (!best || (isFunctionLikeKind(symbol.kind) && !isFunctionLikeKind(best.kind))
        || (symbol.kind === best.kind && symbol.endLine - symbol.startLine > best.endLine - best.startLine)) {
        best = symbol;
      }
    }
    if (best) return best;
    // `import { foo } from './a'; export { foo as bar }` forwards the import.
    const imported = file.bindingsByLocalName.get(explicit.importedName);
    return imported ? follow(imported, imported.importedName) : null;
  }
  if (name === 'default') return null;
  let found: IndexedSymbol | null = null;
  for (const binding of file.importBindings) {
    if (!binding.isReexport || binding.localName !== '*' || binding.importedName !== '*') continue;
    const result = follow(binding, name);
    if (result === 'ambiguous') return result;
    if (!result) continue;
    if (found && (found.filePath !== result.filePath || found.qualifiedName !== result.qualifiedName)) return 'ambiguous';
    found = result;
  }
  return found;
}

/** Resolve namespace members and methods on exported objects/classes through
 * the same export lookup as bare calls, including wildcard barrel chains. */
function findReceiverMethod(
  file: IndexedFile,
  receiverImportedName: string,
  methodName: string,
  depth: number,
  visited: ReadonlySet<string>,
  allFiles: ReadonlyMap<string, IndexedFile>,
): IndexedSymbol | null {
  if (depth > REEXPORT_MAX_DEPTH) return null;
  if (receiverImportedName === '*') {
    const symbol = findExportedSymbol(file, methodName, depth, visited, allFiles);
    return symbol && symbol !== 'ambiguous' && isFunctionLikeKind(symbol.kind) ? symbol : null;
  }
  const key = JSON.stringify([file.path, receiverImportedName, methodName]);
  if (visited.has(key)) return null;
  const branch = new Set(visited).add(key);
  const reexport = file.reexportsByLocalName.get(receiverImportedName);
  if (reexport?.specifier && reexport.importedName === '*') {
    const nextPath = file.resolvedImports.get(reexport.specifier);
    const nextFile = nextPath && allFiles.get(nextPath);
    return nextFile ? findReceiverMethod(nextFile, '*', methodName, depth + 1, branch, allFiles) : null;
  }
  const receiver = findExportedSymbol(file, receiverImportedName, depth, branch, allFiles);
  if (!receiver || receiver === 'ambiguous') return null;
  const owner = allFiles.get(receiver.filePath);
  const member = owner?.symbolsByQname.get(`${receiver.qualifiedName}>${methodName}`);
  return member && isFunctionLikeKind(member.kind) ? member : null;
}

/** Build a TS-family handler for one grammar id + extension set.
 *  Same handler logic, three registrations (typescript / tsx / javascript). */
function makeTsFamilyHandler(
  grammarId: GrammarId,
  extensions: readonly string[],
): LanguageHandler {
  return {
    grammarId,
    extensions,

    extractSymbols(root: Node, _source: string): ExtractedSymbol[] {
      return extractSymbolsFromTree(root);
    },

    extractImports(root: Node): ImportExtraction {
      // Three legacy extractors combined into one ImportExtraction:
      //   - extractImportsFromTree → spec strings (file-graph layer;
      //     includes side-effect / dynamic / require imports)
      //   - extractImportBindings  → regular per-name bindings
      //   - extractReexports       → reexport bindings (same shape, with
      //                              `isReexport: true`); concatenated
      //                              after baseBindings into the same
      //                              flat array. The resolver filters
      //                              by `b.isReexport` when it needs
      //                              barrel-chain semantics.
      const specs = extractImportsFromTree(root, grammarId);
      const baseBindings = extractImportBindings(root);
      const reexportBindings = extractReexports(root);
      return {
        specs,
        bindings: [...baseBindings, ...reexportBindings],
      };
    },

    extractCallSites(
      root: Node,
      _symbols: IndexedSymbol[],
    ): RawCall[] {
      // The legacy extractor doesn't need the symbol list — call-to-
      // caller attribution is done LATER inside the codeIndex
      // resolution pass (`findEnclosingFlat`). The interface accepts
      // `symbols` for handler implementations that DO want to attribute
      // at extraction time; the TS implementation ignores it.
      return extractRawCalls(root);
    },

    // ----------------------------------------------------------------
    // Project context — loads tsconfig path aliases + workspace
    // packages so resolveSpecifier can match aliased imports
    // (`@/foo`, `@org/auth`) without re-reading filesystem on every
    // resolve. Async because both loaders read JSON files.
    // ----------------------------------------------------------------

    async buildProjectContext(
      cwd: string,
      fileSet: ReadonlySet<string>,
      files?: ProjectContextFiles,
    ): Promise<ProjectContext> {
      // loadWorkspaces wants a mutable Set; the contract gives us a
      // ReadonlySet. Copy to satisfy the type — workspaces detection
      // doesn't mutate, the type is just stricter than the impl.
      const mutableFileSet = new Set(fileSet);
      const tsconfigs = await loadTsconfigs(cwd, files);
      const workspaces = await loadWorkspaces(cwd, mutableFileSet, files);
      const sortedWsNames = [...workspaces.keys()].sort(
        (a, b) => b.length - a.length,
      );
      const ctx: TsProjectContext = {
        cwd,
        tsconfigs,
        workspaces,
        sortedWsNames,
        owningScopesCache: new Map(),
      };
      return ctx;
    },

    resolveSpecifier(
      spec: string,
      fromFilePath: string,
      ctx: ProjectContext,
      fileSet: ReadonlySet<string>,
    ): string | null {
      const c = ctx as TsProjectContext;
      // loadWorkspaces / findFileForBase / findFileRelativeToProject
      // expect a Set (originally written before the readonly contract).
      // Copy keeps the call shape stable; cheap relative to the cost
      // of the path operations.
      const mutableFileSet = fileSet as Set<string>;

      // Per-file owning tsconfig scopes. Cached on first lookup —
      // a file's owningScopes is fixed for the duration of one
      // buildCodeIndex run and the same file usually triggers many
      // resolveSpecifier calls (one per import).
      let owningScopes = c.owningScopesCache.get(fromFilePath);
      if (!owningScopes) {
        owningScopes = c.tsconfigs.filter((t) =>
          fileInScope(fromFilePath, t.scope),
        );
        c.owningScopesCache.set(fromFilePath, owningScopes);
      }

      // Relative path: `./foo`, `../bar`. Resolve against the file's
      // own directory.
      if (spec.startsWith('./') || spec.startsWith('../')) {
        return findFileForBase(
          path.resolve(c.cwd, path.dirname(fromFilePath), spec),
          c.cwd,
          mutableFileSet,
        );
      }
      // Project-absolute (rare in TS but valid): `/foo` → `<cwd>/foo`.
      if (spec.startsWith('/')) {
        return findFileForBase(
          path.resolve(c.cwd, spec.slice(1)),
          c.cwd,
          mutableFileSet,
        );
      }
      // Aliased import — walk owning tsconfig scopes deepest-first so
      // a more-specific scope wins. Within each scope, longest-prefix
      // alias wins (so `@/lib/foo` matches `@/lib` over `@/`).
      // Sort lives on the scope itself (precomputed in loadTsconfigs);
      // we just `find` here.
      for (const ts of owningScopes) {
        const hit = ts.sortedAliases.find(
          ([prefix]) => spec === prefix || spec.startsWith(prefix + '/'),
        );
        if (!hit) continue;
        const [prefix, target] = hit;
        const remainder = spec === prefix ? '' : spec.slice(prefix.length + 1);
        const r = findFileForBase(
          path.resolve(c.cwd, target, remainder),
          c.cwd,
          mutableFileSet,
        );
        if (r) return r;
      }
      // Workspace package — `@org/foo` → `packages/foo/<entry or subpath>`.
      // Workspace names are pre-sorted longest-first in the context.
      for (const pkgName of c.sortedWsNames) {
        if (spec !== pkgName && !spec.startsWith(pkgName + '/')) continue;
        const ws = c.workspaces.get(pkgName)!;
        if (spec === pkgName) return ws.entryFile;
        const subpath = spec.slice(pkgName.length + 1);
        return (
          findFileRelativeToProject(
            path.posix.join(ws.dir, subpath),
            mutableFileSet,
          ) ??
          findFileRelativeToProject(
            path.posix.join(ws.dir, 'src', subpath),
            mutableFileSet,
          )
        );
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
      // Receiver-based path: `obj.method()` where `obj` is an import.
      // Tier 1 + Tier 2 of the legacy resolver — emits ONE outcome:
      //   - target found       → ['symbol']
      //   - receiver resolves but method missing → ['method-unresolved']
      //   - receiver isn't a project import (local var / external)
      //                        → []  (drop; we don't double-count)
      if (call.receiverName) {
        // bindingsByLocalName already excludes reexports (they don't
        // introduce a local name; lookup goes to the separate
        // reexportsByLocalName map for chain-follower use only).
        const recvBinding = fromFile.bindingsByLocalName.get(call.receiverName);
        // Local var / global / unknown — silently drop (no static info).
        if (!recvBinding) return [];
        const recvFilePath = fromFile.resolvedImports.get(recvBinding.specifier);
        // External package — already surfaced via the bare-name path's
        // EXT pin emission upstream; don't double-count here.
        if (!recvFilePath) return [];
        const recvTarget = allFiles.get(recvFilePath);
        if (!recvTarget) return [];
        const sym = findReceiverMethod(
          recvTarget,
          recvBinding.importedName,
          call.calleeName,
          0,
          new Set<string>(),
          allFiles,
        );
        if (sym) {
          return [
            {
              kind: 'symbol',
              addr: { filePath: sym.filePath, qualifiedName: sym.qualifiedName },
            },
          ];
        }
        // Receiver is a real project import but the method itself
        // didn't resolve — visibility-only METHOD pin.
        return [
          {
            kind: 'method-unresolved',
            receiverName: call.receiverName,
            methodName: call.calleeName,
          },
        ];
      }

      // Bare name path: `foo()`. Local match shadows imports — TS scoping.
      // Multiple local matches are real (same name as both a bare
      // function and a class member). Emit one CallResolution per
      // match so codeIndex sees each as a separate intra edge.
      const localMatches = fromFile.symbolsByName.get(call.calleeName);
      if (localMatches && localMatches.length > 0) {
        const out: CallResolution[] = [];
        for (const callee of localMatches) {
          if (callee.qualifiedName === from.qualifiedName) continue; // self
          if (!isFunctionLikeKind(callee.kind)) continue;
          out.push({
            kind: 'symbol',
            addr: {
              filePath: callee.filePath,
              qualifiedName: callee.qualifiedName,
            },
          });
        }
        return out;
      }

      // Import-resolved cross-file path. bindingsByLocalName
      // already filters out reexports (they don't introduce a
      // local name).
      const binding = fromFile.bindingsByLocalName.get(call.calleeName);
      if (!binding) return [];
      const targetFile = fromFile.resolvedImports.get(binding.specifier);
      if (!targetFile) {
        // Spec didn't resolve — external package call.
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
      // findExportedSymbol: barrel-aware lookup. If `target` has a
      // direct symbol with the imported name, use it; else walk
      // `target.reexports` chain to the real definition.
      const sym = findExportedSymbol(
        target,
        binding.importedName,
        0,
        new Set<string>(),
        allFiles,
      );
      if (!sym || sym === 'ambiguous' || !isFunctionLikeKind(sym.kind)) return [];
      return [
        {
          kind: 'symbol',
          addr: { filePath: sym.filePath, qualifiedName: sym.qualifiedName },
        },
      ];
    },

    moduleForFile(filePath: string, _ctx: ProjectContext): string {
      return filePath;
    },
  };
}

// === Three registrations (handler logic shared, extensions differ) ===

export const typescriptHandler = makeTsFamilyHandler('typescript', ['.ts']);
export const tsxHandler = makeTsFamilyHandler('tsx', ['.tsx', '.jsx']);
export const javascriptHandler = makeTsFamilyHandler('javascript', [
  '.js',
  '.mjs',
  '.cjs',
]);
