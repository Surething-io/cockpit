import { useState, useCallback, useRef, useEffect } from 'react';

interface ChatSearchMatch {
  messageId: string;
  /** Index of this match among all marks within the message */
  markIndex: number;
}

export function useChatSearch(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<ChatSearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const markElementsRef = useRef<HTMLElement[]>([]);

  // Remove all highlight mark elements and restore original text nodes
  const clearHighlights = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const marks = container.querySelectorAll('mark.chat-search-match, mark.chat-search-current');
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize(); // Merge adjacent text nodes
      }
    });
    markElementsRef.current = [];
  }, [containerRef]);

  // Perform search: walk text nodes in the message DOM and wrap matches with mark elements
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

    // Iterate over each message element
    const messageElements = containerRef.current.querySelectorAll('[data-message-id]');
    messageElements.forEach(msgEl => {
      const messageId = msgEl.getAttribute('data-message-id') || '';
      let markIndex = 0;

      // Walk text nodes with TreeWalker
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

        // Replace from back to front to avoid offset issues
        const currentNode: Text = textNode;
        for (let i = ranges.length - 1; i >= 0; i--) {
          const range = ranges[i];
          // Split text node
          const afterNode = currentNode.splitText(range.end);
          const matchNode = currentNode.splitText(range.start);

          // Create mark element
          const mark = document.createElement('mark');
          mark.className = 'chat-search-match';
          mark.textContent = matchNode.textContent;
          matchNode.parentNode!.replaceChild(mark, matchNode);

          allMatches.push({ messageId, markIndex });
          allMarks.push(mark);
          markIndex++;

          // Continue processing the preceding text (currentNode was truncated by splitText)
          void afterNode; // afterNode is automatically positioned right after
        }
      }
    });

    // Marks were inserted back-to-front; reverse to restore DOM order
    allMatches.reverse();
    allMarks.reverse();
    markElementsRef.current = allMarks;
    setMatches(allMatches);
    setCurrentMatchIndex(allMatches.length > 0 ? 0 : -1);
  }, [containerRef, clearHighlights]);

  // Re-run search when query changes
  useEffect(() => {
    queueMicrotask(() => performSearch(searchQuery));
  }, [searchQuery, performSearch]);

  // Update current highlight
  useEffect(() => {
    const marks = markElementsRef.current;
    marks.forEach((mark, i) => {
      mark.className = i === currentMatchIndex ? 'chat-search-current' : 'chat-search-match';
    });

    // Scroll to current match
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

  // Handle key events in the search input
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

  // Listen for Cmd+F
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
