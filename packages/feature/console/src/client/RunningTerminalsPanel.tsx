'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SquareTerminal } from 'lucide-react';
import { toast, ProjectNumberChip } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { useRunningTerminals } from './useRunningTerminals';
import { interruptRunningTerminal, type RunningTerminal } from './effect/consoleClient';

/** A stop that has not produced an exit by then is reported as failed. */
const STOP_TIMEOUT_MS = 3000;

interface RunningTerminalsPanelProps {
  collapsed?: boolean;
  /** Project the user is looking at — its group is listed first. */
  currentCwd?: string;
  /** Sidebar project order; gives each group its number and position. */
  projectOrder: string[];
  /** Switch to the project, swipe to Console and reveal the bubble. */
  onFocusTerminal: (projectCwd: string, commandId: string) => void;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

/** `cwd` relative to the project root, or '' when it is the root itself. */
function subdir(cwd: string, projectCwd: string): string {
  if (!cwd || cwd === projectCwd) return '';
  return cwd.startsWith(projectCwd + '/') ? cwd.slice(projectCwd.length + 1) : cwd;
}

/**
 * Sidebar row + board listing every live terminal bubble across projects.
 * Sits under the scheduled-tasks row and shares its board shell.
 */
export function RunningTerminalsPanel({ collapsed, currentCwd, projectOrder, onFocusTerminal }: RunningTerminalsPanelProps) {
  const { t } = useTranslation();
  const { terminals, refresh } = useRunningTerminals();
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmStopId, setConfirmStopId] = useState<string | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const stopTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Grouped by project: current project first, then sidebar order, then
  // projects that are not open in the sidebar. Oldest terminal first in a group
  // — the longest-running one is the likeliest to be forgotten.
  const groups = useMemo(() => {
    const byProject = new Map<string, RunningTerminal[]>();
    for (const term of terminals) {
      const list = byProject.get(term.projectCwd);
      if (list) list.push(term);
      else byProject.set(term.projectCwd, [term]);
    }
    const rank = (cwd: string) => {
      if (cwd === currentCwd) return -1;
      const i = projectOrder.indexOf(cwd);
      return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
    };
    return [...byProject.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([cwd, items]) => ({
        cwd,
        number: projectOrder.indexOf(cwd) + 1,
        items: [...items].sort((x, y) => x.timestamp.localeCompare(y.timestamp)),
      }));
  }, [terminals, currentCwd, projectOrder]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const closeBoard = useCallback(() => {
    setIsOpen(false);
    setConfirmStopId(null);
  }, []);

  const openBoard = useCallback(() => {
    refresh();
    setNow(Date.now());
    setIsOpen(true);
  }, [refresh]);

  // Durations tick only while the board is open, so the sidebar does not
  // re-render every second.
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  // A stopped terminal leaves the list once its exit lands; forget its timer.
  useEffect(() => {
    const alive = new Set(terminals.map((term) => term.commandId));
    setStoppingIds((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
    for (const [id, timer] of stopTimersRef.current) {
      if (!alive.has(id)) {
        clearTimeout(timer);
        stopTimersRef.current.delete(id);
      }
    }
  }, [terminals]);

  useEffect(() => {
    const timers = stopTimersRef.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); };
  }, []);

  const focusTerminal = useCallback((term: RunningTerminal) => {
    closeBoard();
    onFocusTerminal(term.projectCwd, term.commandId);
  }, [closeBoard, onFocusTerminal]);

  const stopTerminal = useCallback((term: RunningTerminal) => {
    setConfirmStopId(null);
    setStoppingIds((prev) => new Set(prev).add(term.commandId));
    const fail = () => {
      stopTimersRef.current.delete(term.commandId);
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(term.commandId);
        return next;
      });
      toast(t('runningTerminals.stopFailed'), 'error');
    };
    BrowserRuntime.runPromiseExit(interruptRunningTerminal(term.commandId)).then((exit) => {
      if (exit._tag !== 'Success') {
        fail();
        return;
      }
      // Not running any more by the time the request landed: already gone.
      if (!exit.value.interrupted) {
        refresh();
        return;
      }
      stopTimersRef.current.set(term.commandId, setTimeout(fail, STOP_TIMEOUT_MS));
    });
  }, [refresh, t]);

  // Keyboard: ↑/↓ select, Enter jump (or confirm an armed stop),
  // Delete/Backspace arm stop, Esc disarm first, then close.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (confirmStopId) setConfirmStopId(null);
        else closeBoard();
        return;
      }
      if (flat.length === 0) return;
      const index = flat.findIndex((term) => term.commandId === selectedId);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : flat.length - 1) : (index + step + flat.length) % flat.length;
        setSelectedId(flat[next].commandId);
        setConfirmStopId(null);
        return;
      }
      const selected = index >= 0 ? flat[index] : null;
      if (!selected) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (confirmStopId === selected.commandId) stopTerminal(selected);
        else focusTerminal(selected);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (!stoppingIds.has(selected.commandId)) setConfirmStopId(selected.commandId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, flat, selectedId, confirmStopId, stoppingIds, closeBoard, focusTerminal, stopTerminal]);

  const renderRow = (term: RunningTerminal) => {
    const stopping = stoppingIds.has(term.commandId);
    const confirming = confirmStopId === term.commandId;
    const dir = subdir(term.cwd, term.projectCwd);
    const label = term.title || term.command.split('\n')[0];
    return (
      <div
        key={term.commandId}
        data-running-terminal={term.commandId}
        onClick={() => { if (!stopping) focusTerminal(term); }}
        onMouseEnter={() => setSelectedId(term.commandId)}
        title={`${term.command}\npid ${term.pid}`}
        className={`group rounded-md px-3 py-2 transition-colors ${
          stopping ? 'opacity-50 cursor-default' : 'cursor-pointer'
        } ${
          // No per-row border: the selected (hover or ↑/↓) row is the only one with a wash.
          !stopping && selectedId === term.commandId ? 'bg-hover' : ''
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-shrink-0 font-mono text-[10px] px-1 rounded bg-muted text-muted-foreground">{term.shortId}</span>
          <span className="flex-1 min-w-0 truncate text-sm font-mono text-foreground">{label}</span>
          {term.usePty && <span className="flex-shrink-0 text-[10px] text-foreground-subtle">PTY</span>}
          <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatDuration(now - new Date(term.timestamp).getTime())}
          </span>
          {stopping ? (
            <span className="flex-shrink-0 text-xs text-muted-foreground">{t('runningTerminals.stopping')}</span>
          ) : confirming ? null : (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmStopId(term.commandId); }}
              className="flex-shrink-0 px-1.5 py-0.5 text-xs rounded text-muted-foreground hover:text-destructive hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
            >
              {t('runningTerminals.stop')}
            </button>
          )}
        </div>
        {(dir || term.title) && !confirming && (
          <div className="mt-0.5 pl-9 text-xs text-muted-foreground truncate font-mono">
            {term.title ? term.command.split('\n')[0] : dir}
            {term.title && dir ? ` · ${dir}` : ''}
          </div>
        )}
        {confirming && (
          <div className="mt-1.5 flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
            <span className="text-xs text-muted-foreground">{t('runningTerminals.confirmStop')}</span>
            <button
              onClick={() => setConfirmStopId(null)}
              className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => stopTerminal(term)}
              className="px-2 py-0.5 text-xs rounded bg-red-9 text-white hover:bg-red-10"
            >
              {t('runningTerminals.stop')}
            </button>
          </div>
        )}
      </div>
    );
  };

  const count = terminals.length;

  return (
    <>
      <button
        onClick={openBoard}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={collapsed ? t('runningTerminals.title') : undefined}
        data-testid="running-terminals-entry"
      >
        <SquareTerminal className="w-5 h-5 flex-shrink-0" />
        {!collapsed && <span className="text-sm flex-1 text-left">{t('runningTerminals.title')}</span>}
        {/* Neutral count: a running terminal is a state, not something unread. */}
        {count > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-muted-foreground text-xs font-medium rounded-full flex items-center justify-center bg-popover border border-border ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {count}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-scrim" onClick={closeBoard} />
          <div
            className="relative w-[min(calc(100vw-2rem),max(42rem,60vw))] max-w-6xl h-[70vh] mx-4 bg-card rounded-lg shadow-lv3 flex flex-col overflow-hidden"
            data-testid="running-terminals-board"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t('runningTerminals.title')}</h2>
              </div>
              <button
                onClick={closeBoard}
                className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {count === 0 ? (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                {t('runningTerminals.empty')}
              </div>
            ) : (
              /* Padding stays off the scroll node so the sticky group header
                 does not leave a strip of rows visible above it. */
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="p-3 space-y-3">
                  {groups.map((group) => (
                    /* One card per project. No overflow-hidden here: it would make
                       the card the sticky header's scroll container. */
                    <div key={group.cwd} className="rounded-lg border border-border">
                      <div className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                        {group.number > 0 && (
                          <ProjectNumberChip number={group.number} isActive={group.cwd === currentCwd} />
                        )}
                        <span className="truncate" title={group.cwd}>{projectName(group.cwd)}</span>
                        {group.cwd === currentCwd && (
                          <span className="text-foreground-subtle">· {t('runningTerminals.currentProject')}</span>
                        )}
                      </div>
                      <div className="p-1 space-y-0.5">{group.items.map(renderRow)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Status bar: totals on the left, the keyboard map on the right. */}
            <div
              className="flex items-center justify-between gap-3 px-4 py-1.5 border-t border-border text-xs text-muted-foreground"
              data-testid="running-terminals-status"
            >
              <span className="tabular-nums">
                {t('runningTerminals.status', { count, projects: groups.length })}
              </span>
              {count > 0 && (
                <span className="truncate text-foreground-subtle">{t('runningTerminals.keys')}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
