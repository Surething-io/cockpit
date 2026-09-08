/**
 * Lean 4 handler — symbol index only, no call graph.
 *
 * This is the first handler that deliberately implements only ONE of the three
 * extraction methods for real. That is not laziness, it is the shape of the
 * language as it is actually used:
 *
 *   extractImports  → `[]`. Every file in a Mathlib project opens with
 *                     `import Mathlib`, so the import graph is |files| edges
 *                     into a single node. Building it costs a full walk per
 *                     file and tells a reviewer nothing they didn't know.
 *   extractCallSites→ `[]`. A Lean proof body is a tactic script; what it
 *                     "calls" are lemmas resolved by elaboration against
 *                     Mathlib, which tree-sitter cannot see and which mostly
 *                     live outside the project anyway. A best-effort
 *                     identifier scrape would produce a graph that is almost
 *                     entirely wrong edges to external names — worse than no
 *                     graph, because the UI would render it as fact.
 *
 * What IS worth having, and what this handler exists for, is the symbol index:
 * `search` / `file` / the Cmd+K palette over declaration names. On a
 * formalization repo that is tens of thousands of theorem names — the single
 * most useful thing the Code Map can offer for this language.
 *
 * Registering this handler is what admits `.lean` into `codeIndex` at all; see
 * `grammarForExtension` in `projectGraph/serverTreeSitter.ts`, which gates the
 * file walk and must list `.lean` in lockstep with `extensions` below.
 */

import type { Node } from 'web-tree-sitter';
import type {
  CallResolution,
  ImportExtraction,
  LanguageHandler,
  ProjectContext,
} from './types';
import type { ExtractedSymbol } from '../types';
import type { IndexedSymbol } from '../projectGraph/codeIndex';
import type { RawCall } from '../extractCalls';
import { extractSymbolsFromTree } from '../extractSymbols';

export const leanHandler: LanguageHandler = {
  grammarId: 'lean',
  extensions: ['.lean'],

  extractSymbols(root: Node, _source: string): ExtractedSymbol[] {
    // The `'lean'` argument selects the namespace-stack walker; without it the
    // TS/JS dispatcher runs and silently returns nothing for a Lean AST.
    return extractSymbolsFromTree(root, 'lean');
  },

  extractImports(_root: Node): ImportExtraction {
    // Intentionally empty — see the file header. `import Mathlib` in every
    // file makes this graph pure noise.
    return { specs: [], bindings: [] };
  },

  extractCallSites(_root: Node, _symbols: IndexedSymbol[]): RawCall[] {
    // Intentionally empty — see the file header.
    return [];
  },

  buildProjectContext(): ProjectContext {
    return undefined;
  },

  resolveSpecifier(): string | null {
    // Unreachable in practice: `extractImports` emits no specs, so nothing
    // ever asks for a resolution. Null is the honest answer regardless.
    return null;
  },

  resolveCall(): CallResolution[] {
    // Unreachable in practice: `extractCallSites` emits no calls.
    return [];
  },

  moduleForFile(filePath: string): string {
    // Lean's own module name IS the path: `Theorems/Thm_Foo.lean` is imported
    // as `Theorems.Thm_Foo`. Reproducing that (rather than Python's
    // return-the-path fallback) makes the module-graph labels match what a
    // reader would type in an `import` line.
    return filePath.replace(/\.lean$/i, '').replace(/[/\\]/g, '.');
  },
};
