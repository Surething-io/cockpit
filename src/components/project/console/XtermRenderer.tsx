'use client';

import { useRef, useEffect, useCallback, memo, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';

/** 暴露给父组件的搜索接口 */
export interface XtermSearchHandle {
  findNext: (query: string) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
}

interface XtermRendererProps {
  /** 累积的原始 PTY 输出（含 ANSI 控制序列） */
  output: string;
  /** 是否正在运行 */
  isRunning: boolean;
  /** 逐键输入回调（PTY 模式下每个按键立即发送） */
  onInput?: (data: string) => void;
  /** 终端尺寸变化回调（通知服务端 PTY resize） */
  onResize?: (cols: number, rows: number) => void;
  /** 是否最大化 */
  maximized?: boolean;
  /** 非最大化时的固定高度（px） */
  height?: number;
}

/**
 * 使用 xterm.js 渲染 PTY 输出
 * 支持完整的终端控制序列（光标移动、清屏、alternate buffer 等）
 * 运行中时启用 stdin 输入，逐键发送到 PTY
 */
export const XtermRenderer = memo(forwardRef<XtermSearchHandle, XtermRendererProps>(function XtermRenderer({
  output,
  isRunning,
  onInput,
  onResize,
  maximized,
  height,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const writtenLenRef = useRef(0);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  // 暴露搜索接口
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
  }), []);

  // 初始化 xterm
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

    // 逐键转发到 PTY
    term.onData((data: string) => {
      if (onInputRef.current) {
        onInputRef.current(data);
      }
    });

    // 初始 fit + 通知服务端尺寸
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

  // 增量写入新数据
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    let didReset = false;

    // 检测 output 截断（重跑时 output 变短）
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

    // reset 后 xterm 内部 textarea 可能失焦，需要延迟重新聚焦
    if (didReset && onInputRef.current) {
      requestAnimationFrame(() => term.focus());
    }
  }, [output]);

  // 运行状态变化时聚焦终端
  useEffect(() => {
    if (isRunning && termRef.current) {
      termRef.current.focus();
    }
  }, [isRunning]);

  // resize: fit xterm 并通知服务端 PTY 调整尺寸
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

  // maximized 变化时触发 fit
  // 需要多帧延迟：DOM 移动（useLayoutEffect）后容器尺寸可能需要几帧才稳定
  useEffect(() => {
    requestAnimationFrame(() => {
      doFit();
      // 再延迟一帧确保 xterm 内部布局更新后二次 fit
      requestAnimationFrame(doFit);
    });
  }, [maximized, doFit]);

  // 容器尺寸变化时 fit
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
