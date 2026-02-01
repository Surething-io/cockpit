'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

// ============================================
// Types
// ============================================

interface CodeViewerProps {
  content: string;
  filePath: string;
  showLineNumbers?: boolean;
  showSearch?: boolean;
  className?: string;
}

interface SearchMatch {
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function findMatches(
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

// ============================================
// CodeViewer Component
// ============================================

export function CodeViewer({
  content,
  filePath,
  showLineNumbers = true,
  showSearch = true,
  className = '',
}: CodeViewerProps) {
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const [isDark, setIsDark] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search state
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const lines = useMemo(() => content.split('\n'), [content]);

  // Find matches
  const matches = useMemo(() => {
    return findMatches(lines, searchQuery, caseSensitive, wholeWord);
  }, [lines, searchQuery, caseSensitive, wholeWord]);

  // Reset current match when matches change
  useEffect(() => {
    if (matches.length > 0) {
      setCurrentMatchIndex(0);
    }
  }, [matches.length, searchQuery, caseSensitive, wholeWord]);

  // Dark mode detection
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Syntax highlighting
  useEffect(() => {
    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const highlighted = lines.map(line => {
          try {
            const html = highlighter.codeToHtml(line || ' ', {
              lang: language as BundledLanguage,
              theme,
            });
            const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
            return match ? match[1] : escapeHtml(line);
          } catch {
            return escapeHtml(line);
          }
        });

        setHighlightedLines(highlighted);
      } catch (err) {
        console.error('Highlight error:', err);
        setHighlightedLines(lines.map(line => escapeHtml(line)));
      }
    };

    highlight();
  }, [content, filePath, isDark, lines]);

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  // Keyboard shortcut for search
  useEffect(() => {
    if (!showSearch) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchVisible(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === 'Escape' && isSearchVisible) {
        setIsSearchVisible(false);
        setSearchQuery('');
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
      return () => container.removeEventListener('keydown', handleKeyDown);
    }
  }, [showSearch, isSearchVisible]);

  // Navigate to current match
  useEffect(() => {
    if (matches.length > 0 && currentMatchIndex >= 0 && currentMatchIndex < matches.length) {
      const match = matches[currentMatchIndex];
      virtualizer.scrollToIndex(match.lineIndex, { align: 'center' });
    }
  }, [currentMatchIndex, matches, virtualizer]);

  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    }
    if (e.key === 'Escape') {
      setIsSearchVisible(false);
      setSearchQuery('');
    }
  }, [goToNextMatch, goToPrevMatch]);

  const lineNumberWidth = showLineNumbers ? Math.max(3, String(lines.length).length) * 10 + 16 : 0;

  // Highlight match in line
  const getHighlightedLineHtml = useCallback((lineIndex: number, html: string): string => {
    if (!searchQuery || matches.length === 0) return html;

    const lineMatches = matches.filter(m => m.lineIndex === lineIndex);
    if (lineMatches.length === 0) return html;

    // For simplicity, wrap matches with highlight span
    // This is a basic implementation - could be improved for complex HTML
    let result = html;
    const line = lines[lineIndex];

    for (const match of lineMatches.reverse()) {
      const isCurrentMatch = matches[currentMatchIndex]?.lineIndex === lineIndex &&
        matches[currentMatchIndex]?.startCol === match.startCol;

      const matchText = line.substring(match.startCol, match.endCol);
      const escapedMatch = escapeHtml(matchText);
      const highlightClass = isCurrentMatch ? 'bg-amber-9/50' : 'bg-amber-9/30';

      // Try to find and replace the escaped match text in HTML
      const regex = new RegExp(escapedMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      result = result.replace(regex, `<span class="${highlightClass}">${escapedMatch}</span>`);
    }

    return result;
  }, [searchQuery, matches, currentMatchIndex, lines]);

  return (
    <div ref={containerRef} className={`h-full flex flex-col ${className}`} tabIndex={0}>
      {/* Search Bar */}
      {showSearch && isSearchVisible && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-secondary border-b border-border">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索..."
            className="flex-1 max-w-xs px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {/* Case sensitive toggle */}
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              caseSensitive
                ? 'bg-brand text-white border-brand'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
            title="区分大小写"
          >
            Aa
          </button>
          {/* Whole word toggle */}
          <button
            onClick={() => setWholeWord(!wholeWord)}
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              wholeWord
                ? 'bg-brand text-white border-brand'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
            title="全字匹配"
          >
            [ab]
          </button>
          {/* Match count */}
          <span className="text-xs text-muted-foreground">
            {matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : '无匹配'}
          </span>
          {/* Navigation */}
          <button
            onClick={goToPrevMatch}
            disabled={matches.length === 0}
            className="p-1 rounded hover:bg-accent disabled:opacity-50"
            title="上一个 (Shift+Enter)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={goToNextMatch}
            disabled={matches.length === 0}
            className="p-1 rounded hover:bg-accent disabled:opacity-50"
            title="下一个 (Enter)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {/* Close */}
          <button
            onClick={() => {
              setIsSearchVisible(false);
              setSearchQuery('');
            }}
            className="p-1 rounded hover:bg-accent"
            title="关闭 (Esc)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Code Content */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto font-mono text-xs bg-secondary"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const lineIndex = virtualItem.index;
            const lineNum = lineIndex + 1;
            const html = highlightedLines[lineIndex] || escapeHtml(lines[lineIndex] || '');
            const highlightedHtml = getHighlightedLineHtml(lineIndex, html);

            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                className="flex hover:bg-accent/50"
              >
                {showLineNumbers && (
                  <span
                    className="flex-shrink-0 px-2 text-right text-slate-9 select-none border-r border-border bg-card/50"
                    style={{ width: lineNumberWidth }}
                  >
                    {lineNum}
                  </span>
                )}
                <span
                  className="flex-1 px-3 whitespace-pre overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Simple Code Block (non-virtual, for small content)
// ============================================

interface SimpleCodeBlockProps {
  content: string;
  filePath: string;
  className?: string;
}

export function SimpleCodeBlock({ content, filePath, className = '' }: SimpleCodeBlockProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const lines = content.split('\n');
        const lineNumberWidth = String(lines.length).length;

        const html = highlighter.codeToHtml(content, {
          lang: language as BundledLanguage,
          theme,
          transformers: [
            {
              line(node, line) {
                const lineNum = String(line).padStart(lineNumberWidth, ' ');
                node.children.unshift({
                  type: 'element',
                  tagName: 'span',
                  properties: { class: 'line-number' },
                  children: [{ type: 'text', value: lineNum }],
                });
              },
            },
          ],
        });

        setHighlightedHtml(html);
      } catch (err) {
        console.error('Highlight error:', err);
        setHighlightedHtml(null);
      }
    };

    highlight();
  }, [content, filePath, isDark]);

  if (highlightedHtml) {
    return (
      <div
        className={`overflow-auto text-xs font-mono ${className}`}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        style={{
          // Shiki styles
        }}
      />
    );
  }

  // Fallback: plain text with line numbers
  const lines = content.split('\n');
  const lineNumberWidth = String(lines.length).length;

  return (
    <pre className={`overflow-auto text-xs font-mono bg-secondary p-2 ${className}`}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="text-slate-9 select-none pr-4 text-right" style={{ minWidth: `${lineNumberWidth + 2}ch` }}>
            {i + 1}
          </span>
          <span className="flex-1">{line}</span>
        </div>
      ))}
    </pre>
  );
}
