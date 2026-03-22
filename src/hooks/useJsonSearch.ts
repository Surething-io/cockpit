'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';

/**
 * JSON 可读模式的内容搜索 hook
 * 使用 CSS Custom Highlight API 高亮匹配，不修改 DOM、不触发 re-render
 */
// 动态注入 ::highlight 样式（Turbopack/PostCSS 不认识此伪元素，无法放 globals.css）
const STYLE_ID = 'json-search-highlight-style';
function ensureHighlightStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `::highlight(json-search){background:rgba(217,119,6,.3)}::highlight(json-search-current){background:rgba(217,119,6,.5)}`;
  document.head.appendChild(style);
}

export function useJsonSearch(preRef: React.RefObject<HTMLPreElement | null>) {
  const [isVisible, setIsVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);
  // 存储所有匹配的 Range，用于 scrollIntoView
  const rangesRef = useRef<Range[]>([]);

  // ---- 核心：在 <pre> textContent 中找匹配，生成 Range，注册 CSS highlight ----
  const runSearch = useCallback(() => {
    // 清理旧高亮
    CSS.highlights?.delete('json-search');
    CSS.highlights?.delete('json-search-current');
    rangesRef.current = [];

    const pre = preRef.current;
    if (!pre || !query) {
      setMatchCount(0);
      setCurrentIndex(0);
      return;
    }

    ensureHighlightStyle();

    const text = pre.textContent || '';
    const q = caseSensitive ? query : query.toLowerCase();
    const searchText = caseSensitive ? text : text.toLowerCase();

    // 找出所有匹配的 [start, end) 偏移
    const offsets: [number, number][] = [];
    let pos = 0;
    while (pos < searchText.length) {
      const idx = searchText.indexOf(q, pos);
      if (idx === -1) break;
      offsets.push([idx, idx + q.length]);
      pos = idx + 1;
    }

    if (offsets.length === 0) {
      setMatchCount(0);
      setCurrentIndex(0);
      return;
    }

    // 用 TreeWalker 遍历文本节点，将偏移映射为 DOM Range
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let charIndex = 0;
    let offsetIdx = 0;
    const ranges: Range[] = [];
    // 每个 Range 可能跨多个文本节点，用 partial 追踪
    let pendingRange: Range | null = null;
    let pendingEnd = 0;

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null) && offsetIdx < offsets.length) {
      const nodeLen = node.textContent?.length || 0;
      const nodeStart = charIndex;
      const nodeEnd = charIndex + nodeLen;

      // 处理在此节点范围内开始或进行中的匹配
      while (offsetIdx < offsets.length) {
        const [mStart, mEnd] = offsets[offsetIdx];

        if (mStart >= nodeEnd) break; // 此匹配在后面的节点

        if (!pendingRange) {
          // 匹配开始于此节点
          if (mStart >= nodeStart) {
            pendingRange = document.createRange();
            pendingRange.setStart(node, mStart - nodeStart);
            pendingEnd = mEnd;
          } else {
            break; // 不该到这里
          }
        }

        // 匹配结束于此节点
        if (pendingEnd <= nodeEnd) {
          pendingRange!.setEnd(node, pendingEnd - nodeStart);
          ranges.push(pendingRange!);
          pendingRange = null;
          offsetIdx++;
        } else {
          // 匹配跨到下一个节点
          break;
        }
      }

      charIndex = nodeEnd;
    }

    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setCurrentIndex(prev => ranges.length > 0 ? Math.min(prev, ranges.length - 1) : 0);

    // 注册 CSS highlight
    if (CSS.highlights && ranges.length > 0) {
      CSS.highlights.set('json-search', new Highlight(...ranges));
    }
  }, [preRef, query, caseSensitive]);

  // ---- 更新当前匹配高亮 + 滚动 ----
  const updateCurrentHighlight = useCallback((index: number) => {
    CSS.highlights?.delete('json-search-current');
    const range = rangesRef.current[index];
    if (!range || !CSS.highlights) return;
    CSS.highlights.set('json-search-current', new Highlight(range));

    // 滚动到当前匹配
    const rect = range.getBoundingClientRect();
    const container = preRef.current?.parentElement;
    if (container) {
      const cRect = container.getBoundingClientRect();
      if (rect.top < cRect.top || rect.bottom > cRect.bottom) {
        // 将匹配滚到容器中部
        container.scrollTop += rect.top - cRect.top - cRect.height / 2 + rect.height / 2;
      }
    }
  }, [preRef]);

  // query / caseSensitive 变化 → 重新搜索
  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // currentIndex 变化 → 更新当前匹配高亮
  useEffect(() => {
    updateCurrentHighlight(currentIndex);
  }, [currentIndex, matchCount, updateCurrentHighlight]);

  // MutationObserver: CollapsibleEntry 折叠/展开时自动重新搜索
  useEffect(() => {
    const pre = preRef.current;
    if (!pre || !query) return;
    const observer = new MutationObserver(() => runSearch());
    observer.observe(pre, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [preRef, query, runSearch]);

  // 关闭搜索 / 卸载时清理
  useEffect(() => {
    if (!isVisible) {
      CSS.highlights?.delete('json-search');
      CSS.highlights?.delete('json-search-current');
      rangesRef.current = [];
    }
  }, [isVisible]);

  useEffect(() => {
    return () => {
      CSS.highlights?.delete('json-search');
      CSS.highlights?.delete('json-search-current');
    };
  }, []);

  // ---- 导航 ----
  const goToNext = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentIndex(prev => (prev + 1) % matchCount);
  }, [matchCount]);

  const goToPrev = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentIndex(prev => (prev - 1 + matchCount) % matchCount);
  }, [matchCount]);

  const open = useCallback(() => {
    setIsVisible(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  const close = useCallback(() => {
    setIsVisible(false);
    setQuery('');
    setCurrentIndex(0);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goToPrev(); else goToNext();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }, [goToNext, goToPrev, close]);

  return {
    isVisible,
    query, setQuery,
    caseSensitive, setCaseSensitive,
    matchCount, currentIndex,
    searchInputRef,
    open, close,
    goToNext, goToPrev,
    handleKeyDown,
  };
}

/** 搜索栏 UI，配合 useJsonSearch 使用 */
export function JsonSearchBar({ search }: { search: ReturnType<typeof useJsonSearch> }) {
  if (!search.isVisible) return null;
  return React.createElement('div', { className: 'flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-secondary border-b border-border' },
    React.createElement('input', {
      ref: search.searchInputRef,
      type: 'text',
      value: search.query,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => search.setQuery(e.target.value),
      onKeyDown: search.handleKeyDown,
      placeholder: '搜索...',
      className: 'flex-1 max-w-xs px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring',
    }),
    React.createElement('button', {
      onClick: () => search.setCaseSensitive((v: boolean) => !v),
      className: `px-2 py-1 text-xs font-mono rounded border transition-colors ${search.caseSensitive ? 'bg-brand text-white border-brand' : 'border-border text-muted-foreground hover:bg-accent'}`,
      title: '区分大小写',
    }, 'Aa'),
    React.createElement('span', { className: 'text-xs text-muted-foreground' },
      search.matchCount > 0 ? `${search.currentIndex + 1}/${search.matchCount}` : '无匹配',
    ),
    React.createElement('button', {
      onClick: search.goToPrev, disabled: search.matchCount === 0,
      className: 'p-1 rounded hover:bg-accent disabled:opacity-50', title: '上一个',
    }, React.createElement('svg', { className: 'w-4 h-4', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' },
      React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2, d: 'M5 15l7-7 7 7' }),
    )),
    React.createElement('button', {
      onClick: search.goToNext, disabled: search.matchCount === 0,
      className: 'p-1 rounded hover:bg-accent disabled:opacity-50', title: '下一个',
    }, React.createElement('svg', { className: 'w-4 h-4', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' },
      React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2, d: 'M19 9l-7 7-7-7' }),
    )),
    React.createElement('button', {
      onClick: search.close,
      className: 'p-1 rounded hover:bg-accent', title: '关闭',
    }, React.createElement('svg', { className: 'w-4 h-4', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' },
      React.createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2, d: 'M6 18L18 6M6 6l12 12' }),
    )),
  );
}
