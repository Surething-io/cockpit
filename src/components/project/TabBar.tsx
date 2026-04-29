'use client';

import React, { useState, useRef, useEffect } from 'react';

import { TabInfo } from './useTabState';
import { Tooltip } from '../shared/Tooltip';
import { Portal, usePanelPortalTarget } from '../shared/Portal';
import { useTranslation } from 'react-i18next';

// ============================================
// Tab circle-number icon component
// ============================================

function TabNumberIcon({ number, isActive }: { number: number; isActive: boolean }) {
  return (
    <svg
      className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="12"
        fontWeight="500"
      >
        {number}
      </text>
    </svg>
  );
}

// ============================================
// NewTabButton with engine picker popover
// ============================================

function NewTabButton({ onNewTab, onNewClaude2Tab, onNewCodexTab, onNewKimiTab, onNewOllamaTab, onNewDeepseekTab }: { onNewTab: () => void; onNewClaude2Tab?: () => void; onNewCodexTab?: () => void; onNewKimiTab?: () => void; onNewOllamaTab?: () => void; onNewDeepseekTab?: () => void }) {
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

  const pick = (engine: 'claude' | 'claude2' | 'codex' | 'kimi' | 'ollama' | 'deepseek') => {
    setOpen(false);
    if (engine === 'claude2') onNewClaude2Tab?.();
    else if (engine === 'codex') onNewCodexTab?.();
    else if (engine === 'kimi') onNewKimiTab?.();
    else if (engine === 'ollama') onNewOllamaTab?.();
    else if (engine === 'deepseek') onNewDeepseekTab?.();
    else onNewTab();
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        title="New tab"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
      {open && <Portal>
        <div
          ref={menuRef}
          className="fixed z-[9999] bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[140px]"
          style={{ top: pos.top, right: pos.right }}
        >
          <button
            onClick={() => pick('claude')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-brand flex-shrink-0" />
            Claude Code
          </button>
          <button
            onClick={() => pick('claude2')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" />
            Claude 2
          </button>
          <button
            onClick={() => pick('codex')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
            OpenAI Codex
          </button>
          <button
            onClick={() => pick('deepseek')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-sky-500 flex-shrink-0" />
            Deepseek
          </button>
          <button
            onClick={() => pick('kimi')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
            Kimi
          </button>
          <button
            onClick={() => pick('ollama')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-violet-500 flex-shrink-0" />
            Ollama
          </button>
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
  onNewTab: () => void;
  onNewClaude2Tab?: () => void;
  onNewCodexTab?: () => void;
  onNewKimiTab?: () => void;
  onNewOllamaTab?: () => void;
  onNewDeepseekTab?: () => void;
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
  onNewTab,
  onNewClaude2Tab,
  onNewCodexTab,
  onNewKimiTab,
  onNewOllamaTab,
  onNewDeepseekTab,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TabBarProps) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center px-2 gap-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <Tooltip key={tab.id} content={tab.title} delay={200} className="flex-1 min-w-16 max-w-32">
            <div
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={() => onDrop(index)}
              onDragEnd={onDragEnd}
              className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer rounded-t-lg transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-secondary'
              } ${dragTabIndex === index ? 'opacity-50' : ''} ${
                dragOverTabIndex === index ? 'border-l-2 border-brand' : ''
              }`}
              onClick={() => onSwitchTab(tab.id)}
            >
              {/* Circle number + status badge (top-right) */}
              <div className="relative flex-shrink-0">
                <TabNumberIcon number={index + 1} isActive={tab.id === activeTabId} />
                {/* Loading pulse dot - top-right */}
                {tab.isLoading && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-9 animate-pulse" />
                )}
                {/* Unread red dot badge - top-right (hidden while loading to avoid overlap) */}
                {!tab.isLoading && unreadTabs.has(tab.id) && tab.id !== activeTabId && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
                )}
                {/* Pin badge - top-right (shown when not overlapping loading/unread) */}
                {onTogglePin && isPinned?.(tab.id) && !tab.isLoading && !(unreadTabs.has(tab.id) && tab.id !== activeTabId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(tab.id);
                    }}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-card text-amber-500 hover:text-destructive transition-colors"
                    title={t('tabBar.unpin')}
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16 4h-2V2h-4v2H8c-.55 0-1 .45-1 1v4l-2 3v2h5.97v7l1 1 1-1v-7H19v-2l-2-3V5c0-.55-.45-1-1-1z" />
                    </svg>
                  </button>
                )}
                {/* Show pin icon on hover when not pinned - top-right */}
                {onTogglePin && !isPinned?.(tab.id) && !tab.isLoading && !(unreadTabs.has(tab.id) && tab.id !== activeTabId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(tab.id);
                    }}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-card text-muted-foreground opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:!text-brand transition-all"
                    title={t('tabBar.pin')}
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path d="M16 4h-2V2h-4v2H8c-.55 0-1 .45-1 1v4l-2 3v2h5.97v7l1 1 1-1v-7H19v-2l-2-3V5c0-.55-.45-1-1-1z" />
                    </svg>
                  </button>
                )}
              </div>
              <span className="flex-1 min-w-0 truncate">{tab.title}</span>
              {tab.engine === 'claude2' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-orange-500/15 text-orange-400 font-medium leading-relaxed">C2</span>
              )}
              {tab.engine === 'codex' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-emerald-500/15 text-emerald-400 font-medium leading-relaxed">CX</span>
              )}
              {tab.engine === 'kimi' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-blue-500/15 text-blue-400 font-medium leading-relaxed">KM</span>
              )}
              {tab.engine === 'ollama' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-violet-500/15 text-violet-400 font-medium leading-relaxed">OL</span>
              )}
              {tab.engine === 'deepseek' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-sky-500/15 text-sky-400 font-medium leading-relaxed">DS</span>
              )}
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="ml-1 p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title={t('tabBar.closeTab')}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </Tooltip>
        ))}
        {/* New tab button with engine picker */}
        <NewTabButton onNewTab={onNewTab} onNewClaude2Tab={onNewClaude2Tab} onNewCodexTab={onNewCodexTab} onNewKimiTab={onNewKimiTab} onNewOllamaTab={onNewOllamaTab} onNewDeepseekTab={onNewDeepseekTab} />
      </div>
    </div>
  );
}
