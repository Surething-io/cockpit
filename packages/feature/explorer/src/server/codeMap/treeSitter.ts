/**
 * Tree-sitter loader — initializes the WASM runtime once and caches each grammar.
 *
 * All WASMs are served from `/tree-sitter/` (public/ at build time). This keeps
 * the application "purely local" — no CDN or network dependency at runtime.
 *
 * Concurrency:
 * - `Parser.init` is called at most once (cached promise).
 * - Each grammar's load is also a cached promise so concurrent callers share work.
 *
 * Threading note: this currently runs on the main thread. For very large files
 * a Web Worker would be better, but for typical change-review (a few files at a
 * time, under ~5k lines each) main-thread parsing finishes in milliseconds.
 */

import { Parser, Language } from 'web-tree-sitter';
import type { GrammarId } from './languageMap';

const GRAMMAR_BASE = '/tree-sitter';

let initPromise: Promise<void> | null = null;
const grammarPromises = new Map<GrammarId, Promise<Language>>();

function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      // The Emscripten module looks up `web-tree-sitter.wasm` next to the loader
      // by default. We override to serve from /tree-sitter/.
      locateFile(scriptName: string) {
        return `${GRAMMAR_BASE}/${scriptName}`;
      },
    });
  }
  return initPromise;
}

function loadGrammar(id: GrammarId): Promise<Language> {
  let p = grammarPromises.get(id);
  if (!p) {
    p = (async () => {
      await initParser();
      return Language.load(`${GRAMMAR_BASE}/tree-sitter-${id}.wasm`);
    })();
    grammarPromises.set(id, p);
  }
  return p;
}

/**
 * Get a Parser configured for the given grammar.
 *
 * Each call returns a *fresh* Parser (cheap to construct) bound to the cached
 * Language. Sharing one Parser across concurrent parse calls is unsafe.
 */
export async function getParserFor(id: GrammarId): Promise<Parser> {
  const language = await loadGrammar(id);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** For tests / debug — clear all caches. */
export function _resetTreeSitterForTest(): void {
  initPromise = null;
  grammarPromises.clear();
}
