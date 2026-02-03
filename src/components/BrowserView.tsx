'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';

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
// Number Icon Component
// ============================================================================

interface NumberIconProps {
  number: number;
  size?: number;
}

function NumberIcon({ number, size = 18 }: NumberIconProps) {
  const displayNumber = number > 9 ? '9+' : String(number);
  const fontSize = number > 9 ? size * 0.45 : size * 0.55;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      className="flex-shrink-0"
    >
      <rect
        x="1"
        y="1"
        width="16"
        height="16"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />
      <text
        x="9"
        y="9"
        dominantBaseline="central"
        textAnchor="middle"
        fill="currentColor"
        fontSize={fontSize}
        fontWeight="600"
        fontFamily="system-ui, sans-serif"
      >
        {displayNumber}
      </text>
    </svg>
  );
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

  // If it looks like a URL without protocol, add https://
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    // If it looks like localhost or IP, use http
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
// BrowserView Component
// ============================================================================

export function BrowserView({ cwd, openUrl }: BrowserViewProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openUrlProcessedRef = useRef<string | null>(null); // 记录已处理的 openUrl

  // Get active tab
  const activeTab = tabs.find(t => t.id === activeTabId);

  // ========== Load tabs from server ==========
  useEffect(() => {
    const loadTabs = async () => {
      try {
        const response = await fetch(`/api/browser-tabs?cwd=${encodeURIComponent(cwd)}`);
        if (response.ok) {
          const data = await response.json();
          if (data.tabs && data.tabs.length > 0) {
            setTabs(data.tabs);
            setActiveTabId(data.activeTabId || data.tabs[0].id);
            // Set URL input to active tab's URL
            const active = data.tabs.find((t: BrowserTab) => t.id === (data.activeTabId || data.tabs[0].id));
            if (active) {
              setUrlInput(active.url);
            }
          } else {
            // 没有保存的 tabs，创建默认空白 tab
            const defaultTab: BrowserTab = { id: generateTabId(), url: '' };
            setTabs([defaultTab]);
            setActiveTabId(defaultTab.id);
          }
        } else {
          // API 错误，创建默认空白 tab
          const defaultTab: BrowserTab = { id: generateTabId(), url: '' };
          setTabs([defaultTab]);
          setActiveTabId(defaultTab.id);
        }
      } catch (error) {
        console.error('Failed to load browser tabs:', error);
        // 加载失败，创建默认空白 tab
        const defaultTab: BrowserTab = { id: generateTabId(), url: '' };
        setTabs([defaultTab]);
        setActiveTabId(defaultTab.id);
      } finally {
        setIsInitialized(true);
      }
    };

    loadTabs();
  }, [cwd]);

  // ========== Save tabs to server (debounced) ==========
  const saveTabs = useCallback((newTabs: BrowserTab[], newActiveTabId: string | null) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch('/api/browser-tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, tabs: newTabs, activeTabId: newActiveTabId }),
        });
      } catch (error) {
        console.error('Failed to save browser tabs:', error);
      }
    }, 500);
  }, [cwd]);

  // ========== Handle external openUrl request ==========
  useEffect(() => {
    // 只在初始化完成后且 openUrl 存在且未处理过时才执行
    if (!isInitialized || !openUrl || openUrlProcessedRef.current === openUrl) {
      return;
    }

    // 标记为已处理
    openUrlProcessedRef.current = openUrl;

    // 创建新标签页并打开 URL
    const newTabId = generateTabId();
    const newTab: BrowserTab = { id: newTabId, url: openUrl };
    const newTabs = [...tabs, newTab];

    setTabs(newTabs);
    setActiveTabId(newTabId);
    setUrlInput(openUrl);

    // 保存到服务器
    saveTabs(newTabs, newTabId);
  }, [isInitialized, openUrl, tabs, saveTabs]);

  // ========== Tab Management ==========
  const addTab = useCallback(() => {
    const newTab: BrowserTab = {
      id: generateTabId(),
      url: '',
    };
    const newTabs = [...tabs, newTab];
    setTabs(newTabs);
    setActiveTabId(newTab.id);
    setUrlInput('');
    setLoadError(null);
    saveTabs(newTabs, newTab.id);
  }, [tabs, saveTabs]);

  const closeTab = useCallback((tabId: string) => {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    const newTabs = tabs.filter(t => t.id !== tabId);

    if (newTabs.length === 0) {
      // Keep at least one tab
      const newTab: BrowserTab = { id: generateTabId(), url: '' };
      setTabs([newTab]);
      setActiveTabId(newTab.id);
      setUrlInput('');
      setLoadError(null);
      saveTabs([newTab], newTab.id);
      return;
    }

    let newActiveId = activeTabId;
    if (tabId === activeTabId) {
      // Switch to adjacent tab
      const newIndex = Math.min(tabIndex, newTabs.length - 1);
      newActiveId = newTabs[newIndex].id;
      setActiveTabId(newActiveId);
      setUrlInput(newTabs[newIndex].url);
      setLoadError(null);
    }

    setTabs(newTabs);
    saveTabs(newTabs, newActiveId);
  }, [tabs, activeTabId, saveTabs]);

  const selectTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      setActiveTabId(tabId);
      setUrlInput(tab.url);
      setLoadError(null);
      saveTabs(tabs, tabId);
    }
  }, [tabs, saveTabs]);

  // ========== Navigation ==========
  const navigate = useCallback((url: string) => {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl || !activeTabId) return;

    setIsLoading(true);
    setLoadError(null);

    const newTabs = tabs.map(t =>
      t.id === activeTabId ? { ...t, url: normalizedUrl } : t
    );
    setTabs(newTabs);
    setUrlInput(normalizedUrl);
    saveTabs(newTabs, activeTabId);
  }, [activeTabId, tabs, saveTabs]);

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    navigate(urlInput);
  }, [urlInput, navigate]);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && activeTab?.url) {
      setIsLoading(true);
      setLoadError(null);
      // Force reload by resetting src
      const currentSrc = iframeRef.current.src;
      iframeRef.current.src = '';
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = currentSrc;
        }
      }, 0);
    }
  }, [activeTab?.url]);

  // ========== iframe Events ==========
  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setLoadError('页面加载失败，可能是网站禁止嵌入或网络错误');
  }, []);

  
  // ========== Render ==========
  if (!isInitialized) {
    return (
      <div className="h-full flex items-center justify-center bg-card">
        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card">
      {/* Tab Bar */}
      <div className="flex items-center border-b border-border bg-secondary px-2 py-1 gap-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1.5 px-2 py-1 text-sm cursor-pointer rounded transition-colors ${
              tab.id === activeTabId
                ? 'bg-card text-brand'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
            onClick={() => selectTab(tab.id)}
          >
            <NumberIcon number={index + 1} size={16} />
            <span className="max-w-32 truncate">
              {tab.url ? getHostFromUrl(tab.url) : '新标签页'}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
              title="关闭标签"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
        {/* Add Tab Button */}
        <button
          onClick={addTab}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors flex-shrink-0"
          title="新建标签"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Navigation Bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
        {/* Refresh Button */}
        <button
          onClick={handleRefresh}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          title="刷新"
          disabled={!activeTab?.url}
        >
          <svg className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        {/* URL Input */}
        <form onSubmit={handleUrlSubmit} className="flex-1">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="输入网址..."
            className="w-full px-3 py-1.5 text-sm border border-border rounded bg-secondary text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </form>

        {/* Open in New Window */}
        <button
          onClick={() => activeTab?.url && window.open(activeTab.url, '_blank')}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          title="在新窗口打开"
          disabled={!activeTab?.url}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 relative overflow-hidden bg-white dark:bg-slate-900">
        {!activeTab?.url ? (
          // Empty State
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <svg className="w-16 h-16 mb-4 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <p className="text-sm">输入网址开始浏览</p>
          </div>
        ) : loadError ? (
          // Error State
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
            <svg className="w-16 h-16 mb-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm text-center">{loadError}</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleRefresh}
                className="px-4 py-2 text-sm bg-secondary text-foreground rounded hover:bg-accent transition-colors"
              >
                重试
              </button>
              <button
                onClick={() => activeTab?.url && window.open(activeTab.url, '_blank')}
                className="px-4 py-2 text-sm bg-brand text-white rounded hover:bg-brand/90 transition-colors"
              >
                在新窗口打开
              </button>
            </div>
          </div>
        ) : (
          // iframe
          <>
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-slate-900/80 z-10">
                <span className="inline-block w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={activeTab.url}
              className="w-full h-full border-0"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              title="Browser Content"
            />
                      </>
        )}
      </div>
    </div>
  );
}
