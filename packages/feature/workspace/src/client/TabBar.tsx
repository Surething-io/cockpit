'use client';

import React, { useState, useRef, useEffect } from 'react';

import { TabInfo } from './useTabState';
import { sessionNumberClass, type SessionNumberStatus } from '@cockpit/shared-ui';
import { EngineBadge, EngineIcon, ENGINE_IDS, ENGINE_LABELS, type EngineAccentId } from '@cockpit/feature-agent';
import { Tooltip } from '@cockpit/shared-ui';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';

// ============================================
// Session number: circular shape pairs with the project number while keeping
// the two navigation levels immediately distinguishable. The badge also carries
// the session status (see sessionNumberStyles) — there is no separate status dot.
// ============================================

function TabNumberIcon({ number, status, isActive }: { number: number; status: SessionNumberStatus; isActive: boolean }) {
  return (
    <span
      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border font-mono text-[9px] font-medium leading-none tabular-nums transition-colors ${sessionNumberClass(status, isActive)}`}
      aria-hidden="true"
    >
      {number}
    </span>
  );
}

// ============================================
// NewTabButton with engine picker popover
// ============================================

function NewTabButton({ onNewTab, onNewCodexTab, onNewKimiTab, onNewGlmTab, onNewOllamaTab, onNewDeepseekTab }: { onNewTab: () => void; onNewCodexTab?: () => void; onNewKimiTab?: () => void; onNewGlmTab?: () => void; onNewOllamaTab?: () => void; onNewDeepseekTab?: () => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const panelTarget = usePanelPortalTarget();

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
      const ow = origin?.width ?? window.innerWidth;
      // Position: below button, right-aligned (opens to the left)
      setPos({
        top: rect.bottom + 4 - oy,
        right: ow - (rect.right - ox),
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
        className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
        title="New tab"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
      {open && <Portal>
        <div
          ref={menuRef}
          className="fixed z-[9999] bg-popover border border-border rounded-lg shadow-lv2 py-1 min-w-[140px]"
          style={{ top: pos.top, right: pos.right }}
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
// TabBar component
// ============================================

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  unreadTabs: Set<string>;
  dragTabIndex: number | null;
  dragOverTabIndex: number | null;
  isPinned?: (tabId: string) => boolean;
  onTogglePin?: (tabId: string) => void;
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
}

export function TabBar({
  tabs,
  activeTabId,
  unreadTabs,
  dragTabIndex,
  dragOverTabIndex,
  isPinned,
  onTogglePin,
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
}: TabBarProps) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center px-2 gap-1 overflow-x-auto">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const pinned = isPinned?.(tab.id) ?? false;
          const pinLabel = pinned ? t('sessions.removeFavorite') : t('sessions.addFavorite');
          const status: SessionNumberStatus = tab.isLoading
            ? 'loading'
            : unreadTabs.has(tab.id) && !isActive
              ? 'unread'
              : 'normal';
          return (
          <Tooltip key={tab.id} content={tab.title} delay={200} className="flex-1 min-w-16 max-w-[260px]">
            <div
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={() => onDrop(index)}
              onDragEnd={onDragEnd}
              className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer rounded-t-lg border-t-[1.5px] transition-colors ${
                isActive
                  ? 'border-brand bg-slate-4 text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:bg-secondary/50'
              } ${dragTabIndex === index ? 'opacity-50' : ''} ${
                dragOverTabIndex === index ? 'border-l-2 border-brand' : ''
              }`}
              onClick={() => onSwitchTab(tab.id)}
            >
              {/* Circle number — its colour IS the status (orange pulsing =
                  generating, red = done but unread, brand/muted = seen), which
                  is also the whole colour budget on this chip: the star's
                  `amber-9` is the solid-FILL step, one value in both themes,
                  where the `-11` text step it started as is a brick in light and
                  a glaring lemon in dark. Filled vs outlined is what carries
                  favourited/not; hover previews the outcome (amber = about to
                  gain, faint = about to lose). No star on a session-less tab —
                  favouriting stores a sessionId, so there it is a silent no-op. */}
              <div className="relative flex-shrink-0">
                <TabNumberIcon number={index + 1} status={status} isActive={isActive} />
                {onTogglePin && tab.sessionId && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(tab.id);
                    }}
                    className={`absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-sm transition-colors duration-150 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                      pinned
                        ? 'text-amber-9 opacity-100 hover:text-foreground-faint'
                        : 'text-foreground-faint opacity-0 group-hover:opacity-100 hover:text-amber-9'
                    }`}
                    data-tooltip={pinLabel}
                    aria-label={pinLabel}
                    aria-pressed={pinned}
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill={pinned ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      strokeWidth={pinned ? 1 : 2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                    </svg>
                  </button>
                )}
              </div>
              <span className="flex-1 min-w-0 truncate">{tab.title}</span>
              {/* Same mark as the session lists and the engine picker in the chat top bar.
                  This used to be five hand-written letter chips with their own color table,
                  which is how they drifted out of step with EngineBadge. */}
              <EngineBadge engine={tab.engine} size="sm" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="ml-1 p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-tooltip={t('tabBar.closeTab')}
                aria-label={t('tabBar.closeTab')}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </Tooltip>
          );
        })}
        {/* New tab button with engine picker */}
        <NewTabButton onNewTab={onNewTab} onNewCodexTab={onNewCodexTab} onNewKimiTab={onNewKimiTab} onNewGlmTab={onNewGlmTab} onNewOllamaTab={onNewOllamaTab} onNewDeepseekTab={onNewDeepseekTab} />
        {/* Close-all button — one click closes every tab (resets to a single
            blank tab). Always shown, including with a single tab, where it
            acts as "reset this tab to a blank chat". */}
        {onCloseAllTabs && (
          <button
            onClick={onCloseAllTabs}
            className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-destructive hover:bg-hover rounded transition-colors"
            title={t('tabBar.closeAll')}
            aria-label={t('tabBar.closeAll')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {/* Project sessions entry — only when a project (cwd) is open. Sits
            right after the new-tab button. Chat-bubble icon reads as
            "conversations" and sizes to match NewTabButton. */}
        {onOpenProjectSessions && (
          <button
            onClick={onOpenProjectSessions}
            className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
            title={t('sessions.projectSessions')}
            aria-label={t('sessions.projectSessions')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
