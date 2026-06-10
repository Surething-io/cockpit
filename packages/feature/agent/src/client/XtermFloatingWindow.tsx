'use client';

import { forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
// xterm.css is imported globally in src/app/globals.css; don't import it here (avoids being tree-shaken under sideEffects:false)

// PTY-mode floating window (the live per-character stream of the §5/§6 dual-view):
// carries the raw PTY output of interactive claude. Collapsed to a small window by default, auto-expands while running to show the live terminal.
//
// Key: the TUI (claude) uses cursor control to redraw the spinner/status line **in place**. To render correctly we must:
//   1. convertEol:false —— don't rewrite \n into \r\n, otherwise cursor positioning misaligns.
//   2. xterm dimensions === backend PTY dimensions —— otherwise claude wraps/moves the cursor by PTY width while xterm renders by its own width,
//      the redraw doesn't line up → every frame appends the status line as a new line. So use a fixed PTY_COLS×PTY_ROWS, and the frontend sends the
//      same size with the request to the backend spawn (see useChatStream / chat.ts), keeping both ends strictly identical.

/** Fixed PTY terminal size (must match front and back ends); useChatStream uses this to send the size to the backend */
export const PTY_COLS = 80;
export const PTY_ROWS = 24;

export interface XtermFloatingHandle {
  write: (data: string) => void;
  clear: () => void;
}

interface XtermFloatingWindowProps {
  /** Whether to show (when chatMode==='pty') */
  visible: boolean;
  /** Whether currently running (for the status dot) */
  running: boolean;
  /** Manual fallback: the user's keys in the terminal → written into the running PTY's stdin */
  onInput?: (data: string) => void;
}

export const XtermFloatingWindow = forwardRef<XtermFloatingHandle, XtermFloatingWindowProps>(
  function XtermFloatingWindow({ visible, running, onInput }, ref) {
    const { t } = useTranslation();
    const onInputRef = useRef(onInput);
    useEffect(() => { onInputRef.current = onInput; }, [onInput]);
    const [expanded, setExpanded] = useState(false);
    // Run starts → auto-expand (discoverability); run ends → auto-collapse. The user can still toggle manually.
    const prevRunningRef = useRef(false);
    useEffect(() => {
      if (running && !prevRunningRef.current) setExpanded(true);        // rising edge: expand
      else if (!running && prevRunningRef.current) setExpanded(false);  // falling edge: collapse
      prevRunningRef.current = running;
    }, [running]);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const bufferRef = useRef<string>('');

    const ensureTerm = useCallback(() => {
      if (termRef.current || !containerRef.current) return;
      const term = new Terminal({
        cols: PTY_COLS,
        rows: PTY_ROWS,
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace',
        convertEol: false,           // key: preserve the PTY's raw newline/cursor semantics so in-place redraw works
        scrollback: 2000,
        theme: { background: '#0a0a0a', foreground: '#d4d4d8' },
        disableStdin: false,         // allow user input (manual fallback); echo comes from PTY output, xterm doesn't echo locally
        allowProposedApi: true,
      });
      term.open(containerRef.current);
      // user keys → forwarded to the backend and written into the running PTY's stdin
      term.onData((d) => onInputRef.current?.(d));
      if (bufferRef.current) term.write(bufferRef.current);
      termRef.current = term;
    }, []);

    // create and replay on expand; dispose/release on collapse/unmount (buffer is kept)
    useEffect(() => {
      if (expanded && visible) {
        ensureTerm();
        return;
      }
      termRef.current?.dispose();
      termRef.current = null;
    }, [expanded, visible, ensureTerm]);

    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        bufferRef.current += data;
        if (bufferRef.current.length > 200_000) bufferRef.current = bufferRef.current.slice(-150_000);
        termRef.current?.write(data);
      },
      clear: () => {
        bufferRef.current = '';
        termRef.current?.clear();
      },
    }), []);

    if (!visible) return null;

    return (
      <div
        className="absolute top-12 right-3 z-30 rounded-lg border border-border bg-card shadow-lg overflow-hidden"
        style={{ width: expanded ? 'auto' : 180 }}
        data-testid="pty-floating-window"
      >
        {/* header / collapse bar */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid="pty-floating-toggle"
          className="w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs bg-accent/60 hover:bg-accent"
        >
          <span className="flex items-center gap-1.5">
            <span
              className={`inline-block w-2 h-2 rounded-full ${running ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`}
            />
            <span className="text-muted-foreground">{t('chat.ptyTerminal')}{running ? ` · ${t('chat.ptyRunning')}` : ''}</span>
          </span>
          <span className="text-muted-foreground">{expanded ? `${t('chat.ptyCollapse')} ▾` : `${t('chat.ptyExpand')} ▸`}</span>
        </button>
        {/* terminal area (rendered when expanded; xterm self-sizes by the fixed cols×rows) */}
        <div
          ref={containerRef}
          data-testid="pty-floating-term"
          style={{ display: expanded ? 'block' : 'none', padding: 4 }}
          className="bg-[#0a0a0a]"
        />
      </div>
    );
  }
);
