import { useState, useCallback, useRef, useEffect } from 'react';

interface ChatSearchMatch {
  messageId: string;
  /** 该 match 在消息内所有 mark 中的索引 */
  markIndex: number;
}

export function useChatSearch(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<ChatSearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const markElementsRef = useRef<HTMLElement[]>([]);

  // 清除所有高亮 mark 标签，恢复原始文本节点
  const clearHighlights = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const marks = container.querySelectorAll('mark.chat-search-match, mark.chat-search-current');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize(); // 合并相邻文本节点
      }
    });
    markElementsRef.current = [];
  }, [containerRef]);

  // 执行搜索：遍历消息 DOM 中的文本节点，用 mark 包裹匹配
  const performSearch = useCallback((query: string) => {
    clearHighlights();

    if (!query || !containerRef.current) {
      setMatches([]);
      setCurrentMatchIndex(0);
      return;
    }

    const allMatches: ChatSearchMatch[] = [];
    const allMarks: HTMLElement[] = [];
    const queryLower = query.toLowerCase();

    // 遍历每个消息元素
    const messageElements = containerRef.current.querySelectorAll('[data-message-id]');
    messageElements.forEach(msgEl => {
      const messageId = msgEl.getAttribute('data-message-id') || '';
      let markIndex = 0;

      // TreeWalker 遍历文本节点
      const walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, null);
      const textNodes: Text[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        textNodes.push(node);
      }

      for (const textNode of textNodes) {
        const text = textNode.textContent || '';
        const textLower = text.toLowerCase();
        let startIndex = 0;
        const ranges: { start: number; end: number }[] = [];

        while (true) {
          const foundIndex = textLower.indexOf(queryLower, startIndex);
          if (foundIndex === -1) break;
          ranges.push({ start: foundIndex, end: foundIndex + query.length });
          startIndex = foundIndex + 1;
        }

        if (ranges.length === 0) continue;

        // 从后往前替换，避免偏移问题
        let currentNode: Text = textNode;
        for (let i = ranges.length - 1; i >= 0; i--) {
          const range = ranges[i];
          // 分割文本节点
          const afterNode = currentNode.splitText(range.end);
          const matchNode = currentNode.splitText(range.start);

          // 创建 mark 元素
          const mark = document.createElement('mark');
          mark.className = 'chat-search-match';
          mark.textContent = matchNode.textContent;
          matchNode.parentNode!.replaceChild(mark, matchNode);

          allMatches.push({ messageId, markIndex });
          allMarks.push(mark);
          markIndex++;

          // 继续处理前面的文本（currentNode 已被 splitText 截断）
          void afterNode; // afterNode 自动跟在后面
        }
      }
    });

    // mark 是从后往前插入的，需要反转以保持 DOM 顺序
    allMatches.reverse();
    allMarks.reverse();
    markElementsRef.current = allMarks;
    setMatches(allMatches);
    setCurrentMatchIndex(allMatches.length > 0 ? 0 : -1);
  }, [containerRef, clearHighlights]);

  // query 变化时重新搜索
  useEffect(() => {
    performSearch(searchQuery);
  }, [searchQuery, performSearch]);

  // 更新当前高亮
  useEffect(() => {
    const marks = markElementsRef.current;
    marks.forEach((mark, i) => {
      mark.className = i === currentMatchIndex ? 'chat-search-current' : 'chat-search-match';
    });

    // 滚动到当前匹配
    if (currentMatchIndex >= 0 && currentMatchIndex < marks.length) {
      marks[currentMatchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentMatchIndex, matches]);

  const goToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(prev => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const openSearch = useCallback(() => {
    setIsSearchVisible(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchVisible(false);
    setSearchQuery('');
    clearHighlights();
    setMatches([]);
    setCurrentMatchIndex(0);
  }, [clearHighlights]);

  // 搜索输入框按键处理
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
      closeSearch();
    }
  }, [goToNextMatch, goToPrevMatch, closeSearch]);

  // Cmd+F 监听
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [containerRef, openSearch]);

  return {
    isSearchVisible,
    searchQuery,
    setSearchQuery,
    matches,
    currentMatchIndex,
    goToNextMatch,
    goToPrevMatch,
    openSearch,
    closeSearch,
    searchInputRef,
    handleSearchKeyDown,
  };
}
