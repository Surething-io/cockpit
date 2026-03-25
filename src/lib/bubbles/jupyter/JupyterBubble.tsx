'use client';

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { BUBBLE_CONTENT_HEIGHT } from '@/components/project/console/CommandBubble';
import { useToast } from '@/components/shared/Toast';
import { modKey } from '@/lib/platform';
import { CellRenderer, type NotebookCell, type CellOutput } from './CellRenderer';

// ============================================
// Types
// ============================================

interface JupyterBubbleProps {
  id: string;
  filePath: string;
  displayName: string;
  cwd: string;
  selected: boolean;
  maximized: boolean;
  expandedHeight: number;
  bubbleContentHeight?: number;
  timestamp: string;
  onSelect: () => void;
  onClose: () => void;
  onToggleMaximize: () => void;
  onTitleMouseDown: () => void;
}

type KernelStatus = 'disconnected' | 'starting' | 'idle' | 'busy' | 'error' | 'dead';

// ============================================
// Helpers
// ============================================

const TOOLBAR_HEIGHT = 41;

function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

// ============================================
// Component
// ============================================

export function JupyterBubble({
  id,
  filePath,
  displayName,
  cwd,
  selected,
  maximized,
  expandedHeight,
  bubbleContentHeight,
  timestamp,
  onSelect,
  onClose,
  onToggleMaximize,
  onTitleMouseDown,
}: JupyterBubbleProps) {
  const { showToast } = useToast();

  // Notebook state
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Cell interaction state
  const [activeCellIndex, setActiveCellIndex] = useState<number | null>(null);
  const [editingCellIndex, setEditingCellIndex] = useState<number | null>(null);

  // Kernel state
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>('disconnected');
  const [kernelError, setKernelError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const executingCellsRef = useRef<Map<string, number>>(new Map()); // msg_id -> cell index

  const scrollRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // ============================================
  // Load notebook
  // ============================================

  const loadNotebook = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/jupyter/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, cwd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load notebook');

      setCells(data.cells.map((c: NotebookCell, i: number) => ({ ...c, index: i, isExecuting: false })));
      setDirty(false);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filePath, cwd]);

  useEffect(() => {
    loadNotebook();
  }, [loadNotebook]);

  // ============================================
  // Save notebook
  // ============================================

  const saveNotebook = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/jupyter/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath,
          cwd,
          cells: cells.map(c => ({
            cell_type: c.cell_type,
            source: c.source,
            outputs: c.outputs,
            execution_count: c.execution_count,
            metadata: c.metadata,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setDirty(false);
      showToast('Saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }, [filePath, cwd, cells, saving, showToast]);

  // Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveNotebook();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveNotebook]);

  // ============================================
  // WebSocket kernel connection
  // ============================================

  const connectKernel = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) return; // already connected/connecting

    setKernelStatus('starting');
    setKernelError(null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/jupyter?bubbleId=${encodeURIComponent(id)}&cwd=${encodeURIComponent(cwd)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Wait for ready message
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data); } catch { return; }

      const type = msg.type as string;

      if (type === 'ready') {
        setKernelStatus('idle');
        setKernelError(null);
      } else if (type === 'status') {
        const state = msg.execution_state as string;
        if (state === 'idle') {
          setKernelStatus('idle');
          // Cell completion is handled by the dedicated useEffect below
        } else if (state === 'busy') {
          setKernelStatus('busy');
        }
      } else if (type === 'output') {
        const msgId = msg.msg_id as string;
        const msgType = msg.msg_type as string;
        const content = msg.content as Record<string, unknown>;
        const cellIdx = executingCellsRef.current.get(msgId);
        if (cellIdx === undefined) return;

        setCells(prev => prev.map((c, i) => {
          if (i !== cellIdx) return c;

          const newOutput: CellOutput = {
            output_type: msgType === 'execute_result' ? 'execute_result'
              : msgType === 'display_data' ? 'display_data'
              : msgType === 'update_display_data' ? 'update_display_data'
              : msgType === 'stream' ? 'stream'
              : msgType === 'error' ? 'error'
              : 'display_data',
          };

          if (msgType === 'stream') {
            newOutput.name = content.name as string;
            newOutput.text = content.text as string;
          } else if (msgType === 'error') {
            newOutput.ename = content.ename as string;
            newOutput.evalue = content.evalue as string;
            newOutput.traceback = content.traceback as string[];
          } else {
            newOutput.data = content.data as Record<string, string | string[]>;
            newOutput.metadata = content.metadata as Record<string, unknown>;
            if (msgType === 'execute_result') {
              newOutput.execution_count = content.execution_count as number;
            }
          }

          return { ...c, outputs: [...c.outputs, newOutput] };
        }));
      } else if (type === 'kernel_error') {
        setKernelStatus('error');
        setKernelError(msg.message as string);
      } else if (type === 'kernel_died') {
        setKernelStatus('dead');
        setKernelError('Kernel died');
        // Mark all executing cells as done
        for (const [, cellIdx] of executingCellsRef.current) {
          setCells(prev => prev.map((c, i) => i === cellIdx ? { ...c, isExecuting: false } : c));
        }
        executingCellsRef.current.clear();
      }
    };

    ws.onclose = () => {
      if (kernelStatus !== 'error' && kernelStatus !== 'dead') {
        setKernelStatus('disconnected');
      }
    };

    ws.onerror = () => {
      setKernelStatus('error');
    };
  }, [id, cwd, kernelStatus]);

  // Cleanup WS on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  // ============================================
  // Cell operations
  // ============================================

  const runCell = useCallback((cellIndex: number) => {
    const cell = cellsRef.current[cellIndex];
    if (!cell || cell.cell_type !== 'code') return;

    // Auto-connect kernel if needed
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      connectKernel();
      // Queue the execution — wait for ready
      const checkReady = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          clearInterval(checkReady);
          runCell(cellIndex);
        }
      }, 200);
      setTimeout(() => clearInterval(checkReady), 15000); // timeout
      return;
    }

    const msgId = `cell-${cellIndex}-${Date.now()}`;
    executingCellsRef.current.set(msgId, cellIndex);

    // Clear outputs and mark as executing
    setCells(prev => prev.map((c, i) =>
      i === cellIndex ? { ...c, outputs: [], isExecuting: true, execution_count: null } : c
    ));

    wsRef.current.send(JSON.stringify({
      type: 'execute',
      msg_id: msgId,
      code: cell.source,
    }));

    // Completion is handled by the useEffect below that listens for status=idle
    // Safety timeout: 5 min max execution
    setTimeout(() => {
      if (executingCellsRef.current.has(msgId)) {
        executingCellsRef.current.delete(msgId);
        setCells(prev => prev.map((c, i) =>
          i === cellIndex ? { ...c, isExecuting: false } : c
        ));
      }
    }, 300000);
  }, [connectKernel]);

  // Track cell execution completion via status messages
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return undefined;

    const handleStatusIdle = (msgId: string) => {
      const cellIdx = executingCellsRef.current.get(msgId);
      if (cellIdx !== undefined) {
        executingCellsRef.current.delete(msgId);
        setCells(prev => prev.map((c, i) => {
          if (i !== cellIdx) return c;
          const execResult = c.outputs.find(o => o.output_type === 'execute_result');
          return {
            ...c,
            isExecuting: false,
            execution_count: execResult?.execution_count ?? c.execution_count,
          };
        }));
      }
    };

    // Patch: we'll add a secondary listener
    const extraHandler = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'status' && msg.execution_state === 'idle') {
        // The bridge sends status with msg_id = '' for global status.
        // But individual execution status has the parent msg_id.
        // Try all active executions.
        for (const [msgId] of executingCellsRef.current) {
          handleStatusIdle(msgId);
        }
      }
    };
    ws.addEventListener('message', extraHandler);
    return () => { ws.removeEventListener('message', extraHandler); };
  }, [kernelStatus]); // Re-attach when kernel reconnects

  const runAllCells = useCallback(() => {
    const codeCells = cells.map((c, i) => ({ cell: c, index: i })).filter(x => x.cell.cell_type === 'code');
    // Run sequentially: each cell after the previous one finishes
    const queue = [...codeCells];
    const runNext = () => {
      if (queue.length === 0) return;
      const { index } = queue.shift()!;
      runCell(index);
      // Wait for execution to complete, then run next
      const check = setInterval(() => {
        const cell = cellsRef.current[index];
        if (cell && !cell.isExecuting) {
          clearInterval(check);
          runNext();
        }
      }, 200);
    };
    runNext();
  }, [cells, runCell]);

  const interruptKernel = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'interrupt' }));
  }, []);

  const updateCellSource = useCallback((index: number, source: string) => {
    setCells(prev => prev.map((c, i) => i === index ? { ...c, source } : c));
    setDirty(true);
  }, []);

  const deleteCell = useCallback((index: number) => {
    setCells(prev => prev.filter((_, i) => i !== index));
    setDirty(true);
    if (activeCellIndex === index) {
      setActiveCellIndex(null);
    }
  }, [activeCellIndex]);

  const moveCell = useCallback((index: number, direction: 'up' | 'down') => {
    setCells(prev => {
      const next = [...prev];
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
    setActiveCellIndex(direction === 'up' ? index - 1 : index + 1);
  }, []);

  const toggleCellType = useCallback((index: number) => {
    setCells(prev => prev.map((c, i) => {
      if (i !== index) return c;
      const newType = c.cell_type === 'code' ? 'markdown' : c.cell_type === 'markdown' ? 'raw' : 'code';
      return { ...c, cell_type: newType, outputs: newType === 'code' ? c.outputs : [] };
    }));
    setDirty(true);
  }, []);

  const addCell = useCallback((type: 'code' | 'markdown', afterIndex?: number) => {
    const newCell: NotebookCell = {
      index: 0,
      cell_type: type,
      source: '',
      outputs: [],
      execution_count: null,
      metadata: {},
      isExecuting: false,
    };
    setCells(prev => {
      const next = [...prev];
      const insertIdx = afterIndex !== undefined ? afterIndex + 1 : next.length;
      next.splice(insertIdx, 0, newCell);
      return next;
    });
    setDirty(true);
    const newIndex = afterIndex !== undefined ? afterIndex + 1 : cells.length;
    setActiveCellIndex(newIndex);
    setEditingCellIndex(newIndex);
  }, [cells.length]);

  // ============================================
  // Render
  // ============================================

  const contentHeight = maximized && expandedHeight
    ? expandedHeight - TOOLBAR_HEIGHT
    : (bubbleContentHeight ?? BUBBLE_CONTENT_HEIGHT);

  const kernelStatusIcon = useMemo(() => {
    switch (kernelStatus) {
      case 'idle': return <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" title="Kernel idle" />;
      case 'busy': return <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse inline-block" title="Kernel busy" />;
      case 'starting': return <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin inline-block" title="Starting kernel" />;
      case 'error': return <span className="w-2 h-2 rounded-full bg-red-500 inline-block" title={kernelError || 'Kernel error'} />;
      case 'dead': return <span className="w-2 h-2 rounded-full bg-red-500 inline-block" title="Kernel died" />;
      default: return <span className="w-2 h-2 rounded-full bg-gray-500 inline-block" title="Disconnected" />;
    }
  }, [kernelStatus, kernelError]);

  return (
    <div
      className={`w-full bg-accent text-foreground
        relative transition-colors cursor-pointer
        ${maximized ? 'rounded-none overflow-visible border-0' : 'border overflow-hidden rounded-2xl rounded-bl-md rounded-br-md'}
        ${maximized ? '' : selected ? 'border-brand' : 'border-brand/30'}`}
      onClick={maximized ? undefined : onSelect}
    >
      {/* ---- Title Bar ---- */}
      <div
        data-drag-handle
        onDoubleClick={onToggleMaximize}
        onMouseDown={onTitleMouseDown}
        className={`flex items-center gap-2 px-4 py-1.5 border-b border-border ${maximized ? 'bg-card' : 'bg-card/50'}`}
        style={maximized ? { height: TOOLBAR_HEIGHT } : undefined}
      >
        <span className="text-sm flex-shrink-0">📓</span>
        <span className="text-xs text-foreground truncate font-mono font-medium">{displayName}</span>
        {kernelStatusIcon}
        {dirty && <span className="text-[10px] text-amber-500 flex-shrink-0">unsaved</span>}
        <span className="flex-1" />
        {timestamp && (
          <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatTime(timestamp)}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          title={maximized ? `Exit maximize (${modKey()}+M)` : `Maximize (${modKey()}+M)`}
        >
          {maximized ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          title="Close"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ---- Toolbar ---- */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-border/50 bg-surface-secondary/50 text-[11px]">
        <button
          onClick={(e) => { e.stopPropagation(); runAllCells(); }}
          className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Run All"
        >▶ All</button>
        <button
          onClick={(e) => { e.stopPropagation(); interruptKernel(); }}
          className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Interrupt"
          disabled={kernelStatus !== 'busy'}
        >⬛ Stop</button>
        <div className="w-px h-3 bg-border/50 mx-1" />
        <button
          onClick={(e) => { e.stopPropagation(); addCell('code', activeCellIndex ?? cells.length - 1); }}
          className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Add code cell"
        >+ Code</button>
        <button
          onClick={(e) => { e.stopPropagation(); addCell('markdown', activeCellIndex ?? cells.length - 1); }}
          className="px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Add markdown cell"
        >+ Md</button>
        <div className="w-px h-3 bg-border/50 mx-1" />
        <button
          onClick={(e) => { e.stopPropagation(); saveNotebook(); }}
          className={`px-1.5 py-0.5 rounded hover:bg-accent transition-colors ${dirty ? 'text-brand' : 'text-muted-foreground hover:text-foreground'}`}
          title={`Save (${modKey()}+S)`}
          disabled={saving}
        >{saving ? 'Saving...' : 'Save'}</button>
        <span className="flex-1" />
        {kernelError && (
          <span className="text-[10px] text-red-400 truncate max-w-[50%]" title={kernelError}>
            {kernelError}
          </span>
        )}
        {kernelStatus === 'dead' && (
          <button
            onClick={(e) => { e.stopPropagation(); connectKernel(); }}
            className="px-1.5 py-0.5 rounded text-brand hover:bg-accent transition-colors"
          >Restart</button>
        )}
      </div>

      {/* ---- Content ---- */}
      <div
        ref={scrollRef}
        className="overflow-y-auto"
        style={{ height: contentHeight - 30 }}
      >
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Loading notebook...
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <span className="text-red-400 text-sm">{loadError}</span>
            <button onClick={loadNotebook} className="text-xs text-brand hover:underline">Retry</button>
          </div>
        ) : cells.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
            <span>Empty notebook</span>
            <div className="flex gap-2">
              <button onClick={() => addCell('code')} className="text-xs text-brand hover:underline">+ Code cell</button>
              <button onClick={() => addCell('markdown')} className="text-xs text-brand hover:underline">+ Markdown cell</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">
            {cells.map((cell, i) => (
              <CellRenderer
                key={`${i}-${cell.cell_type}`}
                cell={cell}
                isActive={activeCellIndex === i}
                isEditing={editingCellIndex === i}
                onSelect={() => setActiveCellIndex(i)}
                onEdit={() => { setActiveCellIndex(i); setEditingCellIndex(i); }}
                onStopEdit={() => setEditingCellIndex(null)}
                onSourceChange={(source) => updateCellSource(i, source)}
                onRun={() => {
                  if (cell.cell_type === 'code') {
                    runCell(i);
                  }
                  // Auto advance to next cell
                  if (i < cells.length - 1) {
                    setActiveCellIndex(i + 1);
                  }
                }}
                onDelete={() => deleteCell(i)}
                onMoveUp={() => moveCell(i, 'up')}
                onMoveDown={() => moveCell(i, 'down')}
                onToggleType={() => toggleCellType(i)}
                isFirst={i === 0}
                isLast={i === cells.length - 1}
              />
            ))}
            {/* Add cell button at bottom */}
            <div className="flex justify-center gap-2 py-2 opacity-0 hover:opacity-100 transition-opacity">
              <button
                onClick={() => addCell('code', cells.length - 1)}
                className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border/50 hover:border-border transition-colors"
              >+ Code</button>
              <button
                onClick={() => addCell('markdown', cells.length - 1)}
                className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border/50 hover:border-border transition-colors"
              >+ Markdown</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
