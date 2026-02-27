'use client';

import React, { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { toast } from '../shared/Toast';
import { BUBBLE_CONTENT_HEIGHT } from './terminal/TerminalBubble';

// ============================================================================
// Types
// ============================================================================

interface BrowserTab {
  id: string;
  url: string;
}

interface BrowserViewProps {
  cwd: string;
  openUrl?: string; // 外部传入的 URL，用于打开新标签
}

// ============================================================================
// Utility Functions
// ============================================================================

function getHostFromUrl(url: string): string {
  if (!url) return '';
  try {
    const urlObj = new URL(url);
    return urlObj.port ? `${urlObj.hostname}:${urlObj.port}` : urlObj.hostname;
  } catch {
    return url;
  }
}

function normalizeUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed) return '';

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    if (trimmed.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(trimmed)) {
      return `http://${trimmed}`;
    }
    return `https://${trimmed}`;
  }
  return trimmed;
}

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// BrowserBubble — 单个网页气泡卡片
// ============================================================================

interface BrowserBubbleProps {
  tab: BrowserTab;
  selected: boolean;
  maximized: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onOpenExternal: () => void;
  onToggleMaximize: () => void;
  portalContainer: HTMLDivElement | null;
  compact?: boolean;
}

function BrowserBubble({
  tab,
  selected,
  maximized,
  onSelect,
  onClose,
  onRefresh,
  onOpenExternal,
  onToggleMaximize,
  portalContainer,
  compact,
}: BrowserBubbleProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const bubbleSlotRef = useRef<HTMLDivElement>(null);
  const fullscreenSlotRef = useRef<HTMLDivElement>(null);

  const handleIframeLoad = useCallback(() => setIsLoading(false), []);
  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setLoadError('页面加载失败');
  }, []);

  // 刷新：重置 iframe src
  const doRefresh = useCallback(() => {
    const iframe = iframeWrapperRef.current?.querySelector('iframe');
    if (iframe && tab.url) {
      setIsLoading(true);
      setLoadError(null);
      const src = iframe.src;
      iframe.src = '';
      setTimeout(() => { iframe.src = src; }, 0);
    }
  }, [tab.url]);

  // 外部调用 refresh
  useEffect(() => {
    // expose refresh via ref-like pattern - not needed, doRefresh called via onRefresh
  }, []);

  // URL 变化时重置加载状态
  useEffect(() => {
    if (tab.url) {
      setIsLoading(true);
      setLoadError(null);
    }
  }, [tab.url]);

  // ========== 最大化：DOM 节点移动（对标 PTY）==========
  useLayoutEffect(() => {
    const wrapper = iframeWrapperRef.current;
    if (!wrapper) return;

    if (maximized && fullscreenSlotRef.current) {
      fullscreenSlotRef.current.appendChild(wrapper);
      return () => {
        if (bubbleSlotRef.current && wrapper.parentElement) {
          bubbleSlotRef.current.appendChild(wrapper);
        }
      };
    }
  }, [maximized]);

  // ESC 退出最大化
  useEffect(() => {
    if (!maximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onToggleMaximize();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [maximized, onToggleMaximize]);

  const host = getHostFromUrl(tab.url);

  // ========== 最大化 overlay（通过 portal 渲染到父容器）==========
  const fullscreenOverlay = maximized && portalContainer
    ? createPortal(
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--card)',
          }}
        >
          {/* 最大化顶栏 */}
          <div
            className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card"
            style={{ height: 41, flexShrink: 0 }}
          >
            {/* 地球图标 */}
            <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </span>
            <span className="flex-1 text-xs text-muted-foreground truncate font-mono">
              {tab.url || '空白页'}
            </span>
            {isLoading && (
              <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {/* 刷新 */}
            <button
              onClick={doRefresh}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="刷新"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {/* 新窗口打开 */}
            <button
              onClick={onOpenExternal}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="在新窗口打开"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            {/* 关闭最大化 */}
            <button
              onClick={onToggleMaximize}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="退出最大化"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* iframe 内容区 */}
          <div ref={fullscreenSlotRef} style={{ flex: 1, overflow: 'hidden' }} />
        </div>,
        portalContainer,
      )
    : null;

  return (
    <div className="flex flex-col items-start">
      <div
        className={`w-full bg-accent text-foreground rounded-2xl rounded-bl-md rounded-br-md
          relative overflow-hidden border transition-colors cursor-pointer
          ${selected ? 'border-brand' : 'border-brand/30'}`}
        onClick={onSelect}
      >
        {/* ---- 标题栏 ---- */}
        {!maximized && (
          <div
            className={`flex items-center gap-2 px-4 py-1.5 border-b text-xs transition-colors
              ${selected ? 'border-brand' : 'border-brand/30'}`}
          >
            {/* 地球图标 */}
            <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">
              <svg className="w-3 h-3 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </span>
            <span className="font-mono text-foreground truncate">
              {host || '空白页'}
            </span>
            <span className="flex-1" />
            {isLoading && (
              <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {/* 复制网址 */}
            <button
              onClick={(e) => { e.stopPropagation(); if (tab.url) { navigator.clipboard.writeText(tab.url); toast('已复制网址'); } }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="复制网址"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            {/* 刷新 */}
            <button
              onClick={(e) => { e.stopPropagation(); doRefresh(); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="刷新"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {/* 最大化 */}
            <button
              onClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="最大化"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
            {/* 新窗口打开 */}
            <button
              onClick={(e) => { e.stopPropagation(); onOpenExternal(); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="在新窗口打开"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            {/* 关闭 */}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="p-0.5 rounded text-destructive hover:text-destructive/80 transition-colors flex-shrink-0"
              title="关闭"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* ---- 内容区（iframe）---- */}
        <div ref={bubbleSlotRef}>
          <div ref={iframeWrapperRef} className="w-full" style={{ height: maximized ? '100%' : undefined }}>
            {tab.url ? (
              loadError ? (
                <div className="flex flex-col items-center justify-center text-muted-foreground p-6" style={{ height: maximized ? '100%' : BUBBLE_CONTENT_HEIGHT }}>
                  <svg className="w-10 h-10 mb-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <p className="text-xs">{loadError}</p>
                  <button
                    onClick={(e) => { e.stopPropagation(); doRefresh(); }}
                    className="mt-2 px-3 py-1 text-xs bg-secondary text-foreground rounded hover:bg-accent transition-colors"
                  >
                    重试
                  </button>
                </div>
              ) : (
                <div className="relative" style={{ height: maximized ? '100%' : BUBBLE_CONTENT_HEIGHT }}>
                  {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-slate-900/80 z-10">
                      <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  <iframe
                    src={tab.url}
                    className="w-full h-full border-0"
                    onLoad={handleIframeLoad}
                    onError={handleIframeError}
                    sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
                    title={`Browser: ${host}`}
                  />
                </div>
              )
            ) : (
              <div className="flex flex-col items-center justify-center text-muted-foreground" style={{ height: 120 }}>
                <svg className="w-10 h-10 mb-2 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <p className="text-xs">空白页</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 最大化 overlay */}
      {fullscreenOverlay}
    </div>
  );
}

// ============================================================================
// BrowserView — 主容器
// ============================================================================

export function BrowserView({ cwd, openUrl }: BrowserViewProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [maximizedTabId, setMaximizedTabId] = useState<string | null>(null);
  const [gridLayout, setGridLayout] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openUrlProcessedRef = useRef<string | null>(null);

  // ========== Load tabs from server ==========
  useEffect(() => {
    const loadTabs = async () => {
      try {
        const response = await fetch(`/api/browser-tabs?cwd=${encodeURIComponent(cwd)}`);
        if (response.ok) {
          const data = await response.json();
          if (data.tabs && data.tabs.length > 0) {
            setTabs(data.tabs);
            setSelectedTabId(data.activeTabId || data.tabs[0].id);
          }
        }
      } catch (error) {
        console.error('Failed to load browser tabs:', error);
      } finally {
        setIsInitialized(true);
      }
    };
    loadTabs();
  }, [cwd]);

  // ========== Save tabs (debounced) ==========
  const saveTabs = useCallback((newTabs: BrowserTab[], activeId: string | null) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch('/api/browser-tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, tabs: newTabs, activeTabId: activeId }),
        });
      } catch (error) {
        console.error('Failed to save browser tabs:', error);
      }
    }, 500);
  }, [cwd]);

  // ========== Handle external openUrl ==========
  useEffect(() => {
    if (!isInitialized || !openUrl || openUrlProcessedRef.current === openUrl) return;
    openUrlProcessedRef.current = openUrl;

    const newTabId = generateTabId();
    const newTab: BrowserTab = { id: newTabId, url: openUrl };
    const newTabs = [...tabs, newTab];

    setTabs(newTabs);
    setSelectedTabId(newTabId);
    setUrlInput('');
    saveTabs(newTabs, newTabId);

    // 滚动到底部
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [isInitialized, openUrl, tabs, saveTabs]);

  // ========== Tab Management ==========
  const addTab = useCallback((url: string) => {
    const normalizedUrl = normalizeUrl(url);
    const newTab: BrowserTab = { id: generateTabId(), url: normalizedUrl };
    const newTabs = [...tabs, newTab];
    setTabs(newTabs);
    setSelectedTabId(newTab.id);
    saveTabs(newTabs, newTab.id);

    // 滚动到底部
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, [tabs, saveTabs]);

  const closeTab = useCallback((tabId: string) => {
    const newTabs = tabs.filter(t => t.id !== tabId);
    setTabs(newTabs);

    if (tabId === maximizedTabId) setMaximizedTabId(null);

    if (tabId === selectedTabId) {
      const idx = tabs.findIndex(t => t.id === tabId);
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newSelectedId = newTabs[newIdx]?.id ?? null;
      setSelectedTabId(newSelectedId);
      saveTabs(newTabs, newSelectedId);
    } else {
      saveTabs(newTabs, selectedTabId);
    }
  }, [tabs, selectedTabId, maximizedTabId, saveTabs]);

  // ========== URL submit ==========
  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    addTab(trimmed);
    setUrlInput('');
  }, [urlInput, addTab]);

  // ========== Render ==========
  if (!isInitialized) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-background relative">
      {/* ===== 滚动卡片区 ===== */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 px-4">
        {tabs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <svg className="w-16 h-16 mb-4 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <p className="text-sm">输入网址开始浏览</p>
          </div>
        ) : (
          <div className={gridLayout ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
            {tabs.map((tab) => (
              <BrowserBubble
                key={tab.id}
                tab={tab}
                selected={tab.id === selectedTabId}
                maximized={tab.id === maximizedTabId}
                onSelect={() => setSelectedTabId(tab.id)}
                onClose={() => closeTab(tab.id)}
                onRefresh={() => {/* refresh handled inside bubble */}}
                onOpenExternal={() => tab.url && window.open(tab.url, '_blank')}
                onToggleMaximize={() => setMaximizedTabId(prev => prev === tab.id ? null : tab.id)}
                portalContainer={rootRef.current}
                compact={gridLayout}
              />
            ))}
          </div>
        )}
      </div>

      {/* ===== 底部操作栏 ===== */}
      <div className="border-t border-border p-4">
        <form onSubmit={handleUrlSubmit} className="relative flex gap-2 items-center">
          {/* 清空所有 */}
          {tabs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTabs([]);
                setSelectedTabId(null);
                setMaximizedTabId(null);
                saveTabs([], null);
              }}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
              title="清空全部"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}

          {/* 双栏/单栏切换 */}
          <button
            type="button"
            onClick={() => setGridLayout(prev => !prev)}
            className={`p-2 rounded-lg transition-all ${
              gridLayout
                ? 'text-brand bg-brand/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'
            }`}
            title={gridLayout ? '切换为单栏' : '切换为双栏'}
          >
            {gridLayout ? (
              /* 双栏图标 */
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h7v12H4zM13 6h7v12h-7z" />
              </svg>
            ) : (
              /* 单栏图标 */
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16v12H4z" />
              </svg>
            )}
          </button>

          {/* URL 输入框 */}
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="输入网址，回车打开..."
            className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />

        </form>
      </div>
    </div>
  );
}
