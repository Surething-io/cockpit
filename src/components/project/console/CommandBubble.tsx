'use client';

import { useRef, useEffect, useLayoutEffect, memo, useState, lazy, Suspense, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Clipboard, X, RotateCw, ChevronUp, ChevronDown, Search } from 'lucide-react';
import { toast } from '../../shared/Toast';
import { AnsiUp } from 'ansi_up';
import type { XtermSearchHandle } from './XtermRenderer';

const XtermRenderer = lazy(() => import('./XtermRenderer').then(m => ({ default: m.XtermRenderer })));

interface CommandBubbleProps {
  command: string;
  output: string;
  exitCode?: number;
  isRunning: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onInterrupt?: () => void;
  onStdin?: (data: string) => void;
  onDelete?: () => void;
  onRerun?: () => void;
  timestamp?: string;
  usePty?: boolean;
  onPtyResize?: (cols: number, rows: number) => void;
  onToggleMaximize?: () => void;
  maximized?: boolean;
  /** TerminalView 根容器（用于全屏绝对定位） */
  portalContainer?: HTMLElement | null;
  onTitleMouseDown?: () => void;
}

// 格式化时间：01-15 14:30
const formatTime = (ts?: string) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
};

// 控制键映射表
const CTRL_KEY_MAP: Record<string, string> = {
  c: '\x03', // SIGINT
  d: '\x04', // EOF
  z: '\x1a', // SIGTSTP
  l: '\x0c', // clear
  a: '\x01', // home
  e: '\x05', // end
  u: '\x15', // kill line
  w: '\x17', // kill word
};

// 全屏顶栏高度（px）
const FULLSCREEN_BAR_HEIGHT = 41;

/** 气泡内容区固定高度（px），确保垂直方向刚好放下 2 个完整气泡 */
export const BUBBLE_CONTENT_HEIGHT = 360;

export const CommandBubble = memo(function CommandBubble({
  command,
  output,
  exitCode,
  isRunning,
  selected,
  onSelect,
  onInterrupt,
  onStdin,
  onDelete,
  onRerun,
  timestamp,
  usePty,
  onPtyResize,
  onToggleMaximize,
  maximized,
  portalContainer,
  onTitleMouseDown,
}: CommandBubbleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const shouldAutoScroll = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const stdinRef = useRef<HTMLInputElement>(null);
  const timeStr = formatTime(timestamp);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [stdinValue, setStdinValue] = useState('');

  // xterm DOM 移动相关 ref
  const xtermWrapperRef = useRef<HTMLDivElement>(null);  // xterm 所在的 wrapper
  const bubbleSlotRef = useRef<HTMLDivElement>(null);     // 气泡中的插槽
  const fullscreenXtermAreaRef = useRef<HTMLDivElement>(null); // 全屏 overlay 中的 xterm 区域
  const xtermSearchRef = useRef<XtermSearchHandle>(null); // xterm 搜索接口
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 搜索状态
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // ANSI 解析器 & 增量追踪
  const ansiUpRef = useRef<AnsiUp | null>(null);
  const parsedLenRef = useRef(0);

  if (!ansiUpRef.current) {
    ansiUpRef.current = new AnsiUp();
    ansiUpRef.current.use_classes = true;
  }

  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre || !ansiUpRef.current) return;

    if (output.length < parsedLenRef.current) {
      ansiUpRef.current = new AnsiUp();
      ansiUpRef.current.use_classes = true;
      parsedLenRef.current = 0;
      pre.innerHTML = '';
    }

    if (output.length > parsedLenRef.current) {
      const newPart = output.slice(parsedLenRef.current);
      const newHtml = ansiUpRef.current.ansi_to_html(newPart);
      parsedLenRef.current = output.length;
      pre.insertAdjacentHTML('beforeend', newHtml);
    }

    if (scrollRef.current) {
      const overflow = scrollRef.current.scrollHeight > scrollRef.current.clientHeight;
      setIsOverflowing(overflow);
      if (overflow) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
  }, [output]);

  useEffect(() => {
    if (isRunning && shouldAutoScroll.current && scrollRef.current) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        rafIdRef.current = null;
      });
    }
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [output, isRunning]);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      shouldAutoScroll.current = isAtBottom;
    }
  };

  const handleCopy = () => {
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    navigator.clipboard.writeText(plain);
    toast('已复制输出');
  };

  // ESC 关闭全屏
  useEffect(() => {
    if (!maximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onToggleMaximize?.();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [maximized, onToggleMaximize]);

  /**
   * 原生 DOM 移动 xterm wrapper：
   * maximized 时移入全屏 overlay 的 xterm 区域，还原时移回气泡插槽。
   * xterm.js Terminal 实例不会被销毁（DOM 移动不触发 React unmount）。
   *
   * 全屏 overlay 通过 createPortal 渲染到 portalContainer（terminalRootRef），
   * 使用 position: absolute; inset: 0 覆盖整个 terminal 区域，
   * 不再挂载到 document.body，也不需要 position: fixed。
   */
  useLayoutEffect(() => {
    if (!usePty) return;
    const xtermWrapper = xtermWrapperRef.current;
    if (!xtermWrapper) return;

    if (maximized && fullscreenXtermAreaRef.current) {
      // 移入全屏 overlay 的 xterm 区域
      fullscreenXtermAreaRef.current.appendChild(xtermWrapper);

      // DOM 移动后重新聚焦 xterm
      requestAnimationFrame(() => {
        const xtermEl = xtermWrapper.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        xtermEl?.focus();
      });

      return () => {
        // 移回气泡插槽
        if (bubbleSlotRef.current && xtermWrapper.parentElement) {
          bubbleSlotRef.current.appendChild(xtermWrapper);
        }
        // 退出全屏时关闭搜索
        setSearchVisible(false);
        setSearchQuery('');
      };
    }
  }, [maximized, usePty]);

  const lineCount = output ? output.split('\n').length : 0;

  // 搜索：Cmd+F 唤出，ESC 关闭
  const openSearch = useCallback(() => {
    setSearchVisible(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
    xtermSearchRef.current?.clearSearch();
  }, []);

  const doSearchNext = useCallback((q: string) => {
    if (q.trim()) xtermSearchRef.current?.findNext(q);
  }, []);

  const doSearchPrev = useCallback((q: string) => {
    if (q.trim()) xtermSearchRef.current?.findPrevious(q);
  }, []);

  // Cmd+F / ESC 快捷键（仅在 PTY 全屏时）
  useEffect(() => {
    if (!usePty || !maximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return;
      }
      if (e.key === 'Escape' && searchVisible) {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [usePty, maximized, searchVisible, openSearch, closeSearch]);

  // 全屏 overlay：通过 createPortal 渲染到 terminalRootRef，absolute 定位覆盖整个 terminal 区域
  // PTY 模式全屏 overlay
  const fullscreenOverlay = usePty && maximized && portalContainer ? createPortal(
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card)',
      }}
    >
      {/* 顶栏 */}
      <div onDoubleClick={() => onToggleMaximize?.()} className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card" style={{ height: FULLSCREEN_BAR_HEIGHT, flexShrink: 0 }}>
        <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded bg-muted text-muted-foreground">&gt;_</span>
        <span className="flex-1 text-xs text-muted-foreground truncate font-mono">{command}</span>
        {isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            运行中
          </span>
        )}
        {isRunning && onInterrupt && (
          <button
            onClick={onInterrupt}
            className="text-xs px-3 py-1 rounded-md font-medium bg-destructive text-destructive-foreground transition-all duration-150 hover:bg-destructive/80 hover:shadow-md active:scale-95 active:bg-destructive/70 cursor-pointer select-none"
          >
            Ctrl+C
          </button>
        )}
        <button
          onClick={() => onToggleMaximize?.()}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="还原 (⌘M / ESC)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* 搜索栏 - Cmd+F 唤出 */}
      {searchVisible && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card" style={{ flexShrink: 0 }}>
          <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value.trim()) xtermSearchRef.current?.findNext(e.target.value);
              else xtermSearchRef.current?.clearSearch();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) doSearchPrev(searchQuery);
                else doSearchNext(searchQuery);
              }
            }}
            placeholder="搜索..."
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck="false"
          />
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => doSearchPrev(searchQuery)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="上一个 (Shift+Enter)"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => doSearchNext(searchQuery)}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="下一个 (Enter)"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={closeSearch}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {/* xterm 区域 - 原生 DOM 会将 xtermWrapper 移入此处 */}
      <div ref={fullscreenXtermAreaRef} style={{ flex: 1, overflow: 'hidden' }} />
    </div>,
    portalContainer,
  ) : null;

  return (
    <div className="flex flex-col items-start">
        <div
          className={`w-full bg-accent text-foreground dark:text-slate-11 rounded-2xl rounded-bl-md rounded-br-md relative overflow-hidden border transition-colors cursor-pointer ${
            selected ? 'border-brand' : 'border-brand/30'
          }`}
          onClick={onSelect}
        >
          {/* 命令行头部 - 最大化时隐藏 */}
          {!maximized && (
          <div
            data-drag-handle
            onMouseDown={() => onTitleMouseDown?.()}
            onDoubleClick={(e) => { e.stopPropagation(); onToggleMaximize?.(); }}
            className={`flex items-center gap-2 px-4 py-1.5 border-b text-xs transition-colors cursor-grab active:cursor-grabbing ${
            selected ? 'border-brand' : 'border-brand/30'
          }`}>
            <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">&gt;_</span>
            <span className="font-mono text-foreground truncate">{command}</span>
            <button
              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(command); toast('已复制命令'); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="复制命令"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <span className="flex-1" />
            {isOverflowing && !isRunning && (
              <span className="text-muted-foreground flex-shrink-0">共 {lineCount} 行</span>
            )}
            {output && (
              <button
                onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="复制输出"
              >
                <Clipboard className="w-3.5 h-3.5" />
              </button>
            )}
            {onRerun && (
              <button
                onClick={(e) => { e.stopPropagation(); onRerun(); }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="重新运行"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-0.5 rounded text-destructive hover:text-destructive/80 transition-colors flex-shrink-0"
                title="删除记录"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          )}

          {/* 输出内容 */}
          {usePty ? (
            /**
             * PTY: bubbleSlotRef 是气泡内的插槽。
             * xtermWrapperRef 包含 XtermRenderer，maximized 时通过原生 DOM appendChild
             * 移入全屏 overlay 的 xterm 区域，还原时移回此插槽。
             * React 树位置不变 → xterm Terminal 实例不会被销毁。
             */
            <div ref={bubbleSlotRef}>
              <div ref={xtermWrapperRef} style={maximized ? { height: '100%' } : undefined}>
                <Suspense fallback={<div className="px-4 py-2 text-xs text-muted-foreground" style={{ height: BUBBLE_CONTENT_HEIGHT }}>加载终端...</div>}>
                  <XtermRenderer ref={xtermSearchRef} output={output} isRunning={isRunning} onInput={onStdin} onResize={onPtyResize} maximized={maximized} height={BUBBLE_CONTENT_HEIGHT} />
                </Suspense>
              </div>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="overflow-auto px-4 py-2"
              style={{ height: BUBBLE_CONTENT_HEIGHT }}
              onScroll={handleScroll}
            >
              <pre ref={preRef} className="text-sm font-mono whitespace-pre-wrap break-words select-text" />
            </div>
          )}

          {/* 运行中状态栏 - 最大化时隐藏 */}
          {isRunning && !maximized && (
            <div className="border-t border-border px-4 py-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
              {usePty ? (
                <>
                  <span className="text-xs text-muted-foreground flex-1">点击终端区域输入</span>
                  {onToggleMaximize && (
                    <button
                      onClick={onToggleMaximize}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                      title="最大化 (⌘M)"
                    >
                      最大化
                    </button>
                  )}
                </>
              ) : onStdin ? (
                <input
                  ref={stdinRef}
                  value={stdinValue}
                  onChange={(e) => setStdinValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.ctrlKey && !e.metaKey && !e.altKey) {
                      const ctrl = CTRL_KEY_MAP[e.key.toLowerCase()];
                      if (ctrl) {
                        e.preventDefault();
                        e.stopPropagation();
                        onStdin(ctrl);
                        return;
                      }
                    }
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      onStdin(stdinValue + '\n');
                      setStdinValue('');
                    }
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      onStdin('\t');
                    }
                  }}
                  placeholder="stdin 输入..."
                  className="flex-1 min-w-0 bg-transparent text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground"
                  autoComplete="off"
                  spellCheck="false"
                />
              ) : (
                <span className="text-xs text-muted-foreground">运行中...</span>
              )}
              {onInterrupt && (
                <button
                  onClick={onInterrupt}
                  className="flex-shrink-0 text-xs text-destructive hover:brightness-125 transition-colors cursor-pointer select-none"
                >
                  Ctrl+C
                </button>
              )}
              {timeStr && <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeStr}</span>}
            </div>
          )}

          {/* 已结束：退出代码 - 最大化时隐藏 */}
          {!isRunning && exitCode !== undefined && !maximized && (
            <div className="border-t border-border px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`inline-block w-2 h-2 rounded-full ${exitCode === 0 ? 'bg-green-500' : 'bg-red-500'}`} />
              <span>退出代码: {exitCode}</span>
              <span className="flex-1" />
              {timeStr && <span className="text-[11px] flex-shrink-0">{timeStr}</span>}
            </div>
          )}
        </div>

      {/* 全屏 overlay - 通过 createPortal 渲染到 terminalRootRef */}
      {fullscreenOverlay}
    </div>
  );
});
