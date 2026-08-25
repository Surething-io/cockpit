import type { Highlighter, BundledLanguage, ThemedToken } from 'shiki';

export type { BundledLanguage };

// ============================================
// Types
// ============================================

export interface SearchMatch {
  lineIndex: number;
  startCol: number;
  endCol: number;
}

// ============================================
// Shiki Highlighter Singleton
// ============================================

let highlighterPromise: Promise<Highlighter> | null = null;

const SUPPORTED_LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx',
  'html', 'css', 'scss', 'json', 'yaml',
  'python', 'go', 'rust', 'java', 'ruby', 'php',
  'bash', 'shell', 'markdown', 'sql', 'c', 'cpp',
  'swift', 'kotlin', 'dart', 'lua', 'graphql', 'xml',
] as const;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Dynamic import keeps shiki (+ grammars, ~480KB gzip — a third of the
    // first-load JS) out of the initial bundle; it loads as an async chunk the
    // first time anything actually highlights. Consumers already treat
    // highlighting as async, so nothing upstream changes.
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [...SUPPORTED_LANGS],
      })
    );
  }
  return highlighterPromise;
}

export function getLanguageFromPath(filePath: string): string {
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  const ext = fileName.split('.').pop()?.toLowerCase();

  // Special filename matching (takes priority over extension)
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'bash';
  if (fileName === 'dockerfile' || fileName.startsWith('dockerfile.')) return 'bash';
  if (fileName === 'makefile') return 'bash';

  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    mjs: 'javascript', cjs: 'javascript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', rb: 'ruby', php: 'php',
    cs: 'cpp', cpp: 'cpp', c: 'c', h: 'c',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown', mdx: 'markdown', sql: 'sql',
    swift: 'swift', dart: 'dart', lua: 'lua',
    graphql: 'graphql', gql: 'graphql',
    toml: 'yaml', sass: 'scss', less: 'css',
    scala: 'java', r: 'python', vim: 'bash',
    env: 'bash',
  };
  const lang = map[ext || ''] || 'text';
  if (SUPPORTED_LANGS.includes(lang as typeof SUPPORTED_LANGS[number])) {
    return lang;
  }
  return 'text';
}

// ============================================
// Helper Functions
// ============================================

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Inline-span budget for ONE rendered line, above which the line falls back
 * to uncoloured plain text.
 *
 * Chrome's hit-testing / scroll cost for a single un-wrapped line box is
 * quadratic in the number of inline fragments it contains. Measured on a
 * 760px-wide `white-space: pre` scroller (5 scroll+hit-test events):
 *
 *     1k spans    6ms/event     8k spans   196ms/event
 *     2k spans   16ms/event    16k spans   798ms/event
 *     4k spans   52ms/event    64k spans  13.2s/event
 *
 * 2000 is the last step that still fits a 60fps frame. Past it the tab is
 * simply wedged: a 663KB single-line JSON tokenizes to 53,643 spans, which
 * cost ~8.8s *per scroll event* — a wheel flick queues dozens of them.
 *
 * The cap is deliberately on TOKEN COUNT, not line length: a 20,000-char
 * JSON string value is one token and renders fine, while a dense 4,000-char
 * minified line is the actual hazard. It also lives here, inside the one
 * function every line-rendering surface goes through (CodeViewer read-only
 * + edit, DiffView, BlockViewer, References / Search panels), so no caller
 * can forget it.
 */
export const MAX_TOKENS_PER_LINE = 2000;

/**
 * Join a single-line token array into an HTML string.
 *
 * Lines over `MAX_TOKENS_PER_LINE` degrade to escaped plain text — they keep
 * their exact characters (so columns, search, selection and Cmd+click all
 * still line up) but lose syntax colours, and with them the LSP hover card,
 * which only fires on spans carrying an inline colour.
 */
export function tokensToHtml(tokens: ThemedToken[]): string {
  if (tokens.length > MAX_TOKENS_PER_LINE) {
    // Rebuild the raw line from the tokens themselves rather than taking it
    // as a second argument: the tokens partition the line exactly, so this
    // cannot drift out of alignment with what the caller passed in.
    return escapeHtml(tokens.map(t => t.content).join(''));
  }
  return tokens
    .map(t => t.color
      ? `<span style="color:${t.color}">${escapeHtml(t.content)}</span>`
      : escapeHtml(t.content))
    .join('');
}

export function findMatches(
  lines: string[],
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean
): SearchMatch[] {
  if (!query) return [];

  const matches: SearchMatch[] = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLowerCase();
    let startIndex = 0;

    while (true) {
      const foundIndex = line.indexOf(searchQuery, startIndex);
      if (foundIndex === -1) break;

      const endIndex = foundIndex + searchQuery.length;

      if (wholeWord) {
        const beforeChar = foundIndex > 0 ? line[foundIndex - 1] : ' ';
        const afterChar = endIndex < line.length ? line[endIndex] : ' ';
        const isWordBoundaryBefore = !/\w/.test(beforeChar);
        const isWordBoundaryAfter = !/\w/.test(afterChar);

        if (isWordBoundaryBefore && isWordBoundaryAfter) {
          matches.push({ lineIndex, startCol: foundIndex, endCol: endIndex });
        }
      } else {
        matches.push({ lineIndex, startCol: foundIndex, endCol: endIndex });
      }

      startIndex = foundIndex + 1;
    }
  }

  return matches;
}
