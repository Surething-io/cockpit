/**
 * Python handler — covers `.py`, `.pyi`.
 *
 * P1a status: delegates to legacy module-level extractors. Reexports
 * are not a Python concept — `extractReexports` is a no-op for Python
 * grammar and Python's `extractImports.bindings` never carries
 * `isReexport: true`.
 *
 * Resolution methods are stubs in P1a (see typescript.ts for the same
 * pattern). codeIndex.ts's `tryPythonPaths` and the `isPython` branches
 * in `resolveCallSites` continue to do the real work; P1b will move
 * that logic into this handler.
 */

import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type {
  CallResolution,
  ImportExtraction,
  LanguageHandler,
  ProjectContext,
} from './types';
import { extractSymbolsFromTree } from '../extractSymbols';
import {
  extractImportBindings,
  extractRawCalls,
  type RawCall,
} from '../extractCalls';
import { extractImportsFromTree } from '../projectGraph/extractImports';
import type { ExtractedSymbol } from '../types';
import type {
  IndexedFile,
  IndexedSymbol,
} from '../projectGraph/codeIndex';

/** Python doesn't have JS/TS-style barrel reexports, so the receiver
 *  resolution flow is shorter than typescript.ts's. Otherwise the
 *  shape — local-shadows-import, member-chain dispatch, external
 *  fallback — is the same. */
function isFunctionLikeKind(k: IndexedSymbol['kind']): boolean {
  return k === 'function' || k === 'class' || k === 'method';
}

/** Look up an imported name in `file`. Python has no reexport chain,
 *  so this is a direct flatSymbols search — the OUTERMOST match wins
 *  to point at the top-level definition over nested helpers. Uses the
 *  precomputed `symbolsByName` map for O(1) candidate fetch. */
function findExportedSymbolPy(
  file: IndexedFile,
  name: string,
): IndexedSymbol | null {
  const candidates = file.symbolsByName.get(name);
  if (!candidates) return null;
  let best: IndexedSymbol | null = null;
  for (const s of candidates) {
    if (!isFunctionLikeKind(s.kind)) continue;
    if (!best || s.endLine - s.startLine > best.endLine - best.startLine) {
      best = s;
    }
  }
  return best;
}

/** Receiver method lookup for Python — same strategy 1 + 2 as TS but
 *  no reexport-chain strategy 3. */
function findReceiverMethodPy(
  file: IndexedFile,
  receiverImportedName: string,
  methodName: string,
): IndexedSymbol | null {
  if (receiverImportedName !== '*') {
    const nestedQname = `${receiverImportedName}>${methodName}`;
    const nested = file.symbolsByQname.get(nestedQname);
    if (nested && isFunctionLikeKind(nested.kind)) return nested;
  }
  if (receiverImportedName === '*') {
    const top = file.symbolsByName.get(methodName);
    if (top) {
      let best: IndexedSymbol | null = null;
      for (const s of top) {
        if (s.qualifiedName.includes('>')) continue;
        if (!isFunctionLikeKind(s.kind)) continue;
        if (!best || s.endLine - s.startLine > best.endLine - best.startLine) {
          best = s;
        }
      }
      if (best) return best;
    }
  }
  return null;
}

/** Internal shape of Python handler's ProjectContext. Cast inside this
 *  module only. */
interface PyProjectContext {
  cwd: string;
  /** Project roots under which dotted module names (`a.b.c`) are
   *  searched. Two universal Python conventions:
   *    - flat layout: package dirs sit directly under repo root
   *    - src layout: under `<root>/src/`
   *  Trying both covers ~95% of real Python projects without parsing
   *  pyproject.toml. Order matters — flat wins ties to match the
   *  expectation that absolute imports resolve against the
   *  closest-to-root copy first. */
  pythonRoots: string[];
}

/** Look up a Python module path under a given root.
 *
 *    tryPythonPaths('src', 'a.b.c')
 *      → 'src/a/b/c.py'             (regular module — preferred)
 *      → 'src/a/b/c/__init__.py'    (package)
 *
 *  Empty `modulePath` (the `from . import x` form) resolves to the
 *  `__init__.py` of the base directory, since that's the package the
 *  dot refers to.
 *
 *  `baseDir` and the returned path are project-relative — same shape
 *  as the keys in `fileSet`. */
function tryPythonPaths(
  baseDir: string,
  modulePath: string,
  fileSet: ReadonlySet<string>,
): string | null {
  const sub = modulePath.replace(/\./g, '/');
  const join = (...segs: string[]) =>
    segs.filter((s) => s !== '' && s !== '.').join('/');

  if (!sub) {
    // `from . import x` — the package itself.
    const init = join(baseDir, '__init__.py');
    if (fileSet.has(init)) return init;
    return null;
  }
  // Regular module file.
  const direct = join(baseDir, sub + '.py');
  if (fileSet.has(direct)) return direct;
  // Package directory with __init__.py.
  const initFile = join(baseDir, sub, '__init__.py');
  if (fileSet.has(initFile)) return initFile;
  return null;
}

export const pythonHandler: LanguageHandler = {
  grammarId: 'python',
  extensions: ['.py', '.pyi'],

  extractSymbols(root: Node, _source: string): ExtractedSymbol[] {
    return extractSymbolsFromTree(root);
  },

  extractImports(root: Node): ImportExtraction {
    // Python has no reexport concept — bindings list never has
    // isReexport: true. We deliberately don't call extractReexports
    // here; Python ASTs contain no `export_statement` node so it'd be
    // a wasted walk anyway.
    const specs = extractImportsFromTree(root, 'python');
    const bindings = extractImportBindings(root);
    return { specs, bindings };
  },

  extractCallSites(root: Node, _symbols: IndexedSymbol[]): RawCall[] {
    return extractRawCalls(root);
  },

  buildProjectContext(
    cwd: string,
    fileSet: ReadonlySet<string>,
  ): ProjectContext {
    // Detect src/ layout — fast scan over fileSet (no I/O). The two
    // signals are: a `src/__init__.py` exists, OR any `.py` file lives
    // under `src/`. Either is sufficient.
    const pythonRoots: string[] = [cwd];
    let hasSrcLayout = false;
    if (fileSet.has('src/__init__.py')) {
      hasSrcLayout = true;
    } else {
      for (const p of fileSet) {
        if (p.startsWith('src/') && p.endsWith('.py')) {
          hasSrcLayout = true;
          break;
        }
      }
    }
    if (hasSrcLayout) pythonRoots.push(path.join(cwd, 'src'));
    const ctx: PyProjectContext = { cwd, pythonRoots };
    return ctx;
  },

  resolveSpecifier(
    spec: string,
    fromFilePath: string,
    ctx: ProjectContext,
    fileSet: ReadonlySet<string>,
  ): string | null {
    const c = ctx as PyProjectContext;

    // Relative imports — leading dots. ONE dot keeps us in the
    // current package; each additional dot ascends one level.
    //   `.foo`     → caller's dir, then `foo`
    //   `.`        → caller's dir's __init__.py
    //   `..pkg.x`  → up one level, then `pkg/x`
    const dotMatch = /^(\.+)/.exec(spec);
    if (dotMatch) {
      const dots = dotMatch[1].length;
      const rest = spec.slice(dots);
      let baseDir = path.dirname(fromFilePath);
      for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
      return tryPythonPaths(baseDir || '.', rest, fileSet);
    }
    // Absolute import — try every configured root, in flat-then-src order.
    for (const root of c.pythonRoots) {
      const rootRel = path.relative(c.cwd, root) || '.';
      const r = tryPythonPaths(rootRel, spec, fileSet);
      if (r) return r;
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
    if (call.receiverName) {
      const recvBinding = fromFile.bindingsByLocalName.get(call.receiverName);
      if (!recvBinding) return [];
      const recvFilePath = fromFile.resolvedImports.get(recvBinding.specifier);
      if (!recvFilePath) return [];
      const recvTarget = allFiles.get(recvFilePath);
      if (!recvTarget) return [];
      const sym = findReceiverMethodPy(
        recvTarget,
        recvBinding.importedName,
        call.calleeName,
      );
      if (sym) {
        return [
          {
            kind: 'symbol',
            addr: { filePath: sym.filePath, qualifiedName: sym.qualifiedName },
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

    // Local match shadows imports.
    const localMatches = fromFile.symbolsByName.get(call.calleeName);
    if (localMatches && localMatches.length > 0) {
      const out: CallResolution[] = [];
      for (const callee of localMatches) {
        if (callee.qualifiedName === from.qualifiedName) continue;
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

    // Import-resolved cross-file.
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
    const sym = findExportedSymbolPy(target, binding.importedName);
    if (!sym) return [];
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
