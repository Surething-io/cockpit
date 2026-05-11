'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

// ============================================
// Types
// ============================================

export type ViMode = 'normal' | 'insert' | 'command' | 'search';

export type InsertVariant = 'i' | 'a' | 'I' | 'A' | 'o' | 'O';

interface UndoEntry {
  lineIndex: number;
  oldLines: string[];
  newLines: string[];
  cursorLine: number; // cursor position to restore on undo
}

export interface ViState {
  mode: ViMode;
  cursorLine: number;       // 0-based
  cursorCol: number;        // 0-based column
  isDirty: boolean;         // has unsaved modifications from normal mode
  keyBuffer: string;        // for gg/dd/yy
  commandInput: string;     // : command line content
  searchInput: string;      // / search content
  lastSearch: string;       // for n/N repeat
}

interface UseViModeOptions {
  lines: string[];
  enabled: boolean;
  onContentChange: (newContent: string) => void;
  onEnterInsert: (line: number, col: number, variant: InsertVariant) => void;
  onSave?: () => void;                          // :w
  getVisibleLineCount: () => number;            // for Ctrl+D/U
  scrollToLine: (line: number, align?: 'center' | 'start' | 'auto') => void;
  // search integration: reuse existing search
  onSearchExecute?: (query: string) => void;
  onSearchNext?: () => void;
  onSearchPrev?: () => void;
  onSearchClear?: () => void;            // :noh
}

// ============================================
// Hook
// ============================================

export function useViMode({
  lines,
  enabled,
  onContentChange,
  onEnterInsert,
  onSave,
  getVisibleLineCount,
  scrollToLine,
  onSearchExecute,
  onSearchNext,
  onSearchPrev,
  onSearchClear,
}: UseViModeOptions) {
  const [mode, setMode] = useState<ViMode>('normal');
  const [cursorLine, setCursorLine] = useState(-1); // -1 = inactive; cursor becomes visible after the first click
  const [cursorCol, setCursorCol] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [keyBuffer, setKeyBuffer] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [lastSearch, setLastSearch] = useState('');

  // Refs for undo/redo/yank (no re-render needed)
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const yankBufferRef = useRef<string[]>([]);
  const keyBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep lines ref in sync for callbacks
  const linesRef = useRef(lines);
  useEffect(() => { linesRef.current = lines; });

  // Clamp cursor when lines change
  useEffect(() => {
    if (lines.length === 0) return;
    queueMicrotask(() => setCursorLine(prev => Math.min(prev, lines.length - 1)));
  }, [lines.length]);

  // Clamp cursorCol to current line length
  const clampCol = useCallback((line: number, col: number) => {
    const lineText = linesRef.current[line] ?? '';
    return Math.max(0, Math.min(col, Math.max(0, lineText.length - 1)));
  }, []);

  // Reset state when file changes (lines identity changes significantly)
  const prevLinesLengthRef = useRef(lines.length);
  useEffect(() => {
    // Only reset on large changes (file switch), not dd/p operations
    const diff = Math.abs(lines.length - prevLinesLengthRef.current);
    prevLinesLengthRef.current = lines.length;
    if (diff > 10) {
      queueMicrotask(() => {
        setCursorLine(-1);
        setCursorCol(0);
        setIsDirty(false);
      });
      undoStackRef.current = [];
      redoStackRef.current = [];
      yankBufferRef.current = [];
    }
  }, [lines]);

  // ========== Key buffer helpers ==========
  const clearBuffer = useCallback(() => {
    if (keyBufferTimerRef.current) {
      clearTimeout(keyBufferTimerRef.current);
      keyBufferTimerRef.current = null;
    }
    setKeyBuffer('');
  }, []);

  const startBufferTimeout = useCallback(() => {
    if (keyBufferTimerRef.current) clearTimeout(keyBufferTimerRef.current);
    keyBufferTimerRef.current = setTimeout(() => {
      setKeyBuffer('');
      keyBufferTimerRef.current = null;
    }, 500);
  }, []);

  // ========== Content mutation helpers ==========
  const applyContentChange = useCallback((newLines: string[], undoEntry: UndoEntry) => {
    undoStackRef.current.push(undoEntry);
    redoStackRef.current = []; // clear redo on new change
    setIsDirty(true);
    onContentChange(newLines.join('\n'));
  }, [onContentChange]);

  // ========== Navigation ==========
  const moveCursorTo = useCallback((line: number, col?: number) => {
    const clamped = Math.max(0, Math.min(line, linesRef.current.length - 1));
    setCursorLine(clamped);
    const targetCol = col ?? 0;
    setCursorCol(clampCol(clamped, targetCol));
    scrollToLine(clamped, 'auto');
  }, [scrollToLine, clampCol]);

  const moveCursorBy = useCallback((delta: number) => {
    setCursorLine(prev => {
      const next = Math.max(0, Math.min(prev + delta, linesRef.current.length - 1));
      scrollToLine(next, 'auto');
      // Clamp col to new line length
      setCursorCol(prevCol => {
        const lineText = linesRef.current[next] ?? '';
        return Math.max(0, Math.min(prevCol, Math.max(0, lineText.length - 1)));
      });
      return next;
    });
  }, [scrollToLine]);

  // ========== Layer 4: Normal mode editing ==========
  const deleteLine = useCallback(() => {
    const cur = linesRef.current;
    const idx = Math.min(cursorLine, cur.length - 1);
    if (cur.length === 0) return;

    const removed = cur[idx];
    yankBufferRef.current = [removed];

    const newLines = [...cur];
    newLines.splice(idx, 1);
    if (newLines.length === 0) newLines.push('');

    const newCursor = Math.min(idx, newLines.length - 1);
    applyContentChange(newLines, {
      lineIndex: idx,
      oldLines: [removed],
      newLines: [],
      cursorLine: idx,
    });
    setCursorLine(newCursor);
    setCursorCol(0);
  }, [cursorLine, applyContentChange]);

  const yankLine = useCallback(() => {
    const cur = linesRef.current;
    const idx = Math.min(cursorLine, cur.length - 1);
    if (cur.length > 0) {
      yankBufferRef.current = [cur[idx]];
    }
  }, [cursorLine]);

  const putAfter = useCallback(() => {
    const yanked = yankBufferRef.current;
    if (yanked.length === 0) return;

    const cur = linesRef.current;
    const idx = Math.min(cursorLine, cur.length - 1);
    const insertAt = idx + 1;

    const newLines = [...cur];
    newLines.splice(insertAt, 0, ...yanked);

    applyContentChange(newLines, {
      lineIndex: insertAt,
      oldLines: [],
      newLines: [...yanked],
      cursorLine: cursorLine,
    });
    setCursorLine(insertAt);
    setCursorCol(0);
    scrollToLine(insertAt, 'auto');
  }, [cursorLine, applyContentChange, scrollToLine]);

  const deleteChar = useCallback(() => {
    const cur = linesRef.current;
    const idx = Math.min(cursorLine, cur.length - 1);
    const line = cur[idx];
    if (!line || line.length === 0) return;

    const newLine = line.substring(1);
    const newLines = [...cur];
    newLines[idx] = newLine;

    applyContentChange(newLines, {
      lineIndex: idx,
      oldLines: [line],
      newLines: [newLine],
      cursorLine: cursorLine,
    });
  }, [cursorLine, applyContentChange]);

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;

    const entry = stack.pop()!;
    const cur = linesRef.current;
    const newLines = [...cur];

    // Reverse the operation
    if (entry.newLines.length === 0 && entry.oldLines.length > 0) {
      // Was a delete → re-insert
      newLines.splice(entry.lineIndex, 0, ...entry.oldLines);
    } else if (entry.oldLines.length === 0 && entry.newLines.length > 0) {
      // Was an insert → remove
      newLines.splice(entry.lineIndex, entry.newLines.length);
      if (newLines.length === 0) newLines.push('');
    } else {
      // Was a replace → restore old
      newLines.splice(entry.lineIndex, entry.newLines.length, ...entry.oldLines);
    }

    redoStackRef.current.push(entry);
    onContentChange(newLines.join('\n'));
    setCursorLine(Math.min(entry.cursorLine, newLines.length - 1));
    scrollToLine(Math.min(entry.cursorLine, newLines.length - 1), 'auto');

    if (stack.length === 0) setIsDirty(false);
  }, [onContentChange, scrollToLine]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;

    const entry = stack.pop()!;
    const cur = linesRef.current;
    const newLines = [...cur];

    // Re-apply the operation
    if (entry.newLines.length === 0 && entry.oldLines.length > 0) {
      // Original was a delete → delete again
      newLines.splice(entry.lineIndex, entry.oldLines.length);
      if (newLines.length === 0) newLines.push('');
    } else if (entry.oldLines.length === 0 && entry.newLines.length > 0) {
      // Original was an insert → insert again
      newLines.splice(entry.lineIndex, 0, ...entry.newLines);
    } else {
      // Original was a replace → replace again
      newLines.splice(entry.lineIndex, entry.oldLines.length, ...entry.newLines);
    }

    undoStackRef.current.push(entry);
    setIsDirty(true);
    onContentChange(newLines.join('\n'));

    const newCursor = entry.lineIndex + Math.max(0, entry.newLines.length - 1);
    setCursorLine(Math.min(newCursor, newLines.length - 1));
    scrollToLine(Math.min(newCursor, newLines.length - 1), 'auto');
  }, [onContentChange, scrollToLine]);

  // ========== Mode transitions ==========
  const enterInsert = useCallback((variant: InsertVariant) => {
    const cur = linesRef.current;
    let targetLine = Math.min(cursorLine, cur.length - 1);

    // o/O: insert a blank line first (content mutation)
    if (variant === 'o' || variant === 'O') {
      const insertAt = variant === 'o' ? targetLine + 1 : targetLine;
      const newLines = [...cur];
      newLines.splice(insertAt, 0, '');

      applyContentChange(newLines, {
        lineIndex: insertAt,
        oldLines: [],
        newLines: [''],
        cursorLine: cursorLine,
      });

      targetLine = insertAt;
      setCursorLine(insertAt);
    }

    setMode('insert');
    onEnterInsert(targetLine, cursorCol, variant);
  }, [cursorLine, cursorCol, applyContentChange, onEnterInsert]);

  const enterNormal = useCallback(() => {
    setMode('normal');
    clearBuffer();
  }, [clearBuffer]);

  const enterCommand = useCallback(() => {
    setMode('command');
    setCommandInput('');
  }, []);

  const exitCommand = useCallback(() => {
    setMode('normal');
    setCommandInput('');
  }, []);

  const enterSearch = useCallback(() => {
    setMode('search');
    setSearchInput('');
  }, []);

  const exitSearch = useCallback(() => {
    setMode('normal');
    setSearchInput('');
  }, []);

  // ========== Command execution ==========
  const executeCommand = useCallback((cmd: string) => {
    const trimmed = cmd.trim();

    // :w — save
    if (trimmed === 'w') {
      onSave?.();
      setMode('normal');
      setCommandInput('');
      return;
    }

    // :q — close (just exit to normal for now)
    if (trimmed === 'q') {
      setMode('normal');
      setCommandInput('');
      return;
    }

    // :wq — save and close
    if (trimmed === 'wq') {
      onSave?.();
      setMode('normal');
      setCommandInput('');
      return;
    }

    // :noh — clear search highlight
    if (trimmed === 'noh' || trimmed === 'nohlsearch') {
      onSearchClear?.();
      setMode('normal');
      setCommandInput('');
      return;
    }

    // :<number> — go to line
    const lineNum = parseInt(trimmed, 10);
    if (!isNaN(lineNum) && lineNum > 0) {
      const target = Math.min(lineNum - 1, linesRef.current.length - 1);
      setCursorLine(target);
      scrollToLine(target, 'center');
      setMode('normal');
      setCommandInput('');
      return;
    }

    // Unknown command — just exit
    setMode('normal');
    setCommandInput('');
  }, [onSave, onSearchClear, scrollToLine]);

  const executeSearch = useCallback((query: string) => {
    if (!query) {
      setMode('normal');
      setSearchInput('');
      return;
    }
    setLastSearch(query);
    onSearchExecute?.(query);
    setMode('normal');
    setSearchInput('');
  }, [onSearchExecute]);

  // ========== Main keydown handler ==========
  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    if (!enabled) return false;

    // Ctrl+C acts as Escape in all non-normal modes
    const isCtrlC = e.ctrlKey && e.key === 'c' && !e.metaKey && !e.shiftKey;

    // ---- Insert mode: Escape or Ctrl+C exits ----
    if (mode === 'insert') {
      if (e.key === 'Escape' || isCtrlC) {
        enterNormal();
        return true;
      }
      return false; // let contentEditable handle everything else
    }

    // ---- Command mode: handle input ----
    if (mode === 'command') {
      // Don't intercept Enter/Backspace during IME composition (e.g., confirming candidate words)
      if (e.isComposing) return false;
      if (e.key === 'Escape' || isCtrlC) {
        exitCommand();
        return true;
      }
      if (e.key === 'Enter') {
        executeCommand(commandInput);
        return true;
      }
      if (e.key === 'Backspace') {
        if (commandInput.length === 0) {
          exitCommand();
        } else {
          setCommandInput(prev => prev.slice(0, -1));
        }
        return true;
      }
      // Single printable char
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setCommandInput(prev => prev + e.key);
        return true;
      }
      return true; // consume all keys in command mode
    }

    // ---- Search mode: handle input ----
    if (mode === 'search') {
      // Don't intercept Enter/Backspace during IME composition (e.g., confirming candidate words)
      if (e.isComposing) return false;
      if (e.key === 'Escape' || isCtrlC) {
        exitSearch();
        return true;
      }
      if (e.key === 'Enter') {
        executeSearch(searchInput);
        return true;
      }
      if (e.key === 'Backspace') {
        if (searchInput.length === 0) {
          exitSearch();
        } else {
          setSearchInput(prev => prev.slice(0, -1));
        }
        return true;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSearchInput(prev => prev + e.key);
        return true;
      }
      return true;
    }

    // ---- Normal mode ----
    // When cursor is inactive (-1), any action first activates it at line 0
    if (cursorLine < 0) {
      setCursorLine(0);
      setCursorCol(0);
    }

    // Let through Cmd/Meta combinations (Cmd+S, Cmd+F, Cmd+P, etc.)
    if (e.metaKey) return false;

    // Ctrl combinations specific to vi
    if (e.ctrlKey) {
      if (e.key === 'd') {
        // Ctrl+D: half page down
        const half = Math.max(1, Math.floor(getVisibleLineCount() / 2));
        moveCursorBy(half);
        clearBuffer();
        return true;
      }
      if (e.key === 'u') {
        // Ctrl+U: half page up
        const half = Math.max(1, Math.floor(getVisibleLineCount() / 2));
        moveCursorBy(-half);
        clearBuffer();
        return true;
      }
      if (e.key === 'r') {
        // Ctrl+R: redo
        redo();
        clearBuffer();
        return true;
      }
      // Let other Ctrl combos through
      return false;
    }

    const key = e.key;
    const buf = keyBuffer + key;

    // === Two-key commands ===
    // g → wait for second key
    if (buf === 'g') {
      setKeyBuffer('g');
      startBufferTimeout();
      return true;
    }
    if (buf === 'gg') {
      moveCursorTo(0);
      clearBuffer();
      return true;
    }

    // d → wait for second key
    if (buf === 'd') {
      setKeyBuffer('d');
      startBufferTimeout();
      return true;
    }
    if (buf === 'dd') {
      deleteLine();
      clearBuffer();
      return true;
    }

    // y → wait for second key
    if (buf === 'y') {
      setKeyBuffer('y');
      startBufferTimeout();
      return true;
    }
    if (buf === 'yy') {
      yankLine();
      clearBuffer();
      return true;
    }

    // If buffer had something but didn't match, clear and process as fresh key
    if (keyBuffer && buf !== key) {
      clearBuffer();
      // Don't consume — fall through to process the new key alone
    }

    // === Single-key commands ===
    if (key === 'j' || key === 'ArrowDown') {
      moveCursorBy(1);
      return true;
    }
    if (key === 'k' || key === 'ArrowUp') {
      moveCursorBy(-1);
      return true;
    }
    if (key === 'h' || key === 'ArrowLeft') {
      setCursorCol(prev => Math.max(0, prev - 1));
      return true;
    }
    if (key === 'l' || key === 'ArrowRight') {
      const lineText = linesRef.current[cursorLine] ?? '';
      const maxCol = Math.max(0, lineText.length - 1);
      setCursorCol(prev => Math.min(maxCol, prev + 1));
      return true;
    }
    if (key === '0') {
      setCursorCol(0);
      return true;
    }
    if (key === '$') {
      const lineText = linesRef.current[cursorLine] ?? '';
      setCursorCol(Math.max(0, lineText.length - 1));
      return true;
    }
    if (key === '^') {
      const lineText = linesRef.current[cursorLine] ?? '';
      const firstNonSpace = lineText.search(/\S/);
      setCursorCol(firstNonSpace >= 0 ? firstNonSpace : 0);
      return true;
    }
    if (key === 'G') {
      moveCursorTo(linesRef.current.length - 1);
      return true;
    }
    if (key === 'x') {
      deleteChar();
      return true;
    }
    if (key === 'p') {
      putAfter();
      return true;
    }
    if (key === 'u') {
      undo();
      return true;
    }

    // Insert mode variants
    if (key === 'i' || key === 'a' || key === 'I' || key === 'A' || key === 'o' || key === 'O') {
      enterInsert(key as InsertVariant);
      return true;
    }

    // Search
    if (key === '/') {
      enterSearch();
      return true;
    }
    if (key === 'n') {
      onSearchNext?.();
      return true;
    }
    if (key === 'N') {
      onSearchPrev?.();
      return true;
    }

    // Command line
    if (key === ':') {
      enterCommand();
      return true;
    }

    // Escape in normal mode — don't consume, let parent handle (close panels etc.)
    if (key === 'Escape') {
      return false;
    }

    // Consume unrecognized single printable keys to prevent them from triggering browser shortcuts
    if (key.length === 1) {
      return true;
    }

    return false;
  }, [
    enabled, mode, keyBuffer, commandInput, searchInput, cursorLine,
    enterNormal, enterInsert, enterCommand, exitCommand, enterSearch, exitSearch,
    executeCommand, executeSearch,
    moveCursorBy, moveCursorTo, getVisibleLineCount,
    deleteLine, yankLine, putAfter, deleteChar, undo, redo,
    clearBuffer, startBufferTimeout,
    onSearchNext, onSearchPrev,
  ]);

  // ========== Public API ==========
  const state: ViState = {
    mode,
    cursorLine,
    cursorCol,
    isDirty,
    keyBuffer,
    commandInput,
    searchInput,
    lastSearch,
  };

  return {
    state,
    handleKeyDown,
    enterNormal,
    enterInsert,
    setCursorLine,
    setCursorCol,
    setCommandInput,
    setSearchInput,
    setIsDirty,
    clearUndoHistory: useCallback(() => {
      undoStackRef.current = [];
      redoStackRef.current = [];
    }, []),
  };
}
