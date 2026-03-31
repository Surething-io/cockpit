'use client';

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

import { TabInfo } from './useTabState';
import { Tooltip } from '../shared/Tooltip';
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

function NewTabButton({ onNewTab, onNewCodexTab, onNewKimiTab, onNewOllamaTab }: { onNewTab: () => void; onNewCodexTab?: () => void; onNewKimiTab?: () => void; onNewOllamaTab?: () => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

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
      // Position: below button, right-aligned (opens to the left)
      setPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setOpen(v => !v);
  };

  const pick = (engine: 'claude' | 'codex' | 'kimi' | 'ollama') => {
    setOpen(false);
    if (engine === 'codex') onNewCodexTab?.();
    else if (engine === 'kimi') onNewKimiTab?.();
    else if (engine === 'ollama') onNewOllamaTab?.();
    else onNewTab();
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
        title="New tab"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
      {open && createPortal(
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
            onClick={() => pick('codex')}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-brand/10 transition-colors whitespace-nowrap"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
            OpenAI Codex
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
        </div>,
        document.body
      )}
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
  onNewCodexTab?: () => void;
  onNewKimiTab?: () => void;
  onNewOllamaTab?: () => void;
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
  onNewCodexTab,
  onNewKimiTab,
  onNewOllamaTab,
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
          <Tooltip key={tab.id} content={tab.title} delay={200}>
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
              <span className="max-w-32 truncate">{tab.title}</span>
              {tab.engine === 'codex' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-emerald-500/15 text-emerald-400 font-medium leading-relaxed">CX</span>
              )}
              {tab.engine === 'kimi' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-blue-500/15 text-blue-400 font-medium leading-relaxed">KM</span>
              )}
              {tab.engine === 'ollama' && (
                <span className="flex-shrink-0 text-[9px] px-1 py-0 rounded bg-violet-500/15 text-violet-400 font-medium leading-relaxed">OL</span>
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
        <NewTabButton onNewTab={onNewTab} onNewCodexTab={onNewCodexTab} onNewKimiTab={onNewKimiTab} onNewOllamaTab={onNewOllamaTab} />
      </div>
    </div>
  );
}
