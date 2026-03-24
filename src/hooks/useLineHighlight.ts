'use client';

import { useState, useEffect, useRef } from 'react';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, escapeHtml, tokensToHtml } from '@/lib/codeHighlighter';

/**
 * Run codeToTokens on the entire file at once and return an array of HTML strings.
 * First render plain text, then asynchronously apply syntax highlighting in batches to avoid white-screen on large files.
 */
export function useLineHighlight(lines: string[], filePath: string): string[] {
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const [isDark, setIsDark] = useState(false);
  const prevLinesKeyRef = useRef<string>('');

  // Detect dark mode
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();

    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  const linesKey = lines.join('\n');

  useEffect(() => {
    if (lines.length === 0) return;

    // Skip if content hasn't changed
    const currentKey = `${linesKey}:${filePath}:${isDark}`;
    if (currentKey === prevLinesKeyRef.current) {
      return;
    }
    prevLinesKeyRef.current = currentKey;

    // Render plain text first to avoid waiting with a blank screen
    setHighlightedLines(lines.map(l => escapeHtml(l || ' ')));

    let cancelled = false;

    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        if (cancelled) return;
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const content = lines.join('\n');
        const result = highlighter.codeToTokens(content, {
          lang: language as BundledLanguage,
          theme,
        });

        const htmlLines: string[] = [];
        for (let i = 0; i < result.tokens.length; i++) {
          htmlLines[i] = tokensToHtml(result.tokens[i]);
          // Yield every 500 lines to avoid blocking the main thread
          if (i % 500 === 0 && i > 0) {
            await new Promise(r => setTimeout(r, 0));
            if (cancelled) return;
          }
        }

        setHighlightedLines(htmlLines);
      } catch (err) {
        console.error('Line highlight error:', err);
      }
    };

    highlight();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, filePath, isDark]);

  return highlightedLines;
}
