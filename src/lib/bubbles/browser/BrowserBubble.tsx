'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from '@/components/shared/Toast';
import { BUBBLE_CONTENT_HEIGHT } from '@/components/project/console/CommandBubble';
import { useBrowserBridge } from '@/hooks/useBrowserBridge';
import { ShortIdBadge } from '@/components/project/console/ShortIdBadge';
import { modKey } from '@/lib/platform';

// ============================================================================
// Utility Functions
// ============================================================================

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

function getHostFromUrl(url: string): string {
  if (!url) return '';
  try {
    const urlObj = new URL(url);
    return urlObj.port ? `${urlObj.hostname}:${urlObj.port}` : urlObj.hostname;
  } catch {
    return url;
  }
}

/** Append _cockpit=1 param to the URL so background webNavigation can track it and the DNR network layer can strip it */
function addCockpitParam(url: string): string {
  if (!url) return url;
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.set('_cockpit', '1');
    return urlObj.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_cockpit=1`;
  }
}

/** Remove the _cockpit param from a URL (for display purposes) */
function stripCockpitParam(url: string): string {
  if (!url) return url;
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.delete('_cockpit');
    return urlObj.toString();
  } catch {
    return url.replace(/[?&]_cockpit=1/, '');
  }
}

import { getCockpitBridge } from '@/hooks/useCockpitBridge';

/**
 * Get the Chrome extension ID (read from window.__cockpitBridge broadcast by the content script).
 */
function getExtensionId(): string | null {
  return getCockpitBridge()?.id ?? null;
}

/**
 * Call the extension background directly via externally_connectable
 * to pre-create the cookie injection rule. Returns true on success.
 *
 * Flow: BrowserBubble → chrome.runtime.sendMessage(extId) → background
 * No content script relay, no postMessage — 100% reliable.
 */
async function prepareCookies(url: string): Promise<boolean> {
  const extId = getExtensionId();
  if (!extId) return false; // Extension not installed

  return new Promise((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chromeRuntime = (globalThis as any).chrome?.runtime;
      if (!chromeRuntime?.sendMessage) { resolve(false); return; }

      const timer = setTimeout(() => resolve(false), 2000); // 2s timeout fallback
      chromeRuntime.sendMessage(extId, { type: 'prepare-iframe', url }, (response: { ok?: boolean } | undefined) => {
        clearTimeout(timer);
        resolve(response?.ok ?? false);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Check if the URL is localhost (no cookie pre-injection needed) */
function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1';
  } catch { return false; }
}

// ============================================================================
// BrowserBubble — single webpage bubble card (used in ConsoleView)
// ============================================================================

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
/** Maximized toolbar height */
const TOOLBAR_HEIGHT = 41;

interface BrowserBubbleProps {
  url: string;
  id: string;
  selected: boolean;
  maximized: boolean;
  /** Content area height when maximized (passed in from ConsoleView's scrollRef.clientHeight) */
  expandedHeight?: number;
  /** Content height when not maximized (50% layout, computed by ConsoleView) */
  bubbleContentHeight?: number;
  onSelect: () => void;
  onClose: () => void;
  onToggleMaximize: () => void;
  onNewTab?: (url: string, afterId: string) => void;
  timestamp?: string;
  onTitleMouseDown?: () => void;
  initialSleeping?: boolean;
  onSleep?: (id: string) => void;
  onWake?: (id: string) => void;
}

export function BrowserBubble({
  url,
  id,
  selected,
  maximized,
  expandedHeight,
  bubbleContentHeight,
  onSelect,
  onClose,
  onToggleMaximize,
  onNewTab,
  timestamp,
  onTitleMouseDown,
  initialSleeping,
  onSleep,
  onWake,
}: BrowserBubbleProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [readyUrl, setReadyUrl] = useState<string | null>(null); // iframe src after cookies are ready
  const [isSleeping, setIsSleeping] = useState(initialSleeping ?? false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Sync external url prop changes
  useEffect(() => { setCurrentUrl(url); }, [url]);

  // ========== Idle sleep ==========
  const isVisibleRef = useRef(true); // Driven by IntersectionObserver

  const goToSleep = useCallback(() => {
    if (isSleeping) return;
    setIsSleeping(true);
    setReadyUrl(null); // Unmount the iframe
    onSleep?.(id);
  }, [isSleeping, id, onSleep]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  // Browser automation bridge (CLI → WS → postMessage → content script)
  // WS connects on demand: connect when clicking the shortId badge, disconnect on sleep
  const iframeReady = !!readyUrl && !isSleeping && !isLoading;
  const { shortId, connected: bridgeConnected, connect: bridgeConnect, disconnect: bridgeDisconnect } = useBrowserBridge(id, iframeRef, iframeReady);

  // bridgeConnectedRef: lets IntersectionObserver callbacks read the latest value
  const bridgeConnectedRef = useRef(bridgeConnected);
  bridgeConnectedRef.current = bridgeConnected;

  // IntersectionObserver: detect whether the bubble is in the viewport
  // Don't start the sleep countdown when bridge is connected
  useEffect(() => {
    const el = iframeWrapperRef.current;
    if (!el || isSleeping) return;
    const observer = new IntersectionObserver(([entry]) => {
      isVisibleRef.current = entry.isIntersecting;
      if (entry.isIntersecting || bridgeConnectedRef.current) {
        // Entered viewport or bridge is connected → cancel countdown
        clearIdleTimer();
      } else {
        // Left viewport and not connected → start countdown
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(goToSleep, IDLE_TIMEOUT);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isSleeping, goToSleep, clearIdleTimer]);

  // Adjust sleep strategy when bridge connection state changes
  useEffect(() => {
    if (isSleeping) {
      // Disconnect bridge WS when sleeping
      bridgeDisconnect();
      return;
    }
    if (bridgeConnected) {
      // Connected → cancel sleep countdown
      clearIdleTimer();
    } else if (!isVisibleRef.current) {
      // Disconnected and not visible → start countdown
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(goToSleep, IDLE_TIMEOUT);
    }
  }, [bridgeConnected, isSleeping, bridgeDisconnect, clearIdleTimer, goToSleep]);

  // If initialSleeping, don't load the iframe
  useEffect(() => {
    if (initialSleeping) {
      setReadyUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wake up
  const doWake = useCallback(() => {
    setIsSleeping(false);
    onWake?.(id);
    // Reload the iframe
    const cockpitUrl = addCockpitParam(url);
    if (isLocalUrl(url)) {
      setReadyUrl(cockpitUrl);
    } else {
      prepareCookies(url).then(() => setReadyUrl(cockpitUrl));
    }
  }, [url, id, onWake]);

  // Cookie pre-injection: connect directly to background via externally_connectable, then set iframe src after awaiting
  useEffect(() => {
    if (!url || isSleeping) { if (!url) setReadyUrl(null); return; }

    const cockpitUrl = addCockpitParam(url);

    // localhost doesn't need cookie pre-injection
    if (isLocalUrl(url)) {
      setReadyUrl(cockpitUrl);
      return;
    }

    let cancelled = false;
    prepareCookies(url).then(() => {
      if (!cancelled) setReadyUrl(cockpitUrl);
    });

    return () => { cancelled = true; };
  }, [url, isSleeping]);

  const handleIframeLoad = useCallback(() => setIsLoading(false), []);

  // Prevent iframe interactions from scrolling the parent scroll container.
  // Two sources: (1) cross-origin iframe wheel scroll chaining (compositor-layer propagation)
  //              (2) clicking iframe → browser focus auto-scroll-into-view (programmatic scrollTop change)
  // overflow:hidden only blocks (1); (2) requires a scroll event listener + scrollTop restoration
  useEffect(() => {
    const wrapper = iframeWrapperRef.current;
    if (!wrapper) return;

    let scrollParent: HTMLElement | null = null;
    let el = wrapper.parentElement;
    while (el) {
      const { overflowY } = getComputedStyle(el);
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scrollParent = el;
        break;
      }
      el = el.parentElement;
    }
    if (!scrollParent) return;

    let savedOverflow = '';
    let lockedScrollTop = 0;
    let locked = false;

    const onScroll = () => {
      if (locked && scrollParent) {
        scrollParent.scrollTop = lockedScrollTop;
      }
    };

    const onEnter = () => {
      savedOverflow = scrollParent!.style.overflow;
      lockedScrollTop = scrollParent!.scrollTop;
      locked = true;
      scrollParent!.style.overflow = 'hidden';
      scrollParent!.addEventListener('scroll', onScroll);
    };
    const onLeave = () => {
      locked = false;
      scrollParent!.removeEventListener('scroll', onScroll);
      scrollParent!.style.overflow = savedOverflow;
    };

    wrapper.addEventListener('mouseenter', onEnter);
    wrapper.addEventListener('mouseleave', onLeave);
    return () => {
      wrapper.removeEventListener('mouseenter', onEnter);
      wrapper.removeEventListener('mouseleave', onLeave);
      scrollParent!.removeEventListener('scroll', onScroll);
      if (locked) scrollParent!.style.overflow = savedOverflow;
    };
  }, []);

  // Listen for Chrome extension postMessage (link interception & navigation notifications)
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data.type !== 'string') return;
      if (!e.data.type.startsWith('cockpit:')) return;

      // Match message source: event.source is the iframe contentWindow that sent the message
      const iframe = iframeWrapperRef.current?.querySelector('iframe');
      if (!iframe || e.source !== iframe.contentWindow) return;

      const type = e.data.type as string;

      if (type === 'cockpit:new-tab' && e.data.url) {
        onNewTab?.(stripCockpitParam(e.data.url), id);
      } else if ((type === 'cockpit:navigate' || type === 'cockpit:loaded') && e.data.url) {
        setCurrentUrl(stripCockpitParam(e.data.url));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [id, onNewTab]);
  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setLoadError('页面加载失败');
  }, []);

  // Refresh: wake from sleep, otherwise reset iframe src
  const doRefresh = useCallback(() => {
    if (isSleeping) {
      doWake();
      return;
    }
    const iframe = iframeWrapperRef.current?.querySelector('iframe');
    if (iframe && readyUrl) {
      setIsLoading(true);
      setLoadError(null);
      const src = iframe.src;
      iframe.src = '';
      setTimeout(() => { iframe.src = src; }, 0);
    }
  }, [isSleeping, doWake, readyUrl]);

  // Reset loading state when URL changes
  useEffect(() => {
    if (url && !isSleeping) {
      setIsLoading(true);
      setLoadError(null);
    }
  }, [url, isSleeping]);

  // Open in a new window
  const handleOpenExternal = useCallback(() => {
    if (currentUrl) window.open(currentUrl, '_blank');
  }, [currentUrl]);

  // ESC to exit maximize / Cmd+M to toggle maximize
  useEffect(() => {
    if (!selected && !maximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && maximized) {
        e.stopPropagation();
        onToggleMaximize();
      }
      if (e.key === 'm' && (e.metaKey || e.ctrlKey) && selected) {
        e.preventDefault();
        e.stopPropagation();
        onToggleMaximize();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [maximized, selected, onToggleMaximize]);

  const host = getHostFromUrl(currentUrl);

  // Content height when maximized (minus toolbar)
  const contentHeight = maximized && expandedHeight
    ? expandedHeight - TOOLBAR_HEIGHT
    : (bubbleContentHeight ?? BUBBLE_CONTENT_HEIGHT);

  return (
    <div className="flex flex-col items-start">
      <div
        className={`w-full bg-accent text-foreground
          relative transition-colors cursor-pointer
          ${maximized ? 'rounded-none overflow-visible border-0' : 'border overflow-hidden rounded-2xl rounded-bl-md rounded-br-md'}
          ${maximized ? '' : selected ? 'border-brand' : 'border-brand/30'}`}
        onClick={maximized ? undefined : onSelect}
      >
        {/* ---- Title bar (compact when maximized, full when normal) ---- */}
        {maximized ? (
          <div
            onDoubleClick={onToggleMaximize}
            className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card"
            style={{ height: TOOLBAR_HEIGHT }}
          >
            <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </span>
            {shortId && (
              <ShortIdBadge
                shortId={shortId}
                type="browser"
                onRegister={() => bridgeConnect()}
                onUnregister={async () => {
                  bridgeDisconnect();
                  await fetch('/api/browser/unregister', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: shortId }),
                  }).catch(() => {});
                }}
              />
            )}
            <span className="text-xs text-muted-foreground truncate font-mono">
              {currentUrl || '空白页'}
            </span>
            {/* Copy URL */}
            {currentUrl && (
              <button
                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(currentUrl); toast('已复制网址'); }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="复制网址"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            <span className="flex-1" />
            {isLoading && (
              <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            <button
              onClick={doRefresh}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="刷新"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={handleOpenExternal}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="在新窗口打开"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            <button
              onClick={onToggleMaximize}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title={`退出最大化 (${modKey()}M)`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            </button>
          </div>
        ) : (
          <div
            data-drag-handle
            onMouseDown={() => onTitleMouseDown?.()}
            onDoubleClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
            className={`flex items-center gap-2 px-4 py-1.5 border-b text-xs transition-colors cursor-grab active:cursor-grabbing
              ${selected ? 'border-brand' : 'border-brand/30'}`}
          >
            <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">
              <svg className="w-3 h-3 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </span>
            {shortId && (
              <ShortIdBadge
                shortId={shortId}
                type="browser"
                onRegister={() => bridgeConnect()}
                onUnregister={async () => {
                  bridgeDisconnect();
                  await fetch('/api/browser/unregister', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: shortId }),
                  }).catch(() => {});
                }}
              />
            )}
            <span className="font-mono text-foreground truncate">
              {currentUrl || '空白页'}
            </span>
            {/* Copy URL */}
            {currentUrl && (
              <button
                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(currentUrl); toast('已复制网址'); }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="复制网址"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            <span className="flex-1" />
            {isLoading && (
              <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
            )}
            {/* Open in new window */}
            <button
              onClick={(e) => { e.stopPropagation(); handleOpenExternal(); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="在新窗口打开"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            {/* Refresh */}
            <button
              onClick={(e) => { e.stopPropagation(); doRefresh(); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="刷新"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {/* Close */}
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

        {/* ---- Content area (iframe or sleep placeholder) ---- */}
        <div ref={iframeWrapperRef} className="w-full" style={{ height: contentHeight }}>
          {isSleeping ? (
            /* Sleeping: show URL placeholder */
            <div
              className="relative overflow-hidden cursor-pointer group h-full"
              onClick={(e) => { e.stopPropagation(); doRefresh(); }}
            >
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/30">
                <svg className="w-10 h-10 mb-2 text-muted-foreground/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <p className="text-xs text-muted-foreground/60">{host}</p>
              </div>
              {/* Hover-to-refresh hint */}
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 text-white text-xs">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  点击唤醒
                </div>
              </div>
            </div>
          ) : url ? (
            loadError ? (
              <div className="flex flex-col items-center justify-center text-muted-foreground p-6 h-full">
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
              <div className="relative overflow-hidden h-full" style={{ contain: 'strict' }}>
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-slate-900/80 z-10">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {!readyUrl ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <iframe
                    ref={iframeRef}
                    src={readyUrl}
                    className="border-0"
                    allow="clipboard-write; clipboard-read"
                    style={maximized
                      ? { width: '100%', height: '100%' }
                      : { position: 'absolute', top: 0, left: 0, width: '200%', height: '200%', transform: 'scale(0.5)', transformOrigin: 'top left' }
                    }
                    onLoad={handleIframeLoad}
                    onError={handleIframeError}
                    title={`Browser: ${host}`}
                    data-browser-id={id}
                  />
                )}
              </div>
            )
          ) : (
            <div className="flex flex-col items-center justify-center text-muted-foreground h-full">
              <svg className="w-10 h-10 mb-2 text-slate-300 dark:text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
              <p className="text-xs">空白页</p>
            </div>
          )}
        </div>

        {/* ---- Bottom status bar (shown only when not maximized) ---- */}
        {!maximized && url && (
          <div className="border-t border-border px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${isSleeping ? 'bg-yellow-500' : isLoading ? 'bg-brand animate-pulse' : loadError ? 'bg-red-500' : 'bg-green-500'}`} />
            <span className="truncate">{isSleeping ? '已休眠' : isLoading ? '加载中...' : loadError ? '加载失败' : host}</span>
            <span className="flex-1" />
            {timestamp && <span className="text-[11px] flex-shrink-0">{formatTime(timestamp)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
