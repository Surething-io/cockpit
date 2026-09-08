/**
 * Map a file path to a tree-sitter grammar identifier.
 *
 * Add a language here when you also bundle the corresponding
 * `tree-sitter-<lang>.wasm` into `public/tree-sitter/` — either by adding it
 * to `GRAMMARS` in `scripts/copy-tree-sitter-wasms.mjs` (if
 * @vscode/tree-sitter-wasm ships it) or to that script's `VENDORED` list
 * (if, like Lean, it has to be built and committed by hand).
 *
 * Returning `null` means "we have no grammar; UI should fall back to line-only diff".
 */
export type GrammarId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'lean';

/** Set of currently bundled grammars. Keep in sync with public/tree-sitter/. */
export const SUPPORTED_GRAMMARS: ReadonlySet<GrammarId> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'rust',
  'lean',
]);

export function grammarForPath(filePath: string): GrammarId | null {
  const fileName = filePath.split('/').pop()?.toLowerCase() ?? '';
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';

  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'jsx':
      // The TSX grammar parses JSX; reuse it for .jsx until/unless we ship a separate JSX grammar.
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
    case 'pyi':
      // .pyi (stub) shares the Python grammar — both regular modules and
      // type-stub files parse cleanly under tree-sitter-python.
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'lean':
      // Lean 4 only. The grammar is vendored, not copied from
      // @vscode/tree-sitter-wasm — see scripts/build-lean-grammar.mjs.
      // It parses declaration HEADERS reliably but not proof bodies
      // (user-defined notation/macros are out of scope upstream), so
      // unparsed regions degrade to unnamed blocks, i.e. today's
      // line-level behaviour. That is the intended trade.
      return 'lean';
    default:
      return null;
  }
}
