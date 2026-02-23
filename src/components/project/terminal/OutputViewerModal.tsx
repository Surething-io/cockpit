'use client';

import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { X, Filter, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { AnsiUp } from 'ansi_up';

interface OutputViewerModalProps {
  output: string;
  isRunning: boolean;
  onClose: () => void;
}

// 去除 ANSI 转义码
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * 输出查看器 Modal
 * 覆盖 TERMINAL 区域，支持行过滤和搜索高亮
 */
export const OutputViewerModal = memo(function OutputViewerModal({
  output,
  isRunning,
  onClose,
}: OutputViewerModalProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'filter' | 'search'>('filter');
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0); // 搜索模式当前匹配行索引
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mouseDownIsSelect = useRef(false);
  const ansiUpRef = useRef<AnsiUp | null>(null);

  if (!ansiUpRef.current) {
    ansiUpRef.current = new AnsiUp();
    ansiUpRef.current.use_classes = true;
  }

  // 聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 将 output 分行
  const lines = useMemo(() => output.split('\n'), [output]);

  // 行过滤模式：只显示匹配行
  const filteredLines = useMemo(() => {
    if (!query.trim() || mode !== 'filter') return null;
    const lowerQuery = query.toLowerCase();
    const result: { index: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (stripAnsi(lines[i]).toLowerCase().includes(lowerQuery)) {
        result.push({ index: i, text: lines[i] });
      }
    }
    return result;
  }, [lines, query, mode]);

  // 搜索模式：匹配行的索引列表（用于跳转）
  const matchLineIndices = useMemo(() => {
    if (!query.trim() || mode !== 'search') return [];
    const lowerQuery = query.toLowerCase();
    const indices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (stripAnsi(lines[i]).toLowerCase().includes(lowerQuery)) {
        indices.push(i);
      }
    }
    return indices;
  }, [lines, query, mode]);

  // 匹配行 Set（快速查找当前行是否是匹配行）
  const matchLineSet = useMemo(() => new Set(matchLineIndices), [matchLineIndices]);

  // query 变化时重置当前匹配索引
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [query, mode]);

  // 跳转到匹配行
  const scrollToMatchLine = useCallback((lineIndex: number) => {
    const row = contentRef.current?.querySelector(`[data-line="${lineIndex}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, []);

  // 上一个/下一个匹配
  const goNextMatch = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    const next = (currentMatchIdx + 1) % matchLineIndices.length;
    setCurrentMatchIdx(next);
    scrollToMatchLine(matchLineIndices[next]);
  }, [matchLineIndices, currentMatchIdx, scrollToMatchLine]);

  const goPrevMatch = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    const prev = (currentMatchIdx - 1 + matchLineIndices.length) % matchLineIndices.length;
    setCurrentMatchIdx(prev);
    scrollToMatchLine(matchLineIndices[prev]);
  }, [matchLineIndices, currentMatchIdx, scrollToMatchLine]);

  // ESC 关闭 + Enter/Shift+Enter 跳转（搜索模式）
  // 使用 capture 阶段确保优先于其他 handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // 搜索模式下 Enter/Shift+Enter 跳转
      if (e.key === 'Enter' && mode === 'search' && matchLineIndices.length > 0) {
        e.preventDefault();
        if (e.shiftKey) {
          goPrevMatch();
        } else {
          goNextMatch();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, mode, matchLineIndices.length, goNextMatch, goPrevMatch]);

  // ANSI 渲染单行（两种模式都高亮关键词）
  const renderLine = useCallback((text: string, keyword: string, highlight: boolean) => {
    const ansi = new AnsiUp();
    ansi.use_classes = true;
    let html = ansi.ansi_to_html(text);

    // 高亮关键词
    if (highlight && keyword.trim()) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escaped})`, 'gi');
      html = html.replace(regex, '<mark class="bg-yellow-400/50 text-foreground rounded px-0.5">$1</mark>');
    }

    return html;
  }, []);

  // 初次打开和运行中时自动滚动到底部
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (contentRef.current && (!initialScrollDone.current || isRunning)) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [output, isRunning]);

  const displayLines = mode === 'filter' && filteredLines
    ? filteredLines
    : lines.map((text, index) => ({ index, text }));

  const totalLines = lines.length;
  const shownLines = displayLines.length;
  const hasQuery = query.trim().length > 0;
  const currentMatchLineIndex = matchLineIndices[currentMatchIdx] ?? -1;

  return (
    <div className="absolute inset-0 z-50 bg-card flex flex-col">
      {/* 顶栏：搜索/过滤 + 模式切换 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {/* 模式图标 */}
        <button
          onClick={() => setMode(mode === 'filter' ? 'search' : 'filter')}
          className={`p-1.5 rounded transition-colors ${
            mode === 'filter'
              ? 'text-brand bg-brand/10'
              : 'text-brand bg-brand/10'
          }`}
          title={mode === 'filter' ? '行过滤模式（点击切换搜索）' : '搜索高亮模式（点击切换过滤）'}
        >
          {mode === 'filter' ? <Filter className="w-4 h-4" /> : <Search className="w-4 h-4" />}
        </button>

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'filter' ? '输入关键词过滤行...' : '输入关键词搜索高亮...'}
          className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          autoComplete="off"
          spellCheck="false"
        />

        {/* 搜索模式：上一个/下一个 + 统计 */}
        {mode === 'search' && hasQuery && matchLineIndices.length > 0 && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={goPrevMatch}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="上一个 (Shift+Enter)"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[4em] text-center">
              {currentMatchIdx + 1} / {matchLineIndices.length}
            </span>
            <button
              onClick={goNextMatch}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="下一个 (Enter)"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 搜索模式无匹配 */}
        {mode === 'search' && hasQuery && matchLineIndices.length === 0 && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">无匹配</span>
        )}

        {/* 统计 */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {hasQuery && mode === 'filter'
            ? `${shownLines} / ${totalLines} 行`
            : `${totalLines} 行`}
        </span>

        {/* 模式标签 */}
        <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary whitespace-nowrap">
          {mode === 'filter' ? '过滤' : '搜索'}
        </span>

        <button
          onClick={onClose}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 内容区域：点击缩小，拖选不触发 */}
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-sm"
        onMouseDown={() => { mouseDownIsSelect.current = false; }}
        onMouseMove={() => { mouseDownIsSelect.current = true; }}
        onClick={() => {
          if (mouseDownIsSelect.current) return;
          if (window.getSelection()?.toString()) return;
          onClose();
        }}
      >
        {displayLines.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            {query.trim() ? '没有匹配的行' : '无输出'}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {displayLines.map((item) => {
                const isCurrentMatch = mode === 'search' && item.index === currentMatchLineIndex;
                const isMatch = mode === 'search' && matchLineSet.has(item.index);
                return (
                  <tr
                    key={item.index}
                    data-line={item.index}
                    className={`${
                      isCurrentMatch
                        ? 'bg-yellow-400/15'
                        : isMatch
                          ? 'bg-yellow-400/5'
                          : 'hover:bg-accent/30'
                    }`}
                  >
                    <td className="text-right text-muted-foreground select-none pr-3 py-0 align-top w-[1%] whitespace-nowrap text-xs opacity-50">
                      {item.index + 1}
                    </td>
                    <td className="py-0 align-top">
                      <pre
                        className="whitespace-pre-wrap break-words"
                        dangerouslySetInnerHTML={{
                          __html: renderLine(item.text, query, hasQuery),
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 运行中指示 */}
      {isRunning && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span>运行中，输出持续更新...</span>
        </div>
      )}
    </div>
  );
});
