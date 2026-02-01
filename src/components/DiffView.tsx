'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

// ============================================
// Types
// ============================================

export interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

interface HighlightedLine {
  tokens: Array<{ content: string; style?: string }>;
}

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew?: boolean;
  isDeleted?: boolean;
}

// ============================================
// Shiki Highlighter Singleton
// ============================================

let highlighterPromise: Promise<Highlighter> | null = null;

const SUPPORTED_LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx',
  'html', 'css', 'scss', 'json', 'yaml',
  'python', 'go', 'rust', 'java', 'ruby', 'php',
  'bash', 'shell', 'markdown', 'sql', 'c', 'cpp',
  'swift', 'kotlin', 'dart', 'lua', 'graphql', 'xml',
] as const;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...SUPPORTED_LANGS],
    });
  }
  return highlighterPromise;
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    mjs: 'javascript', cjs: 'javascript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', rb: 'ruby', php: 'php',
    cs: 'cpp', cpp: 'cpp', c: 'c', h: 'c',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown', mdx: 'markdown', sql: 'sql',
    swift: 'swift', dart: 'dart', lua: 'lua',
    graphql: 'graphql', gql: 'graphql',
    dockerfile: 'bash',
    toml: 'yaml', sass: 'scss', less: 'css',
    scala: 'java', r: 'python', vim: 'bash',
  };
  const lang = map[ext || ''] || 'text';
  if (SUPPORTED_LANGS.includes(lang as typeof SUPPORTED_LANGS[number])) {
    return lang;
  }
  return 'text';
}

// ============================================
// LCS-based Line Diff Algorithm
// ============================================

export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];

  const m = oldLines.length;
  const n = newLines.length;

  // Build DP table for LCS
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to generate diff
  let i = m, j = n;
  const diffStack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffStack.push({ type: 'unchanged', content: oldLines[i - 1], oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffStack.push({ type: 'added', content: newLines[j - 1], newLineNum: j });
      j--;
    } else {
      diffStack.push({ type: 'removed', content: oldLines[i - 1], oldLineNum: i });
      i--;
    }
  }

  // Reverse to get correct order
  while (diffStack.length > 0) {
    result.push(diffStack.pop()!);
  }

  return result;
}

// ============================================
// Line Highlight Hook
// ============================================

function useLineHighlight(lines: string[], filePath: string): Map<number, HighlightedLine> {
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

function HighlightedContent({
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

// ============================================
// Diff Minimap Component
// ============================================

function DiffMinimap({
  lines,
  containerRef,
}: {
  lines: Array<{ type: 'unchanged' | 'removed' | 'added' }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewportInfo, setViewportInfo] = useState({ top: 0, height: 0 });

  // Update viewport indicator position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewport = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const minimapHeight = minimapRef.current?.clientHeight || 0;

      if (scrollHeight <= clientHeight) {
        // Content doesn't overflow, viewport covers entire minimap
        setViewportInfo({ top: 0, height: minimapHeight });
      } else {
        const ratio = minimapHeight / scrollHeight;
        setViewportInfo({
          top: scrollTop * ratio,
          height: clientHeight * ratio,
        });
      }
    };

    updateViewport();
    container.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      container.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [containerRef]);

  // Click to jump
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const minimap = minimapRef.current;
    if (!container || !minimap) return;

    const rect = minimap.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = clickY / rect.height;

    const targetScroll = ratio * container.scrollHeight - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  };

  if (lines.length === 0) return null;

  // Calculate line height percentage for minimap
  const lineHeight = 100 / lines.length;

  return (
    <div
      ref={minimapRef}
      className="w-4 flex-shrink-0 bg-secondary border-l border-border relative cursor-pointer"
      onClick={handleClick}
    >
      {/* Change markers with percentage positioning */}
      {lines.map((line, idx) => (
        line.type !== 'unchanged' && (
          <div
            key={idx}
            className={`absolute left-0 right-0 ${
              line.type === 'removed' ? 'bg-red-400 dark:bg-red-500' : 'bg-green-400 dark:bg-green-500'
            }`}
            style={{
              top: `${idx * lineHeight}%`,
              height: `${Math.max(lineHeight, 0.5)}%`,
              minHeight: '2px',
            }}
          />
        )
      ))}
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 bg-slate-8/40 border-y border-slate-8"
        style={{
          top: `${viewportInfo.top}px`,
          height: `${Math.max(viewportInfo.height, 10)}px`,
        }}
      />
    </div>
  );
}

// ============================================
// Main DiffView Component (Split View)
// ============================================

export function DiffView({ oldContent, newContent, filePath, isNew = false, isDeleted = false }: DiffViewProps) {
  const diffLines = computeLineDiff(oldContent, newContent);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);

  // Sync both vertical and horizontal scroll between left and right panels
  useEffect(() => {
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!leftPanel || !rightPanel) return;

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    };

    const handleLeftScroll = () => syncScroll(leftPanel, rightPanel);
    const handleRightScroll = () => syncScroll(rightPanel, leftPanel);

    leftPanel.addEventListener('scroll', handleLeftScroll);
    rightPanel.addEventListener('scroll', handleRightScroll);

    return () => {
      leftPanel.removeEventListener('scroll', handleLeftScroll);
      rightPanel.removeEventListener('scroll', handleRightScroll);
    };
  }, []);

  // Split into left and right columns
  const leftLines: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
  const rightLines: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

  let leftIdx = 0;
  let rightIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type === 'unchanged') {
      // Align: pad with empty lines if needed
      while (leftLines.length < rightLines.length) {
        leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      }
      while (rightLines.length < leftLines.length) {
        rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      }
      leftIdx++;
      rightIdx++;
      leftLines.push({ lineNum: leftIdx, content: line.content, type: 'unchanged', originalIdx: i });
      rightLines.push({ lineNum: rightIdx, content: line.content, type: 'unchanged', originalIdx: i });
    } else if (line.type === 'removed') {
      leftIdx++;
      leftLines.push({ lineNum: leftIdx, content: line.content, type: 'removed', originalIdx: i });
    } else if (line.type === 'added') {
      rightIdx++;
      rightLines.push({ lineNum: rightIdx, content: line.content, type: 'added', originalIdx: i });
    }
  }

  // Final alignment
  while (leftLines.length < rightLines.length) {
    leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }

  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // Adjust left/right width based on file status: new file 25%/75%, deleted 75%/25%, otherwise 50%/50%
  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  // Prepare minimap line types
  const minimapLines = leftLines.map((leftLine, idx) => {
    const rightLine = rightLines[idx];
    if (leftLine.type === 'removed') return { type: 'removed' as const };
    if (rightLine?.type === 'added') return { type: 'added' as const };
    return { type: 'unchanged' as const };
  });

  return (
    <div className="font-mono flex flex-col h-full" style={{ fontSize: '0.8125rem' }}>
      {/* Header row - fixed */}
      <div className="flex flex-shrink-0 border-b border-border">
        <div className={`${leftWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium border-r border-border`}>
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        <div className={`${rightWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium`}>
          {isDeleted ? '(Deleted)' : 'New'}
        </div>
        <div className="w-4 flex-shrink-0 bg-accent" />
      </div>
      {/* Content row - two independent scroll panels with synced vertical scroll */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel - Old */}
        <div
          ref={leftPanelRef}
          className={`${leftWidth} overflow-auto border-r border-border`}
        >
          <div className="min-w-max">
            {leftLines.map((line, idx) => (
              <div
                key={idx}
                className={`flex ${line.type === 'removed' ? 'bg-red-9/15 dark:bg-red-9/25' : ''}`}
              >
                <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                  {line.lineNum || ''}
                </span>
                <HighlightedContent
                  content={line.content}
                  highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
                  className="whitespace-pre pl-2"
                />
              </div>
            ))}
          </div>
        </div>
        {/* Right Panel - New */}
        <div
          ref={rightPanelRef}
          className={`${rightWidth} overflow-auto`}
        >
          <div className="min-w-max">
            {rightLines.map((line, idx) => (
              <div
                key={idx}
                className={`flex ${line?.type === 'added' ? 'bg-green-9/15 dark:bg-green-9/25' : ''}`}
              >
                <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                  {line?.lineNum || ''}
                </span>
                <HighlightedContent
                  content={line?.content || ''}
                  highlightedLine={line?.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
                  className="whitespace-pre pl-2"
                />
              </div>
            ))}
          </div>
        </div>
        {/* Minimap */}
        <DiffMinimap
          lines={minimapLines}
          containerRef={leftPanelRef}
        />
      </div>
    </div>
  );
}

// ============================================
// Unified Diff View Component (optional export)
// ============================================

export function DiffUnifiedView({ oldContent, newContent, filePath }: Omit<DiffViewProps, 'isNew' | 'isDeleted'>) {
  const diffLines = computeLineDiff(oldContent, newContent);

  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  return (
    <div className="font-mono" style={{ fontSize: '0.8125rem' }}>
      {diffLines.map((line, idx) => (
        <div
          key={idx}
          className={`flex ${
            line.type === 'removed'
              ? 'bg-red-9/15 dark:bg-red-9/25'
              : line.type === 'added'
              ? 'bg-green-9/15 dark:bg-green-9/25'
              : ''
          }`}
        >
          {/* Line numbers */}
          <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
            {line.type !== 'added' ? line.oldLineNum : ''}
          </span>
          <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
            {line.type !== 'removed' ? line.newLineNum : ''}
          </span>
          {/* Symbol */}
          <span
            className={`w-6 flex-shrink-0 text-center select-none ${
              line.type === 'removed'
                ? 'text-red-11'
                : line.type === 'added'
                ? 'text-green-11'
                : 'text-slate-9'
            }`}
          >
            {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
          </span>
          {/* Content with syntax highlighting */}
          <HighlightedContent
            content={line.content}
            highlightedLine={highlightedLines.get(idx)}
            className="flex-1 whitespace-pre pl-1"
          />
        </div>
      ))}
    </div>
  );
}

// Default export is the split view
export default DiffView;
