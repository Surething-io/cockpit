import { useState, useCallback, useRef } from 'react';
import type { SearchResult, SearchResponse } from '../components/project/fileBrowser/types';
import i18n from '@/lib/i18n';

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

    try {
      const params = new URLSearchParams({
        cwd,
        q: query,
        caseSensitive: String(searchOptions.caseSensitive),
        wholeWord: String(searchOptions.wholeWord),
        regex: String(searchOptions.regex),
        fileType: searchOptions.fileType,
      });

      const response = await fetch(`/api/files/search?${params}`);
      const data: SearchResponse = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      setContentSearchResults(data.results);
      setSearchStats({
        totalFiles: data.totalFiles,
        totalMatches: data.totalMatches,
        truncated: data.truncated,
      });

      // Expand all search results by default
      const expandedPaths = new Set(data.results.map(r => r.path));
      setSearchExpandedPaths(expandedPaths);

      if (data.results.length > 0) onSearchComplete?.();
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
      setContentSearchResults([]);
    } finally {
      setIsSearching(false);
    }
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
