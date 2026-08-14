'use client';

import { useRef, useEffect, useCallback, memo, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { useThemeSafe } from '@cockpit/shared-ui';

/**
 * xterm palettes, one per theme.
 *
 * These are literal hex rather than the `--slate-12` / `--red-11` CSS variables
 * that drive the equivalent `.ansi-*` rules in globals.css, because xterm.js
 * parses `ITheme` colors with its own parser and never resolves them against
 * the DOM — a `hsl(var(--x))` string would simply fail to parse. The LIGHT
 * values below are the resolved Radix tokens, kept slot-for-slot in sync with
 * those `.ansi-*` rules so a bubble rendering via ansi_up and a bubble
 * rendering via a PTY agree on what "bright green" looks like.
 *
 * Light forces two remappings (same reasoning as the CSS side): "bright" means
 * more vivid rather than lighter, and yellow takes orange-11/amber-11 because
 * the amber solids sit near 2:1 on a light ground.
 *
 * Neither carries a `background`: it is resolved from the DOM at apply time by
 * resolveSurfaceColor() below. See that function for why 'transparent' does
 * not work here.
 */
const XTERM_THEME_DARK: ITheme = {
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
};

const XTERM_THEME_LIGHT: ITheme = {
  foreground: '#1d2126', // slate-12 — 16.2:1 on the bubble's white surface
  cursor: '#1d2126',
  cursorAccent: '#ffffff',
  selectionBackground: '#3b82f640',
  black: '#1d2126', // slate-12
  red: '#ce2c31', // red-11
  green: '#18774c', // green-11
  yellow: '#a13812', // orange-11
  blue: '#0d74ce', // blue-11
  magenta: '#5746af', // violet-11
  cyan: '#1c5454', // teal-11
  white: '#60636c', // slate-11
  brightBlack: '#787b87', // slate-10
  brightRed: '#e5484d', // red-9
  brightGreen: '#2b9c67', // green-10
  brightYellow: '#bd4b00', // amber-11
  brightBlue: '#0478d7', // blue-10
  brightMagenta: '#6d54cf', // violet-9
  brightCyan: '#3a7877', // teal-9
  brightWhite: '#1d2126', // slate-12 — on a light ground the two "maximum
  // contrast" ends converge, so this matches `black` by design
};

/**
 * Resolve the opaque colour of the surface the terminal is sitting on, by
 * walking up to the nearest ancestor that actually paints a background.
 *
 * `theme.background: 'transparent'` CANNOT be used instead, even though the
 * bubble behind would be the thing we want showing through, and even though
 * globals.css already forces `.xterm-viewport` / `.xterm-screen` transparent.
 * Those two rules only reach the DOM layers; the glyphs are painted by a
 * canvas renderer that fills the background itself, and with xterm's
 * `allowTransparency` left at its default of false any background carrying an
 * alpha channel is forced opaque. 'transparent' is rgba(0,0,0,0), so it came
 * out as solid #000 — invisible in dark, where it sat on an almost-black
 * bubble, and a black brick in light.
 *
 * Turning `allowTransparency` on would be the other fix, but it costs the
 * renderer's opaque fast path and drops text from subpixel to grayscale
 * antialiasing — a bad trade in dense mono type.
 *
 * The surface is read as a TOKEN, not as the container's computed
 * backgroundColor. Walking up to the nearest painted ancestor looks more
 * general and was the first attempt, but it is wrong on a theme switch: the
 * bubble that paints this surface carries `transition-colors`, and during a
 * transition getComputedStyle reports the INTERPOLATED value. Reading it in
 * the effect that fires on the class flip therefore returns (near enough) the
 * outgoing theme's colour, which xterm then keeps forever — a dark terminal
 * sitting in a light bubble. Custom properties do not participate in
 * transitions, so the token flips instantly and reads clean.
 *
 * SURFACE_TOKEN must name whatever CommandBubble puts on the terminal's bubble
 * body (`bg-card` as of writing — see the matching note there), and it must be
 * a SURFACE token rather than one of the alpha fills. Fills hold rgba(), and
 * xterm forces any background with an alpha channel opaque, so pointing this
 * at a fill would resolve a 6%-black tint to near-solid black — the same
 * failure that `background: 'transparent'` produced.
 */
const SURFACE_TOKEN = '--card';

/** Fallbacks used only if the token is missing (e.g. mounted outside the app
 *  shell); they are the resolved light/dark values of SURFACE_TOKEN. */
const SURFACE_FALLBACK = { light: '#ffffff', dark: '#1b1b1d' } as const;

/**
 * Read a semantic token and return it as `#rrggbb`.
 *
 * The tokens store bare HSL triples ("240 14% 94.5%") so they can compose via
 * `hsl(var(--x) / <alpha>)`, and xterm parses ITheme colours with its own
 * parser rather than the DOM, so the triple is converted here instead of being
 * handed over as an `hsl(...)` string.
 */
function readSurfaceColor(el: HTMLElement | null, theme: 'light' | 'dark'): string {
  const fallback = SURFACE_FALLBACK[theme];
  if (!el) return fallback;
  const raw = getComputedStyle(el).getPropertyValue(SURFACE_TOKEN).trim();
  const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(raw);
  if (!m) return fallback;
  const h = Number(m[1]), s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l - c / 2;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][
    Math.floor(h / 60) % 6
  ];
  const ch = (v: number) => Math.round((v + base) * 255).toString(16).padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/** Interface exposed to parent component (search + direct write) */
export interface XtermSearchHandle {
  findNext: (query: string) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
  /** Write data directly to xterm (bypass output prop) */
  write: (data: string) => void;
  /** Reset terminal (clear screen + buffer) */
  reset: () => void;
  /** Repaint from the buffer (e.g. after a DOM relocation that dropped the render) */
  refresh: () => void;
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

  // Nullable variant: the standalone markdown/html bundles can mount console
  // pieces outside a ThemeProvider, and a hard useTheme would throw there.
  // Falling back to dark preserves this component's previous behaviour.
  const resolvedTheme = useThemeSafe()?.resolvedTheme ?? 'dark';
  const xtermTheme = resolvedTheme === 'dark' ? XTERM_THEME_DARK : XTERM_THEME_LIGHT;
  // Read by the init effect, which must stay on `[]` deps — re-running it would
  // dispose the Terminal and take the scrollback with it.
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;

  // Repaint the live terminal on theme switch. Assigning options.theme mutates
  // the existing instance, so the buffer, scroll position and any running PTY
  // are untouched — which is the whole reason this is a separate effect.
  //
  // The surface is re-resolved here rather than reused from mount: by the time
  // this runs ThemeProvider has already put the new class on <html> (it sets
  // the class before the state update that lands us here), so the ancestor
  // bubble's computed background is the new theme's.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = {
      ...xtermTheme,
      background: readSurfaceColor(containerRef.current, resolvedTheme),
    };
  }, [xtermTheme, resolvedTheme]);

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
    refresh: () => {
      const term = termRef.current;
      if (!term) return;
      // The buffer survives DOM moves; the rendered rows don't. Re-fit (in case the
      // new slot has a different width) and force a full repaint from the buffer.
      try { fitAddonRef.current?.fit(); } catch { /* not ready */ }
      try { term.refresh(0, term.rows - 1); } catch { /* not ready */ }
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
        ...xtermThemeRef.current,
        background: readSurfaceColor(containerRef.current, resolvedThemeRef.current),
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(containerRef.current);

    // ===== Block terminal-protocol response floods =====
    // When a hung child process leaves unread query responses in the pty input
    // buffer (e.g. it asked OSC 11 background color or CSI 6n cursor position
    // and exited before reading the answer), the parent zsh later reads those
    // bytes as keystrokes. ESC/CSI gets eaten by ZLE; the printable remainder
    // is run as a command, producing `command not found: 11` /
    // `no such file or directory: rgb:0000/0000/0000` storms.
    //
    // Two layers of defense:
    //   (1) Don't let xterm.js auto-answer these queries in the first place.
    //   (2) Even if something else generates a response, strip it from the
    //       upstream onData stream before it reaches the pty.
    const blockOsc = (id: number) =>
      term.parser.registerOscHandler(id, () => true);
    blockOsc(10);   // foreground color query
    blockOsc(11);   // background color query (root cause in observed bug)
    blockOsc(12);   // cursor color query
    blockOsc(4);    // palette color query
    blockOsc(52);   // clipboard read
    // CSI handlers are matched by (prefix, intermediates, final) — register
    // every variant we want to swallow. Without the prefix variants xterm.js
    // still auto-answers `\x1b[>c` (secondary DA) and `\x1b[=c` (tertiary DA),
    // which then leaks `0;276;0c` onto the next zsh prompt as a self-insert.
    const blockCsi = (final: string, prefix?: string) =>
      term.parser.registerCsiHandler({ prefix, final }, () => true);
    blockCsi('n');           // DSR / CPR (cursor position report)
    blockCsi('n', '?');      // DEC private DSR
    blockCsi('c');           // Primary DA  (`\x1b[c`,  `\x1b[0c`)
    blockCsi('c', '>');      // Secondary DA (`\x1b[>c`, `\x1b[>0c`) — xterm.js replies `\x1b[>0;276;0c`
    blockCsi('c', '=');      // Tertiary DA  (`\x1b[=c`)

    // Match OSC responses (ESC ] N ; ... BEL  or  ESC ] N ; ... ESC \) and
    // CSI responses ending in R (CPR) or c (DA). The CSI parameter class must
    // include `>` and `=` so secondary/tertiary DA replies (e.g.
    // `\x1b[>0;276;0c`) get stripped — otherwise the whole reply is forwarded
    // to the pty as stdin and zsh self-inserts the printable tail.
    const RESPONSE_SEQ_RE = /\x1b\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\d;?>=]*[Rc]/g;

    // Forward each key to PTY (filter out any stray protocol responses)
    term.onData((data: string) => {
      const cleaned = data.replace(RESPONSE_SEQ_RE, '');
      if (!cleaned) return;
      if (onInputRef.current) {
        onInputRef.current(cleaned);
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
    const term = termRef.current;
    if (!term) return;

    if (directWrite) {
      // Live data arrives via the parent's writer (subscribePtyOutput) / ref.write,
      // so we skip the incremental sync. EXCEPT: a finished PTY bubble restored from
      // history carries its scrollback in `output` (which stays empty for a live
      // command, since live PTY output bypasses React state). Write it once per
      // mounted terminal so the stored scrollback renders on (re)mount.
      if (output && writtenLenRef.current === 0) {
        term.write(output);
        writtenLenRef.current = output.length;
      }
      return;
    }

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

  // Stop wheel scroll from chaining to the outer bubble list once the terminal
  // hits its top/bottom. xterm only preventDefaults while the buffer can still
  // scroll, so at the boundary the event would otherwise bubble up and scroll
  // the bubble list. overscroll-behavior can't cover this, so guard it here.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const vp = el.querySelector('.xterm-viewport') as HTMLElement | null;
      if (!vp) return;
      const max = vp.scrollHeight - vp.clientHeight;
      const atTop = e.deltaY < 0 && vp.scrollTop <= 0;
      const atBottom = e.deltaY > 0 && vp.scrollTop >= max - 1;
      if (max <= 0 || atTop || atBottom) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={containerRef}
      className="xterm-renderer px-2"
      style={{ height: height ?? '100%', overflow: 'hidden' }}
    />
  );
}));
