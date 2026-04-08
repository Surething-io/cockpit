'use client';

import { useRef, useEffect, useCallback, memo, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';

/** Interface exposed to parent component (search + direct write) */
export interface XtermSearchHandle {
  findNext: (query: string) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
  /** Write data directly to xterm (bypass output prop) */
  write: (data: string) => void;
  /** Reset terminal (clear screen + buffer) */
  reset: () => void;
}

interface XtermRendererProps {
  /** Accumulated raw PTY output (including ANSI control sequences). Ignored when directWrite is true. */
  output: string;
  /** Whether currently running */
  isRunning: boolean;
  /** Per-keystroke input callback (each key sent immediately in PTY mode) */
  onInput?: (data: string) => void;
  /** Terminal size change callback (notify server of PTY resize) */
  onResize?: (cols: number, rows: number) => void;
  /** Whether maximized */
  maximized?: boolean;
  /** Fixed height when not maximized (px) */
  height?: number;
  /** When true, parent writes data via ref.write() — output prop is ignored. xterm scrollback manages memory. */
  directWrite?: boolean;
}

/**
 * Render PTY output using xterm.js
 * Supports full terminal control sequences (cursor movement, clear screen, alternate buffer, etc.)
 * Enables stdin input when running, sends each key to PTY
 */
export const XtermRenderer = memo(forwardRef<XtermSearchHandle, XtermRendererProps>(function XtermRenderer({
  output,
  isRunning,
  onInput,
  onResize,
  maximized,
  height,
  directWrite,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const writtenLenRef = useRef(0);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  useEffect(() => { onInputRef.current = onInput; }, [onInput]);
  useEffect(() => { onResizeRef.current = onResize; }, [onResize]);

  // Expose search + write interface
  useImperativeHandle(ref, () => ({
    findNext: (query: string) => {
      return searchAddonRef.current?.findNext(query, { caseSensitive: false, decorations: {
        matchBackground: '#facc1550',
        matchBorder: '#facc15',
        matchOverviewRuler: '#facc15',
        activeMatchBackground: '#facc1590',
        activeMatchBorder: '#facc15',
        activeMatchColorOverviewRuler: '#facc15',
      } }) ?? false;
    },
    findPrevious: (query: string) => {
      return searchAddonRef.current?.findPrevious(query, { caseSensitive: false, decorations: {
        matchBackground: '#facc1550',
        matchBorder: '#facc15',
        matchOverviewRuler: '#facc15',
        activeMatchBackground: '#facc1590',
        activeMatchBorder: '#facc15',
        activeMatchColorOverviewRuler: '#facc15',
      } }) ?? false;
    },
    clearSearch: () => {
      searchAddonRef.current?.clearDecorations();
    },
    write: (data: string) => {
      termRef.current?.write(data);
    },
    reset: () => {
      termRef.current?.reset();
    },
  }), []);

  // Initialize xterm
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: false,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      cursorStyle: 'block',
      cursorBlink: true,
      disableStdin: false,
      allowProposedApi: true,
      theme: {
        background: 'transparent',
        foreground: '#d4d4d8',
        cursor: '#d4d4d8',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#3b82f680',
        black: '#27272a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(containerRef.current);

    // Forward each key to PTY
    term.onData((data: string) => {
      if (onInputRef.current) {
        onInputRef.current(data);
      }
    });

    // Initial fit + notify server of size
    try {
      fitAddon.fit();
      if (onResizeRef.current) {
        onResizeRef.current(term.cols, term.rows);
      }
    } catch { /* not ready */ }

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    writtenLenRef.current = 0;

    return () => {
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      writtenLenRef.current = 0;
    };
  }, []);

  // Write new data incrementally (only in output-prop mode; skipped in directWrite mode)
  useEffect(() => {
    if (directWrite) return; // In directWrite mode, parent calls ref.write() directly

    const term = termRef.current;
    if (!term) return;

    let didReset = false;

    // Detect output truncation (output gets shorter on rerun)
    if (output.length < writtenLenRef.current) {
      term.reset();
      writtenLenRef.current = 0;
      didReset = true;
    }

    if (output.length > writtenLenRef.current) {
      const newData = output.slice(writtenLenRef.current);
      term.write(newData);
      writtenLenRef.current = output.length;
    }

    // After reset xterm's internal textarea may lose focus, delay to refocus
    if (didReset && onInputRef.current) {
      requestAnimationFrame(() => term.focus());
    }
  }, [output, directWrite]);

  // Focus terminal when running state changes
  useEffect(() => {
    if (isRunning && termRef.current) {
      termRef.current.focus();
    }
  }, [isRunning]);

  // resize: fit xterm and notify server to resize PTY
  const doFit = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;
    try {
      fitAddon.fit();
      if (onResizeRef.current) {
        onResizeRef.current(term.cols, term.rows);
      }
    } catch { /* ignore */ }
  }, []);

  // Trigger fit when maximized changes
  // Needs multi-frame delay: container size may take a few frames to stabilize after DOM move (useLayoutEffect)
  useEffect(() => {
    requestAnimationFrame(() => {
      doFit();
      // Delay one more frame to ensure xterm internal layout updates before second fit
      requestAnimationFrame(doFit);
    });
  }, [maximized, doFit]);

  // Fit when container size changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(doFit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doFit]);

  return (
    <div
      ref={containerRef}
      className="xterm-renderer px-2"
      style={{ height: height ?? '100%', overflow: 'hidden' }}
    />
  );
}));
