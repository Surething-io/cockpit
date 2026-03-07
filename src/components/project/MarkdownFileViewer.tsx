'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { useLineHighlight } from '@/hooks/useLineHighlight';
import { escapeHtml } from '@/lib/codeHighlighter';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';

type MdViewMode = 'source' | 'preview' | 'split';

interface MarkdownFileViewerProps {
  content: string;
  filePath: string;
  className?: string;
}

export function MarkdownFileViewer({ content, filePath, className = '' }: MarkdownFileViewerProps) {
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>('source');
  const lines = useMemo(() => content.split('\n'), [content]);
  const highlightedLines = useLineHighlight(lines, filePath);

  // 双栏滚动同步
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);

  // 滚动同步处理
  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;

    const sourceEl = source === 'left' ? leftPanelRef.current : rightPanelRef.current;
    const targetEl = source === 'left' ? rightPanelRef.current : leftPanelRef.current;

    if (sourceEl && targetEl) {
      const scrollRatio = sourceEl.scrollTop / (sourceEl.scrollHeight - sourceEl.clientHeight || 1);
      targetEl.scrollTop = scrollRatio * (targetEl.scrollHeight - targetEl.clientHeight);
    }

    requestAnimationFrame(() => {
      isSyncingRef.current = false;
    });
  }, []);

  // 渲染模式切换按钮
  const renderModeSwitch = () => (
    <div className="flex items-center gap-1 bg-accent rounded p-0.5">
      <button
        onClick={() => setMdViewMode('source')}
        className={`px-2 py-1 text-xs rounded transition-colors ${
          mdViewMode === 'source'
            ? 'bg-card text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        title="原文"
      >
        原文
      </button>
      <button
        onClick={() => setMdViewMode('preview')}
        className={`px-2 py-1 text-xs rounded transition-colors ${
          mdViewMode === 'preview'
            ? 'bg-card text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        title="预览"
      >
        预览
      </button>
      <button
        onClick={() => setMdViewMode('split')}
        className={`px-2 py-1 text-xs rounded transition-colors ${
          mdViewMode === 'split'
            ? 'bg-card text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        title="双栏"
      >
        双栏
      </button>
    </div>
  );

  // 渲染源码（带高亮）
  const renderSource = () => (
    <pre className="font-mono text-sm text-foreground whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span
          key={i}
          dangerouslySetInnerHTML={{ __html: (highlightedLines[i] || escapeHtml(line || ' ')) + '\n' }}
        />
      ))}
    </pre>
  );

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* 顶部工具栏 */}
      <div className="px-4 py-2 bg-secondary border-b border-border flex items-center justify-end flex-shrink-0">
        {renderModeSwitch()}
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {mdViewMode === 'source' && (
          <div className="h-full overflow-auto p-4">
            {renderSource()}
          </div>
        )}

        {mdViewMode === 'preview' && (
          <div className="h-full overflow-auto p-4">
            <MarkdownRenderer content={content} />
          </div>
        )}

        {mdViewMode === 'split' && (
          <div className="h-full flex">
            {/* 左侧：原文（带语法高亮） */}
            <div
              ref={leftPanelRef}
              className="w-1/2 h-full overflow-auto border-r border-border p-4 bg-secondary"
              onScroll={() => handleScroll('left')}
            >
              {renderSource()}
            </div>
            {/* 右侧：预览 */}
            <div
              ref={rightPanelRef}
              className="w-1/2 h-full overflow-auto p-4"
              onScroll={() => handleScroll('right')}
            >
              <MarkdownRenderer content={content} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 检测是否为 Markdown 文件
export function isMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}
