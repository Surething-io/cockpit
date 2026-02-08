import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

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
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...SUPPORTED_LANGS],
    });
  }
  return highlighterPromise;
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
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
    dockerfile: 'bash',
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
