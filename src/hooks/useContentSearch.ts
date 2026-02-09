import { useState, useCallback, useRef } from 'react';
import type { SearchResult, SearchResponse } from '../components/project/fileBrowser/types';

interface UseContentSearchOptions {
  cwd: string;
}

export function useContentSearch({ cwd }: UseContentSearchOptions) {
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
    // 最少 2 个字符才触发搜索，防止单字符搜索产生海量结果
    if (trimmed.length < 2) {
      setSearchError('搜索内容至少需要 2 个字符');
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

      // 默认展开所有搜索结果
      const expandedPaths = new Set(data.results.map(r => r.path));
      setSearchExpandedPaths(expandedPaths);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
      setContentSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [cwd, searchOptions]);

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
