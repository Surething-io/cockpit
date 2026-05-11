/**
 * Map a file path to a tree-sitter grammar identifier.
 *
 * We deliberately keep this list short for now (TS/JS family). Add a language
 * here when you also bundle the corresponding `tree-sitter-<lang>.wasm` into
 * `public/tree-sitter/`.
 *
 * Returning `null` means "we have no grammar; UI should fall back to line-only diff".
 */
export type GrammarId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust';

/** Set of currently bundled grammars. Keep in sync with public/tree-sitter/. */
export const SUPPORTED_GRAMMARS: ReadonlySet<GrammarId> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'rust',
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
    default:
      return null;
  }
}
