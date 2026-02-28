'use client';

import React, { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { toast } from '../../shared/Toast';
import { BUBBLE_CONTENT_HEIGHT } from './CommandBubble';

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

/** 给 URL 追加 _cockpit=1 参数，让 background 的 webNavigation 追踪 + DNR 网络层剥离 */
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

/** 从 URL 中移除 _cockpit 参数（用于显示） */
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

/**
 * 通过 externally_connectable 直接调用插件 background，
 * 预创建 Cookie 注入规则。返回 true 表示成功。
 *
 * 流程：BrowserBubble → chrome.runtime.sendMessage(extId) → background
 * 无 content script 中转，无 postMessage，100% 可靠。
 */
async function prepareCookies(url: string): Promise<boolean> {
  const bridge = (window as Record<string, unknown>).__cockpitBridge as { id?: string } | undefined;
  const extId = bridge?.id;
  if (!extId) return false; // 插件未安装

  return new Promise((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chromeRuntime = (globalThis as any).chrome?.runtime;
      if (!chromeRuntime?.sendMessage) { resolve(false); return; }

      const timer = setTimeout(() => resolve(false), 2000); // 2s 超时兜底
      chromeRuntime.sendMessage(extId, { type: 'prepare-iframe', url }, (response: { ok?: boolean } | undefined) => {
        clearTimeout(timer);
        resolve(response?.ok ?? false);
      });
    } catch {
      resolve(false);
    }
  });
}

/** 判断 URL 是否为 localhost（不需要 Cookie 预注入） */
function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1';
  } catch { return false; }
}

// ============================================================================
// BrowserBubble — 单个网页气泡卡片（用于 ConsoleView）
// ============================================================================

interface BrowserBubbleProps {
  url: string;
  id: string;
  selected: boolean;
  maximized: boolean;
  onSelect: () => void;
  onClose: () => void;
  onToggleMaximize: () => void;
  onNewTab?: (url: string) => void;
  portalContainer: HTMLDivElement | null;
  timestamp?: string;
  onTitleMouseDown?: () => void;
}

export function BrowserBubble({
  url,
  id,
  selected,
  maximized,
  onSelect,
  onClose,
  onToggleMaximize,
  onNewTab,
  portalContainer,
  timestamp,
  onTitleMouseDown,
}: BrowserBubbleProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [readyUrl, setReadyUrl] = useState<string | null>(null); // Cookie 就绪后的 iframe src
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const bubbleSlotRef = useRef<HTMLDivElement>(null);
  const fullscreenSlotRef = useRef<HTMLDivElement>(null);

  // 同步外部 url prop 变化
  useEffect(() => { setCurrentUrl(url); }, [url]);

  // Cookie 预注入：通过 externally_connectable 直连 background，await 返回后再设置 iframe src
  useEffect(() => {
    if (!url) { setReadyUrl(null); return; }

    const cockpitUrl = addCockpitParam(url);

    // localhost 不需要 Cookie 预注入
    if (isLocalUrl(url)) {
      setReadyUrl(cockpitUrl);
      return;
    }

    let cancelled = false;
    prepareCookies(url).then(() => {
      if (!cancelled) setReadyUrl(cockpitUrl);
    });

    return () => { cancelled = true; };
  }, [url]);

  const handleIframeLoad = useCallback(() => setIsLoading(false), []);

  // 监听 Chrome 插件 postMessage（链接拦截 & 导航通知）
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data.type !== 'string') return;
      if (!e.data.type.startsWith('cockpit:')) return;

      // 匹配消息来源：event.source 是发送消息的 iframe contentWindow
      const iframe = iframeWrapperRef.current?.querySelector('iframe');
      if (!iframe || e.source !== iframe.contentWindow) return;

      const type = e.data.type as string;

      if (type === 'cockpit:new-tab' && e.data.url) {
        onNewTab?.(stripCockpitParam(e.data.url));
      } else if ((type === 'cockpit:navigate' || type === 'cockpit:loaded') && e.data.url) {
        setCurrentUrl(stripCockpitParam(e.data.url));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onNewTab]);
  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setLoadError('页面加载失败');
  }, []);

  // 刷新：重置 iframe src → 重新导航 → onBeforeNavigate 自动重新注入 Cookie
  const doRefresh = useCallback(() => {
    const iframe = iframeWrapperRef.current?.querySelector('iframe');
    if (iframe && readyUrl) {
      setIsLoading(true);
      setLoadError(null);
      const src = iframe.src;
      iframe.src = '';
      setTimeout(() => { iframe.src = src; }, 0);
    }
  }, [readyUrl]);

  // URL 变化时重置加载状态
  useEffect(() => {
    if (url) {
      setIsLoading(true);
      setLoadError(null);
    }
  }, [url]);

  // 在新窗口打开
  const handleOpenExternal = useCallback(() => {
    if (currentUrl) window.open(currentUrl, '_blank');
  }, [currentUrl]);

  // ========== 最大化：DOM 节点移动 ==========
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

  // ESC 退出最大化 / Cmd+M 切换最大化
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

  // ========== 最大化 overlay ==========
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
            onDoubleClick={onToggleMaximize}
            className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card"
            style={{ height: 41, flexShrink: 0 }}
          >
            <span className="text-[10px] font-mono leading-none px-1 py-0.5 rounded flex-shrink-0 bg-muted text-muted-foreground">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </span>
            <span className="flex-1 text-xs text-muted-foreground truncate font-mono">
              {currentUrl || '空白页'}
            </span>
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
              title="退出最大化 (⌘M)"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            </button>
          </div>
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
            <span className="font-mono text-foreground truncate">
              {currentUrl || '空白页'}
            </span>
            {/* 复制网址 */}
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
            {/* 新窗口打开 */}
            <button
              onClick={(e) => { e.stopPropagation(); handleOpenExternal(); }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title="在新窗口打开"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
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
            {url ? (
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
                <div className="relative overflow-hidden" style={{ height: maximized ? '100%' : BUBBLE_CONTENT_HEIGHT }}>
                  {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-slate-900/80 z-10">
                      <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {!readyUrl ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : maximized ? (
                    <iframe
                      src={readyUrl}
                      className="w-full h-full border-0"
                      onLoad={handleIframeLoad}
                      onError={handleIframeError}
                      title={`Browser: ${host}`}
                    />
                  ) : (
                    <iframe
                      src={readyUrl}
                      className="border-0"
                      style={{
                        width: '200%',
                        height: '200%',
                        transform: 'scale(0.5)',
                        transformOrigin: 'top left',
                      }}
                      onLoad={handleIframeLoad}
                      onError={handleIframeError}
                      title={`Browser: ${host}`}
                    />
                  )}
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

        {/* ---- 底部状态栏 ---- */}
        {!maximized && url && (
          <div className="border-t border-border px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${isLoading ? 'bg-brand animate-pulse' : loadError ? 'bg-red-500' : 'bg-green-500'}`} />
            <span className="truncate">{isLoading ? '加载中...' : loadError ? '加载失败' : host}</span>
            <span className="flex-1" />
            {timestamp && <span className="text-[11px] flex-shrink-0">{formatTime(timestamp)}</span>}
          </div>
        )}
      </div>

      {/* 最大化 overlay */}
      {fullscreenOverlay}
    </div>
  );
}
