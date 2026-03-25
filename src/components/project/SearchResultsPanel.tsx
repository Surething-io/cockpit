'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { SearchResult } from './fileBrowser/types';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, tokensToHtml } from '@/lib/codeHighlighter';

interface SearchResultsPanelProps {
  results: SearchResult[];
  loading: boolean;
  totalMatches: number;
  onSelect: (path: string, lineNumber: number) => void;
  onClose: () => void;
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

export function SearchResultsPanel({ results, loading, totalMatches, onSelect, onClose }: SearchResultsPanelProps) {
  const { t } = useTranslation();
  const htmlMap = useHighlightedSearchLines(results);

  return (
    <div className="border-t border-border bg-secondary flex flex-col" style={{ height: '300px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-card/50 border-b border-border flex-shrink-0">
        <span className="text-xs font-medium text-foreground">
          {t('searchResults.title')} {!loading && t('searchResults.nMatches', { count: totalMatches })}
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-accent text-muted-foreground"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('searchResults.searching')}</div>
        ) : results.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('searchResults.noResults')}</div>
        ) : (
          results.map((result) => (
            <div key={result.path}>
              <div className="px-3 py-1 text-xs text-muted-foreground font-medium bg-card/30 sticky top-0">
                {result.path}
              </div>
              {result.matches.map((match, i) => {
                const key = `${result.path}:${match.lineNumber}`;
                const highlighted = htmlMap.get(key);
                return (
                  <button
                    key={`${match.lineNumber}-${i}`}
                    onClick={() => onSelect(result.path, match.lineNumber)}
                    className="w-full text-left px-3 py-0.5 hover:bg-accent/50 flex items-baseline gap-2 group"
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
