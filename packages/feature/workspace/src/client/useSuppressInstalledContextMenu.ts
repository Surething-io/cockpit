'use client';

import { useEffect } from 'react';

/**
 * Detect whether the current document is running inside an *installed* app
 * window (PWA standalone / minimal-ui / window-controls-overlay), as opposed to
 * a normal browser tab.
 *
 * The `display-mode` media feature is defined against the top-level browsing
 * context, but some engines report `browser` inside a same-origin iframe — and
 * Cockpit renders the workspace shell at `/` and the project panels inside a
 * same-origin `/project` iframe. So we probe the current window first and fall
 * back to the (same-origin) top window.
 */
function isInstalledDisplayMode(): boolean {
  if (typeof window === 'undefined') return false;

  const MODES = ['standalone', 'minimal-ui', 'window-controls-overlay'];
  const matches = (win: Window): boolean => {
    try {
      return typeof win.matchMedia === 'function'
        ? MODES.some((m) => win.matchMedia(`(display-mode: ${m})`).matches)
        : false;
    } catch {
      return false;
    }
  };

  let installed = matches(window);
  try {
    if (!installed && window.top && window.top !== window) installed = matches(window.top);
  } catch {
    // Cross-origin top window — not our case, but never throw here.
  }
  // iOS Safari legacy "Add to Home Screen" flag.
  if (!installed && (navigator as unknown as { standalone?: boolean }).standalone === true) {
    installed = true;
  }
  return installed;
}

/**
 * Suppress the browser's *native* context menu while running inside an installed
 * app window.
 *
 * Why: on macOS, when the native (right-click) context menu opens inside a
 * Chromium PWA app window, the web content loses first-responder status; when
 * the menu closes and focus returns, Chromium fails to re-register the OS input
 * method client (`NSTextInputClient`). The result is that IME composition (e.g.
 * Simplified Pinyin) stops working *window-wide* — only ASCII passes through —
 * and it does not recover on refocus, reload, or even in a freshly created
 * input element (the failure is at the RenderWidgetHostView level, not per
 * element). The user confirmed the native context menu is the *only* trigger:
 * plain reloads / Cmd+R keep IME working; only the popup breaks it.
 *
 * Suppressing the native menu removes the trigger entirely while keeping the
 * `standalone` window. The app's own React context menus (FileTree, console
 * bubbles, …) call `preventDefault()` in their `onContextMenu` handlers, which
 * run before this document-level bubble listener, so they keep working — only
 * the native fallback menu is suppressed. Normal browser tabs are untouched
 * (guarded by `isInstalledDisplayMode`).
 */
export function useSuppressInstalledContextMenu(): void {
  useEffect(() => {
    // Evaluate display-mode *live* on every right-click, not once at mount:
    // `display-mode` changes at runtime as the same document moves between a
    // browser tab and an installed app window, so a mount-time gate goes stale
    // (suppresses in a tab / fails to suppress in the app after a switch).
    const onContextMenu = (e: MouseEvent) => {
      if (isInstalledDisplayMode()) e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);
}
