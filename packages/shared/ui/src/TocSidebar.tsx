'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from './Tooltip';

// ============================================
// TocSidebar — Reusable Markdown table of contents sidebar
// Extracts h1~h6 from markdown source, scroll spy highlights current section, collapsible
// ============================================

export interface TocItem {
  level: number;      // 1-6
  text: string;       // Heading text
  sourceLine: number; // Source line number (1-based)
}

/** Extract heading list from markdown source */
export function extractToc(content: string): TocItem[] {
  const items: TocItem[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      items.push({
        level: match[1].length,
        text: match[2].replace(/\s*#+\s*$/, ''),
        sourceLine: i + 1,
      });
    }
  }
  return items;
}

// Heading selector: locate by data-source-start attribute
const HEADING_SELECTOR = (line: number) =>
  `h1[data-source-start="${line}"], h2[data-source-start="${line}"], h3[data-source-start="${line}"], h4[data-source-start="${line}"], h5[data-source-start="${line}"], h6[data-source-start="${line}"]`;

interface TocSidebarProps {
  /** Markdown source used to extract headings */
  content: string;
  /** Scroll container ref of the rendered content (for scroll spy + scrollIntoView) */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Sidebar width class, defaults to w-80 */
  width?: string;
}

export function TocSidebar({ content, containerRef, width = 'w-80' }: TocSidebarProps) {
  const { t } = useTranslation();
  const tocItems = useMemo(() => extractToc(content), [content]);
  const [collapsed, setCollapsed] = useState(false);
  const [activeHeadingLine, setActiveHeadingLine] = useState<number | null>(null);

  // Click TOC item → scroll to corresponding heading
  const handleTocClick = useCallback((sourceLine: number) => {
    const container = containerRef.current;
    if (!container) return;
    const headingEl = container.querySelector(HEADING_SELECTOR(sourceLine)) as HTMLElement | null;
    if (headingEl) {
      headingEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [containerRef]);

  // Scroll spy
  useEffect(() => {
    const container = containerRef.current;
    if (!container || tocItems.length === 0) return;

    const handleScroll = () => {
      const headings: { line: number; top: number }[] = [];
      for (const item of tocItems) {
        const el = container.querySelector(HEADING_SELECTOR(item.sourceLine)) as HTMLElement | null;
        if (el) {
          const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
          headings.push({ line: item.sourceLine, top });
        }
      }
      const threshold = 60;
      let active: number | null = null;
      for (const h of headings) {
        if (h.top <= threshold) {
          active = h.line;
        }
      }
      if (active === null && headings.length > 0) {
        active = headings[0].line;
      }
      setActiveHeadingLine(active);
    };

    const timer = setTimeout(handleScroll, 150);
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [tocItems, content, containerRef]);

  if (tocItems.length === 0) return null;

  return (
    <div className={`border-r border-border flex-shrink-0 flex flex-col transition-[width] duration-200 ${collapsed ? 'w-8' : width}`}>
      {/* Header + collapse button */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border flex-shrink-0">
        {!collapsed && <span className="text-xs font-medium text-muted-foreground">{t('editor.toc')}</span>}
        <button
          onClick={() => setCollapsed(v => !v)}
          className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          title={collapsed ? t('editor.expandToc') : t('editor.collapseToc')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {collapsed ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            )}
          </svg>
        </button>
      </div>
      {/* TOC list */}
      {!collapsed && (
        <nav className="flex-1 overflow-y-auto py-1">
          {tocItems.map((item, i) => (
            <Tooltip key={i} content={item.text} delay={400}>
              <button
                onClick={() => handleTocClick(item.sourceLine)}
                className={`block w-full text-left text-sm py-1 px-2 truncate transition-colors hover:bg-accent ${
                  activeHeadingLine === item.sourceLine
                    ? 'text-brand font-medium bg-brand/5'
                    : 'text-muted-foreground'
                }`}
                style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
              >
                {item.text}
              </button>
            </Tooltip>
          ))}
        </nav>
      )}
    </div>
  );
}
