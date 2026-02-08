'use client';

import React, { useState, useEffect, useRef } from 'react';
import { type BundledLanguage } from 'shiki';
import { getHighlighter, getLanguageFromPath } from './codeHighlighter';

// ============================================
// Types
// ============================================

export interface HighlightedLine {
  tokens: Array<{ content: string; style?: string }>;
}

// ============================================
// Line Highlight Hook
// ============================================

export function useLineHighlight(lines: string[], filePath: string): Map<number, HighlightedLine> {
  const [highlightedLines, setHighlightedLines] = useState<Map<number, HighlightedLine>>(new Map());
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

    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const result = new Map<number, HighlightedLine>();

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) {
            result.set(i, { tokens: [{ content: '' }] });
            continue;
          }

          const tokens = highlighter.codeToTokens(line, {
            lang: language as BundledLanguage,
            theme: theme,
          });

          const highlightedTokens = tokens.tokens[0]?.map(token => ({
            content: token.content,
            style: token.color ? `color: ${token.color}` : undefined,
          })) || [{ content: line }];

          result.set(i, { tokens: highlightedTokens });
        }

        setHighlightedLines(result);
      } catch (err) {
        console.error('Line highlight error:', err);
      }
    };

    highlight();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, filePath, isDark]);

  return highlightedLines;
}

// ============================================
// Highlighted Content Component
// ============================================

export function HighlightedContent({
  content,
  highlightedLine,
  className
}: {
  content: string;
  highlightedLine?: HighlightedLine;
  className?: string;
}) {
  if (!highlightedLine || highlightedLine.tokens.length === 0) {
    return <span className={className}>{content || ' '}</span>;
  }

  return (
    <span className={className}>
      {highlightedLine.tokens.map((token, i) => (
        <span key={i} style={token.style ? { color: token.style.replace('color: ', '') } : undefined}>
          {token.content}
        </span>
      ))}
    </span>
  );
}
