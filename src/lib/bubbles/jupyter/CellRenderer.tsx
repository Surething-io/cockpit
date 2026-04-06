'use client';

import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { MarkdownRenderer } from '@/components/shared/MarkdownRenderer';
import { AnsiUp } from 'ansi_up';
import { useTheme } from '@/components/shared/ThemeProvider';

// ============================================
// Types
// ============================================

export interface CellOutput {
  output_type: string;
  name?: string;           // stream: stdout/stderr
  text?: string | string[];
  data?: Record<string, string | string[]>;
  metadata?: Record<string, unknown>;
  execution_count?: number;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookCell {
  index: number;
  cell_type: 'code' | 'markdown' | 'raw';
  source: string;
  outputs: CellOutput[];
  execution_count: number | null;
  metadata: Record<string, unknown>;
  // Local state
  isExecuting?: boolean;
}

interface CellRendererProps {
  cell: NotebookCell;
  isActive: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onStopEdit: () => void;
  onSourceChange: (source: string) => void;
  onRun: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleType: () => void;
  isFirst: boolean;
  isLast: boolean;
}

// ============================================
// Output rendering helpers
// ============================================

const ansiUpInstance = new AnsiUp();
ansiUpInstance.use_classes = true;

function normalizeText(text: string | string[] | undefined): string {
  if (!text) return '';
  return Array.isArray(text) ? text.join('') : text;
}

function getMimeData(data: Record<string, string | string[]> | undefined, mimeType: string): string {
  if (!data || !data[mimeType]) return '';
  return normalizeText(data[mimeType]);
}

const OutputRenderer = memo(function OutputRenderer({ output }: { output: CellOutput }) {

  if (output.output_type === 'stream') {
    const text = normalizeText(output.text);
    if (!text) return null;
    const html = ansiUpInstance.ansi_to_html(text);
    return (
      <pre
        className={`text-xs leading-relaxed whitespace-pre-wrap break-all px-3 py-1 ${output.name === 'stderr' ? 'text-amber-500' : 'text-foreground'}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (output.output_type === 'error') {
    const tb = (output.traceback || []).join('\n');
    const html = ansiUpInstance.ansi_to_html(tb);
    return (
      <pre
        className="text-xs leading-relaxed whitespace-pre-wrap break-all px-3 py-1 text-red-400 bg-red-500/5 rounded"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (output.output_type === 'execute_result' || output.output_type === 'display_data' || output.output_type === 'update_display_data') {
    const data = output.data;
    if (!data) return null;

    // Priority: image > html > markdown > latex > text
    const imagePng = getMimeData(data, 'image/png');
    const imageJpeg = getMimeData(data, 'image/jpeg');
    const imageSvg = getMimeData(data, 'image/svg+xml');
    const html = getMimeData(data, 'text/html');
    const markdown = getMimeData(data, 'text/markdown');
    const latex = getMimeData(data, 'text/latex');
    const plain = getMimeData(data, 'text/plain');

    if (imagePng) {
      return (
        <div className="px-3 py-1">
          <img src={`data:image/png;base64,${imagePng}`} alt="output" className="max-w-full" />
        </div>
      );
    }
    if (imageJpeg) {
      return (
        <div className="px-3 py-1">
          <img src={`data:image/jpeg;base64,${imageJpeg}`} alt="output" className="max-w-full" />
        </div>
      );
    }
    if (imageSvg) {
      return (
        <div className="px-3 py-1" dangerouslySetInnerHTML={{ __html: imageSvg }} />
      );
    }
    if (html) {
      return (
        <div
          className="px-3 py-1 overflow-x-auto notebook-html-output"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    if (markdown) {
      return (
        <div className="px-3 py-1">
          <MarkdownRenderer content={markdown} />
        </div>
      );
    }
    if (latex) {
      return (
        <div className="px-3 py-1">
          <MarkdownRenderer content={`$$${latex}$$`} />
        </div>
      );
    }
    if (plain) {
      return (
        <pre className="text-xs leading-relaxed whitespace-pre-wrap break-all px-3 py-1 text-foreground">
          {plain}
        </pre>
      );
    }
  }

  return null;
});

// ============================================
// Cell component
// ============================================

export const CellRenderer = memo(function CellRenderer({
  cell,
  isActive,
  isEditing,
  onSelect,
  onEdit,
  onStopEdit,
  onSourceChange,
  onRun,
  onDelete,
  onMoveUp,
  onMoveDown,
  onToggleType,
  isFirst,
  isLast,
}: CellRendererProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // When not editing, always show the cell's source directly.
  // When editing, maintain local state for edits until blur/commit.
  const [localSource, setLocalSource] = useState(cell.source);
  const handleStartEdit = useCallback(() => {
    setLocalSource(cell.source);
    onEdit();
  }, [cell.source, onEdit]);

  // Auto-focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      // Place cursor at end
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [isEditing]);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }
  }, []);

  useEffect(() => {
    if (isEditing) adjustHeight();
  }, [isEditing, localSource, adjustHeight]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalSource(e.target.value);
    adjustHeight();
  }, [adjustHeight]);

  const handleBlur = useCallback(() => {
    if (localSource !== cell.source) {
      onSourceChange(localSource);
    }
    onStopEdit();
  }, [localSource, cell.source, onSourceChange, onStopEdit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      // Commit changes before running
      if (localSource !== cell.source) {
        onSourceChange(localSource);
      }
      onRun();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (localSource !== cell.source) {
        onSourceChange(localSource);
      }
      onRun();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleBlur();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Insert 4 spaces
      const ta = textareaRef.current;
      if (ta) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newVal = localSource.substring(0, start) + '    ' + localSource.substring(end);
        setLocalSource(newVal);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 4;
        });
      }
    }
  }, [localSource, cell.source, onSourceChange, onRun, handleBlur]);

  const execCount = cell.isExecuting ? '*' : (cell.execution_count ?? ' ');
  const cellTypeLabel = cell.cell_type === 'code' ? 'Code' : cell.cell_type === 'markdown' ? 'Md' : 'Raw';

  return (
    <div
      className={`group relative border rounded-lg transition-colors ${
        isActive
          ? 'border-brand/50 bg-brand/5'
          : 'border-border/50 hover:border-border'
      }`}
      onClick={onSelect}
    >
      {/* Cell toolbar — visible on hover or when active */}
      <div className={`absolute -top-3 left-2 flex items-center gap-0.5 text-[10px] z-10 bg-surface-secondary rounded px-1 py-0.5 border border-border/50 transition-opacity ${
        isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}>
        <button onClick={onRun} className="px-1 hover:text-brand" title="Run (Shift+Enter)">
          {cell.isExecuting ? '⬛' : '▶'}
        </button>
        <button onClick={onToggleType} className="px-1 hover:text-brand" title="Toggle type">
          {cellTypeLabel}
        </button>
        {!isFirst && (
          <button onClick={onMoveUp} className="px-1 hover:text-brand" title="Move up">↑</button>
        )}
        {!isLast && (
          <button onClick={onMoveDown} className="px-1 hover:text-brand" title="Move down">↓</button>
        )}
        <button onClick={onDelete} className="px-1 hover:text-red-400" title="Delete">×</button>
      </div>

      {/* Cell content */}
      <div className="flex">
        {/* Left gutter: execution count / cell type */}
        <div
          className="flex-shrink-0 w-10 text-center py-2 text-[10px] text-muted-foreground select-none cursor-pointer border-r border-border/30"
          onClick={(e) => { e.stopPropagation(); onRun(); }}
          title={cell.cell_type === 'code' ? 'Click to run' : undefined}
        >
          {cell.cell_type === 'code' ? (
            <span className={cell.isExecuting ? 'text-brand animate-pulse' : ''}>
              [{execCount}]
            </span>
          ) : (
            <span className="text-muted-foreground/50">{cellTypeLabel}</span>
          )}
        </div>

        {/* Main area: source + outputs */}
        <div className="flex-1 min-w-0">
          {/* Source */}
          <div
            className="cursor-text"
            onDoubleClick={(e) => { e.stopPropagation(); handleStartEdit(); }}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                value={localSource}
                onChange={handleChange}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className="w-full bg-transparent text-xs font-mono leading-relaxed px-3 py-2 resize-none outline-none text-foreground"
                spellCheck={false}
                style={{ minHeight: '1.5rem' }}
              />
            ) : cell.cell_type === 'code' ? (
              <div className="text-xs [&_pre]:!m-0 [&_pre]:!p-2 [&_pre]:!bg-transparent [&_code]:!bg-transparent">
                <SyntaxHighlighter
                  language="python"
                  style={isDark ? oneDark : oneLight}
                  customStyle={{ margin: 0, padding: '8px 12px', background: 'transparent', fontSize: '12px' }}
                  wrapLongLines
                >
                  {cell.source || ' '}
                </SyntaxHighlighter>
              </div>
            ) : cell.cell_type === 'markdown' ? (
              cell.source.trim() ? (
                <div className="px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer content={cell.source} />
                </div>
              ) : (
                <div className="px-3 py-2 text-xs text-muted-foreground italic">Empty markdown cell</div>
              )
            ) : (
              <pre className="text-xs font-mono px-3 py-2 text-muted-foreground whitespace-pre-wrap">
                {cell.source || ' '}
              </pre>
            )}
          </div>

          {/* Outputs */}
          {cell.outputs.length > 0 && (
            <div className="border-t border-border/30">
              {cell.outputs.map((output, i) => (
                <OutputRenderer key={i} output={output} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
