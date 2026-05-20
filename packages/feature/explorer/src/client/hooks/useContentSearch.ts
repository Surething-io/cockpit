import { useState, useCallback, useRef } from 'react';
import type { SearchResult, SearchResponse } from '../fileBrowser/types';
import i18n from '@cockpit/shared-i18n';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';

interface UseContentSearchOptions {
  cwd: string;
  onSearchComplete?: () => void;
}

export function useContentSearch({ cwd, onSearchComplete }: UseContentSearchOptions) {
  const [contentSearchQuery, setContentSearchQuery] = useState('');
  const [contentSearchResults, setContentSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchExpandedPaths, setSearchExpandedPaths] = useState<Set<string>>(new Set());
  const [searchOptions, setSearchOptions] = useState({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    fileType: '',
  });
  const [searchStats, setSearchStats] = useState<{ totalFiles: number; totalMatches: number; truncated: boolean } | null>(null);
  const contentSearchInputRef = useRef<HTMLInputElement>(null);

  const performContentSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setContentSearchResults([]);
      setSearchStats(null);
      return;
    }
    // Require at least 2 characters to trigger search, preventing massive results from single-character queries
    if (trimmed.length < 2) {
      setSearchError(i18n.t('fileBrowser.searchMinChars'));
      return;
    }

    setIsSearching(true);
    setSearchError(null);

    const params = new URLSearchParams({
      cwd,
      q: query,
      caseSensitive: String(searchOptions.caseSensitive),
      wholeWord: String(searchOptions.wholeWord),
      regex: String(searchOptions.regex),
      fileType: searchOptions.fileType,
    });

    const searchEff = Effect.tryPromise({
      try: async () => {
        const response = await fetch(`/api/files/search?${params}`);
        const data = (await response.json()) as SearchResponse;
        if (data.error) throw new Error(data.error);
        return data;
      },
      catch: (cause) => new AppError({ message: 'content search failed', cause }),
    });

    await BrowserRuntime.runPromise(
      searchEff.pipe(
        Effect.match({
          onSuccess: (data) => {
            setContentSearchResults(data.results);
            setSearchStats({
              totalFiles: data.totalFiles,
              totalMatches: data.totalMatches,
              truncated: data.truncated,
            });
            // Expand all search results by default
            const expandedPaths = new Set(data.results.map((r) => r.path));
            setSearchExpandedPaths(expandedPaths);
            if (data.results.length > 0) onSearchComplete?.();
          },
          onFailure: (err) => {
            const msg = err.cause instanceof Error ? err.cause.message : 'Search failed';
            setSearchError(msg);
            setContentSearchResults([]);
          },
        })
      )
    );
    setIsSearching(false);
  }, [cwd, searchOptions, onSearchComplete]);

  const handleSearchToggle = useCallback((path: string) => {
    setSearchExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return {
    contentSearchQuery,
    setContentSearchQuery,
    contentSearchResults,
    isSearching,
    searchError,
    searchExpandedPaths,
    searchOptions,
    setSearchOptions,
    searchStats,
    contentSearchInputRef,
    performContentSearch,
    handleSearchToggle,
  };
}
