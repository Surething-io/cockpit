'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { SearchResult } from './fileBrowser/types';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, tokensToHtml } from '@cockpit/shared-ui';

export type SearchResultScope = 'selected' | 'all';

interface SearchResultsPanelProps {
  results: SearchResult[];
  loading: boolean;
  totalMatches: number;
  onSelect: (path: string, lineNumber: number) => void;
  onClose: () => void;
  /** Scope toggle: show only the tree-selected file's matches, or all results */
  scope: SearchResultScope;
  onScopeChange: (scope: SearchResultScope) => void;
  /** Currently selected file path in the tree (used when scope === 'selected') */
  selectedPath: string | null;
}

/** Syntax-highlight all matching lines with Shiki */
function useHighlightedSearchLines(results: SearchResult[]) {
  const [htmlMap, setHtmlMap] = useState<Map<string, string>>(new Map());
  const [isDark, setIsDark] = useState(false);
  const versionRef = useRef(0);

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (results.length === 0) { queueMicrotask(() => setHtmlMap(new Map())); return; }
    const version = ++versionRef.current;
    const theme = isDark ? 'github-dark' : 'github-light';

    (async () => {
      const highlighter = await getHighlighter();
      const map = new Map<string, string>();

      for (const result of results) {
        const lang = getLanguageFromPath(result.path);
        if (lang === 'text') continue;
        for (const match of result.matches) {
          if (!match.content) continue;
          const key = `${result.path}:${match.lineNumber}`;
          try {
            const tokens = highlighter.codeToTokens(match.content, { lang: lang as BundledLanguage, theme });
            const html = tokensToHtml(tokens.tokens[0] || []);
            if (html) map.set(key, html);
          } catch { /* skip */ }
        }
      }

      if (version === versionRef.current) setHtmlMap(map);
    })();
  }, [results, isDark]);

  return htmlMap;
}

export function SearchResultsPanel({ results, loading, totalMatches, onSelect, onClose, scope, onScopeChange, selectedPath }: SearchResultsPanelProps) {
  const { t } = useTranslation();
  const htmlMap = useHighlightedSearchLines(results);

  // In "selected" scope, only show matches for the tree-selected file (exact match).
  const visibleResults = scope === 'selected'
    ? results.filter((r) => r.path === selectedPath)
    : results;
  const visibleMatches = visibleResults.reduce((sum, r) => sum + r.matches.length, 0);

  return (
    <div className="border-t border-border bg-card flex flex-col" style={{ height: '300px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-card/50 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground truncate">
            {t('searchResults.title')} {!loading && t('searchResults.nMatches', { count: scope === 'selected' ? visibleMatches : totalMatches })}
          </span>
          {/* Scope toggle: selected file only / all results */}
          <div className="flex items-center rounded border border-border overflow-hidden text-xs flex-shrink-0">
            <button
              onClick={() => onScopeChange('selected')}
              className={`px-2 py-0.5 ${scope === 'selected' ? 'bg-brand/15 text-brand' : 'text-muted-foreground hover:bg-hover'}`}
            >
              {t('searchResults.scopeSelected')}
            </button>
            <button
              onClick={() => onScopeChange('all')}
              className={`px-2 py-0.5 border-l border-border ${scope === 'all' ? 'bg-brand/15 text-brand' : 'text-muted-foreground hover:bg-hover'}`}
            >
              {t('searchResults.scopeAll')}
            </button>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-hover text-muted-foreground flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('searchResults.searching')}</div>
        ) : visibleResults.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('searchResults.noResults')}</div>
        ) : (
          visibleResults.map((result) => (
            <div key={result.path}>
              <div className="px-3 py-1 text-xs text-muted-foreground font-medium bg-card sticky top-0">
                {result.path}
              </div>
              {result.matches.map((match, i) => {
                const key = `${result.path}:${match.lineNumber}`;
                const highlighted = htmlMap.get(key);
                return (
                  <button
                    key={`${match.lineNumber}-${i}`}
                    onClick={() => onSelect(result.path, match.lineNumber)}
                    className="w-full text-left px-3 py-0.5 hover:bg-hover flex items-baseline gap-2 group"
                  >
                    <span className="text-sm text-muted-foreground font-mono font-variant-tabular flex-shrink-0 w-10 text-right">
                      {match.lineNumber}
                    </span>
                    {highlighted ? (
                      <span
                        className="text-sm font-mono truncate"
                        dangerouslySetInnerHTML={{ __html: highlighted }}
                      />
                    ) : (
                      <span className="text-sm font-mono text-foreground truncate">
                        {match.content || ''}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
