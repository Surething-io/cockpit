/**
 * Server-side tree-sitter loader.
 *
 * Mirrors the browser-side `src/lib/codeMap/treeSitter.ts` but loads WASMs
 * from the filesystem (via `public/tree-sitter/`) instead of a `/tree-sitter/`
 * HTTP path. `web-tree-sitter` has built-in Node detection — when given an
 * absolute filesystem path, `Language.load` reads it via `fs.promises.readFile`.
 *
 * Why a separate file from the browser loader: the browser uses fetch URLs,
 * the server uses fs paths. Trying to share resolution logic across both is
 * more trouble than the duplication.
 *
 * Singleton + cached promise per grammar — same pattern as the browser side.
 */

import { Parser, Language } from 'web-tree-sitter';
import path from 'node:path';

/**
 * Absolute path to the bundled tree-sitter WASMs.
 * `process.cwd()` is the project root for both `npm run dev` and the
 * production `cock` CLI (server.mjs / bin/cock.mjs both start from project root).
 * If a deployment scenario violates this assumption we'll need a fallback.
 */
const WASM_DIR = path.join(process.cwd(), 'public', 'tree-sitter');

/** Grammar ids we currently bundle. Extend in lockstep with the browser-side `SUPPORTED_GRAMMARS`. */
export type ServerGrammarId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust';

let initPromise: Promise<void> | null = null;
const grammarPromises = new Map<ServerGrammarId, Promise<Language>>();

function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      // Resolve `web-tree-sitter.wasm` (the runtime) from the same directory.
      locateFile(name: string) {
        return path.join(WASM_DIR, name);
      },
    });
  }
  return initPromise;
}

function loadGrammar(id: ServerGrammarId): Promise<Language> {
  let p = grammarPromises.get(id);
  if (!p) {
    p = (async () => {
      await initParser();
      return Language.load(path.join(WASM_DIR, `tree-sitter-${id}.wasm`));
    })();
    grammarPromises.set(id, p);
  }
  return p;
}

/**
 * Get a Parser bound to the given grammar.
 *
 * Returns a CACHED Parser per grammar id. Tree-sitter `parser.parse()` is
 * synchronous and JS is single-threaded, so even when many file extractions
 * are scheduled with `Promise.all`, only one parse runs at a time per
 * grammar — sharing a single Parser per language is safe and avoids the
 * per-file allocation cost (significant when scanning thousands of files).
 */
const parserCache = new Map<ServerGrammarId, Parser>();
export async function getServerParser(id: ServerGrammarId): Promise<Parser> {
  let parser = parserCache.get(id);
  if (parser) return parser;
  const language = await loadGrammar(id);
  parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(id, parser);
  return parser;
}

/** Path → grammar mapping. Add new languages here when bundling new WASMs. */
export function grammarForExtension(filePath: string): ServerGrammarId | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'typescript';
    case '.tsx':
    case '.jsx':   // TSX grammar handles JSX; share until we ship a separate JSX grammar.
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    default:
      return null;
  }
}
