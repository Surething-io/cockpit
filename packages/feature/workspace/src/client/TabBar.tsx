'use client';

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

import { TabInfo } from './useTabState';
import { SessionNumberChip, sessionNumberRing, sessionNumberWash, type SessionNumberStatus } from '@cockpit/shared-ui';
import { EngineBadge, EngineIcon, ENGINE_IDS, ENGINE_LABELS, ScheduleTaskPopover, type EngineAccentId, type ScheduleTaskParams } from '@cockpit/feature-agent';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { AlarmClock, History, ListX, Plus, Star } from 'lucide-react';

// ============================================
// Session number: circular shape pairs with the project number while keeping
// the two navigation levels immediately distinguishable. Run/unread state lives
// directly on this marker: a spinning ring while running, solid orange when done.
//
// A Bot-dispatched session (feature-agent shared/botSession.ts) keeps its number
// and changes the chip's SHAPE — the circle becomes a robot head. Nothing is
// added beside the number and nothing is taken from it: the marker rides on the
// one piece of chrome every tab already has, and the status colours keep meaning
// exactly what they meant. The two shapes live in SessionNumberChip.
// ============================================

function TabNumberIcon({ number, status, statusLabel, isActive, pinned, bot }: { number: number; status: SessionNumberStatus; statusLabel?: string; isActive: boolean; pinned: boolean; bot?: string }) {
  const wash = status !== 'normal'
    ? sessionNumberWash(status, isActive)
    : pinned
      ? 'border-transparent bg-amber-9 text-black/80'
      : isActive
        ? 'border-transparent bg-brand/25 text-brand'
        : 'border-transparent bg-muted-foreground/25 text-foreground/75';

  return (
    <SessionNumberChip
      wash={wash}
      ring={sessionNumberRing(status)}
      bot={bot}
      role={status !== 'normal' ? 'status' : undefined}
      ariaLabel={bot ? [statusLabel, `Bot session: @${bot}`].filter(Boolean).join(' · ') : statusLabel}
      ariaHidden={status === 'normal' && !bot}
    >
      {number}
    </SessionNumberChip>
  );
}

// ============================================
// NewTabButton with engine picker popover
// ============================================

function NewTabButton({ onNewTab, onNewCodexTab, onNewKimiTab, onNewGlmTab, onNewOllamaTab, onNewDeepseekTab }: { onNewTab: () => void; onNewCodexTab?: () => void; onNewKimiTab?: () => void; onNewGlmTab?: () => void; onNewOllamaTab?: () => void; onNewDeepseekTab?: () => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const panelTarget = usePanelPortalTarget();
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      // Compute position relative to portal target (panel wrapper or viewport).
      // When inside a PanelPortalProvider the portaled element's `position: fixed`
      // is relative to the panel wrapper (containing block), so we subtract the
      // wrapper's viewport origin. With document.body fallback the origin is (0,0).
      const origin = panelTarget?.getBoundingClientRect();
      const ox = origin?.left ?? 0;
      const oy = origin?.top ?? 0;
      // Position: below the button, left-aligned — the list sits at the panel's
      // left edge, so the menu opens rightwards into the chat area.
      setPos({
        top: rect.bottom + 4 - oy,
        left: rect.left - ox,
      });
    }
    setOpen(v => !v);
  };

  const pick = (engine: EngineAccentId) => {
    setOpen(false);
    if (engine === 'codex') onNewCodexTab?.();
    else if (engine === 'kimi') onNewKimiTab?.();
    else if (engine === 'glm') onNewGlmTab?.();
    else if (engine === 'ollama') onNewOllamaTab?.();
    else if (engine === 'deepseek') onNewDeepseekTab?.();
    else onNewTab();
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex-shrink-0 flex items-center gap-1 pl-1.5 pr-2 py-1 text-xs text-foreground hover:bg-hover rounded transition-colors"
      >
        <Plus className="w-4 h-4" />
        {t('tabBar.newTab')}
      </button>
      {open && <Portal>
        <div
          ref={menuRef}
          className="fixed z-[9999] bg-popover border border-border rounded-lg shadow-lv2 py-1 min-w-[140px]"
          style={{ top: pos.top, left: pos.left }}
        >
          {/* Driven by ENGINE_IDS rather than six hand-written rows: the labels and the
              marks now come from the same table the tab chips and the picker pill use,
              and a new engine appears here without a seventh copy being written. */}
          {ENGINE_IDS.map((id) => (
            <button
              key={id}
              onClick={() => pick(id)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
            >
              <EngineIcon engine={id} className="h-3.5 w-3.5" />
              {ENGINE_LABELS[id]}
            </button>
          ))}
        </div>
      </Portal>}
    </>
  );
}

// ============================================
// Scheduler popover for one row — portaled and fixed, because the rows sit in a
// scrolling column that would clip it. Opens to the right of the list, level
// with the row, nudged up when it would run off the bottom.
// ============================================

function RowSchedulePopover({ anchor, onClose, onCreate }: { anchor: { top: number; left: number }; onClose: () => void; onCreate: (params: ScheduleTaskParams) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.getBoundingClientRect().bottom - (window.innerHeight - 8);
    setTop(overflow > 0 ? Math.max(8, anchor.top - overflow) : anchor.top);
  }, [anchor.top]);
  return (
    <Portal>
      <div ref={ref} className="fixed z-[9999]" style={{ top, left: anchor.left }}>
        <ScheduleTaskPopover unanchored onClose={onClose} onCreate={onCreate} />
      </div>
    </Portal>
  );
}

// ============================================
// TabBar component — a vertical list of the open sessions
// ============================================

interface TabBarProps {
  tabs: TabInfo[];
  /** Which tab the list highlights. In side-by-side this is the FOCUSED pane's
   *  tab, not the primary one — the highlight answers "which session am I
   *  looking at", and with two panes open that moves with focus. */
  selectedTabId: string;
  /** Tabs currently on screen (one, or two side by side). The focused one gets
   *  the full highlight; the other a lighter mark, so the list says what both
   *  panes show. */
  visibleTabIds?: readonly string[];
  unreadTabs: Set<string>;
  /** Running sessions restored from the authoritative server snapshot. */
  globalLoadingTabs: Set<string>;
  dragTabIndex: number | null;
  dragOverTabIndex: number | null;
  isPinned?: (tabId: string) => boolean;
  /** Row hover actions. Favorite needs a session id (a blank chat has none);
   *  scheduling needs the tab's project. */
  onTogglePin?: (tabId: string) => void;
  onScheduleTask?: (tabId: string, params: ScheduleTaskParams) => void;
  onSwitchTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseAllTabs?: () => void;
  onNewTab: () => void;
  onNewCodexTab?: () => void;
  onNewKimiTab?: () => void;
  onNewGlmTab?: () => void;
  onNewOllamaTab?: () => void;
  onNewDeepseekTab?: () => void;
  /** Open the current project's session list. Only passed when a project
   *  (cwd) is open — when omitted, the entry button is not rendered. */
  onOpenProjectSessions?: () => void;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
  /** Single / side-by-side panes. Lives here rather than in the composer
   *  because it is panel-level chrome, like the tabs themselves — and reaching
   *  the composer meant a context purely to cross four component layers. */
  sideBySide?: boolean;
  onToggleSideBySide?: () => void;
}

// Same range as the Explorer file tree (FileBrowserModal TREE_WIDTH_*), so the
// two left columns line up by default.
const LIST_WIDTH_MIN = 320;
const LIST_WIDTH_MAX = LIST_WIDTH_MIN * 1.5;

/**
 * The open sessions of this project as a resizable column on the left of the
 * agent panel (it replaced the horizontal tab strip): an action row (new,
 * close all, project sessions, side-by-side) over one row per tab — number chip
 * carrying run/unread state, title, engine mark that turns into a close button
 * on hover. Drag rows to reorder. Only OPEN tabs live here; past sessions are
 * reached through the project-sessions board.
 */
export function TabBar({
  tabs,
  selectedTabId,
  visibleTabIds,
  unreadTabs,
  globalLoadingTabs,
  dragTabIndex,
  dragOverTabIndex,
  isPinned,
  onTogglePin,
  onScheduleTask,
  onSwitchTab,
  onCloseTab,
  onCloseAllTabs,
  onNewTab,
  onNewCodexTab,
  onNewKimiTab,
  onNewGlmTab,
  onNewOllamaTab,
  onNewDeepseekTab,
  onOpenProjectSessions,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  sideBySide,
  onToggleSideBySide,
}: TabBarProps) {
  const { t } = useTranslation();
  // Dragged width, not persisted — same transient policy as the Explorer tree.
  const [width, setWidth] = useState(LIST_WIDTH_MIN);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelTarget = usePanelPortalTarget();
  const [scheduling, setScheduling] = useState<{ tabId: string; top: number; left: number } | null>(null);

  const toggleScheduler = (tabId: string, row: HTMLElement) => {
    if (scheduling?.tabId === tabId) { setScheduling(null); return; }
    // Fixed coordinates are relative to the panel portal target (see NewTabButton).
    const origin = panelTarget?.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const listRight = listRef.current?.getBoundingClientRect().right ?? r.right;
    setScheduling({ tabId, top: r.top - (origin?.top ?? 0), left: listRight + 8 - (origin?.left ?? 0) });
  };

  // Mouse only: on touch, a horizontal drag belongs to the three-panel swipe.
  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [width]);

  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    const next = drag.startWidth + (e.clientX - drag.startX);
    setWidth(Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, next)));
  }, []);

  const handleResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    <div ref={listRef} className="relative flex-shrink-0 h-full flex flex-col border-r border-border bg-card" style={{ width }}>
      {/* Divider — 5px hit area centred on the right border, drag to resize */}
      <div
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        className="absolute inset-y-0 -right-[3px] w-[5px] z-10 cursor-col-resize group"
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px group-hover:bg-brand transition-colors" />
      </div>
      {/* Action row */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border flex-shrink-0">
        <NewTabButton onNewTab={onNewTab} onNewCodexTab={onNewCodexTab} onNewKimiTab={onNewKimiTab} onNewGlmTab={onNewGlmTab} onNewOllamaTab={onNewOllamaTab} onNewDeepseekTab={onNewDeepseekTab} />
        {/* Left group ADDS rows: new session, then past sessions of this project
            (only when a project is open). Clock, not a chat bubble — every row
            here is a conversation already, so the bubble said nothing. */}
        {onOpenProjectSessions && (
          <button
            onClick={onOpenProjectSessions}
            className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
            title={t('sessions.projectSessions')}
            aria-label={t('sessions.projectSessions')}
          >
            <History className="w-4 h-4" />
          </button>
        )}
        {/* Right group: the split toggle changes the chat area's layout, not the
            list, so it sits apart from the left group. */}
        {onToggleSideBySide && (
          <button
            onClick={onToggleSideBySide}
            className="ml-auto flex-shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
            title={sideBySide ? t('chat.singlePane') : t('chat.splitPane')}
            aria-label={sideBySide ? t('chat.singlePane') : t('chat.splitPane')}
            aria-pressed={sideBySide}
          >
            {/* The icon shows the layout you will GET, not the one you are in —
                it reads as the action, like every other button in this row. */}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="16" rx="2" strokeWidth={2} />
              {!sideBySide && <path strokeWidth={2} d="M12 4v16" />}
            </svg>
          </button>
        )}
        {/* Close-all — one click closes every tab (resets to a single blank
            tab). Last, behind a divider: destructive, kept apart from the rest. */}
        {onCloseAllTabs && (
          <>
            {onToggleSideBySide && <div className="w-px h-4 mx-1 bg-border flex-shrink-0" aria-hidden />}
            <button
              onClick={onCloseAllTabs}
              className={`${onToggleSideBySide ? '' : 'ml-auto '}flex-shrink-0 p-1.5 text-muted-foreground hover:text-destructive hover:bg-hover rounded transition-colors`}
              title={t('tabBar.closeAll')}
              aria-label={t('tabBar.closeAll')}
            >
              {/* List-with-x, not a bare x: a lone x at the column's corner reads as
                  "close this sidebar", while this clears every row below it. */}
              <ListX className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      {/* Open sessions */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-0.5">
        {tabs.map((tab, index) => {
          const isActive = tab.id === selectedTabId;
          const isVisible = !isActive && (visibleTabIds?.includes(tab.id) ?? false);
          const pinned = isPinned?.(tab.id) ?? false;
          const status: SessionNumberStatus = tab.isLoading || globalLoadingTabs.has(tab.id)
            ? 'loading'
            : unreadTabs.has(tab.id) && !isActive
              ? 'unread'
              : 'normal';
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={() => onDrop(index)}
              onDragEnd={onDragEnd}
              onClick={() => onSwitchTab(tab.id)}
              className={`group flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer rounded-md transition-colors ${
                isActive
                  ? 'bg-brand/10 text-foreground font-medium'
                  : isVisible
                    ? 'bg-secondary/60 text-foreground'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground'
              } ${dragTabIndex === index ? 'opacity-50' : ''} ${
                dragOverTabIndex === index && dragTabIndex !== index ? 'ring-1 ring-inset ring-brand' : ''
              }`}
            >
              {/* The number keeps its pinned colour as a passive status marker;
                  the favorite toggle is one of the row's hover actions. */}
              <div className="h-4 w-4 flex-shrink-0">
                <TabNumberIcon
                  number={index + 1}
                  status={status}
                  statusLabel={status === 'loading' ? t('sessions.running') : status === 'unread' ? t('sessions.done') : undefined}
                  isActive={isActive}
                  pinned={pinned}
                  bot={tab.bot}
                />
              </div>
              <span className="flex-1 min-w-0 truncate" data-tooltip={tab.title}>{tab.title}</span>
              {/* Hover actions (they used to sit in the composer toolbar): they act
                  on a session, so they live on its row. The scheduler stays shown
                  while its popover is open. */}
              {onTogglePin && tab.sessionId && (
                <button
                  onClick={(e) => { e.stopPropagation(); onTogglePin(tab.id); }}
                  className={`hidden group-hover:flex group-focus-within:flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted ${pinned ? 'text-amber-9' : 'text-muted-foreground hover:text-amber-9'}`}
                  data-tooltip={t(pinned ? 'sessions.removeFavorite' : 'sessions.addFavorite')}
                  aria-label={t(pinned ? 'sessions.removeFavorite' : 'sessions.addFavorite')}
                  aria-pressed={pinned}
                >
                  <Star className="h-3.5 w-3.5" fill={pinned ? 'currentColor' : 'none'} />
                </button>
              )}
              {onScheduleTask && tab.cwd && (
                <button
                  // Keep the popover's outside-click from closing it just before
                  // this click would toggle it — that reopened it.
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); toggleScheduler(tab.id, e.currentTarget.closest('[draggable]') as HTMLElement); }}
                  className={`${scheduling?.tabId === tab.id ? 'flex text-brand bg-brand/10' : 'hidden group-hover:flex group-focus-within:flex text-muted-foreground hover:text-foreground hover:bg-muted'} h-5 w-5 shrink-0 items-center justify-center rounded`}
                  data-tooltip={t('chat.scheduledTasks')}
                  aria-label={t('chat.scheduledTasks')}
                >
                  {/* AlarmClock, not a plain clock: the clock is "history" in the
                      action row above. */}
                  <AlarmClock className="h-3.5 w-3.5" />
                </button>
              )}
              {/* Engine and close share one trailing slot. Status belongs to the
                  session number, so engine identity stays visible. */}
              <span className="relative h-4 w-4 shrink-0">
                <span className="absolute inset-0 inline-flex items-center justify-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                  <EngineBadge engine={tab.engine} size="sm" />
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  data-tooltip={t('tabBar.closeTab')}
                  aria-label={t('tabBar.closeTab')}
                >
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {scheduling && onScheduleTask && (
        <RowSchedulePopover
          key={scheduling.tabId}
          anchor={scheduling}
          onClose={() => setScheduling(null)}
          onCreate={(params) => onScheduleTask(scheduling.tabId, params)}
        />
      )}
    </div>
  );
}
