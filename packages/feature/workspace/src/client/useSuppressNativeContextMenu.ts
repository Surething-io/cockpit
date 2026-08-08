'use client';

import { useEffect } from 'react';

/**
 * Suppress the browser's *native* context menu in the Cockpit workspace.
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
 * the native fallback menu is suppressed.
 *
 * Keep this active in normal browser tabs too: the IME bug is PWA-specific, but
 * Cockpit does not rely on the browser's native context menu, and consistent
 * suppression prevents the same popup from leaking through when users switch
 * between installed and tabbed launches.
 */
export function useSuppressNativeContextMenu(): void {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);
}
