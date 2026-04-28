'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileNode } from './fileBrowser/types';
import { FileIcon } from '../shared/FileIcon';
import { Portal } from '../shared/Portal';

// ============================================
// Types
// ============================================

interface QuickFileOpenProps {
  files: FileNode[];
  fileIndex?: string[] | null;
  recentFiles: string[];
  onSelectFile: (path: string) => void;
  onClose: () => void;
}

// ============================================
// Fuzzy matching
// ============================================

interface FuzzyResult {
  path: string;
  score: number;
  // Indices of matched characters in the path for highlighting
  matchedIndices: number[];
}

function fuzzyMatch(path: string, query: string): FuzzyResult | null {
  const lowerPath = path.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Try to match all query characters in order
  const matchedIndices: number[] = [];
  let queryIdx = 0;
  let score = 0;
  let prevMatchIdx = -1;

  for (let i = 0; i < lowerPath.length && queryIdx < lowerQuery.length; i++) {
    if (lowerPath[i] === lowerQuery[queryIdx]) {
      matchedIndices.push(i);

      // Scoring bonuses
      // 1. Consecutive matches
      if (prevMatchIdx === i - 1) {
        score += 5;
      }
      // 2. Match after separator (/ or .)
      if (i === 0 || path[i - 1] === '/' || path[i - 1] === '.' || path[i - 1] === '-' || path[i - 1] === '_') {
        score += 10;
      }
      // 3. Filename match (after last /)
      const lastSlash = path.lastIndexOf('/');
      if (i > lastSlash) {
        score += 3;
      }
      // 4. Exact case match
      if (path[i] === query[queryIdx]) {
        score += 1;
      }

      prevMatchIdx = i;
      queryIdx++;
    }
  }

  // All query characters must match
  if (queryIdx < lowerQuery.length) return null;

  // Penalty for longer paths (prefer shorter paths)
  score -= path.length * 0.1;

  return { path, score, matchedIndices };
}

// ============================================
// Flatten file tree to paths
// ============================================

function flattenFilePaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  const traverse = (nodeList: FileNode[]) => {
    for (const node of nodeList) {
      if (node.isDirectory && node.children) {
        traverse(node.children);
      } else if (!node.isDirectory) {
        paths.push(node.path);
      }
    }
  };
  traverse(nodes);
  return paths;
}

// ============================================
// Highlighted path rendering
// ============================================

function HighlightedPath({ path, matchedIndices }: { path: string; matchedIndices: number[] }) {
  const matchSet = useMemo(() => new Set(matchedIndices), [matchedIndices]);

  // Split path into directory and filename
  const lastSlash = path.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
  const filePart = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

  const renderPart = (text: string, startIdx: number, className: string) => {
    const segments: React.ReactNode[] = [];
    let currentRun = '';
    let currentIsMatch = false;

    for (let i = 0; i < text.length; i++) {
      const globalIdx = startIdx + i;
      const isMatch = matchSet.has(globalIdx);
      if (isMatch !== currentIsMatch && currentRun) {
        segments.push(
          currentIsMatch
            ? <span key={`${startIdx}-${i}`} className="text-brand font-medium">{currentRun}</span>
            : <span key={`${startIdx}-${i}`}>{currentRun}</span>
        );
        currentRun = '';
      }
      currentIsMatch = isMatch;
      currentRun += text[i];
    }
    if (currentRun) {
      segments.push(
        currentIsMatch
          ? <span key={`${startIdx}-end`} className="text-brand font-medium">{currentRun}</span>
          : <span key={`${startIdx}-end`}>{currentRun}</span>
      );
    }

    return <span className={className}>{segments}</span>;
  };

  return (
    <span className="truncate">
      {dirPart && renderPart(dirPart, 0, 'text-muted-foreground')}
      {renderPart(filePart, dirPart.length, 'text-foreground')}
    </span>
  );
}

// ============================================
// QuickFileOpen Component
// ============================================

export function QuickFileOpen({ files, fileIndex, recentFiles, onSelectFile, onClose }: QuickFileOpenProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Use fileIndex when available (covers all files), fallback to tree flatten
  const allPaths = useMemo(() => fileIndex ?? flattenFilePaths(files), [fileIndex, files]);

  // Compute results
  const results = useMemo(() => {
    if (!query.trim()) {
      // Show recent files first, then all files (limited)
      const recentSet = new Set(recentFiles);
      const recentResults: FuzzyResult[] = recentFiles.map(path => ({
        path,
        score: 0,
        matchedIndices: [],
      }));
      const otherPaths = allPaths
        .filter(p => !recentSet.has(p))
        .slice(0, 50)
        .map(path => ({
          path,
          score: 0,
          matchedIndices: [],
        }));
      return [...recentResults, ...otherPaths];
    }

    const matches: FuzzyResult[] = [];
    for (const path of allPaths) {
      const result = fuzzyMatch(path, query.trim());
      if (result) {
        // Boost recent files
        if (recentFiles.includes(path)) {
          result.score += 20;
        }
        matches.push(result);
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    return matches.slice(0, 50);
  }, [query, allPaths, recentFiles]);

  // Update query and reset selection
  const handleQueryChange = useCallback((newQuery: string) => {
    setQuery(newQuery);
    setSelectedIndex(0);
  }, []);

  // Auto focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedEl = listRef.current.children[selectedIndex] as HTMLElement;
      selectedEl?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((path: string) => {
    onSelectFile(path);
    onClose();
  }, [onSelectFile, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex].path);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [results, selectedIndex, handleSelect, onClose]);

  return (
    <Portal>
    <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-[680px] max-h-[60vh] bg-card border border-border rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <svg className="w-4 h-4 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('quickFileOpen.placeholder')}
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
          />
          <kbd className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded border border-border bg-secondary">ESC</kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t('quickFileOpen.noMatch')}
            </div>
          ) : (
            results.map((result, index) => (
              <div
                key={result.path}
                className={`px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors ${
                  index === selectedIndex
                    ? 'bg-brand/15 text-foreground'
                    : 'hover:bg-accent text-foreground'
                }`}
                data-tooltip={result.path}
                onClick={() => handleSelect(result.path)}
              >
                <FileIcon name={result.path.split('/').pop() || ''} className="w-4 h-4 flex-shrink-0" />
                <HighlightedPath path={result.path} matchedIndices={result.matchedIndices} />
                {!query.trim() && recentFiles.includes(result.path) && (
                  <span className="ml-auto text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary flex-shrink-0">
                    {t('quickFileOpen.recent')}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-border flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-secondary">↑↓</kbd> {t('quickFileOpen.selectHint')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-secondary">Enter</kbd> {t('quickFileOpen.openHint')}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded border border-border bg-secondary">Esc</kbd> {t('quickFileOpen.closeHint')}
          </span>
        </div>
      </div>
    </div>
    </Portal>
  );
}
