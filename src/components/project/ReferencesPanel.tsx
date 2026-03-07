'use client';

import React, { useEffect, useState, useRef } from 'react';
import { X } from 'lucide-react';
import type { Location } from '@/lib/lsp/types';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, tokensToHtml } from '@/lib/codeHighlighter';

interface ReferencesPanelProps {
  references: Location[];
  loading: boolean;
  onSelect: (ref: Location) => void;
  onClose: () => void;
}

/**
 * 对一组 references 的 lineText 做 Shiki 语法高亮，
 * 返回 Map<index, highlightedHTML>
 */
function useHighlightedLines(references: Location[]) {
  const [htmlMap, setHtmlMap] = useState<Map<number, string>>(new Map());
  const [isDark, setIsDark] = useState(false);
  const versionRef = useRef(0);

  // Dark mode detection
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (references.length === 0) { setHtmlMap(new Map()); return; }
    const version = ++versionRef.current;
    const theme = isDark ? 'github-dark' : 'github-light';

    (async () => {
      const highlighter = await getHighlighter();
      if (version !== versionRef.current) return;
      const result = new Map<number, string>();

      for (let i = 0; i < references.length; i++) {
        const ref = references[i];
        if (!ref.lineText) continue;
        const lang = getLanguageFromPath(ref.file);
        if (lang === 'text') continue;
        try {
          const tokens = highlighter.codeToTokens(ref.lineText, { lang: lang as BundledLanguage, theme });
          const html = tokensToHtml(tokens.tokens[0] || []);
          if (html) {
            result.set(i, html);
          }
        } catch {
          // skip highlighting errors
        }
      }

      if (version === versionRef.current) {
        setHtmlMap(result);
      }
    })();
  }, [references, isDark]);

  return htmlMap;
}

export function ReferencesPanel({ references, loading, onSelect, onClose }: ReferencesPanelProps) {
  const htmlMap = useHighlightedLines(references);

  // 按文件分组，保留全局 index
  const grouped: { file: string; items: { ref: Location; idx: number }[] }[] = [];
  const fileIndexMap = new Map<string, number>();
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    let gi = fileIndexMap.get(ref.file);
    if (gi === undefined) {
      gi = grouped.length;
      fileIndexMap.set(ref.file, gi);
      grouped.push({ file: ref.file, items: [] });
    }
    grouped[gi].items.push({ ref, idx: i });
  }

  return (
    <div className="border-t border-border bg-secondary flex flex-col" style={{ height: '300px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-card/50 border-b border-border flex-shrink-0">
        <span className="text-xs font-medium text-foreground">
          引用 {!loading && `(${references.length})`}
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
          <div className="px-3 py-2 text-xs text-muted-foreground">搜索中...</div>
        ) : references.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">未找到引用</div>
        ) : (
          grouped.map(({ file, items }) => (
            <div key={file}>
              <div className="px-3 py-1 text-xs text-muted-foreground font-medium bg-card/30 sticky top-0">
                {file}
              </div>
              {items.map(({ ref, idx }) => (
                <button
                  key={`${ref.line}-${ref.column}-${idx}`}
                  onClick={() => onSelect(ref)}
                  className="w-full text-left px-3 py-0.5 hover:bg-accent/50 flex items-baseline gap-2 group"
                >
                  <span className="text-sm text-muted-foreground font-mono font-variant-tabular flex-shrink-0 w-10 text-right">
                    {ref.line}
                  </span>
                  {htmlMap.has(idx) ? (
                    <span
                      className="text-sm font-mono truncate"
                      dangerouslySetInnerHTML={{ __html: htmlMap.get(idx)! }}
                    />
                  ) : (
                    <span className="text-sm font-mono text-foreground truncate">
                      {ref.lineText || ''}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
