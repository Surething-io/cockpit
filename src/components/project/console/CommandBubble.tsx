'use client';

import React, { useRef, useEffect, useLayoutEffect, memo, useState, lazy, Suspense, useCallback } from 'react';
import { Copy, Clipboard, X, RotateCw, ChevronUp, ChevronDown, Search } from 'lucide-react';
import { toast } from '../../shared/Toast';
import { useTranslation } from 'react-i18next';
import { AnsiUp } from 'ansi_up';
import type { XtermSearchHandle } from './XtermRenderer';
import { toShortId } from '@/lib/shortId';
import { ShortIdBadge } from './ShortIdBadge';
import { modKey } from '@/lib/platform';

const XtermRenderer = lazy(() => import('./XtermRenderer').then(m => ({ default: m.XtermRenderer })));

interface CommandBubbleProps {
  commandId?: string;
  tabId?: string;
  projectCwd?: string;
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
  /** Total height when maximized (passed in from ConsoleView's scrollRef.clientHeight) */
  expandedHeight?: number;
  /** Content height when not maximized (50% layout, computed by ConsoleView) */
  bubbleContentHeight?: number;
  onTitleMouseDown?: () => void;
}

// Format time: 01-15 14:30
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

// Control key mapping table
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

// Fullscreen top bar height (px)
const FULLSCREEN_BAR_HEIGHT = 41;

/** Bubble content area fixed height (px), ensures exactly 2 full bubbles fit vertically */
export const BUBBLE_CONTENT_HEIGHT = 360;

 
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

/** Pipe search/filter view */
function PipeSearchView({
  output,
  query,
  mode,
  currentIdx,
  matchRefs,
}: {
  output: string;
  query: string;
  mode: 'search' | 'filter';
  currentIdx: number;
  matchRefs: React.MutableRefObject<(HTMLElement | null)[]>;
}) {
  const ansiUp = useRef<AnsiUp | null>(null);
  if (!ansiUp.current) {
    ansiUp.current = new AnsiUp();
    ansiUp.current.use_classes = true;
  }

  const lines = output.split('\n');
  const q = query.toLowerCase();
  let matchCount = 0;
  matchRefs.current = [];

  return (
    <pre className="text-sm font-mono whitespace-pre-wrap break-words select-text">
      {lines.map((line, i) => {
        const plain = stripAnsi(line);
        const matches = plain.toLowerCase().includes(q);

        if (mode === 'filter' && !matches) return null;

        if (!matches) {
          // No match: render ANSI normally
          const html = ansiUp.current!.ansi_to_html(line);
          return <div key={i} dangerouslySetInnerHTML={{ __html: html }} />;
        }

        // Has match: highlight matched text
        const parts: React.ReactNode[] = [];
        let lastIdx = 0;
        const lowerPlain = plain.toLowerCase();
        let searchFrom = 0;

        while (searchFrom < lowerPlain.length) {
          const pos = lowerPlain.indexOf(q, searchFrom);
          if (pos === -1) break;

          // Text before match
          if (pos > lastIdx) {
            parts.push(<span key={`t${lastIdx}`}>{plain.slice(lastIdx, pos)}</span>);
          }

          // Highlighted match text
          const thisMatchIdx = matchCount++;
          const isCurrent = thisMatchIdx === currentIdx;
          parts.push(
            <mark
              key={`m${pos}`}
              ref={(el) => { matchRefs.current[thisMatchIdx] = el; }}
              className={isCurrent ? 'bg-brand/40 text-foreground' : 'bg-yellow-300/40 text-foreground'}
            >
              {plain.slice(pos, pos + q.length)}
            </mark>
          );

          lastIdx = pos + q.length;
          searchFrom = lastIdx;
        }

        // Remaining text after match
        if (lastIdx < plain.length) {
          parts.push(<span key={`t${lastIdx}`}>{plain.slice(lastIdx)}</span>);
        }

        return <div key={i}>{parts}</div>;
      })}
    </pre>
  );
}

export const CommandBubble = memo(function CommandBubble({
  commandId,
  tabId,
  projectCwd,
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
  expandedHeight,
  bubbleContentHeight,
  onTitleMouseDown,
}: CommandBubbleProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const shouldAutoScroll = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const stdinRef = useRef<HTMLInputElement>(null);
  const timeStr = formatTime(timestamp);
  const shortId = commandId && tabId ? toShortId(tabId + commandId) : undefined;
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [stdinValue, setStdinValue] = useState('');

  const xtermSearchRef = useRef<XtermSearchHandle>(null); // xterm search interface
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search state (shared by PTY and Pipe)
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  /** Pipe search mode: 'search' highlights matches / 'filter' shows only matching lines */
  const [pipeSearchMode, setPipeSearchMode] = useState<'search' | 'filter'>('search');
  /** Pipe search current match index (used for Enter/Shift+Enter navigation) */
  const [pipeMatchIdx, setPipeMatchIdx] = useState(0);
  const pipeMatchRefs = useRef<(HTMLElement | null)[]>([]);

  // ANSI parser & incremental tracking
  const ansiUpRef = useRef<AnsiUp | null>(null);
  const parsedLenRef = useRef(0);

  useEffect(() => {
    if (!ansiUpRef.current) {
      ansiUpRef.current = new AnsiUp();
      ansiUpRef.current.use_classes = true;
    }
  }, []);

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
     
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    navigator.clipboard.writeText(plain);
    toast(t('toast.copiedOutput'));
  };

  // ESC to exit fullscreen
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

  const lineCount = output ? output.split('\n').length : 0;

  // Search: Cmd+F to open, ESC to close
  const openSearch = useCallback(() => {
    setSearchVisible(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
    setPipeMatchIdx(0);
    xtermSearchRef.current?.clearSearch();
  }, []);

  const doSearchNext = useCallback((q: string) => {
    if (!q.trim()) return;
    if (usePty) {
      xtermSearchRef.current?.findNext(q);
    } else {
      // Pipe: jump to next match
      setPipeMatchIdx(prev => {
        const next = prev + 1;
        const el = pipeMatchRefs.current[next];
        if (el) { el.scrollIntoView({ block: 'nearest' }); return next; }
        // Wrap around to first
        pipeMatchRefs.current[0]?.scrollIntoView({ block: 'nearest' });
        return 0;
      });
    }
  }, [usePty]);

  const doSearchPrev = useCallback((q: string) => {
    if (!q.trim()) return;
    if (usePty) {
      xtermSearchRef.current?.findPrevious(q);
    } else {
      setPipeMatchIdx(prev => {
        const next = prev - 1;
        if (next >= 0) {
          pipeMatchRefs.current[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        }
        const last = pipeMatchRefs.current.length - 1;
        if (last >= 0) pipeMatchRefs.current[last]?.scrollIntoView({ block: 'nearest' });
        return Math.max(last, 0);
      });
    }
  }, [usePty]);

  // Cmd+F / ESC shortcuts (respond when selected, regardless of maximize state)
  useEffect(() => {
    if (!selected) return;
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
  }, [selected, searchVisible, openSearch, closeSearch]);

  // Content area height: maximized > 50% layout > default fixed height
  const contentHeight = maximized && expandedHeight
    ? expandedHeight - FULLSCREEN_BAR_HEIGHT
    : (bubbleContentHeight ?? BUBBLE_CONTENT_HEIGHT);

  return (
    <div className="flex flex-col items-start">
        <div
          className={`w-full bg-accent text-foreground dark:text-slate-11 relative overflow-hidden border transition-colors cursor-pointer ${
            maximized ? 'rounded-none border-0' : 'rounded-2xl rounded-bl-md rounded-br-md'
          } ${
            maximized ? '' : selected ? 'border-brand' : 'border-brand/30'
          }`}
          onClick={onSelect}
        >
          {/* Command header */}
          {maximized ? (
            /* Top bar when maximized */
            <div
              onDoubleClick={() => onToggleMaximize?.()}
              className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card"
              style={{ height: FULLSCREEN_BAR_HEIGHT, flexShrink: 0 }}
            >
              <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded bg-muted text-muted-foreground">&gt;_</span>
              <span className="flex-1 text-xs text-muted-foreground truncate font-mono">{command}</span>
              {isRunning && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  {t('console.runningText')}
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
                title={t('console.restoreTooltip', { modKey: modKey() })}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            /* Title bar when minimized */
            <div
              data-drag-handle
              onMouseDown={() => onTitleMouseDown?.()}
              onDoubleClick={(e) => { e.stopPropagation(); onToggleMaximize?.(); }}
              className={`flex items-center gap-2 px-4 py-1.5 border-b text-xs transition-colors cursor-grab active:cursor-grabbing ${
                selected ? 'border-brand' : 'border-brand/30'
              }`}
            >
              <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">&gt;_</span>
              {shortId && commandId && tabId && (
                <ShortIdBadge
                  shortId={shortId}
                  type="terminal"
                  onRegister={() => {
                    fetch('/api/terminal/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ tabId, commandId, command, projectCwd }),
                    }).catch(() => {});
                  }}
                  onUnregister={() => {
                    fetch('/api/terminal/unregister', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ commandId }),
                    }).catch(() => {});
                  }}
                />
              )}
              <span className="font-mono text-foreground truncate">{command}</span>
              <button
                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(command); toast(t('toast.copiedCmd')); }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title={t('console.copyCommand')}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <span className="flex-1" />
              {isOverflowing && !isRunning && (
                <span className="text-muted-foreground flex-shrink-0">{t('console.totalLines', { count: lineCount })}</span>
              )}
              {output && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                  title={t('console.copyOutput')}
                >
                  <Clipboard className="w-3.5 h-3.5" />
                </button>
              )}
              {onRerun && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRerun(); }}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                  title={t('console.rerun')}
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  className="p-0.5 rounded text-destructive hover:text-destructive/80 transition-colors flex-shrink-0"
                  title={t('console.deleteRecord')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Search bar - Cmd+F to open (shared by PTY and Pipe) */}
          {searchVisible && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card" style={{ flexShrink: 0 }}>
              <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => {
                  const v = e.target.value;
                  setSearchQuery(v);
                  setPipeMatchIdx(0);
                  if (usePty) {
                    if (v.trim()) xtermSearchRef.current?.findNext(v);
                    else xtermSearchRef.current?.clearSearch();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) doSearchPrev(searchQuery);
                    else doSearchNext(searchQuery);
                  }
                }}
                placeholder={t('console.searchPlaceholder')}
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                autoComplete="off"
                spellCheck="false"
              />
              {/* Pipe mode toggle: search / filter */}
              {!usePty && (
                <div className="flex items-center gap-0.5 text-xs flex-shrink-0">
                  <button
                    onClick={() => setPipeSearchMode('search')}
                    className={`px-1.5 py-0.5 rounded transition-colors ${pipeSearchMode === 'search' ? 'bg-brand/20 text-brand' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t('console.searchMode')}
                  </button>
                  <button
                    onClick={() => setPipeSearchMode('filter')}
                    className={`px-1.5 py-0.5 rounded transition-colors ${pipeSearchMode === 'filter' ? 'bg-brand/20 text-brand' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t('console.filterMode')}
                  </button>
                </div>
              )}
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => doSearchPrev(searchQuery)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title={t('console.prevShiftEnter')}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => doSearchNext(searchQuery)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title={t('console.nextEnter')}
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

          {/* Output content */}
          {usePty ? (
            <div style={{ height: contentHeight, overflow: 'hidden' }}>
              <Suspense fallback={<div className="px-4 py-2 text-xs text-muted-foreground" style={{ height: contentHeight }}>{t('console.loadingTerminal')}</div>}>
                <XtermRenderer ref={xtermSearchRef} output={output} isRunning={isRunning} onInput={onStdin} onResize={onPtyResize} maximized={maximized} height={contentHeight} />
              </Suspense>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="overflow-auto px-4 py-2"
              style={{ height: contentHeight }}
              onScroll={handleScroll}
            >
              {searchVisible && searchQuery.trim() ? (
                <PipeSearchView
                  output={output}
                  query={searchQuery}
                  mode={pipeSearchMode}
                  currentIdx={pipeMatchIdx}
                  matchRefs={pipeMatchRefs}
                />
              ) : (
                <pre ref={preRef} className="text-sm font-mono whitespace-pre-wrap break-words select-text" />
              )}
            </div>
          )}

          {/* Running status bar - hidden when maximized */}
          {isRunning && !maximized && (
            <div className="border-t border-border px-4 py-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
              {usePty ? (
                <span className="text-xs text-muted-foreground flex-1">{t('console.clickToInput')}</span>
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
                  placeholder={t('console.stdinPlaceholder')}
                  className="flex-1 min-w-0 bg-transparent text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground"
                  autoComplete="off"
                  spellCheck="false"
                />
              ) : (
                <span className="text-xs text-muted-foreground">{t('console.runningText')}</span>
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

          {/* Finished: exit code - hidden when maximized */}
          {!isRunning && exitCode !== undefined && !maximized && (
            <div className="border-t border-border px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`inline-block w-2 h-2 rounded-full ${exitCode === 0 ? 'bg-green-500' : 'bg-red-500'}`} />
              <span>{t('console.exitCode', { code: exitCode })}</span>
              <span className="flex-1" />
              {timeStr && <span className="text-[11px] flex-shrink-0">{timeStr}</span>}
            </div>
          )}
        </div>
    </div>
  );
});
